// lib/get-daily-pnl-mcp.js
// MCP tool that computes the current day's realized PnL for a tenant.
// Called by Hermes Agent to track progress toward the $1,000 daily target.

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

/**
 * Fetches today's realized PnL (paper + live) for a given tenant.
 * @param {object} args - { tenant_id: string }
 * @returns {{ paper_pnl: number, live_pnl: number, total_pnl: number, target: number }}
 */
export async function getDailyPnlMCP(args) {
    const tenantId = args?.tenant_id;

    if (!tenantId) {
        console.warn('[DAILY PNL MCP] No tenant_id provided, returning zero PnL.');
        return {
            paper_pnl: 0,
            live_pnl: 0,
            total_pnl: 0,
            target: 1000,
            remaining_to_target: 1000
        };
    }

    const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        {
            global: { WebSocket: WebSocket },
            realtime: { transport: WebSocket }
        }
    );

    try {
        // Calculate midnight (UTC) for today's trades
        const now = new Date();
        const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)).toISOString();

        // Fetch all closed trades from today with a PnL value
        const { data: trades, error } = await supabase
            .from('trade_logs')
            .select('pnl, execution_mode')
            .eq('tenant_id', tenantId)
            .gte('exit_time', todayStart)
            .not('pnl', 'is', null);

        if (error) {
            console.error('[DAILY PNL MCP] Query failed:', error.message);
            return {
                paper_pnl: 0,
                live_pnl: 0,
                total_pnl: 0,
                target: 1000,
                remaining_to_target: 1000,
                error: error.message
            };
        }

        // Aggregate by execution mode
        let paperPnl = 0;
        let livePnl = 0;

        for (const trade of trades || []) {
            const pnl = parseFloat(trade.pnl) || 0;
            if (trade.execution_mode === 'LIVE') {
                livePnl += pnl;
            } else {
                paperPnl += pnl;
            }
        }

        const totalPnl = parseFloat((paperPnl + livePnl).toFixed(2));
        const dailyTarget = 1000;

        return {
            paper_pnl: parseFloat(paperPnl.toFixed(2)),
            live_pnl: parseFloat(livePnl.toFixed(2)),
            total_pnl: totalPnl,
            target: dailyTarget,
            remaining_to_target: parseFloat(Math.max(0, dailyTarget - totalPnl).toFixed(2))
        };

    } catch (err) {
        console.error('[DAILY PNL MCP] Unexpected error:', err.message);
        return {
            paper_pnl: 0,
            live_pnl: 0,
            total_pnl: 0,
            target: 1000,
            remaining_to_target: 1000,
            error: err.message
        };
    }
}
