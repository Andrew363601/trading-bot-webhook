import React, { useState, useEffect } from 'react';

// --- Configuration ---
const SUPABASE_URL = "https://wsrioyxzhxxrtzjncfvn.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_urfO8raB60QtvBa89wHp3w_bw3wXdMb";
const VERCEL_OPTIMIZER_URL = "/api/run-gemini-optimizer"; // Using relative path since they are in the same project
const CRON_SECRET = "za9gWknHfXmhH3TDLVBuj8uUA7bE4dsp";

export default function Dashboard() {
  const [supabase, setSupabase] = useState(null);
  const [activeStrategy, setActiveStrategy] = useState(null);
  const [tradeLogs, setTradeLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [optimizerLoading, setOptimizerLoading] = useState(false);
  const [optimizerMessage, setOptimizerMessage] = useState('');

  // 1. Dynamically load Supabase Script
  useEffect(() => {
    const supabaseCdnUrl = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
    
    if (document.querySelector(`script[src="${supabaseCdnUrl}"]`)) {
      if (window.supabase) setSupabase(window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
      return;
    }

    const script = document.createElement('script');
    script.src = supabaseCdnUrl;
    script.async = true;
    script.onload = () => {
      if (window.supabase) {
        setSupabase(window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
      } else {
        setError("Supabase client not found. Check network.");
        setLoading(false);
      }
    };
    script.onerror = () => {
        setError("Failed to load the Supabase client script.");
        setLoading(false);
    };
    document.body.appendChild(script);

    return () => {
      const existingScript = document.querySelector(`script[src="${supabaseCdnUrl}"]`);
      if (existingScript) document.body.removeChild(existingScript);
    };
  }, []);

  // 2. Fetch Data when Supabase is ready
  useEffect(() => {
    if (supabase) {
      fetchData();
    }
  }, [supabase]);

  const fetchData = async () => {
    if (!supabase) return;
    setLoading(true);
    setError(null);

    try {
      // Fetch Strategy
      const { data: strat, error: stratErr } = await supabase
        .from('strategy_config')
        .select('*')
        .eq('is_active', true)
        .single();

      if (stratErr && stratErr.code !== 'PGRST116') throw stratErr;
      setActiveStrategy(strat);

      // Fetch Trade Logs
      const { data: logs, error: logsErr } = await supabase
        .from('trade_logs')
        .select('*')
        .order('exit_time', { ascending: false })
        .limit(20);

      if (logsErr) throw logsErr;
      setTradeLogs(logs || []);

    } catch (err) {
      console.error('Dashboard fetch error:', err);
      setError(err.message || "Failed to fetch data.");
    } finally {
      setLoading(false);
    }
  };

  const triggerGeminiOptimizer = async () => {
    setOptimizerLoading(true);
    setOptimizerMessage('Triggering optimizer...');
    setError(null);
    try {
      const response = await fetch(VERCEL_OPTIMIZER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CRON_SECRET}` 
        },
      });

      const result = await response.json();
      if (response.ok) {
        setOptimizerMessage(result.message || 'Optimizer triggered successfully! Refreshing data...');
        setTimeout(fetchData, 2000); // Give DB time to update
      } else {
        throw new Error(result.error || `Failed to trigger optimizer: ${response.statusText}`);
      }
    } catch (err) {
      setOptimizerMessage('Error triggering optimizer: ' + err.message);
    } finally {
      setOptimizerLoading(false);
    }
  };

  if (loading) {
    return (
      <div style={styles.centerContainer}>
        <div style={styles.spinner}></div>
        <p>Loading dashboard data...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{...styles.centerContainer, color: '#e63946'}}>
        <h3>An Error Occurred:</h3>
        <pre style={styles.errorBox}>{error}</pre>
        <p style={{fontSize: '12px', color: '#666', marginTop: '10px'}}>
          *Note: If your Supabase instance is paused, this error is expected.
        </p>
        <button onClick={() => window.location.reload()} style={styles.button}>Try Again</button>
      </div>
    );
  }

  return (
    <div style={styles.appContainer}>
      <h1 style={styles.header}>Trading Coherence Dashboard</h1>

      <div style={styles.card}>
        <h2 style={{marginTop: 0, color: '#1d3557'}}>Current Active Strategy</h2>
        {activeStrategy ? (
          <div>
            <p><strong>Strategy Name:</strong> {activeStrategy.strategy || 'N/A'}</p>
            <p><strong>Version:</strong> {activeStrategy.version || 'N/A'}</p>
            <p><strong>Last Optimized:</strong> {new Date(activeStrategy.last_updated).toLocaleString()}</p>
            <div>
              <strong>Parameters:</strong>
              <pre style={styles.codeBlock}>
                {JSON.stringify(activeStrategy.parameters, null, 2)}
              </pre>
            </div>
            <button 
              onClick={triggerGeminiOptimizer} 
              disabled={optimizerLoading}
              style={{...styles.button, opacity: optimizerLoading ? 0.6 : 1}}
            >
              {optimizerLoading ? 'Optimizing...' : 'Trigger Gemini Optimizer'}
            </button>
            {optimizerMessage && <p style={{marginTop: '10px', color: '#457b9d', fontWeight: 'bold'}}>{optimizerMessage}</p>}
          </div>
        ) : (
          <p>No active strategy found. Please ensure a row in your 'strategy_config' table has the 'is_active' column set to 'true'.</p>
        )}
      </div>

      <h2 style={{marginTop: '2rem', color: '#1d3557'}}>Recent Trade Logs</h2>
      <div style={styles.card}>
        <div style={{overflowX: 'auto'}}>
          <table style={styles.table}>
            <thead>
              <tr style={styles.tableHeader}>
                <th style={{padding: '12px 8px'}}>Date/Time</th>
                <th style={{padding: '12px 8px'}}>Symbol</th>
                <th style={{padding: '12px 8px'}}>Side</th>
                <th style={{padding: '12px 8px'}}>Entry Price</th>
                <th style={{padding: '12px 8px'}}>Exit Price</th>
                <th style={{padding: '12px 8px'}}>PnL</th>
              </tr>
            </thead>
            <tbody>
              {tradeLogs.length > 0 ? (
                  tradeLogs.map((log, idx) => (
                    <tr key={log.id || idx} style={styles.tableRow}>
                      <td style={{padding: '12px 8px'}}>{new Date(log.exit_time).toLocaleString()}</td>
                      <td style={{padding: '12px 8px', fontWeight: 'bold'}}>{log.symbol || 'N/A'}</td>
                      <td style={{padding: '12px 8px'}}>
                        <span style={{
                          backgroundColor: log.side === 'LONG' ? '#e6f4ea' : '#fce8e6', 
                          color: log.side === 'LONG' ? '#137333' : '#c5221f',
                          padding: '4px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 'bold'
                        }}>
                          {log.side}
                        </span>
                      </td>
                      <td style={{padding: '12px 8px'}}>{log.entry_price?.toFixed(5) || 'N/A'}</td>
                      <td style={{padding: '12px 8px'}}>{log.exit_price?.toFixed(5) || 'N/A'}</td>
                      <td style={{padding: '12px 8px', color: log.pnl >= 0 ? '#137333' : '#c5221f', fontWeight: 'bold'}}>
                        {log.pnl >= 0 ? '+' : ''}{log.pnl?.toFixed(2) || '0.00'}
                      </td>
                    </tr>
                  ))
              ) : (
                  <tr>
                      <td colSpan="6" style={{textAlign: 'center', padding: '30px', color: '#666'}}>No trade logs found in the database.</td>
                  </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Basic inline styles so it looks good without a complex Tailwind/CSS setup in StackBlitz
const styles = {
  appContainer: { fontFamily: 'system-ui, -apple-system, sans-serif', padding: '20px', backgroundColor: '#f4f4f9', minHeight: '100vh', color: '#333' },
  centerContainer: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', fontFamily: 'system-ui, sans-serif' },
  header: { textAlign: 'center', color: '#1d3557', marginBottom: '30px', fontSize: '2.5rem', fontWeight: '900' },
  card: { backgroundColor: 'white', padding: '25px', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06)' },
  codeBlock: { backgroundColor: '#1d3557', color: '#a8dadc', padding: '15px', borderRadius: '8px', overflowX: 'auto', marginTop: '10px', fontSize: '14px' },
  button: { backgroundColor: '#457b9d', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '6px', cursor: 'pointer', marginTop: '15px', fontWeight: 'bold', fontSize: '16px' },
  errorBox: { backgroundColor: '#fce8e6', color: '#c5221f', padding: '15px', borderRadius: '8px', border: '1px solid #f5c6cb', maxWidth: '600px', whiteSpace: 'pre-wrap' },
  table: { width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px' },
  tableHeader: { borderBottom: '2px solid #e5e7eb', color: '#6b7280', textTransform: 'uppercase', fontSize: '12px' },
  tableRow: { borderBottom: '1px solid #f3f4f6' },
  spinner: { width: '40px', height: '40px', border: '4px solid #f3f3f3', borderTop: '4px solid #457b9d', borderRadius: '50%', animation: 'spin 1s linear infinite' }
};