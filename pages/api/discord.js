import { verifyKey } from 'discord-interactions';
import { NextResponse } from 'next/server';

export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new NextResponse('Method Not Allowed', { status: 405 });
  }

  const signature = req.headers.get('x-signature-ed25519');
  const timestamp = req.headers.get('x-signature-timestamp');

  if (!signature || !timestamp) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const rawBody = await req.text();
  let isValidRequest = false;

  try {
    isValidRequest = verifyKey(
      rawBody,
      signature,
      timestamp,
      process.env.DISCORD_PUBLIC_KEY
    );
  } catch (error) {
    console.error('⚠️ Fake ping caught by try/catch! Bouncing with 401.');
    return new NextResponse('Bad request signature', { status: 401 });
  }

  if (!isValidRequest) {
    console.log('❌ Signature rejected cleanly');
    return new NextResponse('Bad request signature', { status: 401 });
  }

  const message = JSON.parse(rawBody);

  // NextResponse natively calculates Content-Length and strict headers for Discord!
  if (message.type === 1) {
    console.log('✅ EDGE RUNTIME PING SUCCESSFUL');
    return NextResponse.json({ type: 1 });
  }

  if (message.type === 2 && message.data.name === 'nexus') {
    const userPrompt = message.data.options[0].value;
    console.log(`🤖 Command trigger: ${userPrompt}`);
    
    return NextResponse.json({
      type: 4, 
      data: {
        content: `🤖 **Nexus Agent Received:** "${userPrompt}"\n\n*(System is listening!)*`
      }
    });
  }

  return new NextResponse('Unknown Type', { status: 400 });
}