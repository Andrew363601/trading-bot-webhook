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
from datetime import datetime, timezone

SUPABASE_URL = os.environ['NEXT_PUBLIC_SUPABASE_URL']
SUPABASE_KEY = os.environ['SUPABASE_SERVICE_ROLE_KEY']
TENANT_FILTER = os.environ.get('TENANT_ID')  # optional; None = all tenants

VALID_REGIMES = {'TREND', 'CHOP', 'ACCUMULATION', 'DISTRIBUTION'}
MIN_TENANT_SAMPLES = 20
MIN_GLOBAL_SAMPLES = 30
MIN_TRANSITION_SAMPLES = 5


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
               'entry_price,exit_price,market_snapshot_at_entry,tp_price,sl_price,exit_time,created_at')
trades = sb_get('trade_logs', select_cols,
                filters='&market_snapshot_at_entry=not.is.null&exit_price=not.is.null',
                order='created_at.desc', limit=2000)
if TENANT_FILTER:
    trades = [t for t in trades if t.get('tenant_id') == TENANT_FILTER]
print(f'Closed trades with snapshots: {len(trades)}')

# ─────────────────────────────────────────────────────────────
# STEP 2: Build dataset
# ─────────────────────────────────────────────────────────────

X, y, pnls = [], [], []
feature_names = None
tenant_of = []
buckets = defaultdict(list)   # (tenant_id, asset, regime, strategy, tf_pair) -> [(feat, label, pnl)]

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
    buckets[(tenant, asset, regime, strategy, tf_pair)].append((feat, label, pnl))

print(f'Dataset: {len(X)} samples x {len(feature_names) if feature_names else 0} features')

# Aggregated (asset, regime) pool across strategies/tfs for ANY-row fallbacks
any_pool = defaultdict(list)
for (tenant, asset, regime, strategy, tf_pair), samples in buckets.items():
    any_pool[(tenant, asset, regime)].extend(samples)
global_pool = defaultdict(list)
for (tenant, asset, regime, strategy, tf_pair), samples in buckets.items():
    global_pool[(asset, regime)].extend(samples)

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


def _emit_model(rows_out, tenant, asset, regime, strategy, tf_pair, samples, xgb_mod, feat_names):
    """Train one model (or compute empirical stats) and stage an upsert row."""
    n = len(samples)
    wins = sum(1 for _, l, _ in samples if l == 1)
    wr = wins / n
    pnls_arr = [p for _, _, p in samples]
    avg_pnl = sum(pnls_arr) / n

    pos_pnls = [p for p in pnls_arr if p > 0]
    neg_pnls = [p for p in pnls_arr if p < 0]
    avg_win_pnl = (sum(pos_pnls) / len(pos_pnls)) if pos_pnls else None
    avg_loss_pnl = (sum(neg_pnls) / len(neg_pnls)) if neg_pnls else None
    capture_ratio = (sum(pos_pnls) / abs(sum(neg_pnls))) if neg_pnls else None

    metrics = {
        'sample_count': n,
        'win_rate': wr,
        'avg_pnl': avg_pnl,
        'avg_win_pnl': avg_win_pnl,
        'avg_loss_pnl': avg_loss_pnl,
        'capture_ratio': capture_ratio
    }
    feature_importance = {}
    model_params = {'tf_pair': tf_pair}
    expected_mean, expected_std = avg_pnl, 0.0
    accuracy = wr  # baseline: majority-class predictor

    if xgb_mod is not None and feat_names and n >= MIN_TENANT_SAMPLES:
        try:
            import numpy as np
            feats = np.array([list(f.values()) for f, _, _ in samples])
            labels = np.array([l for _, l, _ in samples])
            pnl_arr = np.array([p for _, _, p in samples])
            model = xgb_mod.XGBClassifier(
                n_estimators=50, max_depth=3, learning_rate=0.1,
                subsample=0.8, colsample_bytree=0.8, eval_metric='logloss',
                n_jobs=2
            )
            model.fit(feats, labels)
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
        'last_trained': now_iso
    })
    scope = 'GLOBAL' if tenant is None else str(tenant)[:8]
    print(f'  [{scope}] {asset}/{regime}/{strategy}/{tf_pair}: n={n} wr={wr:.2f} acc={accuracy:.2f} E[pnl]={expected_mean:.1f}')


def summarize(samples):
    n = len(samples)
    wins = sum(1 for _, l, _ in samples if l == 1)
    avg_pnl = sum(p for _, _, p in samples) / n
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
    for _, _, _ in samples:
        pass
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
scans = sb_get('scan_results', 'asset,telemetry,created_at', order='created_at.asc', limit=2000)
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
                     filters='&microstructure_archetype=not.is.null&exit_price=not.is.null',
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
