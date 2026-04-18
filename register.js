import 'dotenv/config';

const token = process.env.DISCORD_BOT_TOKEN;
const appId = process.env.DISCORD_APP_ID;

const commands = [
  {
    name: 'nexus',
    description: 'Talk to the Nexus Agent',
    options: [
      {
        name: 'prompt',
        description: 'What do you want to ask the agent?',
        type: 3, // This tells Discord we expect a String input
        required: true,
      },
    ],
  },
];

async function registerCommands() {
  const url = `https://discord.com/api/v10/applications/${appId}/commands`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${token}`,
    },
    body: JSON.stringify(commands[0]),
  });

  if (response.ok) {
    console.log('✅ Command registered successfully!');
  } else {
    const error = await response.json();
    console.error('❌ Failed to register:', error);
  }
}

registerCommands();