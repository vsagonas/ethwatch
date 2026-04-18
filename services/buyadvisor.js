'use strict';

// "Should I buy right now, or hold?" AI advisor. Pulls together every data
// source we already maintain (30-day prices, daily sentiment, hope/macro
// scores, headlines across crypto + macro + hope, funding/OI/BTC-dom/F&G,
// order-flow windows) and asks Claude for a single recommendation.

const Anthropic = require('@anthropic-ai/sdk');
const dbm = require('../db');

// Cached for 5 minutes so rapid page loads don't re-pay for Claude.
const TTL = 5 * 60 * 1000;
let cache = { data: null, ts: 0 };

const SYSTEM_PROMPT = `You are a disciplined crypto trading advisor. You receive a complete snapshot of the current ETH market:
- 30-day daily closes, moves, verdict, hope_score (0-100, 50 = neutral), macro_score (-100..+100), and Claude daily summaries.
- This week's headlines across crypto, macro (war/economy), and hope categories — cite them in reasons.
- Market vitals: funding rate, open interest, BTC dominance, ETH/BTC, Fear & Greed, gas gwei, hash rate, plus computed EMA20/50/200/MACD/Bollinger bandwidth.
- Live order flow buy/sell volumes over 5m, 1h, 24h windows.

Your job: decide between **BUY**, **HODL**, or **SELL** right now.
- BUY = accumulate more ETH; setup is supportive.
- HODL = don't add; risk/reward doesn't favor a new entry, but no reason to dump either.
- SELL = exit / trim here. Only use SELL when the last 24h is clearly negative (e.g. ≤ -3%) AND momentum confirms (order-flow sell dominance, MACD bearish, macro stress) AND no imminent positive catalyst.

Weight heavily:
- Trend: price vs EMA50/EMA200, MACD cross, Bollinger squeeze.
- Momentum: short-term order flow (5m/1h/24h buy-vs-sell dominance).
- Sentiment: Fear & Greed extremes are contrarian signals. Low F&G + stable macro = add. Euphoria + high funding = hold.
- Macro: war escalation, sanctions, recession fears = hold. De-escalation + growth = add.
- Hope: sustained high hope scores over the past week reinforce BUY; collapsing hope reinforces HOLD.
- Price action over the past 7 days: cumulative % move, whether we're at local highs or lows.

Call the submit_recommendation tool once. Cite SPECIFIC data points in reasons (numbers, headline sources, named events). No hedging — commit.`;

const TOOL = {
  name: 'submit_recommendation',
  description: 'Record the BUY-vs-HODL verdict.',
  input_schema: {
    type: 'object',
    properties: {
      verdict:    { type: 'string', enum: ['buy', 'hodl', 'sell'] },
      confidence: { type: 'number', description: '0 to 1' },
      timeframe:  { type: 'string', enum: ['24h', '3d', '7d', '30d'], description: 'How long this call is good for.' },
      headline:   { type: 'string', description: 'One-sentence verdict summary shown on the main card.' },
      pros:       { type: 'array', items: { type: 'string' }, description: 'Concrete supporting signals with data points.' },
      cons:       { type: 'array', items: { type: 'string' }, description: 'Concrete opposing signals.' },
      risks:      { type: 'array', items: { type: 'string' }, description: 'What would flip this call.' },
      entry_zone: {
        type: 'object',
        properties: { low: { type: 'number' }, high: { type: 'number' } },
        description: 'If BUY, the ideal ETH USD price zone to add in. Omit for HODL.',
      },
    },
    required: ['verdict', 'confidence', 'timeframe', 'headline', 'pros', 'cons', 'risks'],
  },
};

