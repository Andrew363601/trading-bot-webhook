// pages/api/discord-link.js
// Push I — Phase 3: Discord auto-join + Challenger role + discord_links row.
// POST { providerToken } — the client's session.provider_token (Discord sign-ins only).
// Flow: verify token → join guild 1495091186598285404 → apply Challenger role →
// upsert discord_links → flip challenge_entries.discord_linked=true.

import { withTenantAuth } from '../../lib/auth-middleware';

const DISCORD_API = 'https://discord.com/api/v10';
const GUILD_ID = '1495091186598285404';
const CHALLENGER_ROLE_ID = '1546611522342752298';

export default withTenantAuth(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = req.tenant.supabase;
  const tenantId = req.tenant.tenantId;
  const providerToken = req.body?.providerToken;

  if (!providerToken) {
    return res.status(400).json({ error: 'Missing providerToken — sign in with Discord first.' });
  }

  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    console.error('[DISCORD_LINK] DISCORD_BOT_TOKEN not configured');
    return res.status(500).json({ error: 'Discord bot not configured' });
  }

  try {
    // 1. Verify the provider token and get the Discord identity.
    const meRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${providerToken}` }
    });
    if (!meRes.ok) {
      return res.status(400).json({ error: 'Discord session expired — sign in with Discord again.' });
    }
    const me = await meRes.json();
    const discordUserId = me.id;
    const discordUsername = me.username || null;

    // 2. Join the guild + apply Challenger role in one call.
    let joined = false;
    const putRes = await fetch(`${DISCORD_API}/guilds/${GUILD_ID}/members/${discordUserId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        access_token: providerToken,
        roles: [CHALLENGER_ROLE_ID]
      })
    });

    if (putRes.status === 204 || putRes.status === 201) {
      joined = true;
    } else if (putRes.status === 409) {
      // Already a member — ensure the Challenger role is applied.
      joined = true;
      const patchRes = await fetch(
        `${DISCORD_API}/guilds/${GUILD_ID}/members/${discordUserId}/roles/${CHALLENGER_ROLE_ID}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bot ${botToken}` }
        }
      );
      if (!patchRes.ok && patchRes.status !== 204) {
        console.warn('[DISCORD_LINK] Role add failed:', patchRes.status);
      }
    } else {
      const body = await putRes.text().catch(() => '');
      console.error('[DISCORD_LINK] Guild join failed:', putRes.status, body);
      return res.status(502).json({ error: 'Could not join the Discord server. Try again later.' });
    }

    // 3. Upsert discord_links + flip challenge_entries.discord_linked.
    const { error: upsertErr } = await supabase
      .from('discord_links')
      .upsert(
        {
          tenant_id: tenantId,
          discord_user_id: discordUserId,
          discord_username: discordUsername
        },
        { onConflict: 'tenant_id' }
      );

    if (upsertErr) {
      console.error('[DISCORD_LINK] Upsert error:', upsertErr);
      return res.status(500).json({ error: 'Failed to save Discord link' });
    }

    await supabase
      .from('challenge_entries')
      .update({ discord_linked: true })
      .eq('tenant_id', tenantId);

    // 4. Done. Never log or return the bot token.
    return res.status(200).json({
      ok: true,
      discord_username: discordUsername,
      joined
    });
  } catch (err) {
    console.error('[DISCORD_LINK] Unexpected error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
