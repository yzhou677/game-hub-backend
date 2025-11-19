import cors from "cors";
import "dotenv/config.js";
import express from "express";
import admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import fs from "fs";
import OpenAI from "openai";
import path from "path";

// -------- Firebase Admin init --------

// Load service account JSON manually
const serviceAccount = JSON.parse(
    fs.readFileSync(path.resolve("service-account.json"), "utf8")
);

// Initialize Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// -------- Candidate games cache --------

let cachedGames = null;
let cachedAt = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Load rawgTopGames from Firestore with simple in-memory cache.
 * Set force = true to ignore cache and reload from Firestore.
 */
async function loadCandidateGames(force = false) {
    const now = Date.now();

    // Use cache if still fresh
    if (!force && cachedGames && now - cachedAt < CACHE_TTL_MS) {
        return cachedGames;
    }

    const snapshot = await db.collection("rawgTopGames").get();
    cachedGames = snapshot.docs.map((doc) => ({
        id: doc.data().id,
        name: doc.data().name,
        genres: (doc.data().genres || []).map((g) => g.name),
        rating: doc.data().rating,
        slug: doc.data().slug,
    }));

    cachedAt = now;
    console.log(
        `Loaded ${cachedGames.length} candidate games (force = ${force})`
    );
    return cachedGames;
}

// Optional: preload once on startup (non-blocking)
loadCandidateGames().catch((err) =>
    console.error("Initial candidate load failed:", err)
);

/**
 * Filter candidate games by genres inferred from user's favorites.
 * 1. Find games in our candidate list whose name matches favorites.
 * 2. Collect their genres as "favorite genres".
 * 3. Keep only candidate games that share at least one favorite genre.
 * 4. If filtering becomes empty, fall back to full list.
 */
function filterByGenre(candidates, favorites) {
    // Normalize favorite names to lowercase for loose matching
    const favLower = favorites.map((f) => f.toLowerCase());

    // Find candidate games whose name matches a favorite
    const favGames = candidates.filter((g) =>
        favLower.includes((g.name || "").toLowerCase())
    );

    // Collect genres of favorite games
    const favGenres = new Set(
        favGames.flatMap((g) => g.genres || [])
    );

    // No genre info -> return original list
    if (!favGenres.size) {
        return candidates;
    }

    // Keep only games that share at least one genre
    const filtered = candidates.filter((g) =>
        (g.genres || []).some((genre) => favGenres.has(genre))
    );

    // Never return an empty pool; fallback to full list
    return filtered.length ? filtered : candidates;
}

// -------- Express app + OpenAI client --------

const app = express();
const port = process.env.PORT || 3000;

// Basic middlewares
app.use(cors());
app.use(express.json());

// Health check
app.get("/status", (req, res) => {
    res.json({ status: "ok" });
});

// Manual cache refresh endpoint (for dev / admin)
app.post("/admin/reload-candidates", async (req, res) => {
    try {
        await loadCandidateGames(true);
        res.json({ ok: true });
    } catch (err) {
        console.error("Failed to reload candidates:", err);
        res.status(500).json({ error: "Failed to reload candidates" });
    }
});

// Create OpenAI client
const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// LLM-based recommendation endpoint
app.post("/recommend", async (req, res) => {
    try {
        const { favorites } = req.body;

        // Basic validation
        if (!Array.isArray(favorites) || favorites.length === 0) {
            return res.status(400).json({
                error: "favorites must be a non-empty array",
            });
        }

        // Load candidate games from Firestore (with cache)
        const candidates = await loadCandidateGames();

        // Step 1: filter candidate pool by genres based on favorites
        const filteredCandidates = filterByGenre(candidates, favorites);

        // Step 2: keep only simple fields for the LLM
        const simplified = filteredCandidates.map((g) => ({
            id: g.id,
            name: g.name,
            genres: g.genres,
            rating: g.rating,
        }));

        const prompt = `
User favorites: ${favorites.join(", ")}.

Candidate games (JSON array):
${JSON.stringify(simplified)}

From ONLY these candidate games, select 5 games the user is most likely to enjoy.
Return ONLY JSON like:
{
  "recommendations": [
    { "id": number, "reason": string }
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
                            recommendations: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        id: { type: "number" },
                                        reason: { type: "string" },
                                    },
                                    required: ["id", "reason"],
                                    additionalProperties: false,
                                },
                            },
                        },
                        required: ["recommendations"],
                        additionalProperties: false,
                    },
                },
            },
        });

        const llmResult = JSON.parse(response.output_text);

        // Attach full game info plus LLM reason
        const finalResult = llmResult.recommendations.map((r) => {
            const game = candidates.find((g) => g.id === r.id);
            // If for some reason not found, just return id + reason
            if (!game) {
                return {
                    id: r.id,
                    name: null,
                    reason: r.reason,
                };
            }
            return { ...game, reason: r.reason };
        });

        res.json({ recommendations: finalResult });
    } catch (err) {
        console.error("LLM error:", err);
        res.status(500).json({ error: "Internal LLM or Firestore error" });
    }
});

// Export Express app as a single HTTPS function
export const api = onRequest(
    {
        cors: true, // Enable CORS for browser calls
    },
    app
);