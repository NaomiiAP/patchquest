export default function geminiLiveKey(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "GEMINI_API_KEY is not configured" });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ apiKey });
}
