import { useEffect, useState } from 'react';

export default function DashResults() {
  const [results, setResults] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [executions, setExecutions] = useState([]);
  const [activeStrategy, setActiveStrategy] = useState(null);

  useEffect(() => {
    fetch('/api/get-results').then(res => res.json()).then(setResults);
    fetch('/api/get-alerts').then(res => res.json()).then(setAlerts);
    fetch('/api/get-executions').then(res => res.json()).then(setExecutions);
    fetch('/api/get-active-strategy').then(res => res.json()).then(setActiveStrategy);
  }, []);

  const deployToPaper = async (config) => {
    try {
      const response = await fetch('/api/deploy-strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, strategy: 'QQE-ATR', version: 'v1.0' })
      });

      const result = await response.json();
      alert(result.message || 'Strategy deployed');
    } catch (err) {
      console.error('Deploy error:', err);
    }
  };

  const copyConfig = (config) => {
    const text = `// Paste into Pine Script settings:\natr_mult = ${config.atr_mult}\ntp_mult = ${config.tp_mult}\nqqe_rsi_len = ${config.qqe_rsi_len}\nqqe_smooth = ${config.qqe_smooth}`;
    navigator.clipboard.writeText(text).then(() => alert("📋 Config copied to clipboard!"));
  };

  return (
    <div style={{ padding: 20 }}>
      <h1>Top Backtest Results</h1>
      {activeStrategy && (
        <div style={{ marginBottom: 20 }}>
          <strong>🚀 Current Strategy:</strong> {activeStrategy.strategy} v{activeStrategy.version}
        </div>
      )}
      <table border="1" cellPadding={8}>
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Version</th>
            <th>Win Rate</th>
            <th>PNL</th>
            <th>Trades</th>
            <th>ATR</th>
            <th>TP</th>
            <th>RSI Len</th>
            <th>Smoothing</th>
            <th colSpan={2}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {results.map((row, i) => (
            <tr key={i}>
              <td>{row.strategy}</td>
              <td>{row.version}</td>
              <td>{(row.win_rate * 100).toFixed(2)}%</td>
              <td>{row.pnl}</td>
              <td>{row.trades}</td>
              <td>{row.config?.atr_mult}</td>
              <td>{row.config?.tp_mult}</td>
              <td>{row.config?.qqe_rsi_len}</td>
              <td>{row.config?.qqe_smooth}</td>
              <td>
                <button
                  onClick={() => deployToPaper(row.config)}
                  style={{ padding: '4px 8px', backgroundColor: '#28a745', color: '#fff', border: 'none', cursor: 'pointer' }}>
                  Promote
                </button>
              </td>
              <td>
                <button
                  onClick={() => copyConfig(row.config)}
                  style={{ padding: '4px 8px', backgroundColor: '#007bff', color: '#fff', border: 'none', cursor: 'pointer' }}>
                  Copy Config
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ marginTop: 40 }}>📡 Recent Alerts</h2>
      <ul>
        {alerts.map((alert, i) => (
          <li key={i}>
            {alert.timestamp} — {alert.symbol} @ {alert.price} ({alert.side})
          </li>
        ))}
      </ul>

      <h2 style={{ marginTop: 40 }}>📘 Execution Log</h2>
      <ul>
        {executions.map((exec, i) => (
          <li key={i}>
            {exec.timestamp} — {exec.symbol} {exec.side} @ {exec.entry_price} ({exec.status})
          </li>
        ))}
      </ul>
    </div>
  );
}
