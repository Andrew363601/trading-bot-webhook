import { verifyKey, InteractionType, InteractionResponseType } from 'discord-interactions';

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  // Bulletproof buffer parsing for Vercel Serverless
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks).toString('utf-8');

  // 1. Verify the request (Wrapped in a try/catch to prevent 500 crashes!)
  try {
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
  } catch (error) {
    // If Discord sends missing headers and crashes the verifier, catch it and return 401!
    console.error('❌ verifyKey crashed (likely Discord fake test):', error);
    return res.status(401).json({ error: 'Bad request signature' });
  }

  const message = JSON.parse(rawBody);

  // 2. Respond to Discord's valid PING
  if (message.type === InteractionType.PING) {
    console.log('✅ Valid PING received. Sending ACK.');
    return res.status(200).send({ type: InteractionResponseType.PONG });
  }

  // 3. Handle our actual /nexus slash command
  if (message.type === InteractionType.APPLICATION_COMMAND && message.data.name === 'nexus') {
    const userPrompt = message.data.options[0].value;
    console.log(`🤖 Command trigger: ${userPrompt}`);
    
    return res.status(200).send({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, 
      data: {
        content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(AI integration pending!)*`
      }
    });
  }

  return res.status(400).json({ error: 'Unknown Type' });
}