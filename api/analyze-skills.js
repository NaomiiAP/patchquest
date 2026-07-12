// api/analyze-skills.js

const SYSTEM_PROMPT = "You are a senior engineer mentor. Given a GitHub issue (title, body, comments), identify 3-5 concrete technical skills a contributor must learn to fix it. Return ONLY valid JSON, no markdown fences.";

function getUserPrompt(issueText) {
  return `Analyze this GitHub issue and identify 3-5 concrete skills a contributor would need. Stick ONLY to official documentation links or well-known predictable URLs. DO NOT invent YouTube links or Medium blog URLs because they are often hallucinated and return 404. It is perfectly fine to only give Docs.\n\nReturn ONLY JSON in this shape:\n{"skills": [{"name": "...", "resourceUrl": "https://...", "rationale": "one sentence", "estimatedTime": "15m", "difficulty": "Beginner|Intermediate|Advanced", "resourceType": "Docs|Article"}]}\n\nIssue:\n${issueText}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { issueText } = req.body;
  if (!issueText) {
    return res.status(400).json({ error: 'Missing issueText' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not configured on the server.' });
  }

  const model = process.env.PATCHQUEST_GROQ_MODEL || 'llama-3.3-70b-versatile';

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: getUserPrompt(issueText) },
        ],
        temperature: 0.2,
        response_format: { type: 'json_object' }
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API returned ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const resultText = data.choices[0]?.message?.content || '';

    // Directly return the parsed JSON from Groq
    return res.status(200).json({ text: resultText });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
