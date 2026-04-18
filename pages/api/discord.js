import { verifyKey } from 'discord-interactions';

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

  // Edge native text reading
  const rawBody = await req.text();

  const isValidRequest = verifyKey(
    rawBody,
    signature,
    timestamp,
    process.env.DISCORD_PUBLIC_KEY
  );

  if (!isValidRequest) {
    console.log('❌ Signature rejected');
    return new Response('Bad request signature', { status: 401 });
  }

  const message = JSON.parse(rawBody);

  // 1. Respond to Discord's PING
  if (message.type === 1) {
    console.log('✅ EDGE RUNTIME PING SUCCESSFUL');
    return new Response(JSON.stringify({ type: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Handle the /nexus command
  if (message.type === 2 && message.data.name === 'nexus') {
    const userPrompt = message.data.options[0].value;
    console.log(`🤖 Command trigger: ${userPrompt}`);
    
    return new Response(
      JSON.stringify({
        type: 4, 
        data: {
          content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(System is listening!)*`
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