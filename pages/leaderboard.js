import React, { useState, useEffect } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import SiteNav from '../components/SiteNav';
import ChallengeCheckout from '../components/ChallengeCheckout';
import { useSession } from '@supabase/auth-helpers-react';
import { Trophy, ShieldAlert, Award, Crown, Medal, Flag, ScrollText, Rocket, LineChart, Zap } from 'lucide-react';

const WINDOW_OPTIONS = ['1D', '7D', '30D'];
const WINDOW_LABELS = { '1D': 'Today', '7D': 'Week', '30D': 'Month' };
const MODE_OPTIONS = ['LIVE', 'PAPER'];

// Podium accents for ranks 1-3
const PODIUM = {
  1: { label: 'CHAMPION', badge: 'bg-amber-400/10 border-amber-400/40 text-amber-300', icon: 'crown' },
  2: { label: 'II · RUNNER-UP', badge: 'bg-slate-300/10 border-slate-300/40 text-slate-200', icon: 'medal' },
  3: { label: 'III · THIRD', badge: 'bg-amber-600/10 border-amber-600/40 text-amber-500', icon: 'medal' }
};

const fmtPnl = (v) => (v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`);
const pnlColor = (v) => (v >= 0 ? 'text-emerald-400' : 'text-rose-400');

const CHALLENGE_RULES = [
  '30-day fixed window — no extensions, no restarts',
  '$100,000 simulated paper start for every entrant',
  'Max 10x leverage on any position',
  'Max 25% of equity per position',
  'Minimum 5 trades to qualify for prizes',
  'One entry per person — aliases only on the public board',
  'Paper resets are locked for the duration of the window',
  'No mid-trade parameter swaps to dodge a drawdown',
  '7 days without a trade = benched (hidden until you trade again)',
  'Alias-only public display — no account details exposed',
  'Prizes: 1st = 6 months PRO + permanent Champion role · 2nd/3rd = 3 months PRO'
];

const CHALLENGE_STEPS = [
  { icon: Rocket, title: 'Pick a plan', body: 'RETAIL — paper trading — 30 days free, then $X/mo — card required at checkout.' },
  { title: 'Deploy a strategy', body: 'Get an agent running before the window opens so you start trading at the bell.', icon: Zap },
  { icon: LineChart, title: 'Trade the window', body: 'The board tracks your $100k simulated balance live for 30 days.' }
];

export default function Leaderboard() {
  const [windowKey, setWindowKey] = useState('30D');
  const [mode, setMode] = useState('LIVE');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const session = useSession();
  const [challengeState, setChallengeState] = useState({ entered: false, status: null, daysRemaining: null, joining: false, joined: false });
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const PodiumIcon = ({ name }) => name === 'crown'
    ? <Crown className="w-3 h-3" />
    : <Medal className="w-3 h-3" />;

  // ── Top-3 Podium Section (FIX: dedicated section, uniform table below) ──
  const PodiumSection = ({ rows }) => {
    if (!rows || rows.length === 0) return null;
    const [champ, runnerUp, third] = rows;

    const Stat = ({ label, value }) => (
      <div className="text-right">
        <div className="text-[8px] font-black uppercase tracking-widest text-slate-500">{label}</div>
        <div className="text-xs font-black font-mono text-white">{value}</div>
      </div>
    );

    return (
      <div className="mb-8">
        <h2 className="text-sm font-black uppercase tracking-widest text-white mb-1">Top Performers</h2>
        <p className="text-[10px] text-slate-500 mb-4">Podium for the selected window &amp; mode</p>

        {/* Champion card */}
        {champ && (
          <div className="relative overflow-hidden rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-400/[0.07] via-emerald-400/[0.04] to-slate-900/40 p-6 backdrop-blur-sm mb-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[10px] font-black uppercase tracking-widest bg-amber-400/10 border-amber-400/40 text-amber-300 mb-2">
                  <Crown className="w-3 h-3" /> Champion
                </span>
                <div className="text-2xl font-black text-white tracking-tight">{champ.alias}</div>
                <div className="text-[11px] text-slate-400 font-medium mt-0.5">
                  <span className="text-slate-500">US</span> · Ranked #1
                </div>
              </div>
              <div className="flex flex-col items-start sm:items-end gap-2">
                <div className="text-[8px] font-black uppercase tracking-widest text-slate-500">Total PnL</div>
                <div className={`text-4xl font-black font-mono tracking-tight ${pnlColor(champ.totalPnl)} drop-shadow-[0_0_18px_rgba(52,211,153,0.35)]`}>
                  {champ.totalPnl >= 0 ? `$${champ.totalPnl.toFixed(2)}` : `-$${Math.abs(champ.totalPnl).toFixed(2)}`}
                </div>
                <div className="flex items-center gap-5">
                  <Stat label="Win Rate" value={`${(champ.winRate * 100).toFixed(1)}%`} />
                  <Stat label="Trades" value={champ.trades} />
                  <Stat label="Days" value={champ.days} />
                  <Stat label="Profit Factor" value={champ.profitFactor ?? '—'} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Runner-up + Third cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[{ row: runnerUp, p: PODIUM[2] }, { row: third, p: PODIUM[3] }].map(({ row, p }, i) =>
            row ? (
              <div key={p.label} className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 backdrop-blur-sm flex items-center gap-4">
                <div className={`flex-shrink-0 w-10 h-10 rounded-xl border flex items-center justify-center font-black text-sm ${i === 0 ? 'bg-slate-300/10 border-slate-300/30 text-slate-200' : 'bg-amber-600/10 border-amber-600/30 text-amber-500'}`}>
                  {i + 2}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white truncate">{row.alias}</span>
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[8px] font-black uppercase tracking-widest ${p.badge}`}>
                      <PodiumIcon name={p.icon} /> {p.label}
                    </span>
                  </div>
                  <div className={`text-lg font-black font-mono ${pnlColor(row.totalPnl)}`}>
                    {row.totalPnl >= 0 ? `$${row.totalPnl.toFixed(2)}` : `-$${Math.abs(row.totalPnl).toFixed(2)}`}
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono">
                    {(row.winRate * 100).toFixed(0)}% win · {row.trades} trades
                  </div>
                </div>
              </div>
            ) : null
          )}
        </div>
      </div>
    );
  };

  // Category Records card (2x2 grid cell)
  const RecordCard = ({ title, entries, valueHeader, renderValue }) => (
    <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 backdrop-blur-sm">
      <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-300 mb-3">{title}</h3>
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="text-[8px] font-black uppercase tracking-widest text-slate-500 border-b border-white/5">
            <th className="py-1.5 pr-2">#</th>
            <th className="py-1.5 pr-2">Agent</th>
            <th className="py-1.5 text-right">{valueHeader}</th>
          </tr>
        </thead>
        <tbody className="text-[11px] font-mono">
          {(!entries || entries.length === 0) ? (
            <tr><td colSpan={3} className="py-3 text-center text-slate-600 italic">No data yet</td></tr>
          ) : entries.map((e, i) => (
            <tr key={i} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02]">
              <td className="py-1.5 pr-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded bg-slate-800 text-[9px] font-bold text-slate-400">{i + 1}</span>
              </td>
              <td className="py-1.5 pr-2 text-slate-200">{e.alias}{e.symbol ? ` · ${e.symbol}` : ''}</td>
              <td className={`py-1.5 text-right font-bold ${e.color || 'text-white'}`}>{renderValue(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  useEffect(() => {
    let isCancelled = false;
    const fetchLeaderboard = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/public/leaderboard?window=${windowKey}&mode=${mode}`);
        if (!res.ok) {
          throw new Error(`Failed to load leaderboard (${res.status})`);
        }
        const json = await res.json();
        if (!isCancelled) {
          setData(json);
        }
      } catch (err) {
        if (!isCancelled) {
          setError(err.message);
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    fetchLeaderboard();
    return () => {
      isCancelled = true;
    };
  }, [windowKey, mode]);

  // Resume challenge checkout after OAuth/magic-link redirect back to this page.
  useEffect(() => {
    if (sessionStorage.getItem('challenge_checkout_resume') !== '1') return;
    if (!session?.access_token) return; // wait for session to hydrate
    sessionStorage.removeItem('challenge_checkout_resume');
    setCheckoutOpen(true);
  }, [session?.access_token]);

  // Challenge status (personal, only when authed)
  useEffect(() => {
    let isCancelled = false;
    const fetchChallengeStatus = async () => {
      if (!session?.access_token) return;
      try {
        const res = await fetch('/api/challenge-status', {
          headers: { Authorization: `Bearer ${session.access_token}` }
        });
        if (!res.ok) return;
        const json = await res.json();
        if (!isCancelled && json.entered) {
          setChallengeState(s => ({ ...s, entered: true, status: json.status || 'active', daysRemaining: json.days_remaining }));
        }
      } catch { /* non-blocking */ }
    };
    fetchChallengeStatus();
    return () => { isCancelled = true; };
  }, [session?.access_token]);

  const joinChallenge = async () => {
    if (!session?.access_token) return;
    setChallengeState(s => ({ ...s, joining: true }));
    try {
      const res = await fetch('/api/challenge-join', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ intent: 'active' })
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setChallengeState(s => ({ ...s, entered: true, status: json.status || 'active', joined: true, joining: false }));
      } else if (res.status === 409) {
        setChallengeState(s => ({ ...s, entered: true, joining: false }));
      } else {
        alert(json.error || 'Could not join the challenge.');
        setChallengeState(s => ({ ...s, joining: false }));
      }
    } catch {
      alert('Could not join the challenge. Try again.');
      setChallengeState(s => ({ ...s, joining: false }));
    }
  };

  return (
    <div className="min-h-screen bg-[#020617] text-slate-100 font-sans selection:bg-indigo-500 selection:text-white">
      <Head>
        <title>Nexus Rolling Leaderboard | Autonomous Trading Quant Intelligence</title>
        <meta name="description" content="Public rolling leaderboard of top performing autonomous execution agents on Nexus Terminal." />
      </Head>

      <SiteNav active="leaderboard" />

      <main className="max-w-6xl mx-auto px-4 pt-28 pb-10">
        {/* ── 100K Challenge Banner ── */}
        <div className="relative overflow-hidden rounded-2xl border border-amber-400/30 bg-gradient-to-r from-amber-400/[0.08] via-indigo-500/[0.05] to-slate-900/40 p-6 backdrop-blur-sm mb-6">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[10px] font-black uppercase tracking-widest bg-amber-400/10 border-amber-400/40 text-amber-300 mb-2">
                <Flag className="w-3 h-3" /> 30 Days · $100,000 Simulated Start
              </span>
              <h2 className="text-xl font-black tracking-tight text-white uppercase">The 100K Simulation Challenge</h2>
              <p className="text-xs text-slate-400 mt-1">
                Starts Friday, Sep 11 · Paper-trade a simulated $100k for 30 days. Top balance wins.
              </p>
            </div>
            <div className="flex-shrink-0">
              {!session ? (
                <Link href="/auth" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold transition-all shadow-lg shadow-indigo-600/30">
                  Sign up to enter
                </Link>
              ) : challengeState.status === 'pending_payment' ? (
                <button
                  onClick={() => setCheckoutOpen(true)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-sm font-black uppercase tracking-wide transition-all shadow-lg shadow-amber-500/30"
                >
                  <Flag className="w-4 h-4" />
                  Complete checkout
                </button>
              ) : challengeState.entered ? (
                <span className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/40 text-emerald-300 text-sm font-bold">
                  <Trophy className="w-4 h-4" />
                  You&apos;re in{challengeState.daysRemaining != null ? ` — ${challengeState.daysRemaining} days remaining` : ''}
                </span>
              ) : (
                <button
                  onClick={() => setCheckoutOpen(true)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-slate-950 text-sm font-black uppercase tracking-wide transition-all shadow-lg shadow-amber-500/30"
                >
                  <Flag className="w-4 h-4" />
                  Enter the 100K Challenge
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Rules Card ── */}
        <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-5 backdrop-blur-sm mb-6">
          <div className="flex items-center gap-2 mb-3">
            <ScrollText className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-black uppercase tracking-widest text-white">Challenge Rules</h3>
          </div>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1.5">
            {CHALLENGE_RULES.map((rule, i) => (
              <li key={i} className="flex items-start gap-2 text-[11px] text-slate-300">
                <span className="mt-0.5 flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded bg-slate-800 text-[8px] font-bold text-slate-400">{i + 1}</span>
                {rule}
              </li>
            ))}
          </ul>
        </div>

        {/* ── 3-Step How It Works ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          {CHALLENGE_STEPS.map((step, i) => (
            <div key={i} className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 backdrop-blur-sm">
              <div className="flex items-center gap-2 mb-2">
                <div className="flex-shrink-0 w-8 h-8 rounded-xl bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 flex items-center justify-center">
                  <step.icon className="w-4 h-4" />
                </div>
                <span className="text-[8px] font-black uppercase tracking-widest text-slate-500">Step {i + 1}</span>
              </div>
              <div className="text-sm font-bold text-white mb-1">{step.title}</div>
              <p className="text-[11px] text-slate-400">{step.body}</p>
            </div>
          ))}
        </div>

        {/* ── 2-Card Pricing Strip ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
          <div className="rounded-2xl border border-indigo-500/30 bg-indigo-500/[0.06] p-5 backdrop-blur-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-black uppercase tracking-widest text-indigo-300">FREE · Paper</span>
              <span className="px-2 py-0.5 rounded-md bg-amber-400/10 border border-amber-400/40 text-amber-300 text-[9px] font-black uppercase tracking-widest">
                Compete in the challenge
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mb-3">RETAIL — paper trading — 30 days free, then $X/mo — card required at checkout.</p>
            <button
              onClick={() => setCheckoutOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold transition-all"
            >
              Enter the Challenge
            </button>
          </div>
          <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-5 backdrop-blur-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-black uppercase tracking-widest text-slate-300">PRO</span>
              <span className="px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/40 text-emerald-300 text-[9px] font-black uppercase tracking-widest">
                First 30 days free with challenge entry
              </span>
            </div>
            <p className="text-[11px] text-slate-400 mb-3">Live execution — first 30 days free with challenge entry.</p>
            <Link href="/demo-index#pricing" className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold transition-all">
              See PRO
            </Link>
          </div>
        </div>

        {/* Header Title */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
              <Trophy className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight text-white uppercase">Agent Rolling Leaderboard</h1>
              <p className="text-xs text-slate-400 font-medium">Verified autonomous execution performance across active institutional and retail nodes.</p>
            </div>
          </div>
        </div>

        {/* Filters Controls */}
        <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-2xl bg-slate-900/60 border border-white/5 backdrop-blur-sm mb-6">
          {/* Window Tabs */}
          <div className="flex items-center gap-1.5 bg-black/40 p-1 rounded-xl border border-white/5">
            {WINDOW_OPTIONS.map((w) => (
              <button
                key={w}
                onClick={() => setWindowKey(w)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  windowKey === w
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {WINDOW_LABELS[w]}
              </button>
            ))}
          </div>

          {/* Mode Tabs */}
          <div className="flex items-center gap-1.5 bg-black/40 p-1 rounded-xl border border-white/5">
            {MODE_OPTIONS.map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                  mode === m
                    ? m === 'LIVE' 
                      ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30'
                      : 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/30'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Top-3 Podium — dedicated section above the table */}
        {!loading && !error && <PodiumSection rows={(data?.rows || []).slice(0, 3)} />}

        {/* Category Records — above the table */}
        <div className="mb-6">
          <h2 className="text-sm font-black uppercase tracking-widest text-white mb-1">Category Records</h2>
          <p className="text-[10px] text-slate-500 mb-4">Standout single-metric leaders</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <RecordCard
              title="Largest Win"
              entries={(data?.records?.largestWin || []).map(e => ({ ...e, color: 'text-emerald-400' }))}
              valueHeader="VALUE"
              renderValue={e => fmtPnl(e.value)}
            />
            <RecordCard
              title="Largest Loss"
              entries={(data?.records?.largestLoss || []).map(e => ({ ...e, color: 'text-rose-400' }))}
              valueHeader="VALUE"
              renderValue={e => fmtPnl(e.value)}
            />
            <RecordCard
              title="Most Trading Days"
              entries={data?.records?.mostDays || []}
              valueHeader="DAYS"
              renderValue={e => `${e.days} days`}
            />
            <RecordCard
              title="Highest Volume"
              entries={data?.records?.highestVolume || []}
              valueHeader="TRADES"
              renderValue={e => `${e.trades} trades`}
            />
          </div>
        </div>

        {/* Leaderboard Table Container */}
        <div className="rounded-2xl border border-white/5 bg-slate-900/40 overflow-hidden backdrop-blur-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/5 bg-white/[0.02] text-[10px] font-black uppercase tracking-wider text-slate-400">
                  <th className="py-3.5 px-4">Rank</th>
                  <th className="py-3.5 px-4">Agent</th>
                  <th className="py-3.5 px-4 text-center">Trades</th>
                  <th className="py-3.5 px-4 text-right">Win Rate</th>
                  <th className="py-3.5 px-4 text-right">Total R</th>
                  <th className="py-3.5 px-4 text-right">PnL</th>
                  <th className="py-3.5 px-4 text-right">Days</th>
                  <th className="py-3.5 px-4 text-right">Profit Factor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-xs">
                {loading ? (
                  // Skeleton State
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="animate-pulse">
                      <td className="py-4 px-4"><div className="h-4 w-6 bg-slate-800 rounded"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-28 bg-slate-800 rounded"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-12 bg-slate-800 rounded mx-auto"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-16 bg-slate-800 rounded ml-auto"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-16 bg-slate-800 rounded ml-auto"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-16 bg-slate-800 rounded ml-auto"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-10 bg-slate-800 rounded ml-auto"></div></td>
                      <td className="py-4 px-4"><div className="h-4 w-14 bg-slate-800 rounded ml-auto"></div></td>
                    </tr>
                  ))
                ) : error ? (
                  <tr>
                    <td colSpan={8} className="py-12 text-center text-rose-400">
                      <ShieldAlert className="w-6 h-6 mx-auto mb-2 opacity-80" />
                      <p className="text-xs font-semibold">{error}</p>
                    </td>
                  </tr>
                ) : !data?.rows || data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-16 text-center text-slate-500">
                      <Award className="w-8 h-8 mx-auto mb-2 opacity-30" />
                      <p className="text-sm font-bold text-slate-400">No qualifying agents for this period</p>
                      <p className="text-xs mt-1 text-slate-600">Requires a minimum of 5 closed trades in the selected window.</p>
                    </td>
                  </tr>
                ) : (
                  data.rows.map((row, idx) => {
                    const rank = idx + 1;
                    const p = PODIUM[rank];
                    const rankBadgeColor =
                      rank === 1 ? 'text-amber-400 bg-amber-400/10 border-amber-400/30' :
                      rank === 2 ? 'text-slate-300 bg-slate-300/10 border-slate-300/30' :
                      rank === 3 ? 'text-amber-600 bg-amber-600/10 border-amber-600/30' :
                      'text-slate-500 bg-slate-800/40 border-transparent';

                    // Uniform rows for ALL ranks — podium lives in its own section above.
                    return (
                      <tr key={`${row.alias}-${idx}`} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-3.5 px-4 font-mono font-bold">
                          <span className={`inline-flex items-center justify-center w-6 h-6 rounded-lg text-xs border ${rankBadgeColor}`}>
                            {rank}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 font-semibold text-slate-200">
                          <div className="flex items-center gap-2">
                            <span>{row.alias}</span>
                            {p && (
                              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[8px] font-black uppercase tracking-widest ${p.badge}`}>
                                <PodiumIcon name={p.icon} /> {p.label}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-center font-mono text-slate-300">
                          {row.trades}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-medium">
                          <span className={row.winRate >= 0.5 ? 'text-emerald-400' : 'text-slate-400'}>
                            {(row.winRate * 100).toFixed(1)}%
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono font-bold">
                          <span className={row.totalR >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                            {row.totalR > 0 ? `+${row.totalR.toFixed(2)}R` : `${row.totalR.toFixed(2)}R`}
                          </span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono">
                          <span className={pnlColor(row.totalPnl)}>{fmtPnl(row.totalPnl)}</span>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-white">
                          {row.days}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono text-slate-300">
                          {row.profitFactor ?? '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── 100K Challenge Standings (below the live board) ── */}
        {data?.challenge && (
          <div className="mt-10">
            <div className="flex items-center gap-2 mb-1">
              <Flag className="w-4 h-4 text-amber-400" />
              <h2 className="text-sm font-black uppercase tracking-widest text-white">100K Challenge Standings</h2>
            </div>
            <p className="text-[10px] text-slate-500 mb-4">
              {data.challenge.total_entries} entrants · 7 days without a trade = benched (hidden until you trade again)
            </p>
            <div className="rounded-2xl border border-amber-400/20 bg-slate-900/40 overflow-hidden backdrop-blur-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/5 bg-white/[0.02] text-[10px] font-black uppercase tracking-wider text-slate-400">
                      <th className="py-3 px-4">Rank</th>
                      <th className="py-3 px-4">Alias</th>
                      <th className="py-3 px-4 text-right">Balance</th>
                      <th className="py-3 px-4 text-right">PnL</th>
                      <th className="py-3 px-4 text-right">Trades</th>
                      <th className="py-3 px-4 text-right">Win Rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5 text-xs">
                    {(data.challenge.top || []).length === 0 ? (
                      <tr>
                        <td colSpan={6} className="py-10 text-center text-slate-500">
                          <Award className="w-6 h-6 mx-auto mb-2 opacity-30" />
                          <p className="text-xs">No active challenge traders yet — be the first.</p>
                        </td>
                      </tr>
                    ) : (data.challenge.top || []).map((row, idx) => (
                      <tr key={`${row.alias}-${idx}`} className="hover:bg-white/[0.02] transition-colors">
                        <td className="py-3 px-4 font-mono font-bold text-slate-400">{idx + 1}</td>
                        <td className="py-3 px-4 font-semibold text-slate-200">{row.alias}</td>
                        <td className="py-3 px-4 text-right font-mono font-bold text-white">
                          ${Number(row.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td className="py-3 px-4 text-right font-mono">
                          <span className={pnlColor(Number(row.pnl))}>{fmtPnl(Number(row.pnl))}</span>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-slate-300">{row.trades}</td>
                        <td className="py-3 px-4 text-right font-mono text-slate-300">
                          {row.win_rate != null ? `${(row.win_rate * 100).toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Footer Note */}
        <div className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-[11px] text-slate-500 border-t border-white/5 pt-4">
          <p>Opt-in leaderboard. R = PnL ÷ risk taken — size-invariant.</p>
          {data?.generatedAt && (
            <p className="font-mono text-[10px]">Updated: {new Date(data.generatedAt).toLocaleTimeString()}</p>
          )}
        </div>
      </main>

      {checkoutOpen && (
        <ChallengeCheckout
          onClose={() => setCheckoutOpen(false)}
          onEntered={() => setChallengeState(s => ({ ...s, entered: true, status: 'active' }))}
        />
      )}
    </div>
  );
}
