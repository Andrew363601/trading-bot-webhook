import { verifyKey } from 'discord-interactions';

// This single line migrates the route from Node.js to Vercel's instant CDN
export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const signature = req.headers.get('x-signature-ed25519');
  const timestamp = req.headers.get('x-signature-timestamp');

  if (!signature || !timestamp) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Edge native text reading - instant and extremely clean
  const rawBody = await req.text();

  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  if (!isValidRequest) {
    return new Response('Bad request signature', { status: 401 });
  }

  const message = JSON.parse(rawBody);

  // Respond to the PING instantly
  if (message.type === 1) {
    console.log('✅ Valid PING received on Edge. Sending ACK.');
    return new Response(JSON.stringify({ type: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Handle the /nexus command
  if (message.type === 2 && message.data.name === 'nexus') {
    const userPrompt = message.data.options[0].value;
    console.log(`🤖 Command trigger: ${userPrompt}`);
    
    return new Response(
      JSON.stringify({
        type: 4, 
        data: {
          content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(AI integration pending!)*`
        }
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return new Response('Unknown Type', { status: 400 });
}