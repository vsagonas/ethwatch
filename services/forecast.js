'use strict';

// AI 7-DAY FORECAST — a pattern-completion engine.
// Feeds Claude Sonnet 4.6 the full stack:
//   • 90 days of daily ETH closes + moves + verdicts (3-month tape)
//   • 30 days of categorized headlines (crypto / macro / hope)
//   •  7 days of recent daily detail (hope/macro scores + summaries)
//   • today's expanded headline set + market vitals + order flow
// Asks for a 28-point (every 6h × 7d) trajectory that mirrors a chosen
// historical analog — including realistic intra-week pullbacks.

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const dbm = require('../db');

const TTL = 30 * 60 * 1000; // 30min cache
const cache = { data: null, ts: 0 };

// Short hash so each prompt version is identifiable in saved predictions.
const promptHash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

const SYSTEM_PROMPT = `You are ETHWATCH's 7-DAY FORECAST ENGINE. You read:
 • daily_90d — 3 months of daily ETH closes, day %, BTC %, and stored daily verdicts.
 • news_30d — 1 month of categorized headlines (crypto / macro / hope), one entry per day.
 • last_7_days — rich daily detail for the last week (hope_score 0-100, macro_score -100..+100, Claude daily summary).
 • today — expanded headline set for today across all three categories.
 • user_posts — community/social posts with hope_score, war_score, people_sentiment (null if none imported). Use as retail street-level sentiment signal.
 • vitals — current technicals (EMA20/50/200, MACD, Bollinger bandwidth), funding rate, OI, BTC dominance, Fear & Greed, gas, hash rate.
 • order_flow — aggregate buy_vol / sell_vol / ratio over 5m, 1h, 24h.

CORE METHOD — PATTERN COMPLETION (this is non-negotiable):
1. Scan the daily_90d tape for prior windows structurally similar to the CURRENT last_7_days setup. Similar means: close sequence shape, daily % pattern (momentum + pullbacks), comparable verdict mix, comparable macro/hope regime.
2. When you identify the strongest analog, study what happened in the 7 days AFTER that analog. Use that post-analog behavior as the skeleton of your new forecast.
3. Modulate by the differences between then-and-now: macro score, hope score, funding/OI extremes, today's news catalysts, order-flow imbalance over 5m/1h/24h.
4. A real 7-day path is NEVER a straight line. Your trajectory MUST contain at least one counter-trend day and realistic intraday wiggle, mirroring the analog's behavior. A bullish 7-day call with +5% expected still has pullback days; a bearish call still has relief bounces.

FRICTION-VS-FUEL DISCIPLINE (funding rate):
- Funding tells you about FRICTION or FUEL, not both. Match language to magnitude:
  • Extreme negative funding (< -0.02% per 8h, or multi-day persistent negatives) = real FUEL for a squeeze. "Coiled spring" language allowed.
  • Mildly negative funding (-0.01% to 0%) = low FRICTION, not stored fuel. Shorts aren't being paid enough to hold through a rally, but there is no squeeze thesis. Never say "squeeze incoming" from a single mildly negative print.
  • Neutral / slightly positive funding = no squeeze thesis at all; don't invent one.
- Calibrate confidence and sizing to match: low friction ≠ high fuel. Being honest about which regime you're in makes the forecast more actionable.

ETH/BTC RATIO — REGIME FILTER, NOT ENTRY TIMING:
Treat the ratio as a REGIME CLASSIFIER, not a precise timing signal.
- Sustained downtrend in ETH/BTC = capital rotating into BTC dominance. In this regime, ETH-bullish setups have a LOWER COMPLETION RATE regardless of local technicals. Your forecast should discount bullish patterns here and widen downside bands.
- When ETH/BTC turns and holds a HIGHER LOW, rotation is beginning. The same bullish setups that fail in the downtrend regime start completing.
- CONFIRMATION: a single higher low is suggestive; a SECOND higher low is the confirmation. Without the second higher low, treat rotation as tentative.
- LEAD TIME: historically anywhere from a few days to 2–3 weeks before price follows. Useful as a regime filter for a 7-day forecast, NOT as an entry-timing tool inside the window. Do not claim tighter lead times than the data supports.
- Call out the current regime explicitly in key_drivers: "ETH/BTC regime: downtrend (discount bullish setups)" or "ETH/BTC regime: turning — first higher low at X, awaiting second for confirmation."

WHAT TO SUBMIT via submit_forecast (call it exactly once, no prose):
 • direction, confidence (0-1), expected_move_pct — overall 7-day call.
 • headline — one committed sentence (no hedging language).
 • pattern_match — name the historical analog with explicit date range (e.g. "Jan 14-20 2026: same low-volatility compression after a macro shock, hope 62→68, macro -18→-6") and why it matches.
 • narrative — 3 to 5 sentences walking setup → analog → projected path → main risk.
 • daily_breakdown — exactly 7 entries, day 1 through 7 (tomorrow = day 1). Each has expected_move_pct, a one-sentence narrative, and optional key_event (e.g. "FOMC minutes Wed", "ETF flow data Thu").
 • trajectory — EXACTLY 28 points, one every 6 hours:
     offset_hours: 6, 12, 18, 24, 30, 36, 42, 48, 54, 60, 66, 72, 78, 84, 90, 96, 102, 108, 114, 120, 126, 132, 138, 144, 150, 156, 162, 168.
   Each point: expected_eth_price + low + high (80% confidence band).
   The trajectory MUST anchor near current_eth_price_usd at offset_hours=6 and land near current_eth_price_usd × (1 + expected_move_pct/100) at offset_hours=168. Include realistic oscillation consistent with the analog and daily_breakdown — do NOT produce a monotonic line.
 • key_drivers — bullet points citing SPECIFIC data (numbers + headline sources + dates). No vague statements.
 • risks — what invalidates this call (specific events or threshold moves).

Tone: commit. You are staking reputation on these numbers. Cite headline sources when they matter. Use numbers, not adjectives.`;

