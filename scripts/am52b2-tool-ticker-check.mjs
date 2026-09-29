// AM52b2 — tool ticker formatter validation.
// Run: node scripts/am52b2-tool-ticker-check.mjs
import { formatToolTicker, dedupeTickerLines } from '../lib/tool-ticker.js';

const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

check('product + strategy echoed', formatToolTicker('runBacktest', { product: 'BTC-USD', strategy_name: 'sma_cross' }) === '[⟳ runBacktest · BTC-USD · sma_cross]', formatToolTicker('runBacktest', { product: 'BTC-USD', strategy_name: 'sma_cross' }));
check('strategy alias echoed', formatToolTicker('deployStrategy', { strategy: 'ut_bot' }) === '[⟳ deployStrategy · ut_bot]', formatToolTicker('deployStrategy', { strategy: 'ut_bot' }));
check('asset echoed', formatToolTicker('x', { asset: 'ETH-USD' }) === '[⟳ x · ETH-USD]', formatToolTicker('x', { asset: 'ETH-USD' }));
check('no args -> bare line', formatToolTicker('getMarketState', {}) === '[⟳ getMarketState]', formatToolTicker('getMarketState', {}));
check('undefined args -> bare line', formatToolTicker('getMarketState') === '[⟳ getMarketState]', formatToolTicker('getMarketState'));
check('strategy_name wins over strategy', formatToolTicker('x', { strategy_name: 'a', strategy: 'b' }) === '[⟳ x · a]', formatToolTicker('x', { strategy_name: 'a', strategy: 'b' }));

check('dedupe collapses consecutive dupes', JSON.stringify(dedupeTickerLines(['[a]', '[a]', '[b]', '[b]', '[a]'])) === JSON.stringify(['[a]', '[b]', '[a]']));
check('dedupe keeps distinct', JSON.stringify(dedupeTickerLines(['[a]', '[b]'])) === JSON.stringify(['[a]', '[b]']));
check('dedupe empty', dedupeTickerLines([]).length === 0);

let pass = 0;
for (const r of results) { console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.extra ? '  [' + r.extra + ']' : ''}`); if (r.ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
