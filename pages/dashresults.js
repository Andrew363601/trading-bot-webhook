// pages/dashresults.js (or wherever your dashboard component is located)

import { useEffect, useState } from 'react';

import { createClient } from '@supabase/supabase-js';


// Initialize Supabase client for client-side fetches

const supabase = createClient(

process.env.NEXT_PUBLIC_SUPABASE_URL,

process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

);


export default function DashResults() {

const [backtestResults, setBacktestResults] = useState([]);

const [tradeLogs, setTradeLogs] = useState([]); // New state for trade logs

const [activeStrategy, setActiveStrategy] = useState(null); // Updated state for active strategy

const [loading, setLoading] = useState(true);

const [error, setError] = useState(null);


useEffect(() => {

async function fetchData() {

try {

// Fetch Top Backtest Results (from old 'backtest_results' table)

const { data: resultsData, error: resultsError } = await supabase

.from('backtest_results')

.select('*')

.order('win_rate', { ascending: false })

.limit(50);

if (resultsError) throw resultsError;

setBacktestResults(resultsData);


// Fetch Current Active Strategy (from new 'strategy_config' table)

const { data: activeStrategyData, error: activeStrategyError } = await supabase

.from('strategy_config')

.select('*')

.eq('is_active', true)

.single();

if (activeStrategyError && activeStrategyError.code !== 'PGRST116') { // PGRST116 means no row found, which is okay if no active strategy yet

throw activeStrategyError;

}

setActiveStrategy(activeStrategyData);


// Fetch Recent Trade Logs (from new 'trade_logs' table)

const { data: tradeLogsData, error: tradeLogsError } = await supabase

.from('trade_logs')

.select('*')

.order('exit_time', { ascending: false })

.limit(20);

if (tradeLogsError) throw tradeLogsError;

setTradeLogs(tradeLogsData);


} catch (err) {

console.error('Dashboard fetch error:', err.message);

setError('Failed to fetch data: ' + err.message);

} finally {

setLoading(false);

}

}


fetchData();

}, []); // Empty dependency array means this runs once on component mount


// Function to promote a backtested config to the active strategy

const deployToPaper = async (config) => {

try {

// This calls your /api/deploy-strategy endpoint

const response = await fetch('/api/deploy-strategy', {

method: 'POST',

headers: { 'Content-Type': 'application/json' },

body: JSON.stringify({

strategy: 'CCA_v1', // This should match your Pine Script strategy name

version: 'v1.0', // This should match your Pine Script version

config: config

})

});


const result = await response.json();

if (response.ok) {

alert(result.message || 'Strategy promoted!');

// Refresh active strategy after promotion

const { data: updatedActiveStrategy, error: updateError } = await supabase

.from('strategy_config')

.select('*')

.eq('is_active', true)

.single();

if (updateError && updateError.code !== 'PGRST116') throw updateError;

setActiveStrategy(updatedActiveStrategy);

} else {

alert('Failed to promote strategy: ' + (result.error || 'Unknown error'));

}

} catch (err) {

console.error('Deploy error:', err);

alert('Error deploying strategy: ' + err.message);

}

};


// Function to copy strategy config to clipboard

const copyConfig = (config) => {

const text = JSON.stringify(config, null, 2); // Copy full JSON config

navigator.clipboard.writeText(text).then(() => alert("📋 Config copied to clipboard!"));

};


if (loading) {

return (

<div className="p-6 text-center text-gray-500">

<p>Loading dashboard data...</p>

</div>

);

}


if (error) {

return (

<div className="p-6 text-center text-red-500">

<p>{error}</p>

</div>

);

}


return (

<div className="p-6 max-w-7xl mx-auto font-inter bg-gray-900 text-gray-100 min-h-screen rounded-lg shadow-lg">

{/* Active Strategy Display */}

<div className="bg-gray-800 p-6 rounded-lg mb-8 shadow-md border border-indigo-700">

<h2 className="text-3xl font-extrabold mb-4 text-indigo-400 flex items-center">

🚀 Current Active Strategy

{/* FIX: Replaced complex SVG with a simpler, self-contained rocket icon */}

<svg className="ml-2 w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">

<path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />

</svg>

</h2>

{activeStrategy ? (

<div className="text-lg space-y-2">

<p><strong className="text-indigo-300">Name:</strong> {activeStrategy.strategy || 'N/A'}</p>

<p><strong className="text-indigo-300">Version:</strong> {activeStrategy.version || 'N/A'}</p>

<p><strong className="text-indigo-300">Last Updated:</strong> {new Date(activeStrategy.last_updated).toLocaleString()}</p>

<div>

<strong className="text-indigo-300">Parameters:</strong>

<pre className="bg-gray-700 p-3 rounded-md mt-1 text-sm overflow-x-auto">

{JSON.stringify(activeStrategy.parameters, null, 2)}

</pre>

</div>

{/* Optional: Add a button to manually trigger Gemini Optimizer for testing */}

<button

onClick={async () => {

alert('Manually triggering Gemini Optimizer. Check Vercel logs!');

await fetch('/api/run-gemini-optimizer', {

method: 'POST',

headers: { 'Authorization': 'Bearer YOUR_CRON_SECRET_HERE' } // Replace with your actual CRON_SECRET for testing

});

}}

className="mt-4 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-md shadow-md transition duration-200"

>

Trigger Gemini Optimizer

</button>

</div>

) : (

<p className="text-gray-400">No active strategy deployed yet. Promote one from below!</p>

)}

</div>


{/* Top Backtest Results */}

<h2 className="text-3xl font-extrabold mb-4 text-green-400">📊 Top Backtest Results</h2>

<div className="overflow-x-auto bg-gray-800 p-4 rounded-lg shadow-md border border-green-700">

<table className="min-w-full divide-y divide-gray-700">

<thead className="bg-gray-700">

<tr>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider rounded-tl-lg">Strategy</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Version</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Win Rate</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">PnL</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Trades</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Config</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider rounded-tr-lg">Actions</th>

</tr>

</thead>

<tbody className="bg-gray-800 divide-y divide-gray-700">

{backtestResults.map((row, idx) => (

<tr key={idx} className="hover:bg-gray-700 transition duration-150 ease-in-out">

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">{row.strategy}</td>

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">{row.version}</td>

<td className="px-6 py-4 whitespace-nowrap text-sm text-green-400">{(row.win_rate * 100).toFixed(2)}%</td>

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">{row.pnl.toFixed(2)}</td>

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">{row.trades}</td>

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">

<pre className="text-xs whitespace-pre-wrap max-h-24 overflow-y-auto bg-gray-700 p-2 rounded">{JSON.stringify(row.config, null, 2)}</pre>

</td>

<td className="px-6 py-4 whitespace-nowrap text-sm font-medium">

<button

className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-md shadow-md transition duration-200 mr-2"

onClick={() => deployToPaper(row.config)}

>

🚀 Promote

</button>

<button

className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-md shadow-md transition duration-200"

onClick={() => copyConfig(row.config)}

>

📋 Copy Config

</button>

</td>

</tr>

))}

</tbody>

</table>

</div>


{/* Recent Trade Logs */}

<h2 className="text-3xl font-extrabold mb-4 mt-8 text-blue-400">📘 Recent Trade Logs</h2>

<div className="overflow-x-auto bg-gray-800 p-4 rounded-lg shadow-md border border-blue-700">

<table className="min-w-full divide-y divide-gray-700">

<thead className="bg-gray-700">

<tr>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider rounded-tl-lg">Date/Time</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Symbol</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Side</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Entry Price</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">Exit Price</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">PnL</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider">MCI Entry</th>

<th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-300 uppercase tracking-wider rounded-tr-lg">SNR Entry</th>

</tr>

</thead>

<tbody className="bg-gray-800 divide-y divide-gray-700">

{tradeLogs.map((log, idx) => (

<tr key={idx} className="hover:bg-gray-700 transition duration-150 ease-in-out">

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">{new Date(log.exit_time).toLocaleString()}</td>

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">{log.symbol || 'N/A'}</td>

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">{log.side}</td>

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">{log.entry_price?.toFixed(5) || 'N/A'}</td>

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">{log.exit_price?.toFixed(5) || 'N/A'}</td>

<td className="px-6 py-4 whitespace-nowrap text-sm">

<span className={log.pnl >= 0 ? 'text-green-500' : 'text-red-500'}>{log.pnl?.toFixed(2)}</span>

</td>

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">{log.mci_at_entry?.toFixed(3) || 'N/A'}</td>

<td className="px-6 py-4 whitespace-nowrap text-sm text-gray-200">{log.snr_score_at_entry?.toFixed(3) || 'N/A'}</td>

</tr>

))}

</tbody>

</table>

</div>


{/* Your old Alerts and Executions (consider integrating into Trade Logs if redundant) */}

{/*

<h2 style={{ marginTop: 40 }}>📡 Recent Alerts (Original)</h2>

<ul>

{alerts.map((alert, i) => (

<li key={i}>

{alert.timestamp} — {alert.symbol} @ {alert.price} ({alert.side})

</li>

))}

</ul>


<h2 style={{ marginTop: 40 }}>📘 Execution Log (Original)</h2>

<ul>

{executions.map((exec, i) => (

<li key={i}>

{exec.timestamp} — {exec.symbol} {exec.side} @ {exec.entry_price} ({exec.status})

</li>

))}

</ul>

*/}

</div>

);

}


