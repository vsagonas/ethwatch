'use strict';

const dbm = require('../db');

// AI 7-DAY FORECAST — a pattern-completion engine.
// Feeds Claude Sonnet 4.6 the full stack:
//   • 90 days of daily ETH closes + moves + verdicts (3-month tape)
//   • 30 days of categorized headlines (crypto / macro / hope)
//   •  7 days of recent daily detail (hope/macro scores + summaries)
//   • today's expanded headline set + market vitals + order flow
// Asks for a 28-point (every 6h × 7d) trajectory that mirrors a chosen
// historical analog — including realistic intra-week pullbacks.

const Anthropic = require('@anthropic-ai/sdk');
const dbm = require('../db');

const TTL = 30 * 60 * 1000; // 30min cache
let cache = { data: null, ts: 0 };

const SYSTEM_PROMPT = `You are ETHWATCH's 7-DAY FORECAST ENGINE. You read:
 • daily_90d — 3 months of daily ETH closes, day %, BTC %, and stored daily verdicts.
 • news_30d — 1 month of categorized headlines (crypto / macro / hope), one entry per day.
 • last_7_days — rich daily detail for the last week (hope_score 0-100, macro_score -100..+100, Claude daily summary).
 • today — expanded headline set for today across all three categories.
 • vitals — current technicals (EMA20/50/200, MACD, Bollinger bandwidth), funding rate, OI, BTC dominance, Fear & Greed, gas, hash rate.
 • order_flow — aggregate buy_vol / sell_vol / ratio over 5m, 1h, 24h.

CORE METHOD — PATTERN COMPLETION (this is non-negotiable):
1. Scan the daily_90d tape for prior windows structurally similar to the CURRENT last_7_days setup. Similar means: close sequence shape, daily % pattern (momentum + pullbacks), comparable verdict mix, comparable macro/hope regime.
2. When you identify the strongest analog, study what happened in the 7 days AFTER that analog. Use that post-analog behavior as the skeleton of your new forecast.
3. Modulate by the differences between then-and-now: macro score, hope score, funding/OI extremes, today's news catalysts, order-flow imbalance over 5m/1h/24h.
4. A real 7-day path is NEVER a straight line. Your trajectory MUST contain at least one counter-trend day and realistic intraday wiggle, mirroring the analog's behavior. A bullish 7-day call with +5% expected still has pullback days; a bearish call still has relief bounces.

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
function gatherContext() {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const from90 = new Date(now - 90 * 86400000).toISOString().slice(0, 10);
  const from30 = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  const from7  = new Date(now -  7 * 86400000).toISOString().slice(0, 10);

  const sent90 = dbm.getSentimentRange(from90, today);

  const daily_90d = sent90.map(r => ({
    date:    r.date,
    close:   r.eth_price,
    eth_pct: r.eth_move_pct,
    btc_pct: r.btc_move_pct,
    verdict: r.verdict,
  }));

  // 30-day news — one row per date with top headlines per category.
  const dates30 = [];
  for (let d = new Date(from30); d <= new Date(today); d = new Date(d.getTime() + 86400000)) {
    dates30.push(d.toISOString().slice(0, 10));
  }
  const news_30d = dates30.map(d => ({
    date:   d,
    crypto: dbm.getHeadlines(d, 3, 'crypto').map(h => ({ s: h.source, t: h.title })),
    macro:  dbm.getHeadlines(d, 2, 'macro' ).map(h => ({ s: h.source, t: h.title })),
    hope:   dbm.getHeadlines(d, 1, 'hope'  ).map(h => ({ s: h.source, t: h.title })),
  }));

  // 7-day rich detail.
  const last_7_days = sent90
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

  const currentPrice = daily_90d.length
    ? daily_90d[daily_90d.length - 1].close
    : vitals?.technicals?.price ?? null;

  return {
    asof: new Date(now).toISOString(),
    current_eth_price_usd: currentPrice,
    daily_90d,
    news_30d,
    last_7_days,
    today: todayNews,
    vitals,
    order_flow: {
      '5m':  flowSummary(flow5m),
      '1h':  flowSummary(flow1h),
      '24h': flowSummary(flow24h),
    },
  };
}

async function buildForecast() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const context = gatherContext();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    tools: [FORECAST_TOOL],
    tool_choice: { type: 'tool', name: 'submit_forecast' },
    messages: [{ role: 'user', content: JSON.stringify(context) }],
  });

  const toolUse = resp.content?.find(c => c.type === 'tool_use' && c.name === 'submit_forecast');
  if (!toolUse) throw new Error(`Forecast tool skipped (stop_reason=${resp.stop_reason})`);

  const forecast = toolUse.input;
  forecast.model         = 'claude-sonnet-4-6';
  forecast.generated_ts  = Date.now();
  forecast.anchor_ts     = Date.now();
  forecast.anchor_price  = context.current_eth_price_usd;
  forecast.horizon       = '7d';

  // Persist to prediction history
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

  return forecast;
}

async function getForecast({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.ts < TTL) return cache.data;
  const data = await buildForecast();
  cache = { data, ts: Date.now() };
  return data;
}

module.exports = { getForecast };
