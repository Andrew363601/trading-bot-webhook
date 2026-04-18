import { verifyKey } from 'discord-interactions';

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  try {
    const isValidRequest = verifyKey(
      rawBody,
      signature,
      timestamp,
      process.env.DISCORD_PUBLIC_KEY
    );

    if (!isValidRequest) {
      return res.status(401).json({ error: 'Bad request signature' });
    }
  } catch (error) {
    return res.status(401).json({ error: 'Bad request signature' });
  }

  const message = JSON.parse(rawBody);

  // CRITICAL FIX: Force explicit JSON headers for Discord's automated validator
  res.setHeader('Content-Type', 'application/json');

  if (message.type === 1) {
    console.log('✅ Valid PING received. Sending ACK.');
    return res.status(200).json({ type: 1 });
  }

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