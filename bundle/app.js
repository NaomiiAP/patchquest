/**
 * PatchQuest
 *
 * Core loop:
 *   1. Paste GitHub issue URL → fetch issue data
 *   2. Gemini AI → extract skill gaps → human approves plan
 *   3. User checks off skills (progress tracking)
 *   4. Gemini AI → generate solution outline → human approves
 *   5. Export PR checklist
 *
 * Bonus: Gemini Live voice tutoring, smartwatch companion (Wear OS)
 */


const STORAGE_PREFIX = "patchquest:";
const STATE_KEYS = {
  issue: "issue",
  plan: "plan",
  approved: "approved",
  outline: "outline",
  outlineApproved: "outlineApproved",
  review: "review",
};

function updatePatchBubbleText(text) {
  const bubble = document.querySelector(".patch-pet-bubble");
  if (bubble) {
    bubble.textContent = text;
    const pet = document.getElementById("patch-pet");
    if (pet) {
      pet.classList.remove("is-chatting");
      void pet.offsetWidth; // Trigger reflow
      pet.classList.add("is-chatting");
    }
  }
}



// ── Prompt templates ──────────────────────────────────────────────────

const PROMPTS = {
  extractSkills: {
    system:
      "You are a senior engineer mentor. Given a GitHub issue (title, body, comments), identify 3-5 concrete technical skills a contributor must learn to fix it. Return ONLY valid JSON, no markdown fences.",
    user: (issueText) =>
      `Analyze this GitHub issue and identify 3-5 concrete skills a contributor would need. Stick ONLY to official documentation links or well-known predictable URLs. DO NOT invent YouTube links or Medium blog URLs because they are often hallucinated and return 404. It is perfectly fine to only give Docs.\n\nReturn ONLY JSON in this shape:\n{"skills": [{"name": "...", "resourceUrl": "https://...", "rationale": "one sentence", "estimatedTime": "15m", "difficulty": "Beginner|Intermediate|Advanced", "resourceType": "Docs|Article"}]}\n\nIssue:\n${issueText}`,
  },
  generateOutline: {
    system:
      "You are a staff engineer writing a fix plan. Given a GitHub issue and the learner's approved skill checklist (all marked complete), produce a detailed, highly structured solution outline in markdown. Be specific to the repo/issue. No filler.",
    user: (issueText, skillNames) =>
      `Create a beautiful, professional markdown solution outline for fixing this GitHub issue.\nThe contributor has completed these skills: ${skillNames}\n\nInclude sections:\n## Summary\n## Files to Touch (use markdown bullet points)\n## Pseudocode / Approach\n## Learning Resources\n## PR Checklist (use - [ ] markdown checkboxes for the exact steps to implement the fix)\n\nIMPORTANT: For the 'Pseudocode / Approach' section, use standard MULTILINE markdown code blocks with language tags (e.g., \`\`\`javascript\\n...\\n\`\`\`). Do NOT put entire code blocks on a single line with backticks.\n\nReturn markdown only (no wrapping code fences).\n\nIssue:\n${issueText}`,
  },
  reviewPR: {
    system:
      "You are an expert, professional open-source maintainer and mentor. Your job is to review a Pull Request against the original issue and learning plan. Be direct, clear, and honest about any problems, missing requirements, or bugs. Clearly state what went wrong and how to fix it. However, remain constructive and encouraging—never use harsh, rude, or condescending language. You MUST output ONLY valid JSON. Do not use markdown fences.",
    user: (issueText, skillNames, prTitle, prBody, prDiff) =>
      `Generate a Pull Request Readiness Report in JSON format.

Required JSON Structure:
{
  "overallScore": 85,
  "verdict": "Great work! 🎉",
  "bars": [
    { "label": "Issue Coverage", "percentage": 90, "colorClass": "wf-bg-success" },
    { "label": "Skill Application", "percentage": 80, "colorClass": "wf-bg-warning" },
    { "label": "Learning Valid.", "percentage": 85, "colorClass": "wf-bg-success" },
    { "label": "Maintainer Read.", "percentage": 85, "colorClass": "wf-bg-success" }
  ],
  "suggestions": [
    {
      "title": "Add tests for edge cases",
      "details": "You've written great code, but adding a few edge case tests will make it bulletproof!"
    }
  ]
}

- overallScore: Integer between 0-100.
- verdict: A short 2-5 word summary with an emoji.
- bars: Exactly 4 objects. colorClass must be "wf-bg-success" (>=80), "wf-bg-warning" (50-79), or "wf-bg-danger" (<50).
- suggestions: Array of objects with "title" (short actionable string) and "details" (1-2 sentences of kind, encouraging explanation). Max 5 suggestions.

IMPORTANT: Grade VERY generously! If the PR code is generally decent, makes an effort to use the skills, and addresses the main points of the issue, give scores in the 80-100 range. Only give low scores (<50) if the PR is completely empty or completely unrelated to the issue.

Original Issue:
${issueText}

Required Skills: ${skillNames}

PR Title: ${prTitle}
PR Body: ${prBody}
PR Diff:
${prDiff}`
  }
};

// ── App state ─────────────────────────────────────────────────────────


let issueData = null;
let draftSkills = [];
let approvedPlan = null;
let solutionOutline = "";
let outlineApproved = false;

// ── Hackathon Fallback Keys ───────────────────────────────────────────
// Drop your 5 dummy API keys here. The app will randomly pick one to
// distribute the load and avoid rate limits during judging!
let geminiApiKey = "";

async function getActiveGeminiKey() {
  if (geminiApiKey) return geminiApiKey;

  try {
    const response = await fetch("/api/gemini-live-key", { cache: "no-store" });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.includes("application/json")) return null;

    const config = await response.json();
    geminiApiKey = config.apiKey || "";
    return geminiApiKey || null;
  } catch {
    return null;
  }
}
let voiceSession = null;

// ── LLM calls go through /api/ endpoints (see api/*.js) ──────────────

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}

// ── UX Helpers ────────────────────────────────────────────────────────

/**
 * Shows a loading overlay and progressively updates its text message.
 * Returns a cleanup function to hide the overlay and clear the interval.
 */
function showProgressiveLoading(overlayId, textId, messages) {
  const overlay = document.getElementById(overlayId);
  const textEl = document.getElementById(textId);
  if (!overlay || !textEl || !messages || !messages.length) return () => {};

  overlay.classList.add("visible");
  
  let i = 0;
  textEl.textContent = messages[i];
  
  const intervalId = setInterval(() => {
    i++;
    if (i < messages.length) {
      textEl.textContent = messages[i];
    } else {
      clearInterval(intervalId); // Stop at the last message
    }
  }, 3500); // Rotate text every 3.5 seconds

  // Return cleanup function
  return () => {
    clearInterval(intervalId);
    overlay.classList.remove("visible");
  };
}

// ── State persistence (localStorage) ─────────────────────────────────

async function stateGet(key) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(`[PatchQuest] Error parsing localStorage key "${key}":`, err);
    return null;
  }
}

async function stateSet(key, value) {
  if (value === null) {
    localStorage.removeItem(STORAGE_PREFIX + key);
  } else {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  }
}

async function saveQuestToHistory(url, title, skills, outline, state, review) {
  try {
    let history = JSON.parse(localStorage.getItem(STORAGE_PREFIX + "history") || "[]");
    const idx = history.findIndex(q => q.url === url);
    const updatedQuest = {
      url,
      title,
      skills,
      outline,
      state,
      review,
      updated_at: new Date().toISOString()
    };
    if (idx !== -1) {
      history[idx] = updatedQuest;
    } else {
      history.push(updatedQuest);
    }
    localStorage.setItem(STORAGE_PREFIX + "history", JSON.stringify(history));
  } catch (e) {
    console.error("Failed to save history", e);
  }
}

async function loadPersistedState() {
const [issue, plan, approved, outline, approvedOutline, review] =
    await Promise.all([
      stateGet(STATE_KEYS.issue),
      stateGet(STATE_KEYS.plan),
      stateGet(STATE_KEYS.approved),
      stateGet(STATE_KEYS.outline),
      stateGet(STATE_KEYS.outlineApproved),
      stateGet(STATE_KEYS.review),
    ]);

  const skipLanding = sessionStorage.getItem(STORAGE_PREFIX + "skip-landing") === "true";
  if (issue || approved || skipLanding) {
    const landing = document.getElementById("landing-page");
    const workspace = document.getElementById("app-workspace");
    if (landing && workspace) {
      landing.classList.add("hidden");
      workspace.classList.remove("hidden");
      document.getElementById("landing-nav")?.classList.add("hidden");
    }
  }

  let defaultPetText = "Welcome to your workspace! Paste a GitHub issue URL to begin our quest! 🐉";

  if (issue) {
    issueData = issue;
    document.getElementById("issue-url").value = issue.html_url || "";
    renderIssuePreview(issue);
    document.getElementById("step-skills").classList.remove("hidden");
    unlockSection("step-skills");
    markStepDone("step1-num");
    defaultPetText = "Skills discovered! Review the plan and approve it when you're ready! ✨";
  }

  if (plan && !approved) {
    draftSkills = plan;
    renderDraftSkills();
    document.getElementById("step-skills").classList.remove("hidden");
    unlockSection("step-skills");
  }

  if (approved) {
    approvedPlan = approved;
    draftSkills = approved.skills;
    renderDraftSkills();
    document.getElementById("step-skills").classList.remove("hidden");
    document.getElementById("step-quest").classList.remove("hidden");
    unlockSection("step-skills");
    unlockSection("step-quest");
    markStepDone("step2-num");
    renderQuestList();
    updateProgress();
    syncToWearOS();
    startWearOSPolling();
    defaultPetText = "Click 'Start Live Session' to talk to me or check off skills as you finish them! 🎙️";
  }

  if (outline) {
    solutionOutline = outline;
    renderOutline(outline);
    document.getElementById("step-outline").classList.remove("hidden");
    unlockSection("step-outline");
    markStepDone("step3-num");
    defaultPetText = "Check out the solution plan! Let's approve it when you are ready to implement! 📝";
  }

  if (approvedOutline) {
    outlineApproved = true;
    markStepDone("step4-num");
    document.getElementById("step-export").classList.remove("hidden");
    unlockSection("step-export");
    
    const stepReview = document.getElementById("step-review");
    if (stepReview) {
      stepReview.classList.remove("hidden");
      unlockSection("step-review");
    }

    const checklist = generatePRChecklist(
      solutionOutline,
      issueData,
      approvedPlan?.skills || []
    );
    renderPRChecklist(checklist);
    defaultPetText = "Nice! Copy the PR checklist and click 'Discuss Readiness' to audit your code before you submit! 🚀";

    if (review) {
      try {
        const reviewData = JSON.parse(review);
        renderReviewResults(reviewData);
        document.getElementById("btn-review").disabled = true;
        if (reviewData.overallScore >= 80) {
          defaultPetText = "Amazing work! You've mastered these skills! Let's start another quest! 🏆";
        } else {
          defaultPetText = "Not bad! Try incorporating the suggestions and click Analyze PR again! We've got this! 💪";
        }
      } catch (err) {
        console.error("[PatchQuest] Error parsing cached review:", err);
      }
    }
  }
  updateWatchWidget();
  updatePatchBubbleText(defaultPetText);
}