const FORECAST_TOOL = {
  name: 'submit_forecast',
  description: 'Submit the 7-day ETH forecast with pattern analog + 28-point trajectory.',
  input_schema: {
    type: 'object',
    properties: {
      direction:         { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
      confidence:        { type: 'number', description: '0 to 1.' },
      expected_move_pct: { type: 'number', description: 'Expected ETH % move over the 7-day horizon (can be negative).' },
      headline:          { type: 'string', description: 'One-sentence committed verdict.' },
      pattern_match: {
        type: 'object',
        properties: {
          analog_dates: { type: 'string', description: 'Date range of the chosen historical analog, e.g. "2026-01-14 to 2026-01-20".' },
          similarity:   { type: 'string', description: 'Why this analog matches the current setup.' },
          outcome:      { type: 'string', description: 'What happened over the 7 days FOLLOWING that analog.' },
        },
        required: ['analog_dates', 'similarity', 'outcome'],
      },
      narrative:   { type: 'string', description: '3-5 sentences.' },
      key_drivers: { type: 'array', items: { type: 'string' } },
      risks:       { type: 'array', items: { type: 'string' } },
      daily_breakdown: {
        type: 'array',
        description: 'Exactly 7 entries, day=1..7.',
        items: {
          type: 'object',
          properties: {
            day:               { type: 'number' },
            expected_move_pct: { type: 'number' },
            narrative:         { type: 'string' },
            key_event:         { type: 'string' },
          },
          required: ['day', 'expected_move_pct', 'narrative'],
        },
      },
      trajectory: {
        type: 'array',
        description: 'Exactly 28 entries at offset_hours 6, 12, 18, ..., 168 (every 6h for 7 days).',
        items: {
          type: 'object',
          properties: {
            offset_hours:       { type: 'number' },
            expected_eth_price: { type: 'number' },
            low:                { type: 'number' },
            high:               { type: 'number' },
          },
          required: ['offset_hours', 'expected_eth_price'],
        },
      },
    },
    required: ['direction', 'confidence', 'expected_move_pct', 'headline', 'pattern_match', 'narrative', 'daily_breakdown', 'trajectory'],
  },
};

// ── CONTEXT ASSEMBLY ───────────────────────────────────────
// historyDays: how many days of daily bars + news Claude sees for pattern matching.
// Supported: 7, 15, 30, 90 (default 90).
function gatherContext(historyDays = 90) {
  const days = Math.max(7, Math.min(90, historyDays));
  const now = Date.now();
  const today  = new Date(now).toISOString().slice(0, 10);
  const fromN  = new Date(now - days * 86400000).toISOString().slice(0, 10);
  // News window: same as history, capped at 30 (NewsAPI only keeps 30 days anyway)
  const newsD  = Math.min(days, 30);
  const fromNews = new Date(now - newsD * 86400000).toISOString().slice(0, 10);
  const from7  = new Date(now - 7 * 86400000).toISOString().slice(0, 10);

  const sentAll = dbm.getSentimentRange(fromN, today);

  const daily_Nd = sentAll.map(r => ({
    date:    r.date,
    close:   r.eth_price,
    eth_pct: r.eth_move_pct,
    btc_pct: r.btc_move_pct,
    verdict: r.verdict,
  }));

  // News window
  const newsDates = [];
  for (let d = new Date(fromNews); d <= new Date(today); d = new Date(d.getTime() + 86400000)) {
    newsDates.push(d.toISOString().slice(0, 10));
  }
  const news_Nd = newsDates.map(d => ({
    date:   d,
    crypto: dbm.getHeadlines(d, 3, 'crypto').map(h => ({ s: h.source, t: h.title })),
    macro:  dbm.getHeadlines(d, 2, 'macro' ).map(h => ({ s: h.source, t: h.title })),
    hope:   dbm.getHeadlines(d, 1, 'hope'  ).map(h => ({ s: h.source, t: h.title })),
  }));

  // Last 7 days of rich detail (always 7 regardless of history window)
  const last_7_days = sentAll
    .filter(r => r.date >= from7)
    .map(r => ({
      date:         r.date,
      close:        r.eth_price,
      eth_pct:      r.eth_move_pct,
      btc_pct:      r.btc_move_pct,
      verdict:      r.verdict,
      hope_score:   r.hope_score,
      macro_score:  r.macro_score,
      summary:      r.summary,
    }));

  // Today — bigger headline set.
  const todayNews = {
    crypto: dbm.getHeadlines(today, 10, 'crypto').map(h => ({ s: h.source, t: h.title })),
    macro:  dbm.getHeadlines(today,  6, 'macro' ).map(h => ({ s: h.source, t: h.title })),
    hope:   dbm.getHeadlines(today,  4, 'hope'  ).map(h => ({ s: h.source, t: h.title })),
  };

  const vitals = dbm.getLatestVitals?.() || null;

  const flow5m  = dbm.getTradeSummary(now -  5 * 60 * 1000);
  const flow1h  = dbm.getTradeSummary(now - 60 * 60 * 1000);
  const flow24h = dbm.getTradeSummary(now - 24 * 60 * 60 * 1000);
  const flowSummary = (s) => ({
    buy_vol:  +(s.buy_vol  || 0).toFixed(2),
    sell_vol: +(s.sell_vol || 0).toFixed(2),
    ratio:    (s.buy_vol + s.sell_vol) > 0 ? +(s.buy_vol / (s.buy_vol + s.sell_vol)).toFixed(3) : null,
  });

  const currentPrice = daily_Nd.length
    ? daily_Nd[daily_Nd.length - 1].close
    : vitals?.technicals?.price ?? null;

  // Community/user posts for the past 30 days — retail sentiment signal
  const postsFrom = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  const rawPosts  = dbm.getUserPostsRange?.(postsFrom, today) ?? [];
  const user_posts = rawPosts.length ? rawPosts.map(p => ({
    date: p.date,
    source: p.source,
    hope_score: p.hope_score,
    war_score: p.war_score,
    people_sentiment: p.people_sentiment,
    summary: p.summary || p.content?.slice(0, 150),
  })) : null;

  return {
    asof: new Date(now).toISOString(),
    history_days: days,
    current_eth_price_usd: currentPrice,
    [`daily_${days}d`]: daily_Nd,
    [`news_${newsD}d`]: news_Nd,
    last_7_days,
    today: todayNews,
    user_posts,
    vitals,
    order_flow: {
      '5m':  flowSummary(flow5m),
      '1h':  flowSummary(flow1h),
      '24h': flowSummary(flow24h),
    },
  };
}

async function buildForecast({ historyDays = 90, bias = 'neutral', persist = true, model = 'claude-sonnet-4-6' } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const context = gatherContext(historyDays);

  // Optional bias directive appended to user message
  let biasNote = '';
  if (bias === 'bullish') {
    biasNote = '\n\n⚡ DIRECTIVE: Generate a BULLISH / UPWARD continuation forecast. Find the bullish analog that best fits the current setup. The overall expected_move_pct MUST be positive. Model an upward trajectory with realistic pullbacks along the way.';
  } else if (bias === 'bearish') {
    biasNote = '\n\n⚡ DIRECTIVE: Generate a BEARISH / DOWNWARD continuation forecast. Find the bearish analog that best fits the current setup. The overall expected_move_pct MUST be negative. Model a downward trajectory with realistic relief bounces along the way.';
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    tools: [FORECAST_TOOL],
    tool_choice: { type: 'tool', name: 'submit_forecast' },
    messages: [{ role: 'user', content: JSON.stringify(context) + biasNote }],
  });

  const toolUse = resp.content?.find(c => c.type === 'tool_use' && c.name === 'submit_forecast');
  if (!toolUse) throw new Error(`Forecast tool skipped (stop_reason=${resp.stop_reason})`);

  const forecast = toolUse.input;
  forecast.model         = model;
  forecast.generated_ts  = Date.now();
  forecast.anchor_ts     = Date.now();
  forecast.anchor_price  = context.current_eth_price_usd;
  forecast.horizon       = '7d';
  forecast.history_days  = context.history_days;
  if (bias !== 'neutral') forecast.bias = bias;
  // Save the exact prompt used so we can review which prompt versions
  // produce accurate vs inaccurate forecasts later.
  forecast.prompt = {
    kind: 'forecast.single',
    system: SYSTEM_PROMPT,
    user_bias_directive: biasNote || null,
    prompt_hash: promptHash(SYSTEM_PROMPT),
  };

  // Persist to prediction history (skip when persist=false, e.g. combined sub-runs)
  if (persist) {
    try {
      const targetDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      dbm.savePrediction({
        type: 'ai_forecast',
        source_ref: forecast.pattern_match?.analog_dates ?? '7D forecast',
        predicted_direction: forecast.direction,
        predicted_move_pct: forecast.expected_move_pct,
        confidence: forecast.confidence != null ? Math.round(forecast.confidence * 100) : null,
        horizon: '7d',
        target_date: targetDate,
        eth_price_at_prediction: context.current_eth_price_usd,
        narrative: forecast.narrative,
        raw_result: forecast,
      });
    } catch { /* non-fatal */ }
  }

  return forecast;
}

