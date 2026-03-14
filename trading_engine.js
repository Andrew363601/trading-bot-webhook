/**
 * PATH 2: STANDALONE COHERENCE ENGINE (Node.js) - ALPHA VERSION
 * ---------------------------------------------------------
 * Features: Live Metric Monitoring, Dual Conviction Entry, and Coherence Decay Exit.
 */

import 'dotenv/config'; 
import axios from 'axios';
import { ADX } from 'technicalindicators'; 
import { RestClientV5 } from 'bybit-api';
import dns from 'node:dns';

// Force IPv4 for DNS stability
dns.setDefaultResultOrder('ipv4first');

// --- 1. ENVIRONMENT ---
const SUPABASE_URL = "https://wsrioyxzhxxrtzjncfvn.supabase.co"; 
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_KEY?.trim();
const BYBIT_API_KEY = process.env.BYBIT_API_KEY?.trim(); 
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET?.trim();

if (!SUPABASE_KEY) {
    console.error("❌ FATAL: SUPABASE_SERVICE_ROLE_KEY missing.");
    process.exit(1);
}

// --- 2. INITIALIZATION ---
const bybit = new RestClientV5({
    key: BYBIT_API_KEY,
    secret: BYBIT_API_SECRET,
    testnet: true // Paper trading enabled
});

const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

// --- ENGINE STATE ---
let activeConfig = null;
let currentPosition = null; 
const SYMBOL = "DOGEUSDT";
const INTERVAL = "5"; 
const TRADE_QTY = "100"; 
let initialSyncDone = false;

/**
 * 3. STRATEGY SYNC (Anti-Bot REST)
 */
async function syncStrategy() {
    try {
        const response = await axios({
            method: 'get',
            url: `${SUPABASE_URL}/rest/v1/strategy_config?is_active=eq.true&select=*`,
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'User-Agent': userAgents[0]
            },
            timeout: 10000
        });

        const data = response.data?.[0];
        if (!data) return;
        
        activeConfig = data;
        if (!initialSyncDone) {
            console.log(`\n[SYS] 🛰️  Engine Synced. Strategy: ${data.strategy}`);
            initialSyncDone = true;
        }
    } catch (err) {
        process.stdout.write("!"); 
    }
}

/**
 * 4. DATA INGESTION
 */
async function fetchBybitKlines(symbol, interval) {
    try {
        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=50`;
        const response = await axios.get(url, { timeout: 10000 });
        return response.data.result.list.map(k => ({
            close: parseFloat(k[4]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            volume: parseFloat(k[5])
        })).reverse(); 
    } catch (err) {
        return [];
    }
}

/**
 * 5. INDICATOR ENGINE
 */
function calculateMetrics(ohlcv) {
    if (ohlcv.length < 30 || !activeConfig) return null;

    const closes = ohlcv.map(c => c.close);
    const highs = ohlcv.map(c => c.high);
    const lows = ohlcv.map(c => c.low);
    const volumes = ohlcv.map(c => c.volume);

    const adxResults = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const currentADX = adxResults[adxResults.length - 1]?.adx || 0;

    const params = typeof activeConfig.parameters === 'string' ? JSON.parse(activeConfig.parameters) : activeConfig.parameters;
    const lookback = params.lookback_period || 10;
    
    const priceChange = Math.abs(closes[closes.length - 1] - closes[closes.length - lookback]);
    let volatility = 0;
    for (let i = closes.length - lookback; i < closes.length; i++) {
        volatility += Math.abs(closes[i] - closes[i-1]);
    }
    const snr = volatility > 0 ? priceChange / volatility : 0;
    const mci = (currentADX / 60 + snr) / 2;

    const avgVol = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const isVolSpike = volumes[volumes.length - 1] > (avgVol * 2.0);

    return { adx: currentADX, snr, mci, isVolSpike, price: closes[closes.length - 1] };
}

/**
 * 6. EXECUTION LOGIC
 */
async function runEngine() {
    await syncStrategy();
    if (!activeConfig) return;

    const ohlcv = await fetchBybitKlines(SYMBOL, INTERVAL);
    const m = calculateMetrics(ohlcv);
    if (!m) return;

    const params = typeof activeConfig.parameters === 'string' ? JSON.parse(activeConfig.parameters) : activeConfig.parameters;
    const threshold = params.coherence_threshold || 0.65;

    // --- LIVE MONITORING OUTPUT ---
    process.stdout.write(`\r[${new Date().toLocaleTimeString()}] MCI: ${m.mci.toFixed(3)} | ADX: ${m.adx.toFixed(1)} | SNR: ${m.snr.toFixed(2)} | VOL: ${m.isVolSpike ? '🔥' : '..'} | POS: ${currentPosition ? 'LONG' : 'NONE'}`);

    // ENTRY LOGIC
    if (m.mci >= threshold && m.isVolSpike && !currentPosition) {
        console.log(`\n>>> 🚀 RESONANCE DETECTED! Entering Long at ${m.price}`);
        const order = await bybit.submitOrder({
            category: 'linear', symbol: SYMBOL, side: 'Buy', orderType: 'Market', qty: TRADE_QTY
        });
        if (order.retCode === 0) {
            currentPosition = { entry: m.price, mci: m.mci };
            await axios.post(`${SUPABASE_URL}/rest/v1/trade_logs`, {
                symbol: SYMBOL, side: 'LONG', entry_price: m.price, mci_at_entry: m.mci
            }, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }});
        }
    }

    // EXIT LOGIC (Coherence Decay)
    if (currentPosition && m.mci < (threshold * 0.85)) {
        console.log(`\n>>> 📉 COHERENCE DECAY. Closing Position at ${m.price}`);
        const order = await bybit.submitOrder({
            category: 'linear', symbol: SYMBOL, side: 'Sell', orderType: 'Market', qty: TRADE_QTY
        });
        if (order.retCode === 0) {
            const pnl = m.price - currentPosition.entry;
            await axios.post(`${SUPABASE_URL}/rest/v1/trade_logs`, {
                symbol: SYMBOL, side: 'EXIT', pnl: pnl, exit_price: m.price, exit_time: new Date().toISOString()
            }, { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }});
            currentPosition = null;
        }
    }
}

console.log("\n=========================================");
console.log(" PATH 2 ENGINE: LIVE MONITORING ACTIVE");
console.log("=========================================");
setInterval(runEngine, 5000); // 5-second pulse for faster response