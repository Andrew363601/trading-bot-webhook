// pages/results.js

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

export default function Results() {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchResults() {
      const { data, error } = await supabase
        .from('backtest_results')
        .select('*')
        .order('win_rate', { ascending: false })
        .limit(50);

      if (error) console.error('Fetch error:', error);
      else setResults(data);
      setLoading(false);
    }

    fetchResults();
  }, []);

  const deployToPaper = async (config) => {
    try {
      const response = await fetch('/api/deploy-strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config })
      });

      const result = await response.json();
      alert(result.message || 'Strategy deployed');
    } catch (err) {
      console.error('Deploy error:', err);
    }
  };

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Top Strategy Results</h1>
      {loading ? (
        <p>Loading results...</p>
      ) : (
        <table className="min-w-full border">
          <thead>
            <tr className="bg-gray-100">
              <th className="border p-2">Win Rate</th>
              <th className="border p-2">PnL</th>
              <th className="border p-2">Trades</th>
              <th className="border p-2">Config</th>
              <th className="border p-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {results.map((row, idx) => (
              <tr key={idx} className="border-t">
                <td className="border p-2">{(row.win_rate * 100).toFixed(2)}%</td>
                <td className="border p-2">{row.pnl}</td>
                <td className="border p-2">{row.trades}</td>
                <td className="border p-2">
                  <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(row.config, null, 2)}</pre>
                </td>
                <td className="border p-2">
                  <button
                    className="bg-green-600 hover:bg-green-700 text-white px-3 py-1 rounded"
                    onClick={() => deployToPaper(row.config)}
                  >
                    🚀 Deploy to Paper
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}