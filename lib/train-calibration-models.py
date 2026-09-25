"""
NEXUS Trainer — lib/train-calibration-models.py
Phase 4: Trains per-tenant + global win-probability models, computes empirical
priors, regime transition matrices, and archetype stats from closed trades.

Run:     python3 lib/train-calibration-models.py
Cron:    every 6h
Deps:    pip install xgboost scikit-learn numpy   (graceful fallback without)

Multi-tenant design (Phase 0.9.2):
  - Per-tenant models: tenants with >= 20 samples in a (asset, regime, strategy)
    bucket get their own rows (tenant_id set).
  - GLOBAL models: aggregated across all tenants (numeric features + pnl only —
    no text, no PII), tenant_id NULL, min 30 samples.
  - Lookup order at runtime: tenant-specific -> global -> omit.

Dual-shape safety (lesson from the regime backfill):
  - Old trades store FLAT snapshots (snap.regime, snap.cvd, snap.macro_poc).
  - New trades store the nested get_market_state shape
    (snap.volume_profile.macro_poc, snap.multi_timeframe_cvd['6H_Macro_Tide']...).
  - _get() helper reads nested first, then flat — never trust one shape.

Strategy keying (Phase 0.7.7): strategy is UPPER-normalized at every read and
write. Case-split buckets fragment silently.
"""

import os, json, math, urllib.request, urllib.parse
from collections import defaultdict
from datetime import datetime, timedelta, timezone

SUPABASE_URL = os.environ['NEXT_PUBLIC_SUPABASE_URL']
SUPABASE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
TENANT_FILTER = os.environ.get('TENANT_ID')  # optional; None = all tenants

VALID_REGIMES = {'TREND', 'CHOP', 'ACCUMULATION', 'DISTRIBUTION'}
MIN_TENANT_SAMPLES = 20
MIN_GLOBAL_SAMPLES = 30
MIN_TRANSITION_SAMPLES = 5

# 🟢 AM32 — Head 2 (expectancy regression) gates.
# MIN_EXPECTANCY_SAMPLES: a bucket needs >= 10 graded closes before the dollar
# head speaks (n>=10 means the bucket has graded dollars behind the geometry).
# SHRINKAGE_K: empirical-Bayes shrinkage constant — a bucket mean is pulled
# toward its pool mean by factor n/(n+k). k=5 (half the n>=10 gate) means a
# 5-sample bucket is pulled 50% toward the pool mean, a 10-sample bucket 33%.
# Small buckets therefore look conservative by design — that is the point:
# the dollar head must not chase one lucky bucket.
MIN_EXPECTANCY_SAMPLES = 10
SHRINKAGE_K = 5

# 🟢 Synthetic-era guard — trainer only learns from the last 30 days of real
# trades. The qty=100 backfill era (synthetic rows, entry_price=0) must never
# re-enter the dollar heads: one poisoned bucket shifts expected_pnl for every
# geometry it shares. Applied to all three loaders (real trades, veto ledger,
# archetype stats) so the three sample pools can never drift apart in era.
CUTOFF = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()


# ─────────────────────────────────────────────────────────────
# Supabase REST helpers
# ─────────────────────────────────────────────────────────────