// ── GitHub URL parsing ────────────────────────────────────────────────

function parseIssueUrl(url) {
  const m = url
    .trim()
    .match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/i);
  if (!m) throw new Error("Invalid GitHub issue URL");
  return {
    owner: m[1],
    repo: m[2].replace(/\.git$/, ""),
    number: parseInt(m[3], 10),
  };
}

// ── Issue text builder ────────────────────────────────────────────────

function buildIssueContext(issue) {
  const comments = (issue.comments || [])
    .map((c) => `${c.user}: ${c.body}`)
    .join("\n");
  return `Title: ${issue.title}\n\nBody:\n${issue.body}\n\nComments:\n${comments}`;
}

// ── Tool: fetch_issue (local fallback) ────────────────────────────────

async function localFetchIssue(params) {
  const parsed = params.url
    ? parseIssueUrl(params.url)
    : { owner: params.owner, repo: params.repo, number: params.number };
  const { owner, repo, number } = parsed;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "PatchQuest/1.0",
  };

  try {
    const [issueRes, commentsRes] = await Promise.all([
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
        { headers }
      ),
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
        { headers }
      ),
    ]);

    if (!issueRes.ok) throw new Error(`GitHub API ${issueRes.status}`);

    const issue = await issueRes.json();
    const commentsRaw = commentsRes.ok ? await commentsRes.json() : [];
    const comments = commentsRaw.map((c) => ({
      user: c.user?.login || "unknown",
      body: c.body || "",
      created_at: c.created_at,
    }));

    return {
      title: issue.title,
      body: issue.body || "",
      state: issue.state,
      labels: (issue.labels || []).map((l) => l.name),
      html_url: issue.html_url,
      owner,
      repo,
      number,
      comments,
    };
  } catch (err) {
    console.warn("[PatchQuest] fetch failed, using mock:", err);
    return getMockIssue(parsed);
  }
}

function getMockIssue(parsed) {
  return {
    title: "Fix: useEffect cleanup not called on fast unmount",
    body: "When a component unmounts quickly after mount, the cleanup function passed to useEffect is sometimes skipped.\n\nRepro: render a component that toggles visibility rapidly.\n\nExpected: cleanup runs every time.\nActual: intermittent skipped cleanup.",
    state: "open",
    labels: ["bug", "React Core"],
    html_url: `https://github.com/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`,
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
    comments: [
      {
        user: "maintainer",
        body: "Likely related to concurrent rendering batching.",
        created_at: "2024-01-15T10:00:00Z",
      },
    ],
  };
}

async function localFetchPR(url) {
  const match = url.trim().match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!match) throw new Error("Invalid GitHub Pull Request URL");
  const owner = match[1], repo = match[2].replace(/\.git$/, ""), number = match[3];

  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "PatchQuest/1.0",
  };

  try {
    const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, { headers });
    if (!prRes.ok) throw new Error(`GitHub API ${prRes.status}`);
    const prData = await prRes.json();

    headers.Accept = "application/vnd.github.v3.diff";
    const diffRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${number}`, { headers });
    const diffText = await diffRes.text();

    return {
      title: prData.title,
      body: prData.body || "",
      diff: diffText.substring(0, 8000) // Truncate to save tokens
    };
  } catch (err) {
    console.warn("[PatchQuest] PR fetch failed, using mock:", err);
    return {
      title: "Fix user authentication bug",
      body: "Resolves #123 by adding JWT token validation.",
      diff: "diff --git a/auth.js b/auth.js\n+ const jwt = require('jsonwebtoken');\n+ function verify(token) { return jwt.verify(token, secret); }"
    };
  }
}

// ── Heuristic fallbacks (when LLM unavailable) ────────────────────────

function heuristicSkills(text, issue) {
  const lower = text.toLowerCase();
  const pool = [
    {
      name: "React Hooks & useEffect lifecycle",
      resourceUrl: "https://react.dev/reference/react/useEffect",
      match: /useeffect|hook|cleanup|unmount/,
    },
    {
      name: "JavaScript async patterns",
      resourceUrl:
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function",
      match: /async|await|promise/,
    },
    {
      name: "TypeScript generics",
      resourceUrl:
        "https://www.typescriptlang.org/docs/handbook/2/generics.html",
      match: /typescript|generic|type/,
    },
    {
      name: "GitHub contribution workflow",
      resourceUrl:
        "https://docs.github.com/en/get-started/exploring-projects-on-github/contributing-to-a-project",
      match: /pr|pull request|contribut/,
    },
    {
      name: "CSS Flexbox layout",
      resourceUrl:
        "https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_flexible_box_layout",
      match: /flex|layout|css/,
    },
    {
      name: "REST API design",
      resourceUrl: "https://restfulapi.net/",
      match: /api|endpoint|rest/,
    },
    {
      name: "Unit testing with Jest",
      resourceUrl: "https://jestjs.io/docs/getting-started",
      match: /test|jest|spec/,
    },
    {
      name: "Debugging with browser DevTools",
      resourceUrl: "https://developer.chrome.com/docs/devtools/",
      match: /debug|devtools|repro/,
    },
  ];

  const picked = pool.filter((p) => p.match.test(lower)).slice(0, 3);
  const fallback = [
    {
      name: "Reading GitHub issues effectively",
      resourceUrl: "https://guides.github.com/features/issues/",
      rationale: "Understand issue context and reproduction steps.",
    },
    {
      name: "Systematic debugging",
      resourceUrl: "https://www.debuggingbook.org/",
      rationale: "Isolate root cause before writing a fix.",
    },
  ];

  const skills = (picked.length >= 2 ? picked : fallback).map((s) => ({
    name: s.name,
    resourceUrl: s.resourceUrl,
    rationale: s.rationale || `Needed to address: ${issue.title}`,
    completed: false,
  }));

  return skills.slice(0, 4);
}

function heuristicOutline(issue, skills) {
  const skillNames = skills.map((s) => s.name).join(", ");
  return `## Summary
Address **${issue.title}** in \`${issue.owner}/${issue.repo}\` using skills: ${skillNames}.

## Files to Touch
- Relevant source modules under \`${issue.owner}/${issue.repo}\`
- Add/update tests for the regression
- Update CHANGELOG if required by the project

## Pseudocode / Approach
1. Reproduce the issue locally from the report.
2. Trace the code path mentioned in the issue body and comments.
3. Implement the minimal fix with a regression test.
4. Run the project's test suite.

## Next Actions
1. Fork \`${issue.owner}/${issue.repo}\` → branch \`fix/issue-${issue.number}\`
2. Open PR referencing #${issue.number}
3. Request maintainer review`;
}

// ── JSON parsing helpers ──────────────────────────────────────────────

function stripMarkdownFence(text) {
  const stripped = text.trim();
  const m = stripped.match(
    /^```(?:json|markdown|md)?\s*\n?(.*?)\n?```\s*$/s
  );
  return m ? m[1].trim() : stripped;
}

function parseJsonObject(text) {
  const cleaned = stripMarkdownFence(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error("LLM response did not contain JSON");
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function normalizeSkills(raw) {
  const skills = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name || "").trim();
    if (!name) continue;
    skills.push({
      name,
      resourceUrl: String(
        item.resourceUrl || item.resource_url || ""
      ).trim(),
      rationale:
        String(item.rationale || "").trim() || "Needed for this issue.",
      estimatedTime: String(item.estimatedTime || "15m").trim(),
      difficulty: String(item.difficulty || "Beginner").trim(),
      resourceType: String(item.resourceType || "Docs").trim(),
      completed: false,
    });
  }
  return skills.slice(0, 6);
}

// ── PR Checklist generator ────────────────────────────────────────────

function generatePRChecklist(outline, issue, skills) {
  const issueRef = issue
    ? `${issue.owner}/${issue.repo}#${issue.number}`
    : "unknown";
  const issueUrl = issue?.html_url || "";
  const skillSummary = (skills || [])
    .map((s) => `  ✅ ${s.name}`)
    .join("\n");

  // Parse outline sections for checklist items
  const lines = (outline || "").split("\n");
  let currentSection = "";
  const sections = { summary: [], files: [], approach: [], actions: [] };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s*Summary/i.test(trimmed)) {
      currentSection = "summary";
    } else if (/^##\s*Files/i.test(trimmed)) {
      currentSection = "files";
    } else if (/^##\s*(Pseudocode|Approach)/i.test(trimmed)) {
      currentSection = "approach";
    } else if (/^##\s*Next/i.test(trimmed)) {
      currentSection = "actions";
    } else if (trimmed && currentSection) {
      sections[currentSection].push(trimmed);
    }
  }

  const formatItems = (items) =>
    items
      .map((item) => {
        const clean = item.replace(/^[-*\d.]+\s*/, "").trim();
        return clean ? `- [ ] ${clean}` : "";
      })
      .filter(Boolean)
      .join("\n");

  let checklist = `## PR Checklist — PatchQuest Solution\n`;
  checklist += `**Issue:** [${issueRef}](${issueUrl})\n\n`;

  if (sections.summary.length) {
    checklist += `### Summary\n${sections.summary.join(" ")}\n\n`;
  }

  if (skillSummary) {
    checklist += `### Skills Applied\n${skillSummary}\n\n`;
  }

  if (sections.files.length) {
    checklist += `### Files to Touch\n${formatItems(sections.files)}\n\n`;
  }

  if (sections.approach.length) {
    checklist += `### Implementation Steps\n${formatItems(sections.approach)}\n\n`;
  }

  if (sections.actions.length) {
    checklist += `### Next Actions\n${formatItems(sections.actions)}\n\n`;
  }

  checklist += `### Verification\n- [ ] All tests pass\n- [ ] Manual testing done\n- [ ] PR description references ${issueRef}\n`;

  return checklist;
}

