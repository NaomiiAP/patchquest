// dev-server.js
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Import serverless handlers
import fetchIssue from './api/fetch-issue.js';
import analyzeSkills from './api/analyze-skills.js';
import generateOutline from './api/generate-outline.js';
import reviewPr from './api/review-pr.js';
import geminiLiveKey from './api/gemini-live-key.js';

// Load environment variables
dotenv.config();

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static frontend files from bundle folder
app.use(express.static(path.join(__dirname, 'bundle')));

// Routes matching the Vercel Serverless directory mapping
app.post('/api/fetch-issue', fetchIssue);
app.post('/api/analyze-skills', analyzeSkills);
app.post('/api/generate-outline', generateOutline);
app.post('/api/review-pr', reviewPr);
app.get('/api/gemini-live-key', geminiLiveKey);

// Fallback to serve index.html for any SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'bundle', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Local dev server running at: http://localhost:${PORT}`);
  console.log(`🔑 Make sure to configure your keys in the .env file.\n`);
});
