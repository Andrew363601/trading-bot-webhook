import { verifyKey } from 'discord-interactions';

export const config = {
  api: { bodyParser: false }, // Required to read the raw Node stream
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!signature || !timestamp) return res.status(401).end('Missing headers');

  // 🛡️ Safely parse the raw body into a Buffer first to preserve exact bytes for the crypto signature
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
    // 🚨 THE FIX: Use native Next.js JSON handling. Vercel requires this to set the Content-Length header correctly!
    return res.status(200).json({ type: 1 });
  }

  // 2. Handle the /nexus command
  if (message.type === 2 && message.data?.name === 'nexus') {
    const userPrompt = message.data.options?.[0]?.value || "Empty command";
    console.log(`🤖 Command trigger: ${userPrompt}`);
    
    // 🚨 THE FIX: Native Next.js response handling
    return res.status(200).json({
      type: 4, 
      data: { content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(System is listening!)*` }
    });
  }

  return res.status(400).end();
}