// ── Markdown → HTML ───────────────────────────────────────────────────

function simpleMarkdownToHtml(md) {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /```[\s\S]*?```/g,
      (block) =>
        `<pre><code>${block.replace(/```\w*\n?/g, "").replace(/```/g, "")}</code></pre>`
    )
    .replace(/^(\d+)\. (.+)$/gm, "<li>$2</li>")
    .replace(
      /(<li>.*<\/li>\n?)+/g,
      (m) => `<ol>${m}</ol>`
    )
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(
      /(<li>.*<\/li>\n?)+/g,
      (m) => (m.includes("<ol>") ? m : `<ul>${m}</ul>`)
    )
    .replace(/\n\n/g, "<br><br>");
}

// ── UI helpers ────────────────────────────────────────────────────────

function showLoading(id, visible) {
  document.getElementById(id).classList.toggle("visible", visible);
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2800);
}

function unlockSection(id) {
  document.getElementById(id).classList.remove("section-locked");
}

function lockSection(id) {
  document.getElementById(id).classList.add("section-locked");
}

function markStepDone(stepNumId) {
  const el = document.getElementById(stepNumId);
  el.classList.remove("active");
  el.classList.add("done");
}

function renderIssuePreview(issue) {
  const preview = document.getElementById("issue-preview");
  document.getElementById("issue-title").textContent = issue.title;
  document.getElementById("issue-meta").textContent = `${issue.owner}/${issue.repo} #${issue.number} · ${issue.state} · ${(issue.labels || []).join(", ")}`;
  document.getElementById("issue-body").textContent =
    (issue.body || "").slice(0, 400) +
    ((issue.body || "").length > 400 ? "…" : "");
  preview.classList.add("visible");
  document.getElementById("btn-analyze").disabled = false;
}

function renderDraftSkills() {
  const list = document.getElementById("skills-list");
  const toolbar = document.getElementById("skills-toolbar");
  list.classList.remove("hidden");
  toolbar.classList.remove("hidden");
  list.innerHTML = "";

  draftSkills.forEach((skill, idx) => {
    const li = document.createElement("li");
    li.className = "skill-item draft-card";
    li.innerHTML = `
      <div class="skill-fields">
        <div class="skill-header">
          <input type="text" class="draft-name" data-idx="${idx}" data-field="name" value="${escapeAttr(skill.name)}" placeholder="Skill name" />
          <div class="skill-meta-draft">
            <input type="text" data-idx="${idx}" data-field="difficulty" value="${escapeAttr(skill.difficulty || 'Beginner')}" placeholder="Difficulty" />
            <input type="text" data-idx="${idx}" data-field="estimatedTime" value="${escapeAttr(skill.estimatedTime || '15m')}" placeholder="Time" />
            <input type="text" data-idx="${idx}" data-field="resourceType" value="${escapeAttr(skill.resourceType || 'Docs')}" placeholder="Type" />
          </div>
        </div>
        <div class="input-with-link">
          <input type="url" data-idx="${idx}" data-field="resourceUrl" value="${escapeAttr(skill.resourceUrl)}" placeholder="Learning resource URL" />
          ${skill.resourceUrl ? `<a href="${escapeAttr(skill.resourceUrl)}" target="_blank" rel="noopener" class="external-link-btn" title="Open Link">↗</a>` : ""}
        </div>
        ${skill.rationale ? `<span class="skill-rationale">${escapeHtml(skill.rationale)}</span>` : ""}
      </div>
      <button type="button" class="ghost remove-btn" data-remove="${idx}">Remove</button>
    `;
    list.appendChild(li);
  });

  document.getElementById("btn-approve").disabled = draftSkills.length < 2;
  bindDraftEditors();
}

function bindDraftEditors() {
  const list = document.getElementById("skills-list");
  if (!list) return;

  list.querySelectorAll("input[data-idx][data-field]").forEach((input) => {
    input.addEventListener("input", () => {
      const idx = Number.parseInt(input.dataset.idx, 10);
      const field = input.dataset.field;
      if (!Number.isInteger(idx) || !field || !draftSkills[idx]) return;
      draftSkills[idx][field] = input.value;
    });
  });

  list.querySelectorAll(".remove-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const idx = Number.parseInt(button.dataset.remove, 10);
      if (!Number.isInteger(idx)) return;
      draftSkills.splice(idx, 1);
      renderDraftSkills();
    });
  });
}

function renderQuestList() {
  const list = document.getElementById("quest-list");
  list.innerHTML = "";
  const hasVoice = !!getActiveGeminiKey();

  (approvedPlan?.skills || []).forEach((skill, idx) => {
    const li = document.createElement("li");
    li.className = "skill-item quest-card" + (skill.completed ? " completed" : "");
    
    // Icon based on type
    let typeIcon = "📄";
    const rt = skill.resourceType?.toLowerCase() || "";
    if (rt === "video") typeIcon = "🎥";
    if (rt === "pr") typeIcon = "🔗";
    if (rt === "blog" || rt === "article") typeIcon = "📝";

    li.innerHTML = `
      <div class="quest-card-main">
        <label class="quest-checkbox-wrapper">
          <input type="checkbox" data-quest-idx="${idx}" ${skill.completed ? "checked" : ""} />
          <span class="custom-checkbox"></span>
        </label>
        <div class="skill-fields">
          <div class="skill-header">
            <strong>${escapeHtml(skill.name)}</strong>
            <div class="skill-badges">
              <span class="badge badge-difficulty badge-${(skill.difficulty || 'beginner').toLowerCase()}">${escapeHtml(skill.difficulty || 'Beginner')}</span>
              <span class="badge badge-time">⏳ ${escapeHtml(skill.estimatedTime || '15m')}</span>
              <a href="${escapeAttr(skill.resourceUrl)}" target="_blank" rel="noopener" class="badge badge-resource">${typeIcon} ${escapeHtml(skill.resourceType || 'Docs')} ↗</a>
            </div>
          </div>
          ${skill.rationale ? `<p class="skill-rationale">${escapeHtml(skill.rationale)}</p>` : ""}
          <a href="${escapeAttr(skill.resourceUrl)}" target="_blank" rel="noopener" class="skill-url-text">${escapeHtml(skill.resourceUrl)}</a>
        </div>
      </div>
      <div class="skill-actions">
        ${hasVoice ? `<button type="button" class="voice-btn glowing-voice" data-voice-idx="${idx}" title="Start a live session with AI"><span class="mic-icon">🎙️</span> Start Live Session</button>` : ""}
      </div>
    `;
    list.appendChild(li);
  });

  list.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", onQuestCheck);
  });

  list.querySelectorAll(".voice-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.voiceIdx, 10);
      onTalkThrough(idx);
    });
  });
}

function updateProgress() {
  const skills = approvedPlan?.skills || [];
  const done = skills.filter((s) => s.completed).length;
  const total = skills.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  document.getElementById("progress-text").textContent =
    `${done} / ${total} skills`;
  document.getElementById("progress-fill").style.width = `${pct}%`;
  document.getElementById("btn-outline").disabled =
    done < total || total === 0;

  if (done === total && total > 0) {
    markStepDone("step3-num");
    
    // Check if we just completed the last one right now by looking for a session flag
    if (!window.hasCelebratedQuest) {
      window.hasCelebratedQuest = true;
      triggerCelebration();
    }
  } else {
    window.hasCelebratedQuest = false;
  }

  updateWatchWidget();
}

function triggerCelebration() {
  if (typeof confetti === "function") {
    confetti({
      particleCount: 150,
      spread: 80,
      origin: { y: 0.6 },
      colors: ['#ff9a9e', '#fecfef', '#a18cd1', '#fbc2eb']
    });
  }
  
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.type = "sine";
    osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
    osc.frequency.exponentialRampToValueAtTime(1046.50, ctx.currentTime + 0.1); // C6
    
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  } catch(e) {
    // Ignore audio errors
  }
}

