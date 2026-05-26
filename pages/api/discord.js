//force again

import { verifyKey } from 'discord-interactions';

// 🟢 Lazily initialize Supabase — avoids cold-start penalty for PINGs
let _supabase = null;
async function getSupabase() {
  if (!_supabase) {
    const { createClient } = await import('@supabase/supabase-js');
    _supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
  }
  return _supabase;
}

export const config = {
  api: { bodyParser: false }, // Required to read the raw Node stream
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!signature || !timestamp) return res.status(401).end('Missing headers');

  // 🛡️ Flawless raw body stream reader for Next.js Pages router
  const rawBody = await new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
  });

  let isValidRequest;
  try {
    isValidRequest = verifyKey(
      rawBody,
      signature,
      timestamp,
      process.env.DISCORD_PUBLIC_KEY
    );
  } catch (e) {
    console.error("[DISCORD] verifyKey threw:", e.message);
    return res.status(401).end('Bad signature');
  }

  if (!isValidRequest) {
    return res.status(401).end('Bad signature');
  }

  const message = JSON.parse(rawBody);

  // 1. Respond to Discord's PING — ULTRA-FAST PATH, no Supabase needed
  if (message.type === 1) {
    console.log('✅ NODE RUNTIME PING SUCCESSFUL');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send('{"type":1}');
    return;
  }

  // 2. Handle the /nexus command — DEFERRED RESPONSE PATTERN
  if (message.type === 2 && message.data?.name === 'nexus') {
    const userPrompt = message.data.options?.[0]?.value || "Empty command";
    console.log(`🤖 Command trigger: ${userPrompt}`);

    const guildId = message.guild_id;
    const userId = message.member?.user?.id || message.user?.id;
    const interactionToken = message.token;
    const applicationId = message.application_id;

    // 🟢 Immediately acknowledge with DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (type: 5)
    // This tells Discord "I'll get back to you" — avoids the 3-second timeout
    res.status(200).json({ type: 5 });

    // 🟢 Then do the heavy work asynchronously and PATCH the deferred message
    (async () => {
      try {
        if (guildId && process.env.NEXT_PUBLIC_SITE_URL) {
          const { data: tenantSettings, error: settingsErr } = await getSupabase()
            .from('tenant_settings')
            .select('tenant_id')
            .eq('discord_guild_id', guildId)
            .maybeSingle();

          if (!settingsErr && tenantSettings?.tenant_id) {
            const chatResponse = await fetch(
              `${process.env.NEXT_PUBLIC_SITE_URL}/api/chat`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  messages: [{ role: 'user', content: userPrompt }],
                  tenant_id: tenantSettings.tenant_id,
                  source: 'discord'
                })
              }
            ).catch(() => null);

            if (chatResponse && chatResponse.ok) {
              const chatData = await chatResponse.json();
              const reply = chatData?.choices?.[0]?.message?.content ||
                           chatData?.message?.content ||
                           "Nexus processed your request.";

              await fetch(
                `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    content: `🤖 **Nexus:** ${reply.substring(0, 1900)}`
                  })
                }
              );
              return;
            }
          }
        }

        // Fallback: patch with a simple echo
        await fetch(
          `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(System is listening!)*`
            })
          }
        );
      } catch (err) {
        console.error("[DISCORD NEXUS] Async handler failed:", err.message);
        try {
          await fetch(
            `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                content: `❌ **Nexus Error:** The agent encountered an issue processing your request.`
              })
            }
          );
        } catch (_) {}
      }
    })();

    return; // Response already sent via res.json({ type: 5 }) above
  }

  return res.status(400).end();
}