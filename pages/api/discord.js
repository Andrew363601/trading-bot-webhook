//force again

import { verifyKey } from 'discord-interactions';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

  const publicKey = process.env.DISCORD_PUBLIC_KEY;

  let isValidRequest;
  try {
    isValidRequest = await verifyKey(rawBody, signature, timestamp, publicKey);
  } catch (e) {
    console.error("[DISCORD] verifyKey threw:", e.message);
    return res.status(401).end('Bad signature');
  }

  if (!isValidRequest) {
    return res.status(401).end('Bad signature');
  }

  const message = JSON.parse(rawBody);

  // 1. Respond to Discord's PING
  if (message.type === 1) {
    console.log('✅ NODE RUNTIME PING SUCCESSFUL');
    res.setHeader('Content-Type', 'application/json');
    res.status(200).send('{"type":1}');
    return;
  }

  // 2. Handle the /nexus command — DEFERRED RESPONSE PATTERN
  if (message.type === 2 && message.data?.name === 'nexus') {
    // 🟢 Extract the "prompt" option by name from Discord's options array
    const options = message.data.options || [];
    const promptOption = options.find(o => o.name === 'prompt') || {};
    const userPrompt = promptOption.value || "Empty command";
    console.log(`🤖 Command trigger: "${userPrompt}" | guild: ${message.guild_id} | options: ${JSON.stringify(options)}`);

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
          console.log(`[DISCORD NEXUS] Looking up guild ${guildId} in tenant_settings`);
          const { data: tenantSettings, error: settingsErr } = await supabase
            .from('tenant_settings')
            .select('tenant_id')
            .eq('discord_guild_id', guildId)
            .maybeSingle();

          if (settingsErr) {
            console.error(`[DISCORD NEXUS] Supabase error:`, settingsErr.message);
          }

          if (!settingsErr && tenantSettings?.tenant_id) {
            console.log(`[DISCORD NEXUS] Found tenant ${tenantSettings.tenant_id}, calling /api/chat`);
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
            ).catch((err) => {
              console.error(`[DISCORD NEXUS] Fetch to /api/chat failed:`, err.message);
              return null;
            });

            if (chatResponse && chatResponse.ok) {
              // 🟢 /api/chat returns text/plain raw response, not JSON
              const reply = await chatResponse.text();
              console.log(`[DISCORD NEXUS] Chat response received, length: ${reply?.length || 0}`);
              const trimmed = reply?.trim()?.substring(0, 1900) || "Nexus processed your request.";

              const patchRes = await fetch(
                `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
                {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    content: `🤖 **Nexus:** ${trimmed}`
                  })
                }
              );
              if (!patchRes.ok) {
                const patchText = await patchRes.text().catch(() => '');
                console.error(`[DISCORD NEXUS] Discord PATCH failed (${patchRes.status}): ${patchText.substring(0, 200)}`);
              } else {
                console.log(`[DISCORD NEXUS] ✅ Response patched to Discord successfully`);
              }
              return;
            } else {
              console.warn(`[DISCORD NEXUS] Chat API returned status: ${chatResponse?.status || 'no response'}`);
            }
          } else {
            console.warn(`[DISCORD NEXUS] No tenant found for guild ${guildId}`);
          }
        } else {
          console.warn(`[DISCORD NEXUS] Missing guildId or NEXT_PUBLIC_SITE_URL`);
        }
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