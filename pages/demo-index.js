// hard push

import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { getCoinbaseAffiliateLink } from '../lib/constants';

export default function LandingPage() {
  const [logs, setLogs] = useState([
    { type: 'SNIPER', text: 'Math signal detected for ETH-PERP.' },
    { type: 'SNIPER', text: 'Fetching Core Memory & Waking Hermes...' },
    { type: 'AGENT', text: 'Analyzing Multi-TF X-Ray...', color: 'text-purple-400' },
    { type: 'AGENT', text: '1H Macro Trend: -98,720 (Bearish)', color: 'text-slate-300' },
    { type: 'AGENT', text: '5M Micro Ripple: +5,550 (Bullish Trap)', color: 'text-slate-300' },
    { type: 'ACTION', text: 'VETO', color: 'text-red-400 font-bold' },
    { type: 'INFO', text: 'Reason: Signal fights dominant 1H Macro Trend. Reward/Risk is 1.18. Capital Protected.', color: 'text-slate-500' }
  ]);
  const [showRationalization, setShowRationalization] = useState(false);

  // Simulate live logs for dummy account
  useEffect(() => {
    const interval = setInterval(() => {
      setShowRationalization(true);
      setTimeout(() => setShowRationalization(false), 5000);
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const coinbaseLink = getCoinbaseAffiliateLink('landing_page');
  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 font-sans selection:bg-cyan-500/30">
      <Head>
        <title>Nexus | Autonomous Quantitative Execution</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      {/* Navbar */}
      <nav className="fixed w-full z-50 bg-slate-900/60 backdrop-blur-md border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-20">
            <div className="flex-shrink-0 flex items-center gap-2">
              <svg className="w-8 h-8 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
              </svg>
              <span className="font-bold text-2xl tracking-wider">NEXUS</span>
            </div>
            <div className="hidden md:block">
              <div className="ml-10 flex items-baseline space-x-8">
                <a href="#features" className="hover:text-cyan-400 transition-colors">Features</a>
                <a href="#architecture" className="hover:text-cyan-400 transition-colors">Architecture</a>
                <a href="#pricing" className="hover:text-cyan-400 transition-colors">Pricing</a>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Link href="/auth" className="hidden md:block hover:text-cyan-400 transition-colors">
                Dashboard
              </Link>
              <a href={coinbaseLink} target="_blank" rel="noopener noreferrer" className="bg-gradient-to-r from-cyan-500 to-purple-600 text-white px-6 py-2 rounded-full font-semibold transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(34,211,238,0.5)]">
                Connect Coinbase
              </a>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <div className="relative pt-32 pb-20 sm:pt-40 sm:pb-24 lg:pb-32 overflow-hidden">
        <div className="absolute top-0 left-1/2 w-full -translate-x-1/2 h-full overflow-hidden -z-10 pointer-events-none">
          <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-cyan-500/20 rounded-full blur-[100px]"></div>
          <div className="absolute top-1/3 right-1/4 w-96 h-96 bg-purple-600/20 rounded-full blur-[100px]"></div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6">
            Stop Trading.<br />
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-purple-500">
              Start Executing.
            </span>
          </h1>
          <p className="mt-4 max-w-2xl text-lg md:text-xl text-slate-400 mx-auto mb-10">
            The world&apos;s first autonomous, self-learning quantitative trading agent built for the retail trader. Don&apos;t just automate your strategy. Arm it with institutional-grade AI.
          </p>
          <div className="flex flex-col sm:flex-row justify-center gap-4">
            <a href="#pricing" className="bg-white text-slate-950 px-8 py-4 rounded-full font-bold text-lg transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(255,255,255,0.3)]">
              Deploy Your Agent
            </a>
            <a href={coinbaseLink} target="_blank" rel="noopener noreferrer" className="bg-slate-900/60 backdrop-blur-md border border-white/5 px-8 py-4 rounded-full font-bold text-lg hover:bg-slate-800 transition-colors">
              Create Coinbase Account
            </a>
          </div>
          <p className="mt-6 text-sm text-slate-500">14-Day Free Trial. Connect to Coinbase in 60 seconds.</p>
        </div>
      </div>

      {/* The Agitation */}
      <div className="py-20 bg-slate-900 border-y border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-bold mb-4">Retail Trading is Broken.</h2>
          <p className="text-slate-400 max-w-3xl mx-auto text-lg mb-12 leading-relaxed">
            You spend hours backtesting the perfect script. The signal fires—but the S&amp;P 500 is tanking, the Dollar is surging, and whales are spoofing the order book. Your script blindly buys into a brick wall, and you get stopped out. <strong className="text-white">You don&apos;t need another indicator. You need an execution desk.</strong>
          </p>
        </div>
      </div>

      {/* Features */}
      <div id="features" className="py-24 relative">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-cyan-400 font-semibold tracking-wide uppercase">Meet Hermes</h2>
            <p className="mt-2 text-4xl font-extrabold">Your Personal Risk Manager</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="bg-slate-900/60 backdrop-blur-md border border-white/5 p-8 rounded-2xl">
              <div className="w-12 h-12 bg-cyan-500/20 rounded-lg flex items-center justify-center mb-6">
                <svg className="w-6 h-6 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-3">Institutional Reasoning</h3>
              <p className="text-slate-400 leading-relaxed">Hermes scans the 6H Macro Tide, the 1H Trend, and the 5M Tape. If your script tries to catch a falling knife, Hermes vetoes the trade to protect your capital.</p>
            </div>
            <div className="bg-slate-900/60 backdrop-blur-md border border-white/5 p-8 rounded-2xl relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-purple-500/10 rounded-bl-full blur-2xl"></div>
              <div className="w-12 h-12 bg-purple-500/20 rounded-lg flex items-center justify-center mb-6 relative z-10">
                <svg className="w-6 h-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-3 relative z-10">Agentic Reflection</h3>
              <p className="text-slate-400 leading-relaxed relative z-10">Hermes runs a post-mortem on every closed trade. If a setup fails, it extracts the math and writes a permanent rule to its Core Memory. It learns from its trauma.</p>
            </div>
            <div className="bg-slate-900/60 backdrop-blur-md border border-white/5 p-8 rounded-2xl">
              <div className="w-12 h-12 bg-cyan-500/20 rounded-lg flex items-center justify-center mb-6">
                <svg className="w-6 h-6 text-cyan-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <h3 className="text-xl font-bold mb-3">Multi-TF X-Ray</h3>
              <p className="text-slate-400 leading-relaxed">Real-time Level 2 spoof detection, volume node mapping, and structural fractal stop-losses. It calculates the exact Reward-to-Risk ratio before entering.</p>
            </div>
          </div>
        </div>
      </div>

      {/* Architecture */}
      <div id="architecture" className="py-24 bg-slate-900 border-y border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-col lg:flex-row items-center gap-16">
            <div className="w-full lg:w-1/2">
              <h2 className="text-4xl font-extrabold mb-6">From Backtest to Bank Account.</h2>
              <div className="space-y-8 mt-10">
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center text-cyan-400 font-bold border border-cyan-500/30">1</div>
                  <div>
                    <h4 className="text-xl font-bold">Bring Your Own Strategy</h4>
                    <p className="text-slate-400 mt-1">Import your winning scripts or use our library. Plug in your parameters and backtest natively.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center text-cyan-400 font-bold border border-cyan-500/30">2</div>
                  <div>
                    <h4 className="text-xl font-bold">The Sandbox</h4>
                    <p className="text-slate-400 mt-1">Watch Hermes manage a simulated $100k portfolio in live market conditions. Watch it veto toxic setups without risking a dime.</p>
                  </div>
                </div>
                <div className="flex gap-4">
                  <div className="flex-shrink-0 w-10 h-10 rounded-full bg-cyan-500/20 flex items-center justify-center text-cyan-400 font-bold border border-cyan-500/30">3</div>
                  <div>
                    <h4 className="text-xl font-bold">Flip the Switch to LIVE</h4>
                    <p className="text-slate-400 mt-1">Connect your &quot;Trade Only&quot; API keys. Allocate capital. Go to sleep. Wake up to Discord push notifications of secured profit.</p>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="w-full lg:w-1/2">
              <div className="bg-slate-950 rounded-xl overflow-hidden border border-slate-700 shadow-2xl">
                <div className="bg-slate-900 px-4 py-3 border-b border-slate-700 flex gap-2">
                  <div className="w-3 h-3 rounded-full bg-red-500"></div>
                  <div className="w-3 h-3 rounded-full bg-yellow-500"></div>
                  <div className="w-3 h-3 rounded-full bg-green-500"></div>
                  <span className="text-[10px] text-slate-500 font-mono ml-auto uppercase tracking-widest">Live Agent Swarm</span>
                </div>
                <div className="p-6 font-mono text-sm text-slate-300 space-y-2 h-[240px] overflow-y-auto">
                  {logs.map((log, i) => (
                    <p key={i} className={log.color || 'text-slate-300'}>
                      &gt; [{log.type}] {log.text}
                    </p>
                  ))}
                  <div className="animate-pulse inline-block w-2 h-4 bg-cyan-400 ml-1"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Coinbase Card Section */}
      <div className="py-24 relative overflow-hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <svg className="w-20 h-20 text-blue-500 mx-auto mb-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 18.286c-3.472 0-6.286-2.814-6.286-6.286S8.528 5.714 12 5.714s6.286 2.814 6.286 6.286-2.814 6.286-6.286 6.286z"/>
          </svg>
          <h2 className="text-4xl font-extrabold mb-6">Swipe Your Profit.</h2>
          <p className="text-slate-400 max-w-2xl mx-auto text-lg mb-10 leading-relaxed">
            Instantly settle your trading gains. Connect your <strong className="text-white">Coinbase Card</strong> to spend your profits in the real world. Pay for dinner, book a flight, or cover rent directly from your autonomous execution gains.
          </p>
          <a href={coinbaseLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-8 py-4 rounded-full font-bold transition-all shadow-lg hover:shadow-blue-500/20">
            Get Your Coinbase Card
          </a>
        </div>
      </div>

      {/* Pricing */}
      <div id="pricing" className="py-24 bg-slate-900 border-t border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-16">
            <h2 className="text-3xl font-extrabold mb-4">Choose Your Arsenal</h2>
            <p className="text-slate-400">Transparent pricing. Cancel anytime.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-6xl mx-auto">
            <div className="bg-slate-900/60 backdrop-blur-md border border-white/5 p-8 rounded-2xl flex flex-col">
              <h3 className="text-2xl font-bold text-slate-300">Retail</h3>
              <div className="mt-4 mb-8">
                <span className="text-4xl font-extrabold">$49</span><span className="text-slate-500">/mo</span>
              </div>
              <ul className="space-y-4 mb-8 flex-1 text-slate-400">
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> 1 Active Asset</li>
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> Standard Execution Routing</li>
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> Discord Alerts</li>
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> Static Risk Rules</li>
              </ul>
              <button className="w-full text-center bg-slate-800 border border-slate-700 py-3 rounded-lg hover:bg-slate-700 transition font-bold">Start Retail</button>
            </div>

            <div className="bg-slate-900/60 backdrop-blur-md p-8 rounded-2xl flex flex-col relative transform md:-translate-y-4 ring-2 ring-cyan-400 shadow-[0_0_30px_rgba(34,211,238,0.15)]">
              <div className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-gradient-to-r from-cyan-500 to-purple-600 text-white px-4 py-1 rounded-full text-sm font-bold shadow-lg">MOST POPULAR</div>
              <h3 className="text-2xl font-bold text-white">Pro</h3>
              <div className="mt-4 mb-8">
                <span className="text-4xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-cyan-400 to-purple-400">$149</span><span className="text-slate-500">/mo</span>
              </div>
              <ul className="space-y-4 mb-8 flex-1 text-slate-200">
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> 5 Active Assets</li>
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> High-Priority Routing</li>
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> Multi-TF X-Ray Telemetry</li>
                <li className="flex items-center font-semibold text-white"><svg className="w-5 h-5 text-purple-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg> Agentic Reflection (Self-Learning)</li>
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> Standard Nexus Card</li>
              </ul>
              <button className="w-full text-center bg-white text-slate-950 py-3 rounded-lg transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(255,255,255,0.3)] font-bold">Deploy Pro Agent</button>
            </div>

            <div className="bg-slate-900/60 backdrop-blur-md border border-white/5 p-8 rounded-2xl flex flex-col">
              <h3 className="text-2xl font-bold text-slate-300">Institutional</h3>
              <div className="mt-4 mb-8">
                <span className="text-4xl font-extrabold">$499</span><span className="text-slate-500">/mo</span>
              </div>
              <ul className="space-y-4 mb-8 flex-1 text-slate-400">
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> Unlimited Assets</li>
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> Colocated HFT Speeds</li>
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> Full Order Book Depth</li>
                <li className="flex items-center"><svg className="w-5 h-5 text-purple-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg> Agentic Reflection</li>
                <li className="flex items-center"><svg className="w-5 h-5 text-cyan-400 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg> Metal Nexus Card + Cash Back</li>
              </ul>
              <button className="w-full text-center bg-slate-800 border border-slate-700 py-3 rounded-lg hover:bg-slate-700 transition font-bold">Apply Now</button>
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="bg-slate-950 border-t border-slate-900 py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row justify-between items-center">
          <div className="flex items-center gap-2 mb-4 md:mb-0">
            <svg className="w-6 h-6 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 002-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <span className="font-bold text-xl text-slate-600 tracking-wider">NEXUS</span>
          </div>
          <p className="text-slate-600 text-sm">© 2026 Nexus Quantitative. All rights reserved.</p>
        </div>
      </footer>

      {/* Rationalization Toast */}
      <div className={`fixed bottom-8 right-8 z-[60] transition-all duration-500 transform ${showRationalization ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0 pointer-events-none'}`}>
        <div className="bg-slate-900/90 backdrop-blur-xl border border-indigo-500/30 p-6 rounded-2xl shadow-[0_0_40px_rgba(99,102,241,0.2)] max-w-xs">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-2 h-2 bg-indigo-400 rounded-full animate-ping"></div>
            <span className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Agent Cortex</span>
          </div>
          <p className="text-xs text-slate-300 font-medium leading-relaxed">
            Rationalizing trade for <span className="text-white font-bold">SOL-PERP</span>... analyzing volume absorption at 5M nodes.
          </p>
        </div>
      </div>
    </div>
  );
}