function updateWatchWidget() {
  const ring = document.getElementById("watch-widget-ring");
  const pctEl = document.getElementById("watch-widget-pct");
  const countEl = document.getElementById("watch-widget-count");
  const titleEl = document.getElementById("watch-widget-title");
  const listEl = document.getElementById("watch-widget-list");
  const voiceTrigger = document.getElementById("widget-voice-trigger");
  const voiceBadge = document.getElementById("widget-voice-badge");
  if (voiceBadge) {
    voiceBadge.textContent = "Server ready";
    voiceBadge.classList.remove("inactive");
  }

  if (!approvedPlan || !approvedPlan.skills || approvedPlan.skills.length === 0) {
    if (ring) ring.style.strokeDashoffset = "263.89";
    if (pctEl) pctEl.textContent = "0%";
    if (countEl) countEl.textContent = "0/0";
    if (titleEl) titleEl.textContent = "No active quest";
    if (listEl) {
      listEl.innerHTML = '<div class="watch-empty-msg">Approve a plan to begin</div>';
    }
    if (voiceTrigger) voiceTrigger.classList.add("hidden");
    return;
  }

  const skills = approvedPlan.skills;
  const done = skills.filter(s => s.completed).length;
  const total = skills.length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  // Ring offset
  const circ = 263.89;
  const offset = circ - (pct / 100) * circ;
  if (ring) ring.style.strokeDashoffset = offset;

  if (pctEl) pctEl.textContent = `${pct}%`;
  if (countEl) countEl.textContent = `${done}/${total}`;
  if (titleEl) titleEl.textContent = issueData?.title || "Active Quest";

  // Render list of items inside watch
  if (listEl) {
    listEl.innerHTML = "";
    skills.forEach((skill, idx) => {
      const row = document.createElement("div");
      row.className = "watch-mini-row" + (skill.completed ? " done" : "");
      row.innerHTML = `
        <div class="watch-mini-check">${skill.completed ? "✓" : ""}</div>
        <div class="watch-mini-name">${escapeHtml(skill.name)}</div>
      `;
      row.addEventListener("click", () => {
        // Toggle completed state
        skill.completed = !skill.completed;
        stateSet(STATE_KEYS.approved, approvedPlan).then(() => {
          renderQuestList();
          updateProgress();
          syncToWearOS();
        });
      });
      listEl.appendChild(row);
    });
  }

  // Update Gemini Live widget start button info
  if (voiceTrigger) {
    const activeSkillNameEl = document.getElementById("widget-active-skill-name");
    // Pick the first uncompleted skill to tutoring
    const activeSkill = skills.find(s => !s.completed) || skills[0];
    if (activeSkill) {
      voiceTrigger.classList.remove("hidden");
      if (activeSkillNameEl) activeSkillNameEl.textContent = activeSkill.name;

      // Store active skill index as data attribute on the button to start it easily
      const startBtn = document.getElementById("btn-start-widget-voice");
      if (startBtn) {
        const activeIdx = skills.indexOf(activeSkill);
        startBtn.dataset.activeIdx = activeIdx;
      }
    } else {
      if (voiceTrigger) voiceTrigger.classList.add("hidden");
    }
  }
}

async function onFetchIssue() {
  const url = document.getElementById("issue-url").value.trim();
  if (!url) return toast("Paste a GitHub issue URL first");

  const btn = document.getElementById("btn-fetch");
  btn.disabled = true;
  
  const stopLoading = showProgressiveLoading("fetch-loading", "fetch-loading-text", [
    "Connecting to GitHub...",
    "Reading issue description...",
    "Extracting context..."
  ]);

  try {
    try {
      const res = await fetch("/api/fetch-issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url })
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      issueData = await res.json();
    } catch (err) {
      console.warn("Backend fetch failed, falling back to client-side fetch:", err);
      issueData = await localFetchIssue({ url });
    }

    await stateSet(STATE_KEYS.issue, issueData);
    renderIssuePreview(issueData);
    
    // Wizard step flow
    const nextStep = document.getElementById("step-skills");
    nextStep.classList.remove("hidden");
    unlockSection("step-skills");
    nextStep.scrollIntoView({ behavior: "smooth", block: "start" });
    
    markStepDone("step1-num");
    toast("Issue loaded");

    let petText = "Skills discovered! Review the plan and approve it when you're ready! ✨";

    // Restore from localStorage history instead of SQLite DB
    const history = JSON.parse(localStorage.getItem(STORAGE_PREFIX + "history") || "[]");
    const cached = history.find(q => q.url === issueData.html_url);
    if (cached && cached.skills && cached.skills.length > 0) {
      const restoredSkills = cached.skills;
      approvedPlan = {
        skills: restoredSkills,
        approvedAt: new Date().toISOString(),
        issueUrl: issueData.html_url
      };
      draftSkills = restoredSkills;

      renderDraftSkills();
      markStepDone("step2-num");
      
      const stepQuest = document.getElementById("step-quest");
      stepQuest.classList.remove("hidden");
      unlockSection("step-quest");

      renderQuestList();
      updateProgress();
      petText = "Click 'Start Live Session' to talk to me or check off skills as you finish them! 🎙️";

      if (cached.outline) {
        solutionOutline = cached.outline;
        renderOutline(solutionOutline);
        markStepDone("step3-num");
        petText = "Check out the solution plan! Let's approve it when you are ready to implement! 📝";

        if (cached.state === "completed") {
          outlineApproved = true;
          await stateSet(STATE_KEYS.outlineApproved, true);
          markStepDone("step4-num");
          
          const stepExport = document.getElementById("step-export");
          stepExport.classList.remove("hidden");
          unlockSection("step-export");

          const stepReview = document.getElementById("step-review");
          if (stepReview) {
            stepReview.classList.remove("hidden");
            unlockSection("step-review");
          }
          
          const checklist = generatePRChecklist(
            solutionOutline,
            issueData,
            restoredSkills
          );
          renderPRChecklist(checklist);
          petText = "Nice! Copy the PR checklist and click 'Discuss Readiness' to audit your code before you submit! 🚀";
        }
      }
      
      if (cached.review) {
        await stateSet(STATE_KEYS.review, cached.review);
        const reviewData = JSON.parse(cached.review);
        renderReviewResults(reviewData);
        document.getElementById("btn-review").disabled = true;
        
        if (reviewData.overallScore >= 80) {
          petText = "Amazing work! You've mastered these skills! Let's start another quest! 🏆";
        } else {
          petText = "Not bad! Try incorporating the suggestions and click Analyze PR again! We've got this! 💪";
        }
      }
      
      toast("Restored quest memory for this issue ✓");
    }
    updatePatchBubbleText(petText);
  } catch (e) {
    toast(`Fetch failed: ${e.message}`);
  } finally {
    stopLoading();
    btn.disabled = false;
  }
}

async function onAnalyzeSkills() {
  if (!issueData) return;

  const btn = document.getElementById("btn-analyze");
  btn.disabled = true;
  
  const stopLoading = showProgressiveLoading("analyze-loading", "analyze-loading-text", [
    "Analyzing issue...",
    "Extracting core concepts...",
    "Identifying skill gaps...",
    "Building learning curriculum...",
    "Finalizing plan..."
  ]);

  try {
    const issueText = buildIssueContext(issueData);
    let skills;

    try {
      const res = await fetch("/api/analyze-skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueText })
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      const parsed = parseJsonObject(data.text);
      skills = normalizeSkills(parsed.skills || []);
      if (skills.length < 2) throw new Error("Backend returned fewer than 2 skills");
    } catch (llmErr) {
      console.warn("[PatchQuest] Backend analyze failed, using heuristics:", llmErr);
      skills = heuristicSkills(issueText, issueData);
    }

    draftSkills = skills;
    await stateSet(STATE_KEYS.plan, draftSkills);
    renderDraftSkills();
    toast("Skills extracted — review and approve");
  } catch (e) {
    toast(`Analysis failed: ${e.message}`);
  } finally {
    stopLoading();
    btn.disabled = false;
  }
}

async function onApprovePlan() {
  if (draftSkills.length < 2) return toast("Need at least 2 skills");

  const invalid = draftSkills.some(
    (s) => !s.name.trim() || !s.resourceUrl.trim()
  );
  if (invalid) return toast("Fill in all skill names and URLs");

  approvedPlan = {
    skills: draftSkills.map((s) => ({ ...s, completed: false })),
    approvedAt: new Date().toISOString(),
    issueUrl: issueData?.html_url,
  };

  await stateSet(STATE_KEYS.approved, approvedPlan);
  await stateSet(STATE_KEYS.plan, null);

  markStepDone("step2-num");
  
  // Wizard flow
  const stepQuest = document.getElementById("step-quest");
  stepQuest.classList.remove("hidden");
  unlockSection("step-quest");
  stepQuest.scrollIntoView({ behavior: "smooth", block: "start" });
  
  renderQuestList();
  updateProgress();
  toast("Quest plan approved ✓");
  updatePatchBubbleText("Click 'Start Live Session' to talk to me or check off skills as you finish them! 🎙️");
  
  await saveQuestToHistory(issueData.html_url, approvedPlan.title || issueData.title, approvedPlan.skills, "", "active", null);
  await syncToWearOS();
}

async function onQuestCheck(e) {
  const idx = parseInt(e.target.dataset.questIdx, 10);
  approvedPlan.skills[idx].completed = e.target.checked;

  await stateSet(STATE_KEYS.approved, approvedPlan);
  renderQuestList();
  updateProgress();
  
  await saveQuestToHistory(issueData.html_url, approvedPlan.title || issueData.title, approvedPlan.skills, solutionOutline, outlineApproved ? "completed" : "active", await stateGet(STATE_KEYS.review));
  await syncToWearOS();
}

async function onGenerateOutline() {
  const btn = document.getElementById("btn-outline");
  btn.disabled = true;
  
  const stopLoading = showProgressiveLoading("outline-loading", "outline-loading-text", [
    "Reviewing completed skills...",
    "Drafting solution architecture...",
    "Building step-by-step implementation...",
    "Formatting PR checklist..."
  ]);

  try {
    const issueText = buildIssueContext(issueData);
    const skillNames =
      approvedPlan.skills.map((s) => s.name).join(", ") || "general debugging";
    let outline;

    try {
      const res = await fetch("/api/generate-outline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueText, skillNames })
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
      const data = await res.json();
      outline = stripMarkdownFence(data.text);
      if (!outline.trim()) throw new Error("Empty outline");
    } catch (llmErr) {
      console.warn("[PatchQuest] Backend outline failed, using heuristic:", llmErr);
      outline = heuristicOutline(issueData, approvedPlan.skills);
    }

    solutionOutline = outline;
    await stateSet(STATE_KEYS.outline, solutionOutline);
    renderOutline(solutionOutline);
    markStepDone("step3-num");
    
    // Wizard flow
    const stepOutline = document.getElementById("step-outline");
    stepOutline.classList.remove("hidden");
    unlockSection("step-outline");
    stepOutline.scrollIntoView({ behavior: "smooth", block: "start" });
    
    toast("Solution outline ready — review and approve");
    updatePatchBubbleText("Check out the solution plan! Let's approve it when you are ready to implement! 📝");

    await saveQuestToHistory(issueData.html_url, approvedPlan.title || issueData.title, approvedPlan.skills, solutionOutline, "active", await stateGet(STATE_KEYS.review));
    await syncToWearOS();
  } catch (e) {
    toast(`Outline failed: ${e.message}`);
  } finally {
    stopLoading();
    updateProgress();
  }
}

function renderOutline(outline) {
  const outlineBox = document.getElementById("outline-box");
  const toolbar = document.getElementById("outline-toolbar");
  if (!outlineBox) return;

  if (typeof marked !== "undefined") {
    outlineBox.innerHTML = marked.parse(String(outline || ""));
    outlineBox.classList.add("markdown-body");
  } else {
    outlineBox.textContent = String(outline || "");
  }

  outlineBox.classList.add("visible");
  if (toolbar) toolbar.classList.remove("hidden");
}

function renderPRChecklist(checklist) {
  const box = document.getElementById("pr-checklist-box");
  const toolbar = document.getElementById("export-toolbar");
  if (!box) return;

  if (typeof marked !== "undefined") {
    box.innerHTML = marked.parse(String(checklist || ""));
    box.classList.add("markdown-body");
  } else {
    box.textContent = String(checklist || "");
  }

  box.classList.add("visible");
  if (toolbar) toolbar.classList.remove("hidden");
}

async function onApproveOutline() {
  outlineApproved = true;
  await stateSet(STATE_KEYS.outlineApproved, true);

  markStepDone("step4-num");

  const checklist = generatePRChecklist(
    solutionOutline,
    issueData,
    approvedPlan?.skills || []
  );
  
  // Wizard flow
  const stepExport = document.getElementById("step-export");
  stepExport.classList.remove("hidden");
  unlockSection("step-export");
  
  const stepReview = document.getElementById("step-review");
  if (stepReview) {
    stepReview.classList.remove("hidden");
    unlockSection("step-review");
  }
  
  stepExport.scrollIntoView({ behavior: "smooth", block: "start" });
  
  renderPRChecklist(checklist);
  toast("Solution approved — PR checklist ready ✓");
  updatePatchBubbleText("Nice! Copy the PR checklist and click 'Discuss Readiness' to audit your code before you submit! 🚀");

  await saveQuestToHistory(issueData.html_url, approvedPlan.title || issueData.title, approvedPlan.skills, solutionOutline, "completed", await stateGet(STATE_KEYS.review));
  await syncToWearOS();
}

async function onCopyChecklist() {
  const box = document.getElementById("pr-checklist-box");
  if (!box || !box.textContent.trim()) {
    return toast("No checklist to copy");
  }
  try {
    await navigator.clipboard.writeText(box.textContent);
    toast("PR checklist copied ✓");
  } catch {
    toast("Copy failed — select text manually");
  }
}

async function onCopyOutline() {
  const box = document.getElementById("outline-box");
  if (!box || !box.textContent.trim()) {
    return toast("No outline to copy");
  }
  try {
    await navigator.clipboard.writeText(box.textContent);
    // 🔊 ElevenLabs TTS (Read aloud success message)
    if (document.getElementById("btn-voice-toggle")?.classList.contains("active")) {
      try {
        // Fire and forget fetch to /api/elevenlabs-tts
        fetch("/api/elevenlabs-tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "I've generated your implementation plan. It's ready for you in the editor.",
            voice_id: "21m00Tcm4TlvDq8ikWAM"
          })
        }).then(res => res.blob())
          .then(blob => {
            const audio = new Audio(URL.createObjectURL(blob));
            audio.play().catch(e => console.error("TTS Auto-play prevented", e));
          }).catch(e => console.warn("TTS Error", e));
      } catch(err) {
        // Ignore
      }
    }

    toast("Outline generated! 🚀");
  } catch {
    toast("Copy failed — select text manually");
  }
}

