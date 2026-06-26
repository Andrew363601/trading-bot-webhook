// pages/api/wix-content.js
// Proxies data from Wix CMS collection to demo-index.
// Keeps the Wix API key server-side so it never leaks to the client.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  try {
    const wixApiKey = process.env.WIX_API_KEY;
    if (!wixApiKey) {
      return res.status(200).json({ configured: false, content: null });
    }

    const response = await fetch('https://www.wixapis.com/wix-data/v2/items/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': wixApiKey
      },
      body: JSON.stringify({
        dataCollectionId: 'NewCollection1',
        query: {}
      })
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      console.error('[WIX CONTENT] Wix API error:', response.status, errBody);
      throw new Error(`Wix API ${response.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await response.json();
    
    const contentMap = {};
    if (data.dataItems) {
      for (const item of data.dataItems) {
        const sectionKey = item.data?.sectionKey;
        if (sectionKey && item.data?.content) {
          try {
            contentMap[sectionKey] = JSON.parse(item.data.content);
          } catch {
            contentMap[sectionKey] = item.data.content;
          }
        }
      }
    }

    return res.status(200).json({ configured: true, content: contentMap });
  } catch (e) {
    console.error('[WIX CONTENT] Fetch failed:', e.message);
    return res.status(200).json({ configured: false, content: null, error: e.message });
  }
}
