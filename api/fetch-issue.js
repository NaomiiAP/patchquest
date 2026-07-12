// api/fetch-issue.js

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Missing GitHub URL' });
  }

  const match = url.trim().match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/i);
  if (!match) {
    return res.status(400).json({ error: 'Invalid GitHub URL format' });
  }

  const owner = match[1];
  const repo = match[2].replace(/\.git$/, '');
  const number = parseInt(match[3], 10);

  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'PatchQuest-Node-Serverless',
  };

  const githubToken = process.env.GITHUB_TOKEN;
  if (githubToken) {
    headers['Authorization'] = `token ${githubToken}`;
  }

  try {
    const [issueRes, commentsRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}`, { headers }),
      fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`, { headers }),
    ]);

    if (!issueRes.ok) {
      throw new Error(`GitHub API returned status ${issueRes.status}`);
    }

    const issue = await issueRes.json();
    const commentsRaw = commentsRes.ok ? await commentsRes.json() : [];
    
    const comments = commentsRaw.map((c) => ({
      user: c.user?.login || 'unknown',
      body: c.body || '',
      created_at: c.created_at,
    }));

    return res.status(200).json({
      title: issue.title,
      body: issue.body || '',
      state: issue.state,
      labels: (issue.labels || []).map((l) => l.name),
      html_url: issue.html_url,
      owner,
      repo,
      number,
      comments,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