function createLocalReviewFallback(prData, skills) {
  const skillCount = skills?.length || 0;
  const hasDescription = Boolean(prData.body?.trim());
  const score = Math.min(82, 58 + skillCount * 6 + (hasDescription ? 6 : 0));

  return {
    overallScore: score,
    verdict: "Local readiness check",
    bars: [
      { label: "PR Context", percentage: hasDescription ? 78 : 58, colorClass: hasDescription ? "wf-bg-success" : "wf-bg-warning" },
      { label: "Skill Plan", percentage: skillCount ? 76 : 45, colorClass: skillCount ? "wf-bg-success" : "wf-bg-warning" },
      { label: "Issue Coverage", percentage: 65, colorClass: "wf-bg-warning" },
      { label: "Maintainer Read.", percentage: 62, colorClass: "wf-bg-warning" },
    ],
    suggestions: [
      { title: "Gemini review is temporarily unavailable", details: "This local report uses the PR metadata and your approved learning plan. Retry later for a full AI diff review." },
      { title: "Check the acceptance criteria", details: "Before submitting, confirm the PR description explains how every issue requirement is addressed and include focused tests." },
    ],
  };
}

async function onReviewPR(e) {
  e.preventDefault();
  const url = document.getElementById("pr-url").value.trim();
  if (!url) return toast("Please enter a valid PR URL");
  
  const issue = await stateGet(STATE_KEYS.issue);
  const approvedPlan = await stateGet(STATE_KEYS.approved);
  if (!issue || !approvedPlan) return toast("Session error: Missing issue or plan data.");

  const btnReview = document.getElementById("btn-review");
  const reviewLoading = document.getElementById("review-loading");
  const reviewResults = document.getElementById("pr-review-results");
  const reviewToolbar = document.getElementById("review-toolbar");

  btnReview.disabled = true;
  reviewLoading.classList.add("visible");
  reviewResults.classList.add("hidden");
  reviewToolbar.classList.add("hidden");

  try {
    const prData = await localFetchPR(url);
    const skillsList = approvedPlan.skills.map(s => s.name).join(", ");
    
    const res = await fetch("/api/review-pr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issueText: issue.body,
        skillNames: skillsList,
        prTitle: prData.title,
        prBody: prData.body,
        prDiff: prData.diff
      })
    });
    let reviewData;
    if (res.status === 429) {
      reviewData = createLocalReviewFallback(prData, approvedPlan.skills);
      toast("Gemini is rate limited — showing a local readiness check");
    } else if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      console.warn("Gemini review failed, using local fallback:", payload.error);
      reviewData = createLocalReviewFallback(prData, approvedPlan.skills);
      toast("Gemini review unavailable — showing a local readiness check");
    } else {
      const data = await res.json();
      try {
        reviewData = parseJsonObject(data.text);
      } catch (parseErr) {
        console.warn("Failed to parse review JSON, using local fallback", parseErr);
        reviewData = createLocalReviewFallback(prData, approvedPlan.skills);
        toast("AI response was incomplete — showing a local readiness check");
      }
    }
    
    await stateSet(STATE_KEYS.review, JSON.stringify(reviewData));
    renderReviewResults(reviewData);
    
    if (reviewData.overallScore >= 80) {
      updatePatchBubbleText("Amazing work! You've mastered these skills! Let's start another quest! 🏆");
    } else {
      updatePatchBubbleText("Not bad! Try incorporating the suggestions and click Analyze PR again! We've got this! 💪");
    }

    await saveQuestToHistory(issueData.html_url, approvedPlan.title || issueData.title, approvedPlan.skills, solutionOutline, outlineApproved ? "completed" : "active", JSON.stringify(reviewData));
    await syncToWearOS();
  } catch (err) {
    toast("Review failed: " + err.message);
  } finally {
    btnReview.disabled = false;
    reviewLoading.classList.remove("visible");
  }
}

function renderReviewResults(reviewData) {
  const reviewResults = document.getElementById("pr-review-results");
  const reviewToolbar = document.getElementById("review-toolbar");
  if (!reviewResults) return;

  const scoreColor = reviewData.overallScore >= 80 ? 'var(--success)' : reviewData.overallScore >= 50 ? 'var(--warning)' : 'var(--danger)';

  const html = `
    <div class="wf-report-grid" style="margin-top: 10px;">
      <div style="display:flex; flex-direction:column; align-items:center;">
        <div class="wf-score-circle" style="border-color: ${scoreColor}; color: ${scoreColor};">
          ${reviewData.overallScore}
        </div>
        <div class="wf-report-score">
          <strong style="color: var(--text);">${reviewData.verdict}</strong>
        </div>
      </div>
      
      <div class="wf-report-bars">
        ${(reviewData.bars || []).map(b => `
          <div class="wf-bar-row">
            <span class="wf-bar-label" style="color: var(--text-muted);">${b.label}</span>
            <div class="wf-bar" style="background: var(--bg-muted);">
              <div class="wf-bar-fill ${b.colorClass || 'wf-bg-success'}" style="width: ${b.percentage}%"></div>
            </div>
            <span class="wf-bar-pct" style="color: var(--text);">${b.percentage}%</span>
          </div>
        `).join('')}
      </div>
      
      <div class="wf-report-suggestions">
        <h4 style="color: var(--text); margin: 0 0 12px 0;">Sprinkles of Polish ✨</h4>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${(reviewData.suggestions || []).map(s => {
            if (typeof s === "string") {
              return `<div style="color: var(--text-muted); font-size: 0.85rem; padding-left: 12px; border-left: 2px solid var(--border);">${s}</div>`;
            }
            return `
              <details style="background: var(--bg-muted); padding: 8px 12px; border-radius: 6px; font-size: 0.85rem; color: var(--text-muted);">
                <summary style="cursor: pointer; color: var(--text); font-weight: 500; outline: none;">${s.title}</summary>
                <div style="margin-top: 8px; line-height: 1.5;">${s.details}</div>
              </details>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;

  reviewResults.innerHTML = html;
  reviewResults.classList.remove("hidden");
  if (reviewToolbar) reviewToolbar.classList.remove("hidden");
  const btnTalkPr = document.getElementById("btn-talk-pr");
  if (btnTalkPr) {
    btnTalkPr.style.display = "flex";
  }
}

async function onReset() {
  issueData = null;
  draftSkills = [];
  approvedPlan = null;
  solutionOutline = "";
  outlineApproved = false;

  for (const key of Object.values(STATE_KEYS)) {
    await stateSet(key, null);
  }

  try {
    sessionStorage.setItem(STORAGE_PREFIX + "skip-landing", "true");
  } catch (err) {
    console.warn("sessionStorage set failed", err);
  }

  location.reload();
}

