// mcp-gateway.js
import express from 'express';
import { executeTradeMCP } from './lib/execute-trade-mcp.js';
import { getMarketStateMCP } from './lib/get-market-state-mcp.js';

// 🟢 THE NEW TRUTH SERUM IMPORTS
import { get_open_interest_flow, get_funding_rates, get_liquidation_map } from './tools/intent-oracle.js';

const app = express();
app.use(express.json());

// 🟢 1. THE TOOL REGISTRY (What Hermes reads)
const TOOLS = {
    execute_order: {
        description: "Physically place a trade on the exchange. You MUST use this to execute your thesis.",
        parameters: {
            symbol: "string (e.g., ETH-PERP)",
            side: "string (BUY or SELL)",
            price: "number (Limit price, or current price for MARKET)",
            order_type: "string (LIMIT or MARKET)",
            qty: "number (Position size)",
            tp_price: "number (Take profit limit)",
            sl_price: "number (Stop loss trigger)",
            reason: "string (Your Oracle rationale and working thesis)"
        }
    },
    get_market_state: {
        description: "Fetch live X-Ray telemetry, Micro/Macro CVD, and historical nodes to evaluate a setup.",
        parameters: { 
            symbol: "string (e.g., ETH-PERP)" 
        }
    },
    // 🟢 THE NEW INTENT TOOLS
    get_open_interest_flow: {
        description: "Fetch Open Interest data to determine if a move is driven by new money (trend) or squeezed positions (exhaustion).",
        parameters: {
            symbol: "string (e.g., ETH-PERP)",
            macro_tf: "string",
            trigger_tf: "string"
        }
    },
    get_funding_rates: {
        description: "Fetch 8-hour and annualized funding rates to determine retail crowdedness and potential squeeze setups.",
        parameters: {
            symbol: "string (e.g., ETH-PERP)"
        }
    },
    get_liquidation_map: {
        description: "Fetch the exact price clusters where high-leverage traders will be liquidated. Use as God-Tier Take Profit targets.",
        parameters: {
            symbol: "string (e.g., ETH-PERP)"
        }
    }
};

// 🟢 2. THE DISCOVERY ENDPOINT
app.get('/mcp/tools', (req, res) => {
    res.json({ tools: TOOLS });
});

// 🟢 3. THE EXECUTION ENDPOINT (Where Hermes sends commands)
app.post('/mcp/execute', async (req, res) => {
    const { tool, arguments: args } = req.body;

    try {
        if (tool === 'execute_order') {
            console.log(`[MCP GATEWAY] Hermes Agent invoked execute_order for ${args.symbol}`);
            const result = await executeTradeMCP(args);
            return res.json({ result });
        }
        
        if (tool === 'get_market_state') {
            console.log(`[MCP GATEWAY] Hermes Agent analyzing market state for ${args.symbol}`);
            const result = await getMarketStateMCP(args); 
            return res.json({ result });                  
        }

        // 🟢 ROUTING THE NEW TRUTH SERUM TOOLS
        if (tool === 'get_open_interest_flow') {
            console.log(`[MCP GATEWAY] Hermes Agent checking OI Flow for ${args.symbol}`);
            const result = await get_open_interest_flow(args);
            return res.json({ result });
        }

        if (tool === 'get_funding_rates') {
            console.log(`[MCP GATEWAY] Hermes Agent checking Funding Rates for ${args.symbol}`);
            const result = await get_funding_rates(args);
            return res.json({ result });
        }

        if (tool === 'get_liquidation_map') {
            console.log(`[MCP GATEWAY] Hermes Agent sweeping Liquidation Map for ${args.symbol}`);
            const result = await get_liquidation_map(args);
            return res.json({ result });
        }

        return res.status(404).json({ error: `[MCP FAULT] Tool ${tool} not recognized by Gateway.` });

    } catch (error) {
        console.error(`[MCP GATEWAY FAULT]:`, error.message);
        return res.status(500).json({ error: error.message });
    }
});

// 🟢 4. THE BOOT SEQUENCE
export function startMCPGateway() {
    const PORT = process.env.MCP_PORT || 4000;
    app.listen(PORT, () => {
        console.log(`[MCP GATEWAY] Online. Hermes translation layer listening on port ${PORT}`);
    });
}