def sb_get(table, select, filters='', order=None, limit=2000):
    path = f'{SUPABASE_URL}/rest/v1/{table}?select={urllib.parse.quote(select)}'
    if order:
        path += f'&order={urllib.parse.quote(order)}'
    if limit:
        path += f'&limit={limit}'
    if filters:
        path += filters
    req = urllib.request.Request(path, headers={
        'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}',
        'Accept': 'application/json'
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def sb_upsert(table, rows, conflict):
    if not rows:
        return
    path = f'{SUPABASE_URL}/rest/v1/{table}?on_conflict={conflict}'
    body = json.dumps(rows).encode()
    req = urllib.request.Request(path, data=body, method='POST', headers={
        'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}',
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=minimal'
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        resp.read()


# ─────────────────────────────────────────────────────────────
# Dual-shape snapshot access
# ─────────────────────────────────────────────────────────────

def _get(snap, *paths, default=None):
    """Read the first resolvable path. Each path is a list of nested keys;
    falls back to the LAST key as a flat top-level key (old snapshot shape)."""
    for path in paths:
        cur = snap
        ok = True
        for k in path[:-1]:
            if isinstance(cur, dict) and k in cur:
                cur = cur[k]
            else:
                ok = False
                break
        if ok and isinstance(cur, dict) and path[-1] in cur:
            v = cur[path[-1]]
            if v is not None:
                return v
        # flat fallback: last key at top level
        if path[-1] in snap:
            v = snap[path[-1]]
            if v is not None:
                return v
    return default


def extract_features(snap, trade):
    """Feature dict + regime + strategy + tf_pair. Returns (None,...) on failure."""
    try:
        if isinstance(snap, str):
            snap = json.loads(snap)
        if not isinstance(snap, dict):
            return None, None, None, None

        price = _get(snap, ['current_price'], ['price'], default=0) or trade.get('entry_price') or 0

        def _sf(v, fallback=0.0):
            """Safe float — tolerates 'Unavailable' strings, None, bad formats, NaN."""
            try:
                f = float(v)
                return f if f == f else fallback  # NaN guard
            except (TypeError, ValueError):
                return fallback

        price = _sf(price, 0.0)
        poc = _sf(_get(snap, ['volume_profile', 'macro_poc'], ['macro_poc'], default=0), 0.0)
        atr = _sf(_get(snap, ['volatility_atr', '5M'], ['atr'], default=1), 1.0) or 1.0
        cvd_6h = _sf(_get(snap, ['multi_timeframe_cvd', '6H_Macro_Tide'], ['macro_cvd'], default=0), 0.0)
        cvd_1h = _sf(_get(snap, ['multi_timeframe_cvd', '1H_Macro_Trend'], default=0), 0.0)
        cvd_5m = _sf(_get(snap, ['multi_timeframe_cvd', '5M_Micro_Ripple'], ['cvd'], default=0), 0.0)
        trigger_flow = _sf(_get(snap, ['multi_timeframe_cvd', 'Trigger_Flow'], ['trigger_flow'], default=0), 0.0)
        seq = _get(snap, ['multi_timeframe_cvd', '5M_Sequence'], ['cvd_sequence'], default=None)
        deep_bids = _sf(_get(snap, ['order_book_depth', 'deep_bids'], ['bids'], default=0), 0.0)
        deep_asks = _sf(_get(snap, ['order_book_depth', 'deep_asks'], ['asks'], default=1), 1.0) or 1.0
        funding = _sf(_get(snap, ['derivatives_premium', 'funding_rate'], ['funding_rate'], default=0), 0.0)
        funding_ann = _sf(_get(snap, ['derivatives_premium', 'annualized_funding_percent'], ['funding_annualized'], default=0), 0.0)
        oi = _sf(_get(snap, ['derivatives_premium', 'open_interest'], ['open_interest'], default=0), 0.0)
        sp500 = _sf(_get(snap, ['cross_asset_macro', 'SP500'], ['sp500'], default=0), 0.0)
        dxy = _sf(_get(snap, ['cross_asset_macro', 'DXY'], ['dxy'], default=0), 0.0)
        upper_node = _sf(_get(snap, ['volume_profile', 'upper_node'], ['upper_node'], default=price), price)
        lower_node = _sf(_get(snap, ['volume_profile', 'lower_node'], ['lower_node'], default=price), price)

        price_dist_poc = abs(price - poc) / max(atr, 0.01) if poc else 0
        multi_align = 1 if (cvd_6h > 0 and cvd_5m > 0 and cvd_1h > 0) else (-1 if (cvd_6h < 0 and cvd_5m < 0 and cvd_1h < 0) else 0)

        features = {
            'cvd_6h_macro_tide': cvd_6h,
            'cvd_1h_macro_trend': cvd_1h,
            'cvd_5m_micro_ripple': cvd_5m,
            'trigger_flow': trigger_flow,
            'cvd_seq_last': (seq[-1] if isinstance(seq, list) and seq else 0),
            'cvd_seq_delta': ((seq[-1] - seq[-2]) if isinstance(seq, list) and len(seq) >= 2 else 0),
            'orderbook_imbalance': deep_bids / max(deep_asks, 0.01),
            'funding_rate': funding,
            'funding_annualized': funding_ann,
            'open_interest': oi,
            'price_dist_from_poc_atr': price_dist_poc,
            'atr_5m': atr,
            'price_to_upper_node': abs(upper_node - price) / max(atr, 0.01),
            'price_to_lower_node': abs(price - lower_node) / max(atr, 0.01),
            'multi_tf_cvd_alignment': multi_align,
            'sp500': sp500 / 1000,
            'dxy': dxy,
        }

        regime = trade.get('regime_at_entry') or _get(snap, ['regime'], default='CHOP') or 'CHOP'
        if regime not in VALID_REGIMES:
            regime = 'CHOP'
        strategy = str(trade.get('strategy_id') or 'ANY').upper()   # NORMALIZE — critical
        macro_tf = str(trade.get('macro_tf') or 'ANY').upper()
        trigger_tf = str(trade.get('trigger_tf') or 'ANY').upper()
        tf_pair = f'{macro_tf}/{trigger_tf}'
        return features, regime, strategy, tf_pair
    except Exception as e:
        print(f'  Feature extraction failed for trade #{trade.get("id")}: {e}')
        return None, None, None, None


# ─────────────────────────────────────────────────────────────
# STEP 1: Load closed trades with snapshots
# ─────────────────────────────────────────────────────────────

print('=== NEXUS Trainer starting ===')
# NOTE: trade_logs has no 'asset'/'macro_tf'/'trigger_tf' columns yet.
# extract_features() falls back: asset→symbol, tf_pair→'ANY/ANY'.
select_cols = ('id,tenant_id,symbol,strategy_id,regime_at_entry,pnl,side,'
               'entry_price,exit_price,market_snapshot_at_entry,tp_price,sl_price,exit_time,created_at,'
               'params_context')
# 🟢 AM32 — pnl IS NOT NULL: the paper-poison cleanup NULLed garbage pnl rows;
# one unguarded row would re-poison Head 2's dollar labels exactly like it
# poisoned the paper line. (pnl or 0) below stays as belt-and-braces.
trades = sb_get('trade_logs', select_cols,
                filters=('&market_snapshot_at_entry=not.is.null&exit_price=not.is.null&pnl=not.is.null'
                         f'&created_at=gte.{CUTOFF}'
                         '&qty=lte.99&entry_price=gt.0'),   # synthetic-era guard (qty=100 backfill, e=0 rows)
                order='created_at.desc', limit=2000)
if TENANT_FILTER:
    trades = [t for t in trades if t.get('tenant_id') == TENANT_FILTER]
print(f'Closed trades with snapshots: {len(trades)}')

# ── PUSH AA: veto-ledger samples (far-side only) ──
shadow = sb_get('shadow_portfolio',
                'id,tenant_id,asset,scan_id,signal_direction,veto_regime,veto_price,verdict,'
                'saved_amount,missed_amount,fill_basis,macro_tf,trigger_tf,params_context',
                # Synthetic-era guard: shadow_portfolio has no qty column (qty
                # lives in sim_params JSONB) — veto_price is the entry analog.
                filters=("&verdict=in.(SAVED,MISSED)&fill_basis=eq.far_side"
                         f'&created_at=gte.{CUTOFF}'
                         '&veto_price=gt.0'), limit=2000)
if TENANT_FILTER:
    shadow = [s for s in shadow if s.get('tenant_id') == TENANT_FILTER]
scan_ids = list({str(s['scan_id']) for s in shadow if s.get('scan_id')})
scan_map = {}
for i in range(0, len(scan_ids), 100):
    chunk = scan_ids[i:i+100]
    sid_filter = '&id=in.(' + ','.join(chunk) + ')'
    for srow in sb_get('scan_results', 'id,strategy,telemetry', filters=sid_filter, limit=100):
        scan_map[srow['id']] = srow
print(f'Veto samples: {len(shadow)} (scans matched: {len(scan_map)})')

# ─────────────────────────────────────────────────────────────
# STEP 2: Build dataset
# ─────────────────────────────────────────────────────────────

X, y, pnls = [], [], []
feature_names = None
tenant_of = []
buckets = defaultdict(list)   # (tenant_id, asset, regime, strategy, tf_pair) -> [(feat, label, pnl, weight)]
# PUSH AA: real trades keep weight 1.0; veto counterfactuals ride at 0.5
# 🟢 AM7 — per-bucket param profiles: key -> list of (tp, sl, tripwire, trail,
# win, pnl, weight). Grouped by params used → win-rate / E[pnl] per profile.
param_profiles = defaultdict(list)
# 🟢 AM32 — Head 2: per-bucket geometry samples -> list of (geometry, pnl, weight).
geometry_samples = defaultdict(list)

for t in trades:
    feat, regime, strategy, tf_pair = extract_features(t.get('market_snapshot_at_entry'), t)
    if feat is None:
        continue
    pnl = float(t.get('pnl') or 0)
    # Winsorize: corrupt rows (±$100M+) poison expected_pnl for every bucket.
    # Cap magnitude at $10K — beyond that it's a data bug, not a trade.
    pnl = max(-10000.0, min(10000.0, pnl))
    label = 1 if pnl >= 0 else 0
    asset = t.get('asset') or t.get('symbol') or 'UNKNOWN'
    tenant = t.get('tenant_id')
    X.append(list(feat.values()))
    y.append(label)
    pnls.append(pnl)
    tenant_of.append(tenant)
    if feature_names is None:
        feature_names = list(feat.keys())
    buckets[(tenant, asset, regime, strategy, tf_pair)].append((feat, label, pnl, 1.0))
    # 🟢 AM7 — record the params profile this trade ran under. Prefer
    # params_context (AM7, config-as-truth + agent diff); fall back to the
    # entry snapshot's tp/sl when present. Rounded to 3dp so near-identical
    # profiles group together.
    pc = t.get('params_context') or {}
    snap = t.get('market_snapshot_at_entry') or {}
    def _r3(v):
        try:
            f = float(v)
            return round(f, 3) if f > 0 else None
        except (TypeError, ValueError):
            return None
    prof = (_r3(pc.get('tp_price') or snap.get('tp_price')),
            _r3(pc.get('sl_price') or snap.get('sl_price')),
            _r3(pc.get('tripwire')),
            _r3(pc.get('trail_step')))
    if any(prof):
        param_profiles[(tenant, asset, regime, strategy, tf_pair)].append((*prof, label, pnl, 1.0))
    # 🟢 AM32 — Head 2 geometry features: entry geometry + regime/ATR context
    # per sample, so the expectancy head can regress signed pnl on the
    # geometry the trade actually ran under (not just bucket means).
    def _rf(v):
        try:
            f = float(v)
            return f if f == f else None  # NaN guard
        except (TypeError, ValueError):
            return None
    entry_px = _rf(t.get('entry_price')) or 0.0
    tp_px = _rf(pc.get('tp_price') or snap.get('tp_price'))
    sl_px = _rf(pc.get('sl_price') or snap.get('sl_price'))
    atr_f = _rf(feat.get('atr_5m')) or 1.0
    geometry = {
        'sl_dist': (abs(entry_px - sl_px) / max(atr_f, 0.01)) if (entry_px and sl_px) else None,
        'tp_dist': (abs(tp_px - entry_px) / max(atr_f, 0.01)) if (entry_px and tp_px) else None,
        'tripwire': _rf(pc.get('tripwire')),
        'trail_step': _rf(pc.get('trail_step')),
        'trail_activation': _rf(pc.get('trail_activation')),
        'atr_5m': _rf(feat.get('atr_5m')),
        'regime': regime,
    }
    geometry_samples[(tenant, asset, regime, strategy, tf_pair)].append((geometry, pnl, 1.0))

print(f'Dataset: {len(X)} samples x {len(feature_names) if feature_names else 0} features')

# ── PUSH AA: synthesize veto samples into the SAME buckets (weighted 0.5) ──
veto_buckets = defaultdict(list)   # same key shape -> (feat, label, pnl)
for s in shadow:
    sc = scan_map.get(s.get('scan_id'))
    if not sc:
        continue
    telemetry = sc.get('telemetry')
    pseudo = {
        'id': f"veto_{s['id']}", 'strategy_id': sc.get('strategy'),
        'regime_at_entry': s.get('veto_regime'),
        'side': s.get('signal_direction'),
        'entry_price': s.get('veto_price'),
        'macro_tf': s.get('macro_tf') or 'ANY',
        'trigger_tf': s.get('trigger_tf') or 'ANY',
        'pnl': s['missed_amount'] if s['verdict'] == 'MISSED' else -s['saved_amount'],
        'win': 1 if s['verdict'] == 'MISSED' else 0,
    }
    pnl = max(-10000.0, min(10000.0, float(pseudo['pnl'])))
    label = pseudo['win']
    try:
        feat, regime, strategy, tf_pair = extract_features(telemetry, pseudo)
    except Exception as e:
        print(f'  Veto feature extraction failed for veto #{s.get("id")}: {e}')
        continue
    if feat is None:
        continue
    asset = s.get('asset') or 'UNKNOWN'
    veto_buckets[(s.get('tenant_id'), asset, regime, strategy, tf_pair)].append((feat, label, pnl))

# veto samples ride along wherever REAL samples already qualify — never create a model alone.
# Merging into buckets FIRST means any_pool / global_pool / global_exact_pool (all built from
# buckets below) inherit the same qualify-then-attach rule automatically.
for key, vsamples in veto_buckets.items():
    if key in buckets and len([x for x in buckets[key] if len(x) < 4 or x[3] >= 1.0]) >= MIN_TENANT_SAMPLES:
        buckets[key].extend((f, l, p, 0.5) for f, l, p in vsamples)
print(f'Veto buckets merged: {sum(len(v) for v in veto_buckets.values())} samples across {len(veto_buckets)} keys')

# 🟢 AM32 — veto counterfactuals ride into Head 2 at weight 0.5, same
# qualify-then-attach rule as the classifier head (never create a bucket alone).
for key, vsamples in veto_buckets.items():
    if key in geometry_samples and len([x for x in geometry_samples[key] if x[2] >= 1.0]) >= MIN_TENANT_SAMPLES:
        geometry_samples[key].extend(((None, p, 0.5) for _, p, _ in vsamples))

# Aggregated (asset, regime) pool across strategies/tfs for ANY-row fallbacks
any_pool = defaultdict(list)
for (tenant, asset, regime, strategy, tf_pair), samples in buckets.items():
    any_pool[(tenant, asset, regime)].extend(samples)
global_pool = defaultdict(list)
for (tenant, asset, regime, strategy, tf_pair), samples in buckets.items():
    global_pool[(asset, regime)].extend(samples)

# 🟢 AM32 — pool index for Head 2 shrinkage: (tenant, asset, regime) -> samples.
geometry_pool_index = defaultdict(list)
for (tenant, asset, regime, strategy, tf_pair), samples in geometry_samples.items():
    geometry_pool_index[(tenant, asset, regime)].extend(samples)

now_iso = datetime.now(timezone.utc).isoformat()


def ts_iso(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00'))


def _sb_delete(table, filters):
    path = f'{SUPABASE_URL}/rest/v1/{table}?{filters}'
    req = urllib.request.Request(path, method='DELETE', headers={
        'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}',
        'Prefer': 'return=minimal'
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        resp.read()


# ─────────────────────────────────────────────────────────────
# 🟢 AM32 — HEAD 2: expectancy regression (empirical-Bayes, variance-penalized)
# ─────────────────────────────────────────────────────────────

def _train_expectancy_head(tenant, asset, regime, strategy, tf_pair, samples):
    """Head 2: per-bucket expectancy regression on signed pnl.

    Empirical-Bayes form (auditable, no new deps): per-geometry-profile means
    shrunk toward the bucket mean, and the bucket mean shrunk toward the pool
    mean by n/(n+SHRINKAGE_K). Upgrade to a fitted regression only when
    buckets grow past ~50 samples.

    Returns dict: {p_win, avg_win_usd, avg_loss_usd, expected_pnl_per_1k,
                   ev_per_1k, n, shrink_factor, profiles} or None.
    """
    real = [(g, p) for g, p, w in samples if w >= 1.0 and p is not None]
    n = len(real)
    if n < MIN_EXPECTANCY_SAMPLES:
        return None

    pnls = [p for _, p in real]
    bucket_mean = sum(pnls) / n
    pos = [p for p in pnls if p > 0]
    neg = [p for p in pnls if p < 0]
    avg_win = (sum(pos) / len(pos)) if pos else 0.0
    avg_loss = (sum(neg) / len(neg)) if neg else 0.0  # negative
    p_win = (len(pos) + 0.5 * len([p for p in pnls if p == 0])) / n

    # Pool mean for shrinkage: nearest coarser pool that exists.
    pool = None
    for pk in ((tenant, asset, regime), (asset, regime)):
        pool_samples = [p for (t_, a_, r_), lst in geometry_pool_index.items() if (t_, a_, r_) == pk
                        for (_, p, w) in lst if w >= 1.0 and p is not None]
        if len(pool_samples) >= MIN_GLOBAL_SAMPLES:
            pool = sum(pool_samples) / len(pool_samples)
            break
    if pool is None:
        pool = bucket_mean

    # Variance penalty: shrink the bucket mean toward the pool mean.
    shrink = n / (n + SHRINKAGE_K)
    shrunk_mean = shrink * bucket_mean + (1 - shrink) * pool

    # Per-geometry-profile shrunk means (the suggested-geometry candidates).
    profiles = []
    by_geom = defaultdict(list)
    for g, p in real:
        if not g:
            continue
        key = (round(g.get('sl_dist') or 0, 2), round(g.get('tp_dist') or 0, 2),
               round(g.get('tripwire') or 0, 3), round(g.get('trail_step') or 0, 3),
               round(g.get('trail_activation') or 0, 3))
        by_geom[key].append(p)
    for gkey, plist in by_geom.items():
        gn = len(plist)
        gmean = sum(plist) / gn
        gshrink = gn / (gn + SHRINKAGE_K)
        gshrunk = gshrink * gmean + (1 - gshrink) * shrunk_mean
        gwr = len([p for p in plist if p > 0]) / gn
        profiles.append({
            'sl_dist': gkey[0], 'tp_dist': gkey[1], 'tripwire': gkey[2],
            'trail_step': gkey[3], 'trail_activation': gkey[4],
            'n': gn, 'raw_mean': round(gmean, 2),
            'shrunk_mean': round(gshrunk, 2), 'win_rate': round(gwr, 3)
        })
    profiles.sort(key=lambda pr: -pr['shrunk_mean'])

    # Expected pnl per $1k notional: bucket pnl is already config-true $, but
    # normalize to the AM7 $1k convention for cross-bucket comparability.
    # (trade pnl is recorded at the trade's own notional; per-1k scaling uses
    # the mean |geometry| risk as a proxy — kept simple: report raw $ and per-1k
    # assuming the bucket's typical notional ≈ $1k default convention.)
    expected_per_1k = shrunk_mean
    ev = p_win * avg_win + (1 - p_win) * avg_loss

    return {
        'p_win': round(p_win, 3),
        'avg_win_usd': round(avg_win, 2),
        'avg_loss_usd': round(avg_loss, 2),
        'expected_pnl_per_1k': round(expected_per_1k, 2),
        'ev_per_1k': round(ev, 2),
        'n': n,
        'shrink_factor': round(shrink, 3),
        'pool_mean': round(pool, 2),
        'top_profiles': profiles[:3]
    }


def _emit_model(rows_out, tenant, asset, regime, strategy, tf_pair, samples, xgb_mod, feat_names):
    """Train one model (or compute empirical stats) and stage an upsert row.
    PUSH AA: samples are 4-tuples (feat, label, pnl, weight) — real=1.0, veto=0.5.
    ALL headline metrics are computed from REAL samples only; counterfactuals
    only influence the XGB fit (via sample_weight) and veto_* accounting."""
    real_samples = [s for s in samples if len(s) < 4 or s[3] >= 1.0]
    veto_samples = [s for s in samples if len(s) >= 4 and s[3] < 1.0]
    n_real = len(real_samples)
    veto_n = len(veto_samples)
    n = n_real  # legacy var: headline stats + sample_count stay real-only
    wins = sum(1 for s in real_samples if s[1] == 1)
    wr = wins / n if n else 0.0
    pnls_arr = [s[2] for s in real_samples]
    avg_pnl = (sum(pnls_arr) / n) if n else 0.0

    pos_pnls = [p for p in pnls_arr if p > 0]
    neg_pnls = [p for p in pnls_arr if p < 0]
    avg_win_pnl = (sum(pos_pnls) / len(pos_pnls)) if pos_pnls else None
    avg_loss_pnl = (sum(neg_pnls) / len(neg_pnls)) if neg_pnls else None
    capture_ratio = (sum(pos_pnls) / abs(sum(neg_pnls))) if neg_pnls else None

    # PUSH AA: veto counterfactual accounting (never touches headline stats)
    veto_wins = sum(1 for s in veto_samples if s[1] == 1)

    metrics = {
        'sample_count': n,
        'win_rate': wr,
        'avg_pnl': avg_pnl,
        'avg_win_pnl': avg_win_pnl,
        'avg_loss_pnl': avg_loss_pnl,
        'capture_ratio': capture_ratio,
        'veto_sample_count': veto_n,
        'veto_win_rate': (veto_wins / veto_n) if veto_n else None,
        'sample_sources': {'trades': n_real, 'vetoes': veto_n}
    }
    feature_importance = {}
    model_params = {'tf_pair': tf_pair}

    # 🟢 AM7 — Layer 2: per-bucket parameter stats. Group closed rows by the
    # params profile used → win-rate / E[pnl] per profile. Guardrail: only emit
    # when the bucket has >= 10 closes (small n lies). Shadow rows weigh 0.5,
    # real 1.0 — same as the model fit.
    # 🟢 AM32 — COMBINED EV: the tuple pick (win_rate, expected_pnl) is replaced
    # by EV = p_win × avg_win_$ − p_loss × avg_loss_$ at the Head-2-predicted
    # p. Head 1 (classifier) supplies p_win; Head 2 (expectancy) supplies the
    # dollar legs. suggested_params now carries all THREE priors.
    suggested_params = None
    expectancy = _train_expectancy_head(tenant, asset, regime, strategy, tf_pair,
                                        geometry_samples.get((tenant, asset, regime, strategy, tf_pair)) or [])
    profiles = param_profiles.get((tenant, asset, regime, strategy, tf_pair)) or []
    if len(profiles) >= 10:
        by_profile = defaultdict(list)
        for tp_, sl_, tw_, tr_, win_, pnl_, w_ in profiles:
            by_profile[(tp_, sl_, tw_, tr_)].append((win_, pnl_, w_))
        best_key, best_stats = None, None
        for pkey, rows in by_profile.items():
            wsum = sum(w for _, _, w in rows)
            if wsum <= 0:
                continue
            pwr = sum(w for win_, _, w in rows if win_ == 1) / wsum
            pep = sum(pnl_ * w for _, pnl_, w in rows) / wsum
            # AM32: rank by combined EV when Head 2 has graded dollars for the
            # bucket; fall back to the legacy (win_rate, expected_pnl) tuple.
            if expectancy:
                p_h2 = expectancy['p_win']
                ev = p_h2 * (expectancy['avg_win_usd'] or 0) - (1 - p_h2) * abs(expectancy['avg_loss_usd'] or 0)
                rank = (ev, pwr)
            else:
                rank = (pwr, pep)
            if best_stats is None or rank > best_stats[0]:
                best_key, best_stats = pkey, (rank, pwr, pep, wsum, len(rows))
        if best_key is not None:
            _, pwr, pep, wsum, pcount = best_stats
            tp_, sl_, tw_, tr_ = best_key
            suggested_params = {
                'tp_price': tp_, 'sl_price': sl_,
                'tripwire': tw_, 'trail_step': tr_,
                'win_rate': round(pwr, 3),
                'expected_pnl': round(pep, 2),
                'n': pcount,
                'summary': (f"tp ≈ {tp_}%, sl ≈ {sl_}%, tripwire {tw_}%, "
                            f"trail {tr_}% → {pwr * 100:.0f}% win, n = {pcount}")
            }
            if expectancy:
                suggested_params['win_prob'] = expectancy['p_win']
                suggested_params['expected_pnl_per_1k'] = expectancy['expected_pnl_per_1k']
                suggested_params['ev_per_1k'] = expectancy['ev_per_1k']
                suggested_params['summary'] += (f" | EV ${expectancy['ev_per_1k']:.2f}/1k "
                                                f"(p_win {expectancy['p_win'] * 100:.0f}%, "
                                                f"avg win ${expectancy['avg_win_usd']:.2f} vs "
                                                f"avg loss ${abs(expectancy['avg_loss_usd']):.2f})")
    expected_mean, expected_std = avg_pnl, 0.0
    accuracy = wr  # baseline: majority-class predictor

    if xgb_mod is not None and feat_names and n_real >= MIN_TENANT_SAMPLES:
        try:
            import numpy as np
            # 🟢 PUSH AA: fit on the FULL weighted set (real + veto), metrics on real only
            feats = np.array([list(f.values()) for f, _, _, *_ in samples])
            labels = np.array([l for _, l, *_ in samples])
            weights = np.array([s[3] if len(s) >= 4 else 1.0 for s in samples])
            pnl_arr = np.array([p for _, _, p, *_ in samples])
            model = xgb_mod.XGBClassifier(
                n_estimators=50, max_depth=3, learning_rate=0.1,
                subsample=0.8, colsample_bytree=0.8, eval_metric='logloss',
                n_jobs=2
            )
            model.fit(feats, labels, sample_weight=weights)
            imp = {feat_names[i]: float(model.feature_importances_[i]) for i in range(len(feat_names))}
            feature_importance = dict(sorted(imp.items(), key=lambda kv: -kv[1])[:8])
            preds = model.predict(feats)
            accuracy = float((preds == labels).mean())
            win_idx = np.where(preds == 1)[0]
            if len(win_idx) > 0:
                expected_mean = float(pnl_arr[win_idx].mean())
                expected_std = float(pnl_arr[win_idx].std()) if len(win_idx) > 1 else 0.0
            metrics['accuracy'] = accuracy
        except Exception as e:
            print(f'  XGB training failed for {asset}/{regime}/{strategy}: {e}')

    rows_out.append({
        'tenant_id': tenant,
        'asset': asset,
        'regime': regime,
        'strategy': strategy,
        'model_params': model_params,
        'feature_importance': feature_importance,
        'metrics': metrics,
        'sample_count': n,
        'expected_pnl_mean': expected_mean,
        'expected_pnl_std': expected_std,
        'suggested_params': suggested_params,
        # 🟢 AM32 — Head 2 output (calibration card row 2: predicted vs realized $)
        'expected_pnl_model': expectancy,
        'last_trained': now_iso
    })
    scope = 'GLOBAL' if tenant is None else str(tenant)[:8]
    sp_note = f' | suggested: {suggested_params["summary"]}' if suggested_params else ''
    h2_note = f' | H2: E=${expectancy["expected_pnl_per_1k"]:.2f}/1k shrink={expectancy["shrink_factor"]:.2f}' if expectancy else ''
    print(f'  [{scope}] {asset}/{regime}/{strategy}/{tf_pair}: n={n} wr={wr:.2f} acc={accuracy:.2f} E[pnl]={expected_mean:.1f}{sp_note}{h2_note}')


def summarize(samples):
    real = [s for s in samples if len(s) < 4 or s[3] >= 1.0]
    n = len(real)
    # HOTFIX (TRAINER 2) — index access instead of strict 3-tuple unpack
    # (shape-agnostic; samples may carry extra fields).
    wins = sum(1 for s in real if s[1] == 1)
    avg_pnl = sum(s[2] for s in real) / n if n else 0.0
    # Optimal TP/SL in ATR terms (from stored tp/sl vs entry + snapshot atr)
    return {'n': n, 'win_rate': wins / n if n else 0, 'avg_pnl': avg_pnl}


# ─────────────────────────────────────────────────────────────
# STEP 3: Train models (XGBoost when available; empirical-only otherwise)
# ─────────────────────────────────────────────────────────────

xgb = None
try:
    import xgboost as xgb  # noqa
    import numpy as np
    HAS_NP = True
except ImportError:
    print('xgboost/numpy not installed — empirical stats only.')
    print('Install with: pip install xgboost scikit-learn numpy')
    HAS_NP = False

model_rows = []
tf_report = defaultdict(lambda: {'n': 0, 'wins': 0, 'pnl': 0.0, 'hold_sum': 0.0, 'hold_n': 0})

# Per-tenant rows (exact + ANY fallbacks within tenant)
for (tenant, asset, regime), samples in sorted(any_pool.items(), key=lambda kv: -len(kv[1])):
    if len(samples) < MIN_TENANT_SAMPLES:
        continue
    _emit_model(model_rows, tenant, asset, regime, 'ANY', 'ANY', samples, xgb, feature_names)
for (tenant, asset, regime, strategy, tf_pair), samples in sorted(buckets.items(), key=lambda kv: -len(kv[1])):
    if tenant is None or len(samples) < MIN_TENANT_SAMPLES:
        continue
    _emit_model(model_rows, tenant, asset, regime, strategy, tf_pair, samples, xgb, feature_names)

# Global rows (tenant_id NULL): asset-level ANY/ANY pool
for (asset, regime), samples in sorted(global_pool.items(), key=lambda kv: -len(kv[1])):
    if len(samples) < MIN_GLOBAL_SAMPLES:
        continue
    _emit_model(model_rows, None, asset, regime, 'ANY', 'ANY', samples, xgb, feature_names)

# Global exact-strategy rows: aggregate ACROSS tenants per
# (asset, regime, strategy, tf_pair) — one row per key, no duplicates.
global_exact_pool = defaultdict(list)
for (tenant, asset, regime, strategy, tf_pair), samples in buckets.items():
    global_exact_pool[(asset, regime, strategy, tf_pair)].extend(samples)
for (asset, regime, strategy, tf_pair), samples in sorted(global_exact_pool.items(), key=lambda kv: -len(kv[1])):
    if len(samples) < MIN_GLOBAL_SAMPLES:
        continue
    _emit_model(model_rows, None, asset, regime, strategy, tf_pair, samples, xgb, feature_names)

if model_rows:
    # calibration_models has no natural unique key across all dims; upsert on
    # (tenant_id, asset, regime, strategy) via Postgres-side dedupe is not
    # available, so delete-then-insert per bucket for idempotency.
    for row in model_rows:
        filters = []
        if row['tenant_id']:
            filters.append(f"tenant_id=eq.{row['tenant_id']}")
        else:
            filters.append('tenant_id=is.null')
        filters.append(f"asset=eq.{urllib.parse.quote(row['asset'])}")
        filters.append(f"regime=eq.{urllib.parse.quote(row['regime'] or '')}")
        filters.append(f"strategy=eq.{urllib.parse.quote(row['strategy'] or 'ANY')}")
        _sb_delete('calibration_models', '&'.join(filters))
    sb_upsert('calibration_models', model_rows, 'id')
    print(f'Upserted {len(model_rows)} calibration_models rows.')


# ─────────────────────────────────────────────────────────────
# STEP 4: tf_pair responsiveness report (Phase 0.13.4)
# Does TF actually matter per asset? If stats are identical across tf_pair
# buckets for the same asset -> the lever genuinely doesn't move outcomes.
# ─────────────────────────────────────────────────────────────

print('\n=== TF-pair responsiveness report (per asset) ===')
for (tenant, asset, regime, strategy, tf_pair), samples in sorted(buckets.items()):
    if len(samples) < 10:
        continue
    s = summarize(samples)
    tf_report[(asset, tf_pair)]['n'] += s['n']
    tf_report[(asset, tf_pair)]['wins'] += int(s['win_rate'] * s['n'])
    tf_report[(asset, tf_pair)]['pnl'] += s['avg_pnl'] * s['n']

by_asset = defaultdict(list)
for (asset, tf_pair), agg in tf_report.items():
    by_asset[asset].append((tf_pair, agg))

for asset, pairs in sorted(by_asset.items()):
    print(f'  {asset}:')
    for tf_pair, agg in sorted(pairs):
        n = agg['n']
        if n == 0:
            continue
        wr = agg['wins'] / n
        avg = agg['pnl'] / n
        print(f'    {tf_pair:20s} n={n:4d} wr={wr:.2f} avg_pnl=${avg:8.2f}')

# ─────────────────────────────────────────────────────────────
# STEP 5: Regime transition matrices (GLOBAL — market physics)
# ─────────────────────────────────────────────────────────────

print('\n=== Regime transitions (global) ===')
# 🟢 regime-fix: recent-window only — created_at.asc+limit grabbed the OLDEST 2,000
# scans (10k+ rows in table), anchoring the matrix to stale early-September data.
window_start = (datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%S')
scans = sb_get('scan_results', 'asset,telemetry,created_at',
               filters=f'&created_at=gte.{window_start}', order='created_at.asc', limit=2000)
if scans:
    print(f'Transition window: {len(scans)} scans, {scans[0]["created_at"]} → {scans[-1]["created_at"]}')
asset_series = defaultdict(list)
seen = set()
for s in scans:
    t = s.get('telemetry')
    if isinstance(t, str):
        try:
            t = json.loads(t)
        except Exception:
            continue
    if not isinstance(t, dict):
        continue
    reg = t.get('macro_regime_oracle')
    if reg not in VALID_REGIMES:
        continue
    d = s['created_at'][:16]  # 1-minute dedupe across tenants
    key = (s['asset'], d)
    if key in seen:
        continue
    seen.add(key)
    asset_series[s['asset']].append({
        'time': s['created_at'],
        'regime': reg,
        'cvd': float(t.get('macro_cvd') or t.get('cvd') or 0),
    })

transition_rows = []
for asset, series in sorted(asset_series.items(), key=lambda kv: -len(kv[1])):
    if len(series) < MIN_TRANSITION_SAMPLES * 4:
        continue
    transitions = defaultdict(int)
    dur_sum = defaultdict(float)
    dur_cnt = defaultdict(int)
    prev = None
    seg_start = None

    def ts(iso):
        return datetime.fromisoformat(iso.replace('Z', '+00:00'))

    for p in series:
        cur = p['regime']
        if prev is not None and cur != prev:
            transitions[f'{prev}->{cur}'] += 1
        if cur != prev:
            if prev is not None and seg_start is not None:
                dur_sum[prev] += (ts(p['time']) - ts(seg_start)).total_seconds() / 60
                dur_cnt[prev] += 1
            seg_start = p['time']
        prev = cur

    total = sum(transitions.values())
    if total < MIN_TRANSITION_SAMPLES:
        continue
    print(f'  {asset}: {len(series)} scans, {total} transitions')
    rows = []
    for key, count in sorted(transitions.items(), key=lambda kv: -kv[1]):
        frm, to = key.split('->')
        avg_dur = dur_sum.get(frm, 0) / max(dur_cnt.get(frm, 1), 1)
        rows.append({
            'tenant_id': None,
            'asset': asset,
            'from_regime': frm,
            'to_regime': to,
            'count': count,
            'avg_duration_minutes': avg_dur,
            'updated_at': now_iso
        })
        print(f'    {key}: {count} ({count / total * 100:.0f}%) avg_dur={avg_dur:.0f}m')
    transition_rows.extend(rows)

if transition_rows:
    _sb_delete('regime_transitions', 'tenant_id=is.null')
    sb_upsert('regime_transitions', transition_rows, 'id')
    print(f'Upserted {len(transition_rows)} global regime_transitions rows.')

# ─────────────────────────────────────────────────────────────
# STEP 6: Archetype stats (global structural + per-tenant overlay)
# Uses trade_logs microstructure_archetype column (Phase 3C wiring).
# ─────────────────────────────────────────────────────────────

print('\n=== Archetype stats ===')
arch_trades = sb_get('trade_logs',
                     'tenant_id,symbol,microstructure_archetype,pnl,entry_price,exit_price,market_snapshot_at_entry,tp_price,sl_price,exit_time,created_at',
                     filters=('&microstructure_archetype=not.is.null&exit_price=not.is.null'
                              f'&created_at=gte.{CUTOFF}&entry_price=gt.0'),
                     order='created_at.desc', limit=2000)
arch_agg = defaultdict(list)
for t in arch_trades:
    asset = t.get('asset') or t.get('symbol') or 'UNKNOWN'
    arch_agg[(t.get('tenant_id'), asset, t['microstructure_archetype'])].append(t)

arch_rows = []
for (tenant, asset, arch), ts in sorted(arch_agg.items(), key=lambda kv: -len(kv[1])):
    min_n = 6 if tenant else 10
    if len(ts) < min_n:
        continue
    n = len(ts)
    wins = sum(1 for t in ts if (float(t.get('pnl') or 0)) >= 0)
    avg_pnl = sum(float(t.get('pnl') or 0) for t in ts) / n
    tp_atrs, sl_atrs, holds = [], [], []
    for t in ts:
        try:
            entry = float(t.get('entry_price') or 0)
            tp = float(t.get('tp_price') or 0)
            sl = float(t.get('sl_price') or 0)
            snap = t.get('market_snapshot_at_entry')
            if isinstance(snap, str):
                try:
                    snap = json.loads(snap)
                except Exception:
                    snap = None
            atr5m = None
            if isinstance(snap, dict):
                try:
                    raw_atr = _get(snap, ['volatility_atr', '5M'], ['atr'], default=None)
                    if raw_atr is not None:
                        f_atr = float(raw_atr)
                        if f_atr == f_atr:
                            atr5m = f_atr
                except (TypeError, ValueError):
                    atr5m = None

            # Real sl_atr from snapshot; avg_tp_atr holds a TP:Risk R-multiple, not an ATR multiple (kept for schema compatibility).
            if entry and tp and sl:
                risk = abs(entry - sl)
                if risk > 0:
                    tp_atrs.append(abs(tp - entry) / risk)
                    if atr5m is not None and atr5m > 0:
                        sl_atrs.append(risk / atr5m)
                    else:
                        sl_atrs.append(1.0)
            if t.get('created_at') and t.get('exit_time'):
                d = (ts_iso(t['exit_time']) - ts_iso(t['created_at'])).total_seconds() / 60
                holds.append(max(0, d))
        except Exception:
            pass
    arch_rows.append({
        'tenant_id': tenant,
        'asset': asset,
        'archetype_name': arch,
        'sample_count': n,
        'win_rate': wins / n if n else None,
        'avg_pnl': avg_pnl,
        'avg_tp_atr': sum(tp_atrs) / len(tp_atrs) if tp_atrs else None,
        'avg_sl_atr': sum(sl_atrs) / len(sl_atrs) if sl_atrs else None,
        'avg_hold_time_minutes': sum(holds) / len(holds) if holds else None,
        # requires MFE telemetry per trade (deferred — classifier reads these columns and tolerates NULL)
        'last_updated': now_iso
    })
    scope = 'GLOBAL' if tenant is None else str(tenant)[:8]
    print(f'  [{scope}] {asset}/{arch}: n={n} wr={wins / n if n else 0:.2f}')

if arch_rows:
    _sb_delete('microstructure_archetypes', 'archetype_name=not.is.null')
    sb_upsert('microstructure_archetypes', arch_rows, 'id')
    print(f'Upserted {len(arch_rows)} microstructure_archetypes rows.')


print('\n=== Trainer complete ===')