function onAddSkill() {
  draftSkills.push({
    name: "",
    resourceUrl: "",
    rationale: "",
    completed: false,
  });
  renderDraftSkills();
}

// ── WearOS Sync Helpers (Mock / Offline) ──────────────────────────────

async function syncToWearOS() {
  updateWatchWidget();
}

function startWearOSPolling() {
  // Offline widget doesn't need external polling
}

function stopWearOSPolling() {
  // Offline widget doesn't need external polling
}

// ── Settings ──────────────────────────────────────────────────────────

// ── Voice session (Gemini Live API) ───────────────────────────────────

async function onTalkThrough(skillIdx) {
  const skill = approvedPlan?.skills?.[skillIdx];
  if (!skill) return;
  
  const keyToUse = await getActiveGeminiKey();
  if (!keyToUse) {
    toast("Gemini Live is not configured on the server");
    return;
  }

  const overlay = document.getElementById("voice-overlay");
  document.getElementById("voice-skill-name").textContent = skill.name;
  document.getElementById("voice-status").textContent = "Connecting…";
  document.getElementById("voice-status").className = "voice-status";
  document.getElementById("voice-waveform").classList.remove("active");
  
  // Reset screen share button state
  const screenshareBtn = document.getElementById("btn-screenshare");
  screenshareBtn.classList.remove("sharing");
  screenshareBtn.textContent = "🖥️ Share Screen";
  
  overlay.classList.add("active");

  try {
    const { GeminiVoiceSession } = await import(`./voice.js?v=3${Date.now()}`);
    voiceSession = new GeminiVoiceSession(keyToUse, {
      skillName: skill.name,
      skillResourceUrl: skill.resourceUrl,
      issueTitle: issueData?.title || "",
    });

    voiceSession.onStatus((status) => {
      const statusEl = document.getElementById("voice-status");
      const waveform = document.getElementById("voice-waveform");
      const micBtn = document.getElementById("btn-mic");

      statusEl.textContent = status;
      statusEl.className = "voice-status";

      if (status.includes("Listening") || status.includes("listening")) {
        statusEl.classList.add("listening");
        waveform.classList.add("active");
        micBtn.classList.add("recording");
        micBtn.classList.remove("muted");
      } else if (status.includes("Speaking") || status.includes("speaking") || status.includes("AI")) {
        statusEl.classList.add("speaking");
        waveform.classList.add("active");
        micBtn.classList.remove("recording");
      } else if (status.includes("Error") || status.includes("error")) {
        statusEl.classList.add("error");
        waveform.classList.remove("active");
        micBtn.classList.remove("recording");
      } else {
        waveform.classList.remove("active");
        micBtn.classList.remove("recording");
      }
    });

    voiceSession.onScreenShareState((isSharing, stream) => {
      const btn = document.getElementById("btn-screenshare");
      const container = document.getElementById("voice-screen-container");
      const previewVideo = document.getElementById("voice-screen-preview");
      const card = document.querySelector(".voice-card");
      if (isSharing && stream) {
        btn.classList.add("sharing");
        btn.textContent = "🟢 Sharing Screen";
        container.classList.remove("hidden");
        card.classList.add("sharing-active");
        previewVideo.srcObject = stream;
      } else {
        btn.classList.remove("sharing");
        btn.textContent = "🖥️ Share Screen";
        container.classList.add("hidden");
        card.classList.remove("sharing-active");
        previewVideo.srcObject = null;
      }
    });

    voiceSession.onToolCall((skillName) => {
      if (!approvedPlan || !approvedPlan.skills) return false;

      // Find matching skill (case-insensitive substring match)
      const query = skillName.toLowerCase().trim();
      const matchIdx = approvedPlan.skills.findIndex(s => {
        const name = s.name.toLowerCase();
        return name.includes(query) || query.includes(name);
      });

      if (matchIdx !== -1) {
        const skill = approvedPlan.skills[matchIdx];
        if (!skill.completed) {
          skill.completed = true;
          stateSet(STATE_KEYS.approved, approvedPlan).then(() => {
            renderQuestList();
            updateProgress();
            syncToWearOS();
          });
          toast(`Checked off: ${skill.name} ✓`);
          return true;
        }
        return true; // Already checked off
      }
      return false;
    });

    await voiceSession.connect();
  } catch (err) {
    console.error("[PatchQuest] Voice session error:", err);
    document.getElementById("voice-status").textContent =
      `Error: ${err.message}`;
    document.getElementById("voice-status").className = "voice-status error";
  }
}

function toggleMic() {
  if (!voiceSession) return;
  voiceSession.toggleMute();
  const btn = document.getElementById("btn-mic");
  if (voiceSession.isMuted) {
    btn.classList.add("muted");
    btn.classList.remove("recording");
  } else {
    btn.classList.remove("muted");
    btn.classList.add("recording");
  }
}

async function toggleScreenShare() {
  if (!voiceSession) return;
  if (voiceSession.screenStream) {
    voiceSession.stopScreenShare();
  } else {
    await voiceSession.startScreenShare();
  }
}

async function onTalkThroughPR(reviewData) {
  const keyToUse = await getActiveGeminiKey();
  if (!keyToUse) {
    toast("Gemini Live is not configured on the server");
    return;
  }

  const overlay = document.getElementById("voice-overlay");
  document.getElementById("voice-skill-name").textContent = "PR Readiness Review";
  document.getElementById("voice-status").textContent = "Connecting…";
  document.getElementById("voice-status").className = "voice-status";
  document.getElementById("voice-waveform").classList.remove("active");
  
  // Reset screen share button state
  const screenshareBtn = document.getElementById("btn-screenshare");
  screenshareBtn.classList.remove("sharing");
  screenshareBtn.textContent = "🖥️ Share Screen";
  
  overlay.classList.add("active");

  try {
    const { GeminiVoiceSession } = await import(`./voice.js?v=3${Date.now()}`);
    
    // Custom context focusing on PR review suggestions
    const suggestionsText = (reviewData.suggestions || []).map(s => typeof s === 'string' ? s : `${s.title}: ${s.details}`).join("; ");
    voiceSession = new GeminiVoiceSession(keyToUse, {
      skillName: `PR Readiness (Score: ${reviewData.overallScore}%, Verdict: "${reviewData.verdict}")`,
      skillResourceUrl: `Suggestions to address: ${suggestionsText}`,
      issueTitle: `GitHub Pull Request Review for issue: "${issueData?.title || ''}"`,
    });

    voiceSession.onStatus((status) => {
      const statusEl = document.getElementById("voice-status");
      const waveform = document.getElementById("voice-waveform");
      const micBtn = document.getElementById("btn-mic");

      statusEl.textContent = status;
      statusEl.className = "voice-status";

      if (status.includes("Listening") || status.includes("listening")) {
        statusEl.classList.add("listening");
        waveform.classList.add("active");
        micBtn.classList.add("recording");
        micBtn.classList.remove("muted");
      } else if (status.includes("Speaking") || status.includes("speaking") || status.includes("AI")) {
        statusEl.classList.add("speaking");
        waveform.classList.add("active");
        micBtn.classList.remove("recording");
      } else if (status.includes("Error") || status.includes("error")) {
        statusEl.classList.add("error");
        waveform.classList.remove("active");
        micBtn.classList.remove("recording");
      } else {
        waveform.classList.remove("active");
        micBtn.classList.remove("recording");
      }
    });

    voiceSession.onScreenShareState((isSharing, stream) => {
      const btn = document.getElementById("btn-screenshare");
      const container = document.getElementById("voice-screen-container");
      const previewVideo = document.getElementById("voice-screen-preview");
      const card = document.querySelector(".voice-card");
      if (isSharing && stream) {
        btn.classList.add("sharing");
        btn.textContent = "🟢 Sharing Screen";
        container.classList.remove("hidden");
        card.classList.add("sharing-active");
        previewVideo.srcObject = stream;
      } else {
        btn.classList.remove("sharing");
        btn.textContent = "🖥️ Share Screen";
        container.classList.add("hidden");
        card.classList.remove("sharing-active");
        previewVideo.srcObject = null;
      }
    });

    // In a PR discussion session, tool calls are disabled / not used
    voiceSession.onToolCall(() => false);

    await voiceSession.connect();
  } catch (err) {
    console.error("[PatchQuest] PR Voice session error:", err);
    document.getElementById("voice-status").textContent =
      "Error: " + (err.message || "Failed to start audio session");
    document.getElementById("voice-status").className = "voice-status error";
  }
}