// ── COMBINED MULTI-WINDOW FORECAST ─────────────────────────────────
// Runs 4 independent forecasts (7d/15d/30d/60d), then asks Claude to
// synthesise them into a single consensus forecast.
async function buildCombinedForecast({ onProgress, model = 'claude-sonnet-4-6', windows } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  // Default windows: 4 layers (Sonnet). Opus "max layers" passes [7,15,30,60,90].
  const subWindows = windows && windows.length ? windows : [7, 15, 30, 60];
  const totalSteps = subWindows.length + 1;
  const results = [];

  for (let i = 0; i < subWindows.length; i++) {
    const d = subWindows[i];
    const label = `Running ${d}-day window…`;
    const pct = Math.round(((i) / totalSteps) * 80);
    if (onProgress) onProgress({ step: i + 1, total: totalSteps, label, pct });

    const fc = await buildForecast({ historyDays: d, bias: 'neutral', persist: false, model });
    results.push({ window: d, fc });
  }

  // Final step — synthesis
  if (onProgress) onProgress({ step: totalSteps, total: totalSteps, label: 'Synthesizing consensus…', pct: 85 });

  const compactSummaries = results.map(({ window, fc }) => ({
    window_days: window,
    direction: fc.direction,
    confidence: fc.confidence,
    expected_move_pct: fc.expected_move_pct,
    headline: fc.headline,
    analog_dates: fc.pattern_match?.analog_dates,
    key_drivers: fc.key_drivers,
    risks: fc.risks,
    daily_breakdown: fc.daily_breakdown,
  }));

  const SYNTHESIS_SYSTEM = `You are ETHWATCH's MULTI-WINDOW CONSENSUS ENGINE. You receive 4 independent ETH 7-day forecasts each built from a different historical data window:
- 7-day window: captures very recent momentum and short-term micro-patterns
- 15-day window: smooths noise, shows medium-term trend continuation signals
- 30-day window: one full month of macro context and larger swing patterns
- 60-day window: broad macro regime — captures major structural trends

SYNTHESIS RULES:
1. If 3 or more windows agree on direction → that direction is HIGH confidence.
2. A 2-2 split → use the macro windows (30d/60d) as the tiebreaker; reduce confidence.
3. Weight expected_move_pct as a simple average, then adjust ±20% based on confidence of agreement.
4. The trajectory MUST be anchored to the current ETH price from the windows' anchor_price field. Do NOT produce a monotonic line — include realistic oscillation consistent with the agreed analog.
5. Synthesise a single realistic daily_breakdown (7 entries) that integrates the most common key events across all windows.
6. narrative must explain the multi-window synthesis: what short windows say vs what macro windows say, and why the final call follows the consensus or macro tiebreaker.

Call submit_forecast exactly once with the synthesised consensus.`;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model,
    max_tokens: 8000,
    system: SYNTHESIS_SYSTEM,
    tools: [FORECAST_TOOL],
    tool_choice: { type: 'tool', name: 'submit_forecast' },
    messages: [{
      role: 'user',
      content: `Here are ${subWindows.length} independent ETH 7-day forecasts from different data windows. Synthesise them into a single consensus forecast:\n\n${JSON.stringify(compactSummaries, null, 2)}\n\nBuild the consensus via submit_forecast. Anchor the trajectory to the current ETH price. Include realistic oscillation — not a straight line.`,
    }],
  });

  const toolUse = resp.content?.find(c => c.type === 'tool_use' && c.name === 'submit_forecast');
  if (!toolUse) throw new Error(`Synthesis tool skipped (stop_reason=${resp.stop_reason})`);

  const synthesis = toolUse.input;
  synthesis.model          = model;
  synthesis.generated_ts   = Date.now();
  synthesis.anchor_ts      = Date.now();
  synthesis.anchor_price   = results[0]?.fc?.anchor_price ?? null;
  synthesis.horizon        = '7d';
  synthesis.history_days   = Math.max(...subWindows);
  synthesis.combined       = true;
  synthesis.source_windows = subWindows;
  synthesis.prompt = {
    kind: 'forecast.combined',
    system: SYNTHESIS_SYSTEM,
    sub_forecast_system: SYSTEM_PROMPT,
    prompt_hash: promptHash(SYNTHESIS_SYSTEM + '|' + SYSTEM_PROMPT),
  };

  // Persist
  try {
    const targetDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const tag = model.includes('opus') ? 'opus-max' : 'combined';
    dbm.savePrediction({
      type: 'ai_forecast',
      source_ref: `${tag}:${subWindows.join('d+')}d`,
      predicted_direction: synthesis.direction,
      predicted_move_pct: synthesis.expected_move_pct,
      confidence: synthesis.confidence != null ? Math.round(synthesis.confidence * 100) : null,
      horizon: '7d',
      target_date: targetDate,
      eth_price_at_prediction: synthesis.anchor_price,
      narrative: synthesis.narrative,
      raw_result: synthesis,
    });
  } catch { /* non-fatal */ }

  // Set live cache
  cache.data = synthesis;
  cache.ts   = Date.now();

  return synthesis;
}

async function getForecast({ force = false, historyDays = 90, bias = 'neutral' } = {}) {
  // Always serve cache/DB — NEVER auto-call Claude. Claude runs only on explicit
  // admin button press (force=true). Cache TTL no longer triggers refresh.
  if (!force) {
    if (cache.data) return cache.data;
    // Cold start: seed from DB so the first client request has data.
    const rows = dbm.getPredictions(1, 'ai_forecast');
    if (rows.length && rows[0].raw_result) {
      cache.data = rows[0].raw_result;
      cache.ts   = Date.now();
      return cache.data;
    }
    // Nothing cached, nothing in DB — fail loudly so the client shows empty state.
    throw new Error('No forecast available. Run one from the admin panel.');
  }
  // Explicit force (admin button) — call Claude now.
  const data = await buildForecast({ historyDays, bias });
  cache.data = data;
  cache.ts   = Date.now();
  return data;
}

module.exports = { getForecast, buildForecast, buildCombinedForecast, getCache: () => cache };
