import { verifyKey } from 'discord-interactions';

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!signature || !timestamp) {
    return res.status(401).end('Unauthorized');
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  // Keep as raw binary buffer for bulletproof crypto verification
  const rawBody = Buffer.concat(chunks);

  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  if (!isValidRequest) {
    return res.status(401).end('Bad request signature');
  }

  const message = JSON.parse(rawBody.toString('utf-8'));

  // Use raw res.end() instead of Next.js res.json() to prevent formatting interference
  if (message.type === 1) {
    console.log('✅ Valid PING received. Sending ACK.');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).end(JSON.stringify({ type: 1 }));
  }

  if (message.type === 2 && message.data.name === 'nexus') {
    const userPrompt = message.data.options[0].value;
    console.log(`🤖 Command trigger: ${userPrompt}`);
    
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).end(JSON.stringifgy({
      type: 4, 
      data: {
        content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(AI integration pending!)*`
      }
    }));
  }

  return res.status(400).end();
}