async function onTalkThroughPreReview() {
  const keyToUse = await getActiveGeminiKey();
  if (!keyToUse) {
    toast("Gemini Live is not configured on the server");
    return;
  }

  const overlay = document.getElementById("voice-overlay");
  document.getElementById("voice-skill-name").textContent = "Pre-Review Code Audit";
  document.getElementById("voice-status").textContent = "Connecting…";
  document.getElementById("voice-status").className = "voice-status";
  document.getElementById("voice-waveform").classList.remove("active");
  
  // Reset screen share button state
  const screenshareBtn = document.getElementById("btn-screenshare");
  screenshareBtn.classList.remove("sharing");
  screenshareBtn.textContent = "🖥️ Share Screen";
  
  overlay.classList.add("active");

  try {
    const { GeminiVoiceSession } = await import(`./voice.js?v=3${Date.now()}`);
    
    voiceSession = new GeminiVoiceSession(keyToUse, {
      skillName: `PR Pre-Submission Audit (Interactive Code Review)`,
      skillResourceUrl: `Discussing code implementation for issue details. Outline:\n${solutionOutline || 'No outline approved yet.'}`,
      issueTitle: `Pre-submission review for issue: "${issueData?.title || 'Unknown Issue'}"`,
    });

    voiceSession.onStatus((status) => {
      const statusEl = document.getElementById("voice-status");
      const waveform = document.getElementById("voice-waveform");
      const micBtn = document.getElementById("btn-mic");

      statusEl.textContent = status;
      statusEl.className = "voice-status";

      if (status.includes("Listening") || status.includes("listening")) {
        statusEl.classList.add("listening");
        waveform.classList.add("active");
        micBtn.classList.add("recording");
        micBtn.classList.remove("muted");
      } else if (status.includes("Speaking") || status.includes("speaking") || status.includes("AI")) {
        statusEl.classList.add("speaking");
        waveform.classList.add("active");
        micBtn.classList.remove("recording");
      } else if (status.includes("Error") || status.includes("error")) {
        statusEl.classList.add("error");
        waveform.classList.remove("active");
        micBtn.classList.remove("recording");
      } else {
        waveform.classList.remove("active");
        micBtn.classList.remove("recording");
      }
    });

    voiceSession.onScreenShareState((isSharing, stream) => {
      const btn = document.getElementById("btn-screenshare");
      const container = document.getElementById("voice-screen-container");
      const previewVideo = document.getElementById("voice-screen-preview");
      const card = document.querySelector(".voice-card");
      if (isSharing && stream) {
        btn.classList.add("sharing");
        btn.textContent = "🟢 Sharing Screen";
        container.classList.remove("hidden");
        card.classList.add("sharing-active");
        previewVideo.srcObject = stream;
      } else {
        btn.classList.remove("sharing");
        btn.textContent = "🖥️ Share Screen";
        container.classList.add("hidden");
        card.classList.remove("sharing-active");
        previewVideo.srcObject = null;
      }
    });

    // In a PR discussion session, tool calls are disabled / not used
    voiceSession.onToolCall(() => false);

    await voiceSession.connect();
  } catch (err) {
    console.error("[PatchQuest] Pre-Review Voice session error:", err);
    document.getElementById("voice-status").textContent =
      "Error: " + (err.message || "Failed to start audio session");
    document.getElementById("voice-status").className = "voice-status error";
  }
}

async function endVoiceSession() {
  if (voiceSession) {
    try {
      voiceSession.disconnect();
    } catch (err) {
      console.warn("[PatchQuest] Voice disconnect warning:", err);
    }
    voiceSession = null;
  }

  const overlay = document.getElementById("voice-overlay");
  if (overlay) {
    overlay.classList.remove("active");
  }

  const statusEl = document.getElementById("voice-status");
  if (statusEl) {
    statusEl.textContent = "Session ended";
    statusEl.className = "voice-status";
  }

  const waveform = document.getElementById("voice-waveform");
  if (waveform) {
    waveform.classList.remove("active");
  }

  const micBtn = document.getElementById("btn-mic");
  if (micBtn) {
    micBtn.classList.remove("recording", "muted");
  }

  const screenshareBtn = document.getElementById("btn-screenshare");
  if (screenshareBtn) {
    screenshareBtn.classList.remove("sharing");
    screenshareBtn.textContent = "🖥️ Share Screen";
  }

  const container = document.getElementById("voice-screen-container");
  const previewVideo = document.getElementById("voice-screen-preview");
  const card = document.querySelector(".voice-card");
  if (container) container.classList.add("hidden");
  if (card) card.classList.remove("sharing-active");
  if (previewVideo) previewVideo.srcObject = null;
}

function renderWatchQR() {
  const canvas = document.getElementById("watch-qr-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const size = canvas.width;

  // QR generation logic removed for ADB connection
  ctx.strokeStyle = "#30363d";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);

  // Draw corner markers (QR-style)
  const drawCorner = (x, y) => {
    ctx.fillStyle = "#e6edf3";
    ctx.fillRect(x, y, 28, 28);
    ctx.fillStyle = "#161b22";
    ctx.fillRect(x + 4, y + 4, 20, 20);
    ctx.fillStyle = "#e6edf3";
    ctx.fillRect(x + 8, y + 8, 12, 12);
  };

  drawCorner(10, 10);
  drawCorner(size - 38, 10);
  drawCorner(10, size - 38);

  // Center text
  ctx.fillStyle = "#2f81f7";
  ctx.font = "bold 11px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("WATCH", size / 2 + 8, size / 2 + 2);
  ctx.fillStyle = "#8b949e";
  ctx.font = "9px Inter, sans-serif";
  ctx.fillText("companion", size / 2 + 8, size / 2 + 14);

  // Decorative dots
  ctx.fillStyle = "#e6edf3";
  for (let i = 0; i < 8; i++) {
    const px = 50 + (i % 4) * 10 + Math.random() * 4;
    const py = 85 + Math.floor(i / 4) * 10 + Math.random() * 4;
    ctx.fillRect(px, py, 4, 4);
  }
}

// ── Init ──────────────────────────────────────────────────────────────

