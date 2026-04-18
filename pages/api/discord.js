import { verifyKey } from 'discord-interactions';

// Next.js normally parses the body automatically, but Discord requires the RAW body to verify the security signature. This config turns off the auto-parser.
export const config = {
  api: { bodyParser: false },
};

// Helper function to grab the raw body
async function getRawBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => { resolve(data); });
  });
}

export default async function handler(req, res) {
  // We only accept POST requests from Discord
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];
  const rawBody = await getRawBody(req);

  // 1. Verify the request is actually from Discord
  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  if (!isValidRequest) {
    return res.status(401).send('Bad request signature');
  }

  const message = JSON.parse(rawBody);

  // 2. Discord requires all bots to respond to a "PING" when first connecting
  if (message.type === 1) {
    return res.status(200).json({ type: 1 });
  }

  // 3. Handle our actual /nexus slash command
  if (message.type === 2 && message.data.name === 'nexus') {
    const userPrompt = message.data.options[0].value;

    // For right now, let's just bounce the message back to prove the pipeline works. 
    // We will plug your AI logic in here next!
    return res.status(200).json({
      type: 4, // Type 4 tells Discord to reply in the channel immediately
      data: {
        content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(AI integration pending!)*`
      }
    });
  }

  return res.status(400).send('Unknown command');
}