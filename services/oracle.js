'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const dbm = require('../db');

const promptHash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

const SYSTEM_PROMPT = `You are the ORACLE — a crypto market foresight engine. The user hands you a saved "marker set": a named collection of candles they think form a repeatable pattern, along with their own hypothesis about what should happen next.

For each marker point you receive the day's OHLC, ETH/BTC moves, stored sentiment verdict, and top headlines from that day. You also receive the most recent 30-day market context (per-day ETH close, ETH + BTC %, hope score, macro score, top headlines) plus the current ETH price. Your job:

1. Look for what the marker days have in common — price structure, news themes, regime.
2. Compare that pattern to the CURRENT 30-day context. If the current tape is structurally similar to the marker days, the pattern is "firing".
3. Judge whether the user's hypothesis is supported by the evidence.
4. Project what tends to happen after such days — direction, magnitude, horizon.
5. Generate a daily ETH price trajectory for the next 30 days starting from tomorrow (offset_days 1..30). The trajectory must begin near the current ETH price and evolve consistent with your direction + expected_move_pct. Include low/high bounds for an ~80% confidence band.

Be concrete. Cite headlines by source when they matter. Avoid hedging language like "it depends" — commit to a direction with a confidence number you'd stake real capital on.

Call the submit_prophecy tool exactly once. No prose outside the tool call.`;

const ORACLE_TOOL = {
  name: 'submit_prophecy',
  description: 'Deliver the Oracle prediction for a marker set.',
  input_schema: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
      confidence: { type: 'number', description: 'Number between 0 and 1.' },
      horizon: { type: 'string', enum: ['24h', '3d', '7d', '30d'] },
      expected_move_pct: { type: 'number', description: 'Expected ETH % move over the horizon (can be negative).' },
      user_hypothesis_verdict: { type: 'string', enum: ['supported', 'contradicted', 'partial'], description: 'Does the evidence back the user’s written prediction?' },
      narrative: { type: 'string', description: 'Two to four sentences telling the story of the pattern.' },
      key_signals: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete signals driving the call (headlines, price structure, cross-asset moves).',
      },
      risk_factors: {
        type: 'array',
        items: { type: 'string' },
        description: 'What would invalidate this call.',
      },
      trajectory: {
        type: 'array',
        description: 'Daily projected ETH close prices for the next 30 days. Exactly 30 entries covering offset_days 1 through 30 (tomorrow through 30 days out). The first entry should be near the current price and evolve consistent with direction + expected_move_pct.',
        items: {
          type: 'object',
          properties: {
            offset_days:        { type: 'number', description: '1 = tomorrow, 30 = 30 days from now.' },
            expected_eth_price: { type: 'number' },
            low:                { type: 'number', description: 'Lower bound of ~80% confidence interval.' },
            high:               { type: 'number', description: 'Upper bound of ~80% confidence interval.' },
          },
          required: ['offset_days', 'expected_eth_price'],
        },
      },
    },
    required: ['direction', 'confidence', 'horizon', 'narrative', 'key_signals', 'user_hypothesis_verdict', 'trajectory'],
  },
};

function getRecentContext(days = 30) {
  const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const to   = new Date().toISOString().slice(0, 10);
  const rows = dbm.getSentimentRange(from, to);
  return rows.map(r => ({
    date: r.date,
    eth_close:     r.eth_price,
    eth_move_pct:  r.eth_move_pct,
    btc_move_pct:  r.btc_move_pct,
    verdict:       r.verdict,
    hope_score:    r.hope_score,
    macro_score:   r.macro_score,
    summary:       r.summary,
    top_headlines: dbm.getHeadlines(r.date, 2, 'crypto').map(h => ({ source: h.source, title: h.title })),
  }));
}

function enrichPoint(p) {
  const date = p.date;
  const sentiment = date ? dbm.getSentiment(date) : null;
  const headlines = date ? dbm.getHeadlines(date, 5) : [];
  return {
    date,
    candle_time: p.candle_time,
    ohlc: {
      open: p.eth_open, high: p.eth_high, low: p.eth_low, close: p.eth_close, marker_price: p.eth_price,
    },
    eth_move_pct: sentiment?.eth_move_pct ?? null,
    btc_move_pct: sentiment?.btc_move_pct ?? null,
    day_verdict: sentiment?.verdict ?? null,
    day_summary: sentiment?.summary ?? null,
    headlines: headlines.map(h => ({ source: h.source, title: h.title })),
  };
}

async function runOracle(setId) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }
  const record = dbm.getMarkerSet(setId);
  if (!record) throw new Error('Marker set not found');
  const { set, points } = record;
  if (!points.length) throw new Error('Marker set has no points');

  const enrichedPoints = points.map(enrichPoint);
  const recentContext = getRecentContext(30);
  const currentPrice = recentContext.length
    ? recentContext[recentContext.length - 1].eth_close
    : enrichedPoints[enrichedPoints.length - 1]?.ohlc?.close;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    tools: [ORACLE_TOOL],
    tool_choice: { type: 'tool', name: 'submit_prophecy' },
    messages: [{
      role: 'user',
      content: JSON.stringify({
        set_name: set.name,
        user_description: set.description,
        user_prediction: set.prediction,
        currency: set.currency,
        marker_count: points.length,
        marker_points: enrichedPoints,
        current_eth_price: currentPrice,
        recent_30d_context: recentContext,
      }),
    }],
  });

  const toolUse = resp.content?.find(c => c.type === 'tool_use' && c.name === 'submit_prophecy');
  if (!toolUse) throw new Error('Oracle did not return a prophecy');

  const prophecy = toolUse.input;
  prophecy.model = 'claude-sonnet-4-6';
  prophecy.generated_ts = Date.now();
  prophecy.anchor_price = currentPrice;
  prophecy.anchor_ts = Date.now();
  prophecy.prompt = {
    kind: 'oracle',
    system: SYSTEM_PROMPT,
    prompt_hash: promptHash(SYSTEM_PROMPT),
  };

  dbm.saveOracleResult(setId, prophecy);

  // Persist to unified prediction history
  try {
    const horizonDays = { '24h': 1, '3d': 3, '7d': 7, '30d': 30 }[prophecy.horizon] ?? 7;
    const targetDate = new Date(Date.now() + horizonDays * 86400000).toISOString().slice(0, 10);
    dbm.savePrediction({
      type: 'oracle',
      source_ref: set.name,
      predicted_direction: prophecy.direction,
      predicted_move_pct: prophecy.expected_move_pct,
      confidence: prophecy.confidence != null ? Math.round(prophecy.confidence * 100) : null,
      horizon: prophecy.horizon,
      target_date: targetDate,
      eth_price_at_prediction: currentPrice,
      narrative: prophecy.narrative,
      raw_result: prophecy,
    });
  } catch { /* non-fatal */ }

  return prophecy;
}

module.exports = { runOracle };
