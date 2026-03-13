/**
 * PATH 2: STANDALONE COHERENCE ENGINE (Node.js)
 * ---------------------------------------------------------
 * Features: Real Indicator Calculation & Volume Regime Filtering.
 * Requirement: npm install technicalindicators axios @supabase/supabase-js
 */

import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import { ADX, SMA } from 'technicalindicators'; 

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BYBIT_API_KEY = process.env.BYBIT_API_KEY; // Get these from Bybit Settings
const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- ENGINE STATE ---
let activeConfig = null;
let currentPosition = null; 
const SYMBOL = "DOGEUSDT";
const INTERVAL = "5"; // 5-minute candles

/**
 * 1. STRATEGY SYNC
 * Pulls the latest R(ΨC) parameters optimized by Gemini.
 */
async function syncStrategy() {
    try {
        const { data, error } = await supabase
            .from('strategy_config')
            .select('*')
            .eq('is_active', true)
            .single();
        
        if (error) throw error;
        activeConfig = data;
        console.log(`[SYS] Strategy Synced: ${data.strategy} v${data.version}`);
    } catch (err) {
        console.error("[ERR] Strategy sync failed:", err.message);
    }
}

/**
 * 2. DATA INGESTION (Bybit Public API)
 */
async function fetchBybitKlines(symbol, interval, limit = 50) {
    try {
        const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const response = await axios.get(url);
        return response.data.result.list.map(k => ({
            start: parseFloat(k[0]),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5])
        })).reverse(); // Bybit returns newest first, we need chronological
    } catch (err) {
        console.error("[ERR] Data fetch failed:", err.message);
        return [];
    }
}

/**
 * 3. INDICATOR CALCULATION (LOCAL)
 */
function calculateInternalMetrics(ohlcv) {
    if (ohlcv.length < 30) return null;

    const closes = ohlcv.map(c => c.close);
    const highs = ohlcv.map(c => c.high);
    const lows = ohlcv.map(c => c.low);
    const volumes = ohlcv.map(c => c.volume);

    // --- Component 1: ADX ---
    const adxInput = {
        high: highs,
        low: lows,
        close: closes,
        period: 14
    };
    const adxResults = ADX.calculate(adxInput);
    const currentADX = adxResults[adxResults.length - 1]?.adx || 0;

    // --- Component 2: Efficiency Ratio (SNR) ---
    const lookback = activeConfig?.parameters?.er_len || 10;
    const priceChange = Math.abs(closes[closes.length - 1] - closes[closes.length - lookback]);
    let volatility = 0;
    for (let i = closes.length - lookback; i < closes.length; i++) {
        volatility += Math.abs(closes[i] - closes[i-1]);
    }
    const efficiencyRatio = volatility > 0 ? priceChange / volatility : 0;

    // --- Component 3: Volume Spike (Regime Filter) ---
    const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const currentVolume = volumes[volumes.length - 1];
    const volMultiplier = activeConfig?.parameters?.vol_spike_mult || 2.5;
    const volSpike = currentVolume > (avgVolume * volMultiplier);

    const mci = (currentADX / 60 + efficiencyRatio) / 2;

    return { adx: currentADX, snr: efficiencyRatio, volSpike, mci };
}

/**
 * 4. THE MAIN LOOP
 */
async function runEngine() {
    console.log(`\n--- ENGINE HEARTBEAT: ${new Date().toLocaleTimeString()} ---`);
    
    await syncStrategy();
    if (!activeConfig) return;

    const ohlcv = await fetchBybitKlines(SYMBOL, INTERVAL);
    const metrics = calculateInternalMetrics(ohlcv);
    
    if (!metrics) return;

    const threshold = activeConfig?.parameters?.coherence_threshold || 0.7;
    const isResonant = metrics.mci >= threshold;

    console.log(`[ANALYSIS] Symbol: ${SYMBOL}`);
    console.log(`[METRICS] MCI: ${metrics.mci.toFixed(2)} | ADX: ${metrics.adx.toFixed(1)} | SNR: ${metrics.snr.toFixed(2)}`);
    console.log(`[REGIME] Volume Spike: ${metrics.volSpike ? '🚨 YES' : 'NO'}`);

    if (isResonant && metrics.volSpike && !currentPosition) {
        console.log(">>> [SIGNAL] DUAL CONVICTION REACHED. TRIGGERING BYBIT...");
        
        // This is where the Bybit Order code will go next
        currentPosition = { side: 'LONG', entry: ohlcv[ohlcv.length - 1].close };
        
        // Log to Supabase for Dashboard visibility
        await supabase.from('trade_logs').insert([{
            symbol: SYMBOL,
            side: 'LONG',
            entry_price: currentPosition.entry,
            mci_at_entry: metrics.mci,
            snr_score_at_entry: metrics.snr
        }]);
    }
}

// Start Engine
console.log("Path 2 Standalone Engine starting...");
setInterval(runEngine, 10000); // Pulse every 10 seconds