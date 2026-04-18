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

  const rawBody = await req.text();
  let isValidRequest = false;

  // Catch the malformed fake ping that Discord sends!
  try {
    isValidRequest = verifyKey(
      rawBody,
      signature,
      timestamp,
      process.env.DISCORD_PUBLIC_KEY
    );
  } catch (error) {
    console.log('⚠️ Fake ping caught by try/catch! Bouncing with 401.');
    return new Response('Bad request signature', { status: 401 });
  }

  if (!isValidRequest) {
    console.log('❌ Signature rejected cleanly');
    return new Response('Bad request signature', { status: 401 });
  }

  const message = JSON.parse(rawBody);

  if (message.type === 1) {
    console.log('✅ EDGE RUNTIME PING SUCCESSFUL');
    return new Response(JSON.stringify({ type: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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