# Game Hub Backend

Firebase Cloud Functions backend for the Game Hub project.  
Provides a game recommendation API using Firestore candidate data + OpenAI.

## Tech Stack

- Firebase Cloud Functions (2nd gen, Node.js 20)
- Express
- Firebase Admin SDK (Firestore)
- OpenAI Node SDK

## Deploy

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
