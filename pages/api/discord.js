import { verifyKey } from 'discord-interactions';

export const config = {
  api: { bodyParser: false }, // Required to read the raw Node stream
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!signature || !timestamp) return res.status(401).end('Missing headers');

  // 🛡️ Safely parse the raw body
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  let isValidRequest = false;
  try {
    isValidRequest = verifyKey(
      rawBody,
      signature,
      timestamp,
      process.env.DISCORD_PUBLIC_KEY
    );
  } catch (error) {
    return res.status(401).end('Bad signature auth');
  }

  if (!isValidRequest) {
    return res.status(401).end('Bad signature');
  }

  const message = JSON.parse(rawBody);

  // 1. Respond to Discord's PING
  if (message.type === 1) {
    console.log('✅ NODE RUNTIME PING SUCCESSFUL');
    
    // 🚨 THE ULTIMATE FIX: Discord rejects chunked encoding. 
    // We explicitly calculate the exact byte length and force the Content-Length header.
    const pingPayload = JSON.stringify({ type: 1 });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', Buffer.byteLength(pingPayload));
    
    return res.status(200).send(pingPayload);
  }

  // 2. Handle the /nexus command
  if (message.type === 2 && message.data?.name === 'nexus') {
    const userPrompt = message.data.options?.[0]?.value || "Empty command";
    console.log(`🤖 Command trigger: ${userPrompt}`);
    
    const commandPayload = JSON.stringify({
      type: 4, 
      data: { content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(System is listening!)*` }
    });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', Buffer.byteLength(commandPayload));
    
    return res.status(200).send(commandPayload);
  }

  return res.status(400).end();
}