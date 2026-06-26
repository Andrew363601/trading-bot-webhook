-- 028-site-content.sql
-- Replaces Wix CMS. Stores all landing-page content in Supabase.
-- Public read, authenticated write — admin page edits go live immediately.

-- ---------------------------------------------------------------------------
-- 1. CREATE TABLE
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.site_content (
    id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    section_key text UNIQUE NOT NULL,
    content     jsonb NOT NULL,
    updated_at  timestamptz DEFAULT now()
);

COMMENT ON TABLE public.site_content IS
    'Landing-page content store replacing Wix CMS. Editable via /admin.';

-- ---------------------------------------------------------------------------
-- 2. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.site_content ENABLE ROW LEVEL SECURITY;

-- Anyone can read (public landing page)
CREATE POLICY "Allow read for all"
    ON public.site_content FOR SELECT
    USING (true);

-- Only authenticated users can write (admin page)
CREATE POLICY "Allow write for authenticated"
    ON public.site_content FOR ALL
    USING (auth.role() = 'authenticated')
    WITH CHECK (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------------
-- 3. SEED DATA (from lib/wix-content.js FALLBACK_CONTENT)
-- ---------------------------------------------------------------------------
INSERT INTO public.site_content (section_key, content) VALUES
('hero', '{"title":"Stop Trading.","titleGradient":"Start Executing.","subtitle":"The world''s first autonomous, self-learning quantitative trading agent built for the retail trader. Don''t just automate your strategy. Arm it with institutional-grade AI.","ctaConnect":"Deploy Your Agent","ctaDashboard":"Launch Dashboard","trialText":"7-Day Free Trial. Deploy your first autonomous agent in minutes."}'::jsonb),
('features', '[{"title":"Institutional Reasoning","body":"Nexus AI scans the 6H Macro Tide, the 1H Trend, and the 5M Tape. If a setup tries to catch a falling knife, Nexus AI vetoes the trade to protect your capital."},{"title":"Agentic Reflection","body":"Nexus AI runs a post-mortem on every closed trade. If a setup fails, it extracts the math and writes a permanent rule to its Core Memory. It learns from its trauma."},{"title":"Multi-TF X-Ray","body":"Real-time Level 2 spoof detection, volume node mapping, and structural fractal stop-losses. It calculates the exact Reward-to-Risk ratio before entering."}]'::jsonb),
('differentiators', '[{"title":"Quantum Confluence Matrix™","body":"Five tiers of telemetry fused into one signal — ETF flows, Volume Profile, OI & funding, Cumulative Volume Delta, and L2/L3 order-book spoofing defense."},{"title":"Agentic Reflection™","body":"The agent remembers its own theses. Every wake cycle inherits the previous reasoning, last ~20 trades, and a shadow portfolio of past vetoes for true object permanence."},{"title":"The Accountant Protocol","body":"A hard-coded Risk-to-Reward floor of 1.5 that no AI override can bypass. Macro thesis can never break immutable risk parameters."},{"title":"Ghost Orders (Virtual Trap)","body":"Phantom limit orders staged at structural levels with short expiries — visualized on radar, designed to harvest liquidity sweeps without exposure."},{"title":"Split-Brain Execution","body":"A live CHOP vs TREND regime declaration triggers entirely different rule sets — aggressive trailing in trend, mean-reversion discipline in chop."},{"title":"Self-Healing Infrastructure","body":"Missing entry prices autofix, orphaned brackets auto-cancel, and 30-second dedup keep the execution layer clean without you touching it."}]'::jsonb),
('pricing', '[{"name":"Retail","price":"$49","popular":false,"features":["Up to 3 active trading models simultaneously (e.g., BTC, ETH, and SOL)","Standard polling execution pipeline","Flat-rate fair use — no complex metered overages to track","Full Agentic Reflection, Multi-TF X-Ray, Discord Log Feed, and Nexus Core Memory logging"]},{"name":"Pro","price":"$149","popular":true,"features":["Up to 10 active trading models simultaneously","High-priority, sub-second streaming updates","Flat-rate fair use optimized for high-frequency strategies","Full Agentic Reflection, Multi-TF X-Ray, Discord Log Feed, Nexus Chat AI Integration, and Nexus Core Memory logging"]},{"name":"Institutional","price":"$499","popular":false,"features":["Unlimited active trading models","Direct raw WebSocket pipeline with zero throttling","Uncapped custom execution pool","Custom AI Model integration via OpenRouter, Full Agentic Reflection, Multi-TF X-Ray, and custom Risk-to-Reward Accountant Protocol hard-locks"]}]'::jsonb),
('testimonials', '[{"name":"Marcus T.","plan":"Retail","quote":"I was tired of rewriting Pine Script every time I changed my mind. Now Nexus handles execution while I focus on higher-level strategy.","total_pnl":4850,"closed_trades":37},{"name":"Sarah K.","plan":"Pro","quote":"I''ve been running my ETH scalper for 3 weeks and it''s already up $2,100. The 5-tier confluence catches things my old setup never saw.","total_pnl":2100,"closed_trades":18},{"name":"David L.","plan":"Retail","quote":"The Accountant Protocol saved me from a 3x loss on my first week alone. Worth every cent just for that safety net.","total_pnl":1250,"closed_trades":12}]'::jsonb)
ON CONFLICT (section_key) DO NOTHING;