// components/SiteNav.js
// Public site navbar — sales-page parity (FIX 37). Used by pages/leaderboard.js.
// Links replicate the demo-index (sales page) nav exactly; cross-page hash
// navigation must use <Link> (plain <a href="/#..."> trips the
// no-html-link-for-pages lint rule).

import Link from 'next/link';

export default function SiteNav({ active = '' }) {
  const links = [
    { href: '/#features', label: 'Features', key: 'features' },
    { href: '/#architecture', label: 'Architecture', key: 'architecture' },
    { href: '/#pricing', label: 'Pricing', key: 'pricing' },
    { href: '/#trades', label: 'Trade Log', key: 'trades' },
    { href: '/leaderboard', label: 'Leaderboard', key: 'leaderboard' }
  ];

  return (
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
              {links.map(l => (
                <Link
                  key={l.key}
                  href={l.href}
                  className={`transition-colors ${active === l.key ? 'text-cyan-400 font-semibold' : 'hover:text-cyan-400'}`}
                >
                  {l.label}
                </Link>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Link
              href="/#pricing"
              className="hidden sm:block text-slate-300 hover:text-cyan-400 font-semibold transition-colors"
            >
              Dashboard
            </Link>
            <Link
              href="/#pricing"
              className="hidden sm:block bg-gradient-to-r from-cyan-500 to-purple-600 text-white px-6 py-2 rounded-full font-semibold transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_0_20px_rgba(34,211,238,0.5)]"
            >
              Deploy Your Agent
            </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