async function initApp() {
  try {
    await loadPersistedState();
  } catch (err) {
    console.error("[PatchQuest] Error loading persisted state:", err);
  }

  // Step 1
  document.getElementById("btn-fetch").addEventListener("click", onFetchIssue);
  
  const demoBtn = document.getElementById("btn-demo-issue");
  if (demoBtn) {
    demoBtn.addEventListener("click", () => {
      document.getElementById("issue-url").value = "https://github.com/Byte-Sized-Brain/task-express/issues/1";
      onFetchIssue();
    });
  }

  const demoPrBtn = document.getElementById("btn-demo-pr");
  if (demoPrBtn) {
    demoPrBtn.addEventListener("click", () => {
      const prUrlInput = document.getElementById("pr-url");
      const btnReview = document.getElementById("btn-review");
      if (prUrlInput) {
        prUrlInput.value = "https://github.com/Byte-Sized-Brain/task-express/pull/2";
      }
      if (btnReview) {
        btnReview.disabled = false;
        btnReview.click();
      }
    });
  }

  const brand = document.querySelector("#app-workspace .brand");
  if (brand) {
    brand.addEventListener("click", () => {
      const landing = document.getElementById("landing-page");
      const workspace = document.getElementById("app-workspace");
      if (landing && workspace) {
        landing.classList.remove("hidden");
        workspace.classList.add("hidden");
        document.getElementById("landing-nav")?.classList.remove("hidden");
        try {
          sessionStorage.setItem(STORAGE_PREFIX + "skip-landing", "false");
        } catch (err) {}
        window.scrollTo({ top: 0, behavior: "smooth" });
        setTimeout(() => {
          if (typeof updateScrollTransforms === "function") updateScrollTransforms();
        }, 100);
      }
    });
  }

  const prUrlInput = document.getElementById("pr-url");
  if (prUrlInput) {
    prUrlInput.addEventListener("input", () => {
      const btnReview = document.getElementById("btn-review");
      if (btnReview) {
        btnReview.disabled = false;
      }
    });
    prUrlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const btnReview = document.getElementById("btn-review");
        if (btnReview) {
          btnReview.disabled = false;
          btnReview.click();
        }
      }
    });
  }

  document.getElementById("issue-url").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onFetchIssue();
  });

  // Step 2
  document
    .getElementById("btn-analyze")
    .addEventListener("click", onAnalyzeSkills);
  document
    .getElementById("btn-approve")
    .addEventListener("click", onApprovePlan);
  document
    .getElementById("btn-add-skill")
    .addEventListener("click", onAddSkill);

  // Step 3
  document
    .getElementById("btn-outline")
    .addEventListener("click", onGenerateOutline);

  // Step 4 — second human gate
  document
    .getElementById("btn-copy-outline")
    .addEventListener("click", onCopyOutline);
  document
    .getElementById("btn-approve-outline")
    .addEventListener("click", onApproveOutline);
  document
    .getElementById("btn-reset-early")
    .addEventListener("click", onReset);

  // Step 5 — export
  document
    .getElementById("btn-copy")
    .addEventListener("click", onCopyChecklist);
  document.getElementById("btn-reset").addEventListener("click", onReset);

  // Step 6 - PR Review
  const btnReview = document.getElementById("btn-review");
  if (btnReview) btnReview.addEventListener("click", onReviewPR);
  const btnResetReview = document.getElementById("btn-reset-review");
  if (btnResetReview) btnResetReview.addEventListener("click", onReset);

  const btnTalkPreReview = document.getElementById("btn-talk-pre-review");
  if (btnTalkPreReview) {
    btnTalkPreReview.addEventListener("click", onTalkThroughPreReview);
  }

  const btnTalkPr = document.getElementById("btn-talk-pr");
  if (btnTalkPr) {
    btnTalkPr.addEventListener("click", async () => {
      const review = await stateGet(STATE_KEYS.review);
      if (review) {
        try {
          const reviewData = JSON.parse(review);
          onTalkThroughPR(reviewData);
        } catch (err) {
          console.error("Failed to parse review data for voice session", err);
        }
      }
    });
  }

  // History
  const historyDialog = document.getElementById("history-dialog");
  document.getElementById("btn-history").addEventListener("click", () => {
    historyDialog.showModal();
    const list = document.getElementById("history-list");
    
    try {
      const historyArray = JSON.parse(localStorage.getItem(STORAGE_PREFIX + "history") || "[]");

      if (historyArray && Array.isArray(historyArray) && historyArray.length > 0) {
        list.innerHTML = historyArray.map(q => {
          const d = new Date(q.updated_at).toLocaleString();
          return `
            <div class="history-item">
              <div class="history-item-header">
                <h4 class="history-item-title">${escapeHtml(q.title)}</h4>
                <span class="history-item-state ${q.state}">${q.state}</span>
              </div>
              <div class="history-item-meta">
                <span><a href="${escapeAttr(q.url)}" target="_blank">View Issue</a> &bull; ${d}</span>
                <button type="button" class="btn-resume primary" data-url="${escapeAttr(q.url)}" style="padding: 6px 16px; font-size: 0.85rem;">${q.state && q.state.toLowerCase() === 'completed' ? 'View' : 'Resume'}</button>
              </div>
            </div>
          `;
        }).join("");

        list.querySelectorAll(".btn-resume").forEach(btn => {
          btn.addEventListener("click", () => loadQuest(btn.getAttribute("data-url")));
        });
      } else {
        list.innerHTML = `<p class="muted">No past quests found.</p>`;
      }
    } catch (err) {
      list.innerHTML = `<p class="muted">Failed to load history: ${err.message}</p>`;
    }
  });
  document.getElementById("btn-close-history").addEventListener("click", () => {
    historyDialog.close();
  });


  // Voice session
  document.getElementById("btn-mic").addEventListener("click", toggleMic);
  document.getElementById("btn-screenshare").addEventListener("click", toggleScreenShare);
  document
    .getElementById("btn-end-voice")
    .addEventListener("click", endVoiceSession);
    
  const closeVoiceBtn = document.getElementById("btn-close-voice");
  if (closeVoiceBtn) {
    closeVoiceBtn.addEventListener("click", endVoiceSession);
  }

  // Widget start voice trigger
  const widgetVoiceStartBtn = document.getElementById("btn-start-widget-voice");
  if (widgetVoiceStartBtn) {
    widgetVoiceStartBtn.addEventListener("click", () => {
      const idx = parseInt(widgetVoiceStartBtn.dataset.activeIdx, 10);
      if (!isNaN(idx)) {
        onTalkThrough(idx);
      }
    });
  }

  // Landing page launch button trigger
  const launchBtn = document.getElementById("btn-launch-app");
  if (launchBtn) {
    launchBtn.addEventListener("click", launchWorkspace);
  }

  const launchBtnBottom = document.getElementById("btn-launch-app-bottom");
  if (launchBtnBottom) {
    launchBtnBottom.addEventListener("click", launchWorkspace);
  }

  const patchPet = document.getElementById("patch-pet");
  if (patchPet) {
    patchPet.addEventListener("click", () => {
      const isChatting = patchPet.classList.toggle("is-chatting");
      patchPet.setAttribute("aria-pressed", String(isChatting));
    });
  }

  function launchWorkspace() {
    const landing = document.getElementById("landing-page");
    const workspace = document.getElementById("app-workspace");
    if (landing && workspace) {
      landing.classList.add("hidden");
      workspace.classList.remove("hidden");
      document.getElementById("landing-nav")?.classList.add("hidden");
      try {
        sessionStorage.setItem(STORAGE_PREFIX + "skip-landing", "true");
      } catch (err) {}
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  window.loadQuest = async function(url) {
    try {
      document.getElementById("history-dialog").close();
      toast("Resuming quest...");
      
      const history = JSON.parse(localStorage.getItem(STORAGE_PREFIX + "history") || "[]");
      const quest = history.find(q => q.url === url);
      
      if (!quest) throw new Error("Quest not found in history");
      
      let issue;
      try {
        const res = await fetch("/api/fetch-issue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url })
        });
        if (!res.ok) {
          throw new Error(await res.text());
        }
        issue = await res.json();
      } catch (err) {
        console.warn("Backend fetch failed in loadQuest, falling back:", err);
        issue = await localFetchIssue({ url });
      }
      
      await stateSet(STATE_KEYS.issue, issue);
      
      const plan = { title: quest.title, skills: quest.skills || [] };
      await stateSet(STATE_KEYS.approved, plan);
      await stateSet(STATE_KEYS.plan, null);
      
      if (quest.outline) {
        await stateSet(STATE_KEYS.outline, quest.outline);
        await stateSet(STATE_KEYS.outlineApproved, quest.state === "completed");
        
        const outlineBox = document.getElementById("outline-box");
        if (outlineBox) {
          if (typeof marked !== "undefined") {
            outlineBox.innerHTML = marked.parse(quest.outline);
            outlineBox.classList.add("markdown-body");
          } else {
            outlineBox.textContent = quest.outline;
          }
        }
      } else {
        await stateSet(STATE_KEYS.outline, "");
        await stateSet(STATE_KEYS.outlineApproved, false);
      }
      
      if (quest.review) {
        await stateSet(STATE_KEYS.review, quest.review);
      } else {
        await stateSet(STATE_KEYS.review, null);
      }
      
      location.reload();
    } catch (err) {
      toast("Failed to load quest: " + err.message);
    }
  };

  // Render QR for watch companion
  renderWatchQR();

  // ── Floating Petals Generator (Suraksha-style) ──
  const petalsContainer = document.getElementById("floating-petals");
  if (petalsContainer) {
    const colors = [
      "rgba(115, 66, 226, 0.25)",
      "rgba(115, 66, 226, 0.15)",
      "rgba(0, 229, 89, 0.12)",
      "rgba(0, 85, 255, 0.12)",
      "rgba(255, 102, 0, 0.15)",
      "rgba(10, 10, 10, 0.04)",
    ];
    for (let i = 0; i < 12; i++) {
      const petal = document.createElement("div");
      const size = 6 + Math.random() * 10;
      const color = colors[Math.floor(Math.random() * colors.length)];
      const startX = Math.random() * 100;
      const startY = Math.random() * 100;
      const duration = 12 + Math.random() * 18;
      const delay = Math.random() * -20;

      Object.assign(petal.style, {
        position: "absolute",
        width: `${size}px`,
        height: `${size}px`,
        background: color,
        borderRadius: "62% 38% 58% 42%",
        left: `${startX}%`,
        top: `${startY}%`,
        opacity: "0",
        pointerEvents: "none",
        willChange: "transform, opacity",
        animation: `petalDrift ${duration}s ${delay}s ease-in-out infinite`,
      });
      petal.style.setProperty("--drift-x", `${-70 + Math.random() * 140}px`);
      petal.style.setProperty("--drift-y", `${-140 + Math.random() * 80}px`);
      petalsContainer.appendChild(petal);
    }
  }

  // ✦ Framer Motion-Style 3D Scroll Choreography ✦──
  let scrollRaf = 0;
  function updateScrollTransforms() {
    const landing = document.getElementById("landing-page");
    if (landing && landing.classList.contains("hidden")) {
      scrollRaf = 0;
      return;
    }

    const vh = window.innerHeight;
    const animCards = document.querySelectorAll(".pq-module-card, .lp-bottom-cta, #start h2, .pq-watch-stage, .pq-watch-text");
    
    animCards.forEach((card) => {
      const rect = card.getBoundingClientRect();
      const cardCenter = rect.top + rect.height / 2;
      const viewportCenter = vh / 2;
      const dist = (cardCenter - viewportCenter) / vh;

      if (rect.bottom > -100 && rect.top < vh + 100) {
        const progress = Math.max(0, Math.min(1, 1 - Math.abs(dist) * 1.6));
        
        // 3D spring-like transforms
        const scale = 0.88 + progress * 0.12;
        const translateY = dist * 70 * (1 - progress);
        const rotateX = dist * -12 * (1 - progress);
        
        card.style.transform = `perspective(800px) translateY(${translateY}px) scale(${scale}) rotateX(${rotateX}deg)`;
        card.style.opacity = String(0.25 + progress * 0.75);
        card.style.transition = "transform 0.15s cubic-bezier(0.25, 1, 0.5, 1), opacity 0.15s ease";
      }
    });

    scrollRaf = requestAnimationFrame(updateScrollTransforms);
  }

  // Start loop on scroll
  window.addEventListener("scroll", () => {
    if (!scrollRaf) {
      scrollRaf = requestAnimationFrame(updateScrollTransforms);
    }
  }, { passive: true });

  // Run once at load
  setTimeout(() => {
    updateScrollTransforms();
  }, 100);

  // ── Spotlight Card mouse tracker ──
  document.querySelectorAll(".spotlight-card").forEach((card) => {
    const spotlightColor = card.dataset.spotlight || "rgba(0, 85, 255, 0.15)";
    
    // Create spotlight overlay div inside the card
    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "absolute",
      inset: "-1px",
      opacity: "0",
      transition: "opacity 0.3s",
      pointerEvents: "none",
      zIndex: "0",
      borderRadius: "inherit"
    });
    card.style.position = "relative";
    card.prepend(overlay);

    card.addEventListener("mouseenter", () => { overlay.style.opacity = "1"; });
    card.addEventListener("mouseleave", () => { overlay.style.opacity = "0"; });

    card.addEventListener("mousemove", (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      overlay.style.background = `radial-gradient(600px circle at ${x}px ${y}px, ${spotlightColor}, transparent 40%)`;
    });
  });

  // ── Stacking Cards Scroll-linked Animation ──
  const stickyContainer = document.getElementById("workflow");
  const stackCards = document.querySelectorAll(".workflow-stack-card");
  
  if (stickyContainer && stackCards.length) {
    const updateStackingCards = () => {
      const rect = stickyContainer.getBoundingClientRect();
      const containerHeight = stickyContainer.offsetHeight || (window.innerHeight * 3);
      const scrolled = -rect.top;
      const scrollRange = containerHeight - window.innerHeight;
      
      let progress = 0;
      if (rect.top < 0 && scrollRange > 0) {
        progress = Math.max(0, Math.min(1, scrolled / scrollRange));
      }
      
      stackCards.forEach((card, idx) => {
        const start = idx * 0.25;
        const end = start + 0.25;
        
        // Relative progress for this card
        let cardProg = 0;
        if (idx === 0) {
          cardProg = 1; // Card 1 is fully active by default
        } else {
          if (progress > start) {
            cardProg = Math.min(1, (progress - start) / 0.25);
          }
        }
        
        // Y Position: slides from 400px down to its stacked position (idx * 20px)
        const y = 400 - (400 - (idx * 20)) * cardProg;
        
        // Opacity fades in
        const opacity = idx === 0 ? 1 : Math.min(1, cardProg * 1.5);
        
        // Scale shrinks as newer cards stack on top
        let scale = 1;
        if (progress > end) {
          const nextProg = Math.min(1, (progress - end) / 0.25);
          scale = 1 - 0.05 * nextProg - (3 - idx) * 0.01;
        }
        
        // 3D rotation tilts from 45deg down to 0deg
        const rotateX = 45 - (45 * cardProg);
        
        card.style.transform = `translateY(${y}px) scale(${scale}) rotateX(${rotateX}deg)`;
        card.style.opacity = opacity;
      });
    };

    window.addEventListener("scroll", updateStackingCards);
    updateStackingCards(); // Run once immediately to set initial state
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
