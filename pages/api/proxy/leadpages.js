// pages/api/proxy/leadpages.js
// Proxy endpoint to bypass WAF IP block — forwards blog data to Leadpages API.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.LEADPAGES_API_KEY;
  if (!apiKey) {
    console.error('[LEADPAGES_PROXY_ERROR]: LEADPAGES_API_KEY environment variable is not set.');
    return res.status(500).json({ error: 'Server configuration error: missing API key.' });
  }

  try {
    const payload = req.body;

    const leadpagesResponse = await fetch('https://api.htmlpub.com/api/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const body = await leadpagesResponse.json();

    return res.status(leadpagesResponse.status).json(body);
  } catch (error) {
    console.error('[LEADPAGES_PROXY_ERROR]:', error.message);
    return res.status(502).json({
      error: 'Failed to reach Leadpages API.',
      details: error.message,
    });
  }
}