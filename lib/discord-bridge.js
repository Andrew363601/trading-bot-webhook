// lib/discord-bridge.js
// Discord.js gateway client — listens to #nexus-and-hermes-chat for text triggers,
// forwards them to Vercel /api/chat, and replies in-channel.

import { Client, GatewayIntentBits, Events } from 'discord.js';
import crypto from 'crypto';

const ALLOWED_BOT_IDS = ['1508921445219307762']; // Nexus Hermes Agent bot ID
const COOLDOWN_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const FINGERPRINT_TTL_MS = 60_000;

const NEXUS_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;
const CHANNEL_ID = process.env.DISCORD_BRIDGE_CHANNEL_ID;
const TENANT_ID = process.env.DISCORD_BRIDGE_TENANT_ID;
const BOT_TOKEN = process.env.DISCORD_BRIDGE_TOKEN;

class DiscordBridge {
  constructor() {
    this.client = null;
    this.ready = false;
    this.lastMessageTimestamps = new Map(); // botId → timestamp
    this.messageFingerprints = new Set();
    this.rateCounter = []; // timestamps of actions in current window
  }

  /**
   * Boot the Discord.js client and attach listeners.
   */
  async start() {
    if (!BOT_TOKEN) {
      console.warn('[DISCORD BRIDGE] DISCORD_BRIDGE_TOKEN not set — bridge disabled.');
      return false;
    }
    if (!CHANNEL_ID) {
      console.warn('[DISCORD BRIDGE] DISCORD_BRIDGE_CHANNEL_ID not set — bridge disabled.');
      return false;
    }
    if (!NEXUS_SITE_URL) {
      console.warn('[DISCORD BRIDGE] NEXT_PUBLIC_SITE_URL not set — bridge disabled.');
      return false;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.once(Events.ClientReady, () => {
      this.ready = true;
      console.log(`[DISCORD BRIDGE] ✅ Logged in as ${this.client.user.tag} | Channel: ${CHANNEL_ID}`);
    });

    this.client.on(Events.MessageCreate, async (message) => {
      await this._onMessage(message);
    });

    this.client.on(Events.Error, (err) => {
      console.error('[DISCORD BRIDGE] Client error:', err.message);
    });

    this.client.on(Events.Warn, (warn) => {
      console.warn('[DISCORD BRIDGE] Client warning:', warn);
    });

    try {
      await this.client.login(BOT_TOKEN);
      return true;
    } catch (err) {
      console.error('[DISCORD BRIDGE] Login failed:', err.message);
      return false;
    }
  }

  /**
   * Gracefully disconnect.
   */
  async stop() {
    if (this.client) {
      this.client.destroy();
      this.ready = false;
      console.log('[DISCORD BRIDGE] Disconnected.');
    }
  }

  /**
   * Send a message to the configured channel.
   */
  async sendToChannel(content) {
    if (!this.ready || !this.client) {
      console.warn('[DISCORD BRIDGE] Cannot send — client not ready.');
      return false;
    }
    try {
      const channel = await this.client.channels.fetch(CHANNEL_ID);
      if (!channel) {
        console.error('[DISCORD BRIDGE] Channel not found:', CHANNEL_ID);
        return false;
      }
      await channel.send(content);
      return true;
    } catch (err) {
      console.error('[DISCORD BRIDGE] sendToChannel failed:', err.message);
      return false;
    }
  }

  /**
   * POST a user message to the Vercel /api/chat endpoint and return the reply text.
   */
  async _callChatAPI(messageContent) {
    if (!NEXUS_SITE_URL) return null;
    try {
      const resp = await fetch(`${NEXUS_SITE_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: messageContent }],
          tenant_id: TENANT_ID,
          source: 'discord_text',
        }),
      });
      if (!resp.ok) {
        console.error(`[DISCORD BRIDGE] Chat API returned ${resp.status}`);
        return null;
      }
      return await resp.text();
    } catch (err) {
      console.error('[DISCORD BRIDGE] chat API call failed:', err.message);
      return null;
    }
  }

  /**
   * Guard: is this a bot message we should skip?
   */
  _isBlockedBot(message) {
    if (!message.author.bot) return false; // Human — allow
    return !ALLOWED_BOT_IDS.includes(message.author.id); // Block unknown bots
  }

  /**
   * Guard: check cooldown between bots to prevent loops.
   */
  _checkCooldown(authorId) {
    const now = Date.now();
    const last = this.lastMessageTimestamps.get(authorId) || 0;
    if (now - last < COOLDOWN_MS) return false; // Too soon
    this.lastMessageTimestamps.set(authorId, now);
    return true;
  }

  /**
   * Guard: rate-limit total bridge actions per window.
   */
  _checkRateLimit() {
    const now = Date.now();
    // Prune expired entries
    this.rateCounter = this.rateCounter.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (this.rateCounter.length >= RATE_LIMIT_MAX) return false;
    this.rateCounter.push(now);
    return true;
  }

  /**
   * Guard: fingerprint to prevent repeat identical bot messages.
   */
  _checkFingerprint(content) {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (this.messageFingerprints.has(hash)) return false;
    this.messageFingerprints.add(hash);
    // Auto-expire after TTL
    setTimeout(() => this.messageFingerprints.delete(hash), FINGERPRINT_TTL_MS);
    return true;
  }

  /**
   * Handle an incoming message.
   */
  async _onMessage(message) {
    // 1. Channel filter
    if (message.channelId !== CHANNEL_ID) return;

    // 2. Bot filter
    if (this._isBlockedBot(message)) {
      console.log(`[DISCORD BRIDGE] Skipping blocked bot: ${message.author.id}`);
      return;
    }

    // 3. Skip own messages
    if (this.client && message.author.id === this.client.user.id) return;

    // 4. Cooldown guard
    if (!this._checkCooldown(message.author.id)) {
      console.log(`[DISCORD BRIDGE] Cooldown active for ${message.author.id}, skipping.`);
      return;
    }

    // 5. Rate-limit guard
    if (!this._checkRateLimit()) {
      console.warn('[DISCORD BRIDGE] Rate limit reached, dropping message.');
      return;
    }

    const content = message.content?.trim();
    if (!content || content.length === 0) return;

    console.log(`[DISCORD BRIDGE] Processing: "${content.substring(0, 80)}..." from ${message.author.id}`);

    // 6. Call the chat API
    const reply = await this._callChatAPI(content);
    if (!reply) {
      await message.reply('❌ **Nexus Error:** The agent could not process your request right now.').catch(() => {});
      return;
    }

    const trimmed = reply.trim().substring(0, 1900);

    // 7. Fingerprint guard
    if (!this._checkFingerprint(trimmed)) {
      console.warn('[DISCORD BRIDGE] Duplicate response blocked by fingerprint.');
      return;
    }

    // 8. Reply in-channel
    await message.reply(`🤖 **Nexus:** ${trimmed}`).catch((err) => {
      console.error('[DISCORD BRIDGE] Reply failed:', err.message);
    });
  }
}

// Singleton export
const bridge = new DiscordBridge();
export default bridge;
export { DiscordBridge };