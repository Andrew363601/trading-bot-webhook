// mcp-gateway.js
import express from 'express';
import { executeTradeMCP } from './lib/execute-trade-mcp.js';
import { getMarketStateMCP } from './lib/get-market-state-mcp.js';

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
            const result = await getMarketStateMCP(args); // 🟢 Uncommented
            return res.json({ result });                  // 🟢 Uncommented
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