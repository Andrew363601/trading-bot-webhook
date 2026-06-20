// components/WebhookCreator.js
// Inline chat widget for the landing page hero section.
// Flow: initial CTA -> asset -> name -> email (magic link) -> redirect to dashboard
// CDE-only assets: ready for immediate LIVE trading on Coinbase

import { useState, useRef, useEffect } from 'react';
import { Loader2, ArrowRight, Send } from 'lucide-react';

const CDE_ASSETS = [
  { label: 'Bitcoin (BTC CDE Futures)',  code: 'BIP', ticker: 'BTC' },
  { label: 'Ethereum (ETH CDE Futures)', code: 'ETP', ticker: 'ETH' },
  { label: 'Solana (SOL CDE Futures)',   code: 'SLP', ticker: 'SOL' },
  { label: 'Dogecoin (DOGE CDE Futures)',code: 'DOP', ticker: 'DOGE' },
  { label: 'Litecoin (LTC CDE Futures)', code: 'LCP', ticker: 'LTC' },
  { label: 'Avalanche (AVAX CDE Futures)',code: 'AVP', ticker: 'AVAX' },
  { label: 'Chainlink (LINK CDE Futures)',code: 'LNP', ticker: 'LINK' },
  { label: 'XRP (XRP CDE Futures)',       code: 'XPP', ticker: 'XRP' },
  { label: 'Worldcoin (WLD CDE Futures)', code: 'WLD', ticker: 'WLD' },
];

const INITIAL_MESSAGE = {
  role: 'assistant',
  content: `Hey there. \u{1F44B}

I'm Nexus \u2014 your AI execution desk.

Tell me what crypto asset you want to trade and I'll generate a secure webhook URL for your TradingView strategy in under 30 seconds.

**Available (CDE Futures \u2014 ready for LIVE):**
BTC, ETH, SOL, DOGE, LTC, AVAX, LINK, XRP, WLD

Just type something like *"BTC RSI strategy"* to get started.`
};

export default function WebhookCreator({ onComplete }) {
  const [step, setStep] = useState('initial');
  const [messages, setMessages] = useState([INITIAL_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [asset, setAsset] = useState('');
  const [strategyName, setStrategyName] = useState('');
  const [email, setEmail] = useState('');
  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const addMessage = (role, content) => {
    setMessages(prev => [...prev, { role, content }]);
  };

  const sendToNexusAI = async (userMessage) => {
    const updatedMessages = [...messages, { role: 'user', content: userMessage }];
    setMessages(updatedMessages);
    setLoading(true);

    try {
      const res = await fetch('/api/demo-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: updatedMessages })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      if (res.headers.get('content-type')?.includes('text/plain')) {
        // Streaming response
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let aiContent = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          aiContent += decoder.decode(value, { stream: true });
        }

        const newMessages = [...updatedMessages, { role: 'assistant', content: aiContent || '...' }];
        setMessages(newMessages);

        // Detect email ask — transition to magic link step
        if (aiContent.toLowerCase().includes('email') &&
            (aiContent.toLowerCase().includes('magic') || aiContent.toLowerCase().includes('send'))) {
          setTimeout(() => setStep('email'), 1000);
        }
      } else {
        // JSON error
        const data = await res.json();
        throw new Error(data.error || 'AI error');
      }
    } catch (e) {
      console.error('[DEMO CHAT] Error:', e.message);
      setMessages([...updatedMessages, {
        role: 'assistant',
        content: 'Nexus AI is warming up. Enter your email below to get started directly.'
      }]);
      setStep('email');
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    await sendToNexusAI(text);
  };

  const handleEmailSubmit = async () => {
    if (!email || !email.includes('@')) {
      addMessage('nexus', 'Please enter a valid email address.');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, asset, strategy_name: strategyName })
      });

      const data = await res.json();

      if (!data.success) {
        addMessage('nexus', `Something went wrong: ${data.error || 'Please try again.'}`);
        setLoading(false);
        return;
      }

      setStep('sent');
      addMessage('nexus', `\u2705 **Magic link sent to ${email}!**\n\nCheck your inbox. Click the link and you'll land in your dashboard with your webhook URL ready to copy.\n\n*(Link expires in 10 minutes.)*`);

      sessionStorage.setItem('webhook_pending', JSON.stringify({ asset, strategy_name: strategyName, email }));

    } catch (e) {
      addMessage('nexus', 'Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (step === 'email') {
        handleEmailSubmit();
      } else {
        handleSend();
      }
    }
  };

  return (
    <div className="w-full max-w-2xl mx-auto bg-slate-900/80 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-cyan-600/20 to-purple-600/20 px-6 py-4 border-b border-white/5 flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold">N</div>
        <div className="flex-1">
          <p className="text-sm font-bold text-white">Nexus AI</p>
          <p className="text-xs text-emerald-400 flex items-center gap-1">
            <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
            Online — Autonomous Execution Desk
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="h-80 overflow-y-auto p-6 space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-2xl px-5 py-3 text-sm leading-relaxed ${
              msg.role === 'user'
                ? 'bg-cyan-600/20 border border-cyan-500/20 text-white'
                : 'bg-slate-800/80 border border-white/5 text-slate-200'
            }`}>
              {msg.content.split('\n').map((line, j) => (
                <p key={j} className={line.startsWith('**') ? 'font-bold text-white' : ''}>
                  {line.replace(/\*\*/g, '')}
                </p>
              ))}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Email input */}
      {step === 'email' && (
        <div className="px-6 pb-4">
          <div className="flex gap-2">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="you@example.com"
              className="flex-1 bg-slate-800 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
            />
            <button
              onClick={handleEmailSubmit}
              disabled={loading}
              className="bg-gradient-to-r from-cyan-500 to-purple-600 text-white px-6 py-3 rounded-xl font-bold text-sm hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center gap-2"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send Magic Link'}
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-2">No password needed. Free 7-day trial. Cancel anytime.</p>
        </div>
      )}

      {/* Chat input */}
      {step !== 'email' && step !== 'sent' && (
        <div className="px-6 pb-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. BTC RSI Scalper"
              className="flex-1 bg-slate-800 border border-white/10 rounded-xl px-4 py-3 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-cyan-500/50"
            />
            <button
              onClick={handleSend}
              disabled={loading || !input.trim()}
              className="bg-cyan-500 hover:bg-cyan-400 text-slate-900 px-4 py-3 rounded-xl font-bold disabled:opacity-50 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Confirmation */}
      {step === 'sent' && (
        <div className="px-6 pb-4">
          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl px-5 py-4">
            <p className="text-emerald-400 font-bold text-sm flex items-center gap-2">
              ✅ Magic link sent
            </p>
            <p className="text-slate-400 text-xs mt-1">
              Click the link in your email to activate your webhook. You&apos;ll be redirected to your dashboard with your URL ready to copy.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
