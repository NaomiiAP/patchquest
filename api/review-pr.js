// api/review-pr.js

const SYSTEM_PROMPT = "You are an expert, professional open-source maintainer and mentor. Your job is to review a Pull Request against the original issue and learning plan. Be direct, clear, and honest about any problems, missing requirements, or bugs. Clearly state what went wrong and how to fix it. However, remain constructive and encouraging—never use harsh, rude, or condescending language. You MUST output ONLY valid JSON. Do not use markdown fences.";

function getUserPrompt(issueText, skillNames, prTitle, prBody, prDiff) {
  return `Generate a Pull Request Readiness Report in JSON format.

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
${prDiff}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { issueText, skillNames, prTitle, prBody, prDiff } = req.body;
  if (!issueText || !skillNames || !prTitle || !prBody || !prDiff) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  // Determine provider
  const providerEnv = process.env.PATCHQUEST_LLM_PROVIDER || 'auto';
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  let provider = 'gemini'; // default fallback
  if (providerEnv === 'groq') {
    provider = 'groq';
  } else if (providerEnv === 'gemini') {
    provider = 'gemini';
  } else {
    // 'auto'
    if (groqKey) {
      provider = 'groq';
    } else {
      provider = 'gemini';
    }
  }

  if (provider === 'groq') {
    if (!groqKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server.' });
    }
    const model = process.env.PATCHQUEST_GROQ_MODEL || 'llama-3.3-70b-versatile';

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: getUserPrompt(issueText, skillNames, prTitle, prBody, prDiff) },
          ],
          temperature: 0.2,
          response_format: { type: 'json_object' }
        }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          return res.status(429).json({
            code: "GROQ_RATE_LIMITED",
            error: "Groq quota is temporarily exhausted. PatchQuest can still show a local readiness check.",
          });
        }
        const errText = await response.text();
        return res.status(502).json({
          code: "GROQ_REVIEW_UNAVAILABLE",
          error: `Groq API returned ${response.status}: ${errText}`,
        });
      }

      const data = await response.json();
      const resultText = data.choices[0]?.message?.content || '';
      return res.status(200).json({ text: resultText });
    } catch (err) {
      console.error("[review-pr] Groq request failed:", err.message);
      return res.status(502).json({
        code: "GROQ_REVIEW_UNAVAILABLE",
        error: "Groq could not complete the PR review right now. Please try again shortly.",
      });
    }
  } else {
    // Gemini
    if (!geminiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    }
    const model = process.env.PATCHQUEST_GEMINI_MODEL || 'gemini-2.0-flash';

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: getUserPrompt(issueText, skillNames, prTitle, prBody, prDiff) }]
            }
          ],
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }]
          },
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json"
          }
        }),
      });

      if (!response.ok) {
        if (response.status === 429) {
          return res.status(429).json({
            code: "GEMINI_RATE_LIMITED",
            error: "Gemini quota is temporarily exhausted. PatchQuest can still show a local readiness check.",
          });
        }
        return res.status(502).json({
          code: "GEMINI_REVIEW_UNAVAILABLE",
          error: "Gemini could not complete the PR review right now. Please try again shortly.",
        });
      }

      const data = await response.json();
      const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return res.status(200).json({ text: resultText });
    } catch (err) {
      console.error("[review-pr] Gemini request failed:", err.message);
      return res.status(502).json({
        code: "GEMINI_REVIEW_UNAVAILABLE",
        error: "Gemini could not complete the PR review right now. Please try again shortly.",
      });
    }
  }
}
