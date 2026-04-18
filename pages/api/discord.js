import { verifyKey } from 'discord-interactions';

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  // Add a console log so we can watch it hit the logic block in Vercel
  console.log('--- INCOMING DISCORD REQUEST ---');
  
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  // Bulletproof raw body reader for Next.js Serverless
  let rawBody = '';
  for await (const chunk of req) {
    rawBody += chunk;
  }

  // 1. Verify the request is actually from Discord
  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  // If Discord sends a fake signature test, we MUST return 401
  if (!isValidRequest) {
    console.log('❌ Invalid signature detected. Bouncing request.');
    return res.status(401).json({ error: 'Bad request signature' });
  }

  const message = JSON.parse(rawBody);

  // 2. Respond to Discord's valid PING
  if (message.type === 1) {
    console.log('✅ Valid PING received. Sending ACK.');
    return res.status(200).json({ type: 1 });
  }

  // 3. Handle our actual /nexus slash command
  if (message.type === 2 && message.data.name === 'nexus') {
    const userPrompt = message.data.options[0].value;
    console.log(`🤖 Command trigger: ${userPrompt}`);
    
    return res.status(200).json({
      type: 4, 
      data: {
        content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(AI integration pending!)*`
      }
    });
  }

  return res.status(400).json({ error: 'Unknown Type' });
}