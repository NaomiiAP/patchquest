// api/generate-outline.js

const SYSTEM_PROMPT = "You are a staff engineer writing a fix plan. Given a GitHub issue and the learner's approved skill checklist (all marked complete), produce a detailed, highly structured solution outline in markdown. Be specific to the repo/issue. No filler.";

function getUserPrompt(issueText, skillNames) {
  return `Create a beautiful, professional markdown solution outline for fixing this GitHub issue.\nThe contributor has completed these skills: ${skillNames}\n\nInclude sections:\n## Summary\n## Files to Touch (use markdown bullet points)\n## Pseudocode / Approach\n## Learning Resources\n## PR Checklist (use - [ ] markdown checkboxes for the exact steps to implement the fix)\n\nIMPORTANT: For the 'Pseudocode / Approach' section, use standard MULTILINE markdown code blocks with language tags (e.g., \`\`\`javascript\\n...\\n\`\`\`). Do NOT put entire code blocks on a single line with backticks.\n\nReturn markdown only (no wrapping code fences).\n\nIssue:\n${issueText}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { issueText, skillNames } = req.body;
  if (!issueText || !skillNames) {
    return res.status(400).json({ error: 'Missing issueText or skillNames' });
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
            { role: 'user', content: getUserPrompt(issueText, skillNames) },
          ],
          temperature: 0.2,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Groq API returned ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const resultText = data.choices[0]?.message?.content || '';
      return res.status(200).json({ text: resultText });
    } catch (err) {
      return res.status(500).json({ error: err.message });
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
              parts: [{ text: getUserPrompt(issueText, skillNames) }]
            }
          ],
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }]
          },
          generationConfig: {
            temperature: 0.2
          }
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Gemini API returned ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return res.status(200).json({ text: resultText });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
}
