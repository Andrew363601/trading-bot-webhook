// lib/quick-start-config.js
// Defines the tour steps for the Quick Start Guide coach marks component.
// Each step targets a DOM element by CSS selector with responsive positioning.

export const QUICK_START_STEPS = [
  {
    id: 'dashboard',
    selector: '#dashboard-header',
    title: 'Portfolio Dashboard',
    desc: 'Your live PnL, open positions, account overview, and real-time market metrics at a glance.',
    pos: 'bottom',
    mobilePos: 'bottom'
  },
  {
    id: 'chart',
    selector: '#chart-panel',
    title: 'Live Chart',
    desc: 'Real-time candlestick chart with volume profile, CVD overlay, and trade markers. Toggle timeframes and TP/SL lines.',
    pos: 'left',
    mobilePos: 'bottom'
  },
  {
    id: 'scanner',
    selector: '#market-scanner',
    title: 'Market Scanner',
    desc: 'Real-time CVD, volume profiles, topographical maps, and macro regime detection for each asset.',
    pos: 'right',
    mobilePos: 'bottom'
  },
  {
    id: 'strategies',
    selector: '#strategy-matrix',
    title: 'Strategy Engine',
    desc: 'Deploy, pause, and monitor your trading strategies. Edit parameters, toggle PAPER/LIVE mode, and track performance.',
    pos: 'left',
    mobilePos: 'bottom'
  },
  {
    id: 'logs',
    selector: '#session-logs',
    title: 'Agent Session Logs',
    desc: 'Real-time activity feed from Sniper, Watchdog, and Agent Cortex showing every decision and execution.',
    pos: 'right',
    mobilePos: 'bottom'
  },
  {
    id: 'chat',
    selector: '#nexus-chat',
    title: 'Nexus AI Chat',
    desc: 'Your AI trading assistant. Ask questions, analyze markets, manage strategies, and get real-time trade recommendations.',
    pos: 'top',
    mobilePos: 'top'
  },
  {
    id: 'ledger',
    selector: '#trade-ledger',
    title: 'Trade Ledger',
    desc: 'Complete history of all open orders, active positions, and closed trades with PnL tracking.',
    pos: 'top',
    mobilePos: 'bottom'
  },
  {
    id: 'settings',
    selector: '#settings-btn',
    title: 'Settings & API Keys',
    desc: 'Configure your exchange API keys, risk profile, Discord alerts, and account preferences.',
    pos: 'bottom',
    mobilePos: 'bottom'
  },
  {
    id: 'settings-key-name',
    selector: '#api-key-name-input',
    title: 'API Key Name',
    desc: 'Enter your Coinbase API Key Name here. It starts with "organizations/".',
    pos: 'left',
    mobilePos: 'bottom'
  },
  {
    id: 'settings-key-secret',
    selector: '#api-secret-input',
    title: 'API Secret Key',
    desc: 'Paste your full Private Key here including the BEGIN/END markers.',
    pos: 'left',
    mobilePos: 'bottom'
  },
  {
    id: 'settings-save',
    selector: '#api-key-save-btn',
    title: 'Save Keys',
    desc: 'Click here to encrypt and securely store your API keys.',
    pos: 'bottom',
    mobilePos: 'bottom'
  },
  {
    id: 'discord-setup',
    selector: '#settings-btn',
    title: 'Set Up Discord',
    desc: 'Configure your Discord alert and Nexus agent webhooks in Profile Settings or in the Settings page to receive real-time trade alerts and chat with Nexus on Discord.',
    pos: 'bottom',
    mobilePos: 'bottom'
  }
];

export const QUICK_START_STORAGE_KEY = 'nexus_quick_start_dismissed';
