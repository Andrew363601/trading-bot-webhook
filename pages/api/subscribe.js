/**
 * /api/subscribe — Brevo subscriber proxy for Wix popup
 *
 * Receives email + optional params from the lead magnet popup form,
 * calls Brevo API to create/update the contact with list membership.
 *
 * POST /api/subscribe
 * Body: { email, listIds, LMTITLE, LMURL }
 */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, listIds, LMTITLE, LMURL } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('BREVO_API_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const contactBody = {
    email,
    updateEnabled: true,
    attributes: {},
  };

  if (listIds && Array.isArray(listIds) && listIds.length > 0) {
    contactBody.listIds = listIds;
  }

  if (LMTITLE) contactBody.attributes.LMTITLE = LMTITLE;
  if (LMURL) contactBody.attributes.LMURL = LMURL;

  try {
    const response = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(contactBody),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Brevo API error:', data);
      if (listIds && listIds.length > 0) {
        for (const listId of listIds) {
          try {
            await fetch(`https://api.brevo.com/v3/contacts/lists/${listId}/contacts/${encodeURIComponent(email)}`,
              {
                method: 'POST',
                headers: {
                  'api-key': apiKey,
                  'Content-Type': 'application/json',
                },
              }
            );
          } catch (e) {
            console.error(`Failed to add to list ${listId}:`, e);
          }
        }
      }
      return res.status(200).json({ success: true, message: 'Contact updated' });
    }

    return res.status(201).json({ success: true, id: data.id });
  } catch (error) {
    console.error('Subscribe error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}