// Gather every relevant data source into one compact payload.
function gatherContext() {
  const now = Date.now();
  const fromDate = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  const toDate   = new Date(now).toISOString().slice(0, 10);

  const sentRows = dbm.getSentimentRange(fromDate, toDate);
  const days = sentRows.map(r => ({
    date: r.date,
    eth_close: r.eth_price,
    eth_move_pct: r.eth_move_pct,
    btc_move_pct: r.btc_move_pct,
    verdict: r.verdict,
    hope_score: r.hope_score,
    macro_score: r.macro_score,
    summary: r.summary,
  }));

  // Headlines — week-level detail as the user asked.
  const weekFrom = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
  const weekDates = [];
  for (let d = new Date(weekFrom); d <= new Date(toDate); d = new Date(d.getTime() + 86400000)) {
    weekDates.push(d.toISOString().slice(0, 10));
  }
  const weekHeadlines = weekDates.map(d => ({
    date: d,
    crypto: dbm.getHeadlines(d, 3, 'crypto').map(h => ({ source: h.source, title: h.title })),
    macro:  dbm.getHeadlines(d, 3, 'macro').map(h => ({ source: h.source, title: h.title })),
    hope:   dbm.getHeadlines(d, 3, 'hope').map(h => ({ source: h.source, title: h.title })),
  }));

  const vitals = dbm.getLatestVitals?.() || null;

  const flow5m  = dbm.getTradeSummary(now - 5   * 60 * 1000);
  const flow1h  = dbm.getTradeSummary(now - 60  * 60 * 1000);
  const flow24h = dbm.getTradeSummary(now - 24 * 60 * 60 * 1000);
  const flowSummary = (s) => ({
    buy_vol: Math.round(s.buy_vol * 100) / 100,
    sell_vol: Math.round(s.sell_vol * 100) / 100,
    ratio: s.buy_vol + s.sell_vol > 0 ? +(s.buy_vol / (s.buy_vol + s.sell_vol)).toFixed(3) : null,
  });

  // Quick stats computed from days[]
  const closes = days.map(d => d.eth_close).filter(x => x != null);
  const currentPrice = closes.length ? closes[closes.length - 1] : vitals?.technicals?.price ?? null;
  const sevenDayAgo = closes.length >= 7 ? closes[closes.length - 7] : null;
  const thirtyDayAgo = closes.length ? closes[0] : null;
  const weekMovePct  = (currentPrice && sevenDayAgo)  ? ((currentPrice - sevenDayAgo) / sevenDayAgo) * 100 : null;
  const monthMovePct = (currentPrice && thirtyDayAgo) ? ((currentPrice - thirtyDayAgo) / thirtyDayAgo) * 100 : null;

  const upDays   = days.filter(d => d.eth_move_pct != null && d.eth_move_pct > 0).length;
  const downDays = days.filter(d => d.eth_move_pct != null && d.eth_move_pct < 0).length;

  const hopeAvg  = avg(days.map(d => d.hope_score));
  const macroAvg = avg(days.map(d => d.macro_score));

  return {
    asof: new Date(now).toISOString(),
    current_eth_price_usd: currentPrice,
    week_move_pct: weekMovePct,
    month_move_pct: monthMovePct,
    up_days_30d: upDays,
    down_days_30d: downDays,
    avg_hope_30d: hopeAvg,
    avg_macro_30d: macroAvg,
    daily_30d: days,
    week_headlines: weekHeadlines,
    vitals,
    order_flow: {
      '5m':  flowSummary(flow5m),
      '1h':  flowSummary(flow1h),
      '24h': flowSummary(flow24h),
    },
  };
}

function avg(arr) {
  const nums = arr.filter(v => typeof v === 'number' && isFinite(v));
  if (!nums.length) return null;
  return +(nums.reduce((s, v) => s + v, 0) / nums.length).toFixed(2);
}

async function buildRecommendation() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const context = gatherContext();
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: 'tool', name: 'submit_recommendation' },
    messages: [{ role: 'user', content: JSON.stringify(context) }],
  });

  const toolUse = resp.content?.find(c => c.type === 'tool_use' && c.name === 'submit_recommendation');
  if (!toolUse) throw new Error(`Claude skipped the tool (stop_reason=${resp.stop_reason})`);
  const rec = toolUse.input;
  rec.generated_ts = Date.now();
  rec.current_eth_price_usd = context.current_eth_price_usd;
  rec.context_snapshot = {
    week_move_pct: context.week_move_pct,
    month_move_pct: context.month_move_pct,
    up_days_30d: context.up_days_30d,
    down_days_30d: context.down_days_30d,
    avg_hope_30d: context.avg_hope_30d,
    avg_macro_30d: context.avg_macro_30d,
    order_flow: context.order_flow,
  };
  return rec;
}

async function getRecommendation({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.ts < TTL) return cache.data;
  const data = await buildRecommendation();
  cache = { data, ts: Date.now() };
  try { dbm.saveBuyRecommendation?.(data); } catch {}
  return data;
}

module.exports = { getRecommendation };
