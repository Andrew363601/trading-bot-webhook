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

  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  if (!isValidRequest) {
    return res.status(401).end('Bad signature');
  }

  const message = JSON.parse(rawBody);

  // 1. Respond to Discord's PING
  if (message.type === 1) {
    console.log('✅ NODE RUNTIME PING SUCCESSFUL');
    // Native Next.js JSON handler (Automatically sets Content-Length and Headers perfectly)
    return res.status(200).json({ type: 1 });
  }

  // 2. Handle the /nexus command
  if (message.type === 2 && message.data?.name === 'nexus') {
    const userPrompt = message.data.options?.[0]?.value || "Empty command";
    console.log(`🤖 Command trigger: ${userPrompt}`);
    
    // Try to route to Nexus chat API
    try {
      // Attempt to forward to the internal chat handler
      const guildId = message.guild_id;
      const userId = message.member?.user?.id || message.user?.id;

      if (guildId && process.env.NEXT_PUBLIC_SITE_URL) {
        // Map Discord guild to tenant via tenant_settings stored nexus_discord_guild_id
        const { data: tenantSettings, error: settingsErr } = await supabase
          .from('tenant_settings')
          .select('tenant_id')
          .eq('discord_guild_id', guildId)
          .maybeSingle();

        if (!settingsErr && tenantSettings?.tenant_id) {
          // Forward to Nexus chat API with tenant context
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
            return res.status(200).json({
              type: 4,
              data: { content: `🤖 **Nexus:** ${reply.substring(0, 1900)}` }
            });
          }
        }
      }
    } catch (forwardErr) {
      console.error("[DISCORD NEXUS] Forward to chat failed:", forwardErr.message);
    }

    // Fallback: basic echo response
    return res.status(200).json({
      type: 4, 
      data: { content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(System is listening!)*` }
    });
  }

  return res.status(400).end();
}