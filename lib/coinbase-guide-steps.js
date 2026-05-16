// lib/coinbase-guide-steps.js
// Defines the step-by-step guide for setting up Coinbase API keys.
// The AI walks the user through each step with annotated screenshots.

export const COINBASE_GUIDE_STEPS = [
  {
    step: 1,
    title: 'Open Coinbase Cloud',
    instruction: 'Go to cloud.coinbase.com and log in to your account. If you don\'t have an account yet, create one first.',
    image: '/guide/coinbase-api-1-login.png',
    action: {
      label: 'Open Coinbase Cloud ↗',
      url: 'https://cloud.coinbase.com'
    }
  },
  {
    step: 2,
    title: 'Navigate to API Section',
    instruction: 'In the left sidebar, click on "API" to access the API key management page.',
    image: '/guide/coinbase-api-2-create.png'
  },
  {
    step: 3,
    title: 'Create a New API Key',
    instruction: 'Click "Create API Key". Name it "Nexus Trading". Under permissions, you MUST select BOTH "View" AND "Trade" — you need Trade permissions for the bot to execute orders on your behalf.',
    image: '/guide/coinbase-api-3-permissions.png',
    requiredPermissions: ['View', 'Trade']
  },
  {
    step: 4,
    title: 'Copy Your Credentials',
    instruction: 'Copy the API Key Name (starts with "organizations/") and the full Private Key (including "-----BEGIN EC PRIVATE KEY-----"). Paste both directly in the chat when you\'re ready.',
    image: '/guide/coinbase-api-4-copy.png'
  }
];

/**
 * Returns the guide step for a given step number (1-indexed).
 */
export function getGuideStep(stepNumber) {
  return COINBASE_GUIDE_STEPS.find(s => s.step === stepNumber) || null;
}

/**
 * Returns the total number of steps in the guide.
 */
export function getGuideStepCount() {
  return COINBASE_GUIDE_STEPS.length;
}
