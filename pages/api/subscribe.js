const GA4_MEASUREMENT_ID = 'G-7REMMP1S7R';

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

  const { email, listIds, LMTITLE, LMURL, type, asset, strategy_name, source } = req.body;
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

  // 🧪 Trial signup from chat widget — inject trial list ID + attributes server-side
  if (type === 'trial') {
    const trialListId = parseInt(process.env.BREVO_TRIAL_LIST_ID);
    if (trialListId) {
      contactBody.listIds = [trialListId];
    }
    contactBody.attributes.TRIAL_TIER = strategy_name || 'UNKNOWN';
    contactBody.attributes.SIGNUP_SOURCE = 'chat_widget';
  } else if (type === 'blog_trial') {
    // 📝 Blog popup trial signup — add to trial list with source tracking
    const trialListId = parseInt(process.env.BREVO_TRIAL_LIST_ID);
    if (trialListId) {
      contactBody.listIds = [trialListId];
    }
    contactBody.attributes.SIGNUP_SOURCE = 'blog_popup';
    contactBody.attributes.TRIAL_TIER = 'BLOG';
  } else if (listIds && Array.isArray(listIds) && listIds.length > 0) {
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

    if (process.env.GA4_MEASUREMENT_PROTOCOL_SECRET) {
      try {
        const isTrial = type === 'trial' || type === 'blog_trial';
        const gaEvent = isTrial
          ? { name: 'trial_signup', params: { method: type === 'blog_trial' ? 'blog_popup' : 'chat_widget' } }
          : { name: 'newsletter_signup', params: { method: 'email' } };
        await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${encodeURIComponent(process.env.GA4_MEASUREMENT_PROTOCOL_SECRET)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: email,
            events: [gaEvent]
          })
        });
      } catch (gaError) {
        console.error('GA4 signup event error:', gaError);
      }
    }

    return res.status(201).json({ success: true, id: data.id });
  } catch (error) {
    console.error('Subscribe error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}