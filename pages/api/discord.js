import { verifyKey } from 'discord-interactions';

export const config = {
  api: { bodyParser: false }, // Required to read the raw Node stream
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!signature || !timestamp) return res.status(401).end();

  // Bulletproof raw body reading for Node.js
  let rawBody = '';
  for await (const chunk of req) {
    rawBody += chunk;
  }

  let isValidRequest = false;
  try {
    isValidRequest = verifyKey(
      rawBody,
      signature,
      timestamp,
      process.env.DISCORD_PUBLIC_KEY
    );
  } catch (error) {
    return res.status(401).end('Bad signature');
  }

  if (!isValidRequest) {
    return res.status(401).end('Bad signature');
  }

  const message = JSON.parse(rawBody);

  // 1. Respond to Discord's PING
  if (message.type === 1) {
    console.log('✅ NODE RUNTIME PING SUCCESSFUL');
    // Bypass Next.js formatting to prevent chunked encoding
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ type: 1 }));
  }

  // 2. Handle the /nexus command
  if (message.type === 2 && message.data.name === 'nexus') {
    const userPrompt = message.data.options[0].value;
    console.log(`🤖 Command trigger: ${userPrompt}`);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      type: 4, 
      data: { content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(System is listening!)*` }
    }));
  }

  return res.status(400).end();
}