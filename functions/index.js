const cors = require("cors");
const express = require("express");
const admin = require("firebase-admin");
const functions = require("firebase-functions");
const { onRequest } = require("firebase-functions/v2/https");
const OpenAI = require("openai");
require("dotenv").config();

// -------- Firebase Admin init --------

admin.initializeApp();

const db = admin.firestore();

// -------- auth middleware --------

async function authGuard(req, res, next) {
    try {
        const authHeader = req.headers.authorization || "";
        const match = authHeader.match(/^Bearer (.+)$/);

        if (!match) {
            return res.status(401).json({ error: "Missing Authorization header" });
        }

        const idToken = match[1];
        const decoded = await admin.auth().verifyIdToken(idToken);

        if (decoded.email !== "yzhou677@gmail.com") {
            return res.status(403).json({ error: "Not allowed" });
        }

        req.user = decoded;
        next();
    } catch (err) {
        console.error("Auth error", err);
        return res.status(401).json({ error: "Invalid or expired token" });
    }
}

// -------- Candidate games cache --------

let cachedGames = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

async function loadCandidateGames(force = false) {
    const now = Date.now();

    if (!force && cachedGames && now - cachedAt < CACHE_TTL_MS) {
        return cachedGames;
    }

    const snapshot = await db.collection("rawgTopGames").get();
    cachedGames = snapshot.docs.map((doc) => doc.data());

    cachedAt = now;
    console.log(`Loaded ${cachedGames.length} candidate games (force = ${force})`);
    return cachedGames;
}

// -------- genre filter --------
function filterByGenre(candidates, favorites) {
    const favLower = favorites.map((f) => f.toLowerCase());

    const favGames = candidates.filter((g) =>
        favLower.includes((g.name || "").toLowerCase())
    );

    // collect genre *names* from favorite games
    const favGenres = new Set(
        favGames.flatMap((g) =>
            (g.genres || []).map((gen) => gen.name)
        )
    );

    if (!favGenres.size) return candidates;

    const filtered = candidates.filter((g) =>
        (g.genres || []).some((gen) => favGenres.has(gen.name))
    );

    return filtered.length ? filtered : candidates;
}

// -------- Express app + OpenAI client --------
const app = express();
app.use(cors());
app.use(express.json());

app.get("/status", (req, res) => {
    res.json({ status: "ok" });
});

app.post("/admin/reload-candidates", async (req, res) => {
    try {
        await loadCandidateGames(true);
        res.json({ ok: true });
    } catch (err) {
        console.error("Failed to reload candidates:", err);
        res.status(500).json({ error: "Failed to reload candidates" });
    }
});

// ----- OpenAI client -----
let openaiApiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;

if (!openaiApiKey) {
    const cfg = functions.config();
    if (cfg.openai && cfg.openai.key) {
        openaiApiKey = cfg.openai.key;
    }
}

let client = null;

if (openaiApiKey) {
    client = new OpenAI({ apiKey: openaiApiKey });
    console.log("OpenAI client initialized");
} else {
    console.error("No OpenAI API key found (neither .env nor functions config)");
}

// -------- /recommend --------

app.post("/recommend", authGuard, async (req, res) => {
    try {
        if (!client) {
            return res.status(500).json({
                error: "OpenAI is not configured on the server",
            });
        }

        const { favorites } = req.body;

        if (!Array.isArray(favorites) || favorites.length === 0) {
            return res.status(400).json({
                error: "favorites must be a non-empty array",
            });
        }

        const candidates = await loadCandidateGames();

        // Genre filtering based on favorites
        const genreFiltered = filterByGenre(candidates, favorites);

        // Exclude favorites, but only if we still have at least 8 games left
        const favoritesLower = favorites.map((f) => f.toLowerCase());
        let pool = genreFiltered.filter(
            (g) =>
                !favoritesLower.includes(
                    (g.name || "").toLowerCase()
                )
        );

        // If excluding favorites leaves fewer than 8, fall back to genreFiltered
        if (pool.length < 8) {
            pool = genreFiltered;
        }

        // Safety: if still somehow fewer than 8, you could optionally fall back to all candidates
        if (pool.length < 8) {
            pool = candidates;
        }

        // Build simplified list for the LLM
        const simplified = pool.map((g, idx) => ({
            index: idx,
            name: g.name,
            genres: g.genres,
            rating: g.rating,
        }));

        const validIndexes = simplified.map((g) => g.index);

        const prompt = `
User favorites: ${favorites.join(", ")}.

You are a game recommendation engine.
You MUST ONLY recommend from the following candidate games array.
Each game has a numeric "index". Use this "index" to reference games.
DO NOT invent new games or indices that are not in the list.

Candidate games (JSON array):
${JSON.stringify(simplified, null, 2)}

From ONLY these candidate games:

1. Select **8 games** the user is most likely to enjoy.
2. Provide a **summary** explaining WHY (overall reasoning).

Return ONLY JSON like:
{
  "summary": string,
  "recommendations": [
    { "index": number, "reason": string }
  ]
}
`;

        const response = await client.responses.create({
            model: "gpt-4.1-mini",
            input: prompt,
            text: {
                format: {
                    type: "json_schema",
                    name: "game_recommendations",
                    strict: true,
                    schema: {
                        type: "object",
                        properties: {
                            summary: {
                                type: "string"
                            },
                            recommendations: {
                                type: "array",
                                minItems: 8,
                                maxItems: 8,
                                items: {
                                    type: "object",
                                    properties: {
                                        index: {
                                            type: "integer",
                                            enum: validIndexes
                                        },
                                        reason: { type: "string" }
                                    },
                                    required: ["index", "reason"],
                                    additionalProperties: false
                                }
                            }
                        },
                        required: ["summary", "recommendations"],
                        additionalProperties: false
                    }
                }
            }
        });

        const llmResult = JSON.parse(response.output_text);

        const finalResult = llmResult.recommendations.map((r) => {
            const game = pool[r.index];
            if (!game) {
                return { id: null, name: null, reason: r.reason };
            }
            return {
                ...game,
                reason: r.reason
            };
        });

        res.json({
            summary: llmResult.summary,
            recommendations: finalResult
        });

    } catch (err) {
        console.error("FULL ERROR:", err);
        return res.status(500).json({
            error: err.message || err.toString()
        });
    }
});

// -------- Export HTTPS function --------

exports.api = onRequest(
    {
        cors: true,
    },
    app
);
