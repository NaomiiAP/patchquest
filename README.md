<div align="center">

# 🐉 PatchQuest

**Your AI mentor for open source.**

Go from "I have no idea where to start" to opening your first pull request - with Gemini guiding every step.

[**Live Demo →**](https://patchquest.vercel.app) · [**Demo Video →**](https://www.youtube.com/watch?v=Rqb20SyM1pM) · [**DEV Article →**](https://dev.to/naomiiap/patchquest-turning-passion-into-open-source-contributions-2adm) · [**GitHub →**](https://github.com/NaomiiAP/patchquest)

![License](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)
![Powered by Gemini](https://img.shields.io/badge/Powered%20by-Google%20Gemini-4285F4?style=flat-square&logo=google)
![Powered by ElevenLabs](https://img.shields.io/badge/Voice%20by-ElevenLabs-000000?style=flat-square)
![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-000000?style=flat-square&logo=vercel)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-7342E2?style=flat-square)

</div>

---

> **Open source shouldn't feel like an exclusive club. It should feel like a place where anyone who's willing to learn can contribute.**

## Why I Built PatchQuest

When I saw this weekend's theme, Passion, my mind immediately went to open source.

Every day, thousands of developers star repositories, bookmark issues, and tell themselves they'll contribute "one day." But that first contribution can feel overwhelming. You have to understand an unfamiliar codebase, pick up new concepts, and somehow know where to begin.

I wanted to build something that makes that first step feel a little less intimidating.

---

## What is PatchQuest?

Paste a GitHub issue URL. PatchQuest fetches it, runs it through Gemini, and hands you back a personalized learning quest - the exact skills you need, where to learn them, and a full implementation plan once you are ready.

No more staring at code you do not understand. No more guessing what to Google.

---

## How It Works

```
Paste a GitHub issue URL
        ↓
Gemini reads and understands the issue
        ↓
You get a list of skills you need to learn
        ↓
Work through the learning path at your own pace
        ↓
Gemini builds your implementation plan
        ↓
Code your fix - ask your voice mentor anything, live
        ↓
Submit your PR and get an AI readiness score
        ↓
Open your first contribution
```

---

## Features

### 🧠 AI Features
- **Skill Gap Detection** - Gemini reads the issue and surfaces exactly what you need to learn
- **Solution Outline Generation** - A structured implementation plan generated once your skills are checked off
- **PR Readiness Review** - Paste your PR URL and get a scored, actionable review before you submit

### 🚀 Developer Experience
- **GitHub Issue Import** - Paste any public issue URL, everything is fetched instantly
- **Progress Tracking** - Check off skills as you go, progress saves automatically to local storage
- **Curated Learning Paths** - Each skill links to official docs, with difficulty level and estimated time

### 🎙️ Voice Learning
- **Gemini Live** - Ask your questions out loud, mid-session, in natural language
- **Screen Sharing** - Share your screen so the AI can see exactly what you are looking at
- **ElevenLabs Voice** - Natural, fluid voice responses that do not sound robotic

### ⌚ Companion
- **Wear OS Widget** - A smartwatch-style progress tracker that keeps your quest visible at a glance
- **Patch the Dragon** - Your quest companion. Always there, always encouraging.

---

## Powered by Google Gemini

Gemini is not just a dependency in PatchQuest. It is the engine.

**Issue Understanding**
Gemini reads the full GitHub issue - title, body, comments - and extracts the actual technical problem, not just keywords.

**Skill Analysis**
It identifies 3-5 concrete skills a contributor needs to understand before they can fix the issue. Not generic topics. Specific, actionable ones.

**Personalized Learning Paths**
Each skill comes with a difficulty rating, an estimated learning time, and a link to the right documentation. Gemini chooses based on the issue, not a preset list.

**Solution Planning**
Once your skills are checked off, Gemini writes a full markdown implementation plan - files to touch, approach, pseudocode, and a PR checklist with checkboxes.

**PR Review**
Paste your pull request URL. Gemini reads the diff, scores your implementation against the original issue and learning plan, and returns specific, encouraging suggestions.

---

## Gemini Live Voice Mentor

This is the part I am most excited about.

Once you are in the workspace, you can activate a live voice session with Gemini. You can talk - not type. Ask "wait, what is a mutex?" mid-session and get an explanation immediately. Share your screen so the AI can see the exact code you are looking at and give contextual help.

It feels like pair programming with someone who knows everything and has unlimited patience.

This is what makes PatchQuest different from a docs generator. It is not just a plan on a page. It is a mentor that stays with you while you build.

---

## 🏅 Challenge Tracks

This project was built for the **DEV Weekend Challenge: Passion Edition** and targets:

- **🤖 Best Use of Google AI** - Gemini powers skill analysis, outline generation, PR review, and Gemini Live voice tutoring
- **🎙️ Best Use of ElevenLabs** - Natural voice synthesis for the AI tutor responses (e.g. generating the solution plan)

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS, JavaScript (ES Modules) |
| Backend | Node.js + Express |
| AI | Google Gemini (`gemini-2.0-flash`) |
| Voice | Google Gemini Live + ElevenLabs |
| GitHub Data | GitHub REST API |
| Deployment | Vercel |

---

## Getting Started

```bash
# Clone
git clone https://github.com/NaomiiAP/patchquest.git
cd patchquest

# Install
npm install

# Configure
cp .env.example .env
# Add your keys to .env

# Run
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `GEMINI_API_KEY` | ✅ | Google Gemini API key - [get one free](https://aistudio.google.com/apikey) |
| `GITHUB_TOKEN` | Optional | GitHub PAT for higher rate limits (5,000/hr vs 60) |
| `ELEVENLABS_API_KEY` | Optional | ElevenLabs key for voice synthesis |

Copy `.env.example` to `.env`. Never commit your `.env` file.

---

## Project Structure

```
patchquest/
├── bundle/
│   ├── index.html          # Landing page + workspace UI
│   ├── style.css           # All styles
│   ├── app.js              # Frontend logic
│   └── voice.js            # Gemini Live session module
├── api/
│   ├── fetch-issue.js      # GitHub issue fetching
│   ├── analyze-skills.js   # Gemini skill analysis
│   ├── generate-outline.js # Gemini solution outline
│   ├── review-pr.js        # Gemini PR review
│   └── gemini-live-key.js  # Secure key endpoint
├── dev-server.js           # Local Express server
├── vercel.json             # Vercel config
└── .env.example
```

---

## Deployment

PatchQuest deploys to Vercel in one command:

```bash
npm i -g vercel
vercel --prod
```

The `vercel.json` handles all API route mappings automatically.

---

## Contributing

Found a bug? Have an idea? Pull requests are welcome.

```bash
git checkout -b feat/your-feature
git commit -m "feat: describe what you did"
git push origin feat/your-feature
# Open a PR
```

---

## License

MIT © [Naomi Pereira](https://github.com/NaomiiAP)

---

<div align="center">

Every experienced open-source contributor was once staring at an issue they did not understand.

I hope PatchQuest helps someone make their very first contribution.

If it helped you - or if you just like what it is trying to do - a ⭐ means a lot.

</div>
