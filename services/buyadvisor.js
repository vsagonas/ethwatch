'use strict';

// "Should I buy right now, or hold?" AI advisor. Pulls together every data
// source we already maintain (30-day prices, daily sentiment, hope/macro
// scores, headlines across crypto + macro + hope, funding/OI/BTC-dom/F&G,
// order-flow windows) and asks Claude for a single recommendation.

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const dbm = require('../db');
const forecastSvc = require('./forecast');

const promptHash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

// Cached for 5 minutes so rapid page loads don't re-pay for Claude.
const TTL = 5 * 60 * 1000;
let cache = { data: null, ts: 0 };
let _refreshing = false; // prevents concurrent Claude calls

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
- ETH/BTC ratio: this is your EARLIEST TRIPWIRE for the "ETH rotation" thesis. It turns before price confirms. If you're calling BUY on rotation grounds, name the exact ETH/BTC level whose breakdown would invalidate the call. If BTC dominance keeps climbing while ETH stalls, flag that as a structural warning regardless of what ETH's local technicals say.

FUNDING RATE LANGUAGE — calibrate carefully:
- Extreme negative funding (< -0.02% / 8h, or persistent multi-day negatives): real squeeze fuel, OK to say "coiled spring" / "violent reversal risk".
- Mild negative funding (-0.01% to 0% / 8h): "shorts aren't getting paid enough to hold through a rally" — friction is low, not fuel piled up. Do not over-dramatize.
- Neutral / slightly positive: no squeeze thesis at all.
- Never say "squeeze incoming" from a mildly negative single-day funding print. Match the language to the magnitude.

Call the submit_recommendation tool once. Cite SPECIFIC data points in reasons (numbers, headline sources, named events). No hedging — commit. When you mention ETH/BTC ratio, cite the actual level and the invalidation threshold.`;

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
  rec.model = 'claude-sonnet-4-6';
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
  // Persist the exact prompt so accuracy can be attributed to prompt version.
  rec.prompt = {
    kind: 'buy_advice.sonnet',
    system: SYSTEM_PROMPT,
    prompt_hash: promptHash(SYSTEM_PROMPT),
  };
  return rec;
}

async function getRecommendation({ force = false } = {}) {
  // Seed cache from DB on cold start — Opus preferred, then latest sonnet.
  if (!cache.data) {
    const seed = dbm.getLatestOpusBuyRecommendation?.() ?? dbm.getLatestBuyRecommendation?.() ?? null;
    if (seed) cache = { data: seed, ts: Date.now() };
  }

  // Always serve from cache/DB — never auto-call Claude.
  // Claude is only invoked on explicit force=true (button press).
  if (!force && cache.data) return cache.data;

  // Explicit force (button press) — call Claude now.
  if (_refreshing) {
    await new Promise(r => setTimeout(r, 500));
    if (cache.data) return cache.data;
  }
  _refreshing = true;
  try {
    const data = await buildRecommendation();
    cache = { data, ts: Date.now() };
    try { dbm.saveBuyRecommendation?.(data, 'sonnet'); } catch {}
    return data;
  } catch (err) {
    if (cache.data) return cache.data;
    throw err;
  } finally {
    _refreshing = false;
  }
}

// ── ADVANCED OPUS RECOMMENDATION ─────────────────────────────────────────────
// Uses 90 days of data + the live forecast as context. Opus model.
// Cache: 15 minutes (on-demand only — not polled).

const ADV_TTL = 15 * 60 * 1000;
let advCache = { data: null, ts: 0 };

const ADV_SYSTEM_PROMPT = `You are ETHWATCH's senior trading analyst with access to 90 days of ETH market history plus TODAY'S ACTIVE Opus 7-day price forecast (guaranteed fresh — generated earlier today). Your goal: give the most accurate, data-driven BUY / HODL / SELL call possible.

You receive:
- 90-day daily closes, moves, verdict, hope_score (0-100), macro_score (-100..+100), and AI summaries.
- TODAY'S Opus 7-day AI forecast: direction, confidence, expected move %, 6h trajectory, key drivers, risks, and analog pattern match. This is the current Opus view — your BUY/HODL/SELL call must be CONSISTENT with it unless you explicitly justify a divergence using other data.
- 2-week headlines across crypto, macro, and hope categories.
- sentiment_aggregates: precomputed rolling averages for hope_score (7d + 30d), macro_score (7d + 30d), war_days (count of days with macro_score ≤ -40 in last 14d), hope_momentum (7d minus 30d hope average), macro_momentum (7d minus 30d macro average). Use these as primary sentiment inputs — do not waste effort averaging the raw daily arrays yourself.
- Market vitals: funding rate, OI, BTC dominance, ETH/BTC ratio, Fear & Greed, gas, hash rate, EMA20/50/200, MACD, Bollinger bandwidth.
- Live order-flow buy/sell volumes over 5m, 1h, 24h.
- user_posts_summary: community/social posts with hope_score, war_score, people_sentiment — use these to gauge retail mood and fear/greed on the street level. If present, weight them alongside macro headlines.

Your decision framework:
1. **Trend structure (90 days)**: Is ETH in a macro uptrend, downtrend, or consolidation? Where is price relative to EMA50/200?
2. **Forecast alignment (REQUIRED)**: The Opus 7-day forecast was generated today from full multi-window context. If you call BUY while the forecast is bearish (or vice versa), you MUST justify the contradiction with specific contradicting signals. Default stance: follow the forecast direction unless overwhelmed.
3. **Sentiment regime (use sentiment_aggregates)**: Collapsing hope (hope_momentum negative + 7d avg < 40) = headwind even if price is up. Rising hope + receding macro stress (macro_momentum positive) = structural tailwind. war_days ≥ 4 in last 14 = macro stress regime, favor HODL over BUY unless ETH is pricing in worse already.
4. **Tactical entry (30 days)**: Is this a local high or low? Bollinger position, funding, MACD cross.
5. **Catalyst scan**: Any upcoming catalysts in headlines? ETF news, Fed decisions, geopolitical escalation?
6. **Rotation tripwire (ETH/BTC ratio + BTC dominance)**: ETH/BTC turns BEFORE price confirms. If any part of your thesis leans on "ETH rotation / alt season approaching", name the exact ETH/BTC level whose breakdown invalidates it, and flag rising BTC dominance as a structural early warning that overrides local ETH technicals.
7. **Break-speed discipline (applied to ANY key level you cite — ETH/BTC invalidation level, support/resistance on price, Bollinger edge, EMA50/200 cross)**: the SPEED and CONTEXT of a break matter as much as the break itself. Distinguish two regimes explicitly:
   - **Slow grind on low/declining volume** (intraday order-flow ratio drifting, no macro catalyst in headlines): often retests and reclaims the level. Treat as provisional — wait for a closing confirmation (daily close + next-session follow-through) before flipping the thesis. State that you're waiting for confirmation.
   - **Sharp break on a macro event** (headline-driven, spike in order-flow sell_vol 5m/1h dominance, Fear&Greed gap move, war/regulatory news): tends to accelerate. Act on the break itself — don't wait to be proven wrong at a worse level.
   When you name an invalidation level in risks or forecast_alignment, you MUST specify WHICH kind of break would flip the call versus which you'd wait out. Reference the concrete observables (order-flow ratio window, headline category, F&G delta) that would separate the two in real time.

SENTIMENT INTEGRATION — this is the user's explicit instruction:
The final BUY/HODL/SELL call must be reasoned from hope, war, and macro sentiment together with price structure — not from price alone. Your headline and pros/cons must cite at least one specific sentiment number (e.g. "7d avg hope 38 vs 30d avg 52 = collapsing retail hope") and one specific macro/war signal (e.g. "war_days=5/14, macro_momentum -18, Iran escalation headlines persistent"). If sentiment contradicts price action, NAME the contradiction — don't suppress it.

LANGUAGE CALIBRATION — do not over-dramatize mild signals:
- Funding rate: "violent squeeze incoming" / "coiled spring" language is reserved for EXTREME negative funding (< -0.02% per 8h, or multi-day persistent negatives). A mildly negative print (e.g. -0.0002) means "shorts aren't getting paid enough to hold through a rally" — describe it as friction being low, not fuel piled up. Sizing should reflect that difference.
- Bollinger squeeze: only call it a squeeze if bandwidth is in the bottom quartile of its 90-day range.
- Sentiment extremes: F&G < 20 or > 80 earns contrarian framing. In between = normal conditions, no extreme label.
- If you hedge verbally, make the hedge match the data — don't claim conviction the numbers don't support.

Verdicts:
- BUY = 90-day trend + 7d forecast align bullish AND tactical entry is not at obvious resistance AND ETH/BTC ratio not breaking down.
- HODL = ambiguous signal, conflicting timeframes, or wait for better entry.
- SELL = macro trend breaking down AND 7d forecast bearish AND order flow confirms selling.

Use the submit_advanced_recommendation tool exactly once. Cite specific numbers and data points. Be decisive. In forecast_alignment and macro_context, name the ETH/BTC invalidation level when it matters. Match language intensity to signal magnitude.`;

const ADV_TOOL = {
  name: 'submit_advanced_recommendation',
  description: 'Record the advanced multi-timeframe BUY/HODL/SELL verdict.',
  input_schema: {
    type: 'object',
    properties: {
      verdict:    { type: 'string', enum: ['buy', 'hodl', 'sell'] },
      confidence: { type: 'number', description: '0 to 1' },
      timeframe:  { type: 'string', enum: ['24h', '3d', '7d', '30d'], description: 'How long this call is good for.' },
      headline:   { type: 'string', description: 'One-sentence verdict summary.' },
      macro_context: { type: 'string', description: '2-3 sentences on the 90-day macro trend and structural position.' },
      forecast_alignment: { type: 'string', description: 'How the active 7-day AI forecast aligns with (or contradicts) this call.' },
      pros:       { type: 'array', items: { type: 'string' }, description: 'Concrete supporting signals with data points.' },
      cons:       { type: 'array', items: { type: 'string' }, description: 'Concrete opposing signals.' },
      risks:      { type: 'array', items: { type: 'string' }, description: 'What would flip this call.' },
      entry_zone: {
        type: 'object',
        properties: { low: { type: 'number' }, high: { type: 'number' } },
        description: 'If BUY, the ideal ETH USD price zone to accumulate in.',
      },
    },
    required: ['verdict', 'confidence', 'timeframe', 'headline', 'macro_context', 'forecast_alignment', 'pros', 'cons', 'risks'],
  },
};

function gatherAdvancedContext(pinnedForecast = null) {
  const now = Date.now();
  const fromDate = new Date(now - 90 * 86400000).toISOString().slice(0, 10);
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

  // 2 weeks of headlines for catalysts.
  const twoWeeksFrom = new Date(now - 14 * 86400000).toISOString().slice(0, 10);
  const twDates = [];
  for (let d = new Date(twoWeeksFrom); d <= new Date(toDate); d = new Date(d.getTime() + 86400000)) {
    twDates.push(d.toISOString().slice(0, 10));
  }
  const recentHeadlines = twDates.map(d => ({
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

  const closes = days.map(d => d.eth_close).filter(x => x != null);
  const currentPrice = closes.length ? closes[closes.length - 1] : vitals?.technicals?.price ?? null;

  const stats = (n) => {
    const slice = closes.slice(-n);
    const first = slice[0], last = slice[slice.length - 1];
    return { move_pct: (first && last) ? +((last - first) / first * 100).toFixed(2) : null };
  };

  const upDays   = days.filter(d => d.eth_move_pct != null && d.eth_move_pct > 0).length;
  const downDays = days.filter(d => d.eth_move_pct != null && d.eth_move_pct < 0).length;

  // Prefer the pinned forecast (caller already validated freshness); fall back
  // to DB + live cache so the internal helper stays callable standalone.
  const opusMaxForecast = pinnedForecast ?? dbm.getLatestOpusMaxForecast?.() ?? null;
  const forecastCache   = forecastSvc.getCache();
  const forecastSource  = opusMaxForecast ?? forecastCache?.data ?? null;
  const activeForecast  = forecastSource ? {
    source:            opusMaxForecast ? 'opus-max-multiwindow' : 'live-cache',
    direction:         forecastSource.direction,
    confidence:        forecastSource.confidence,
    expected_move_pct: forecastSource.expected_move_pct,
    narrative:         forecastSource.narrative,
    key_drivers:       forecastSource.key_drivers,
    risks:             forecastSource.risks,
    pattern_match:     forecastSource.pattern_match,
    daily_breakdown:   forecastSource.daily_breakdown,
    generated_ts:      forecastSource.generated_ts ?? (forecastCache?.ts ? new Date(forecastCache.ts).toISOString() : null),
  } : null;

  // User posts for the past 30 days — community/social sentiment
  const postsFrom = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  const rawPosts  = dbm.getUserPostsRange?.(postsFrom, toDate) ?? [];
  const user_posts_summary = rawPosts.length ? rawPosts.map(p => ({
    date: p.date,
    source: p.source,
    hope_score: p.hope_score,
    war_score: p.war_score,
    people_sentiment: p.people_sentiment,
    summary: p.summary || p.content?.slice(0, 200),
  })) : null;

  // ── Sentiment aggregates — precomputed so Opus doesn't re-derive them ──────
  const last7        = days.slice(-7);
  const last14       = days.slice(-14);
  const last30       = days.slice(-30);
  const hope7Avg     = avg(last7.map(d => d.hope_score));
  const hope30Avg    = avg(last30.map(d => d.hope_score));
  const macro7Avg    = avg(last7.map(d => d.macro_score));
  const macro30Avg   = avg(last30.map(d => d.macro_score));
  const warDays14    = last14.filter(d => typeof d.macro_score === 'number' && d.macro_score <= -40).length;
  const postsRecent  = rawPosts.filter(p => new Date(p.date).getTime() >= now - 14 * 86400000);
  const postHope14   = avg(postsRecent.map(p => p.hope_score));
  const postWar14    = avg(postsRecent.map(p => p.war_score));
  const sentiment_aggregates = {
    hope_7d_avg:        hope7Avg,
    hope_30d_avg:       hope30Avg,
    hope_momentum:      (hope7Avg != null && hope30Avg != null) ? +(hope7Avg - hope30Avg).toFixed(2) : null,
    macro_7d_avg:       macro7Avg,
    macro_30d_avg:      macro30Avg,
    macro_momentum:     (macro7Avg != null && macro30Avg != null) ? +(macro7Avg - macro30Avg).toFixed(2) : null,
    war_days_14d:       warDays14,
    user_post_hope_14d: postHope14,
    user_post_war_14d:  postWar14,
    user_post_count_14d: postsRecent.length,
  };

  return {
    asof: new Date(now).toISOString(),
    current_eth_price_usd: currentPrice,
    stats_7d:  stats(7),
    stats_30d: stats(30),
    stats_90d: stats(90),
    up_days_90d: upDays,
    down_days_90d: downDays,
    avg_hope_90d:  avg(days.map(d => d.hope_score)),
    avg_macro_90d: avg(days.map(d => d.macro_score)),
    sentiment_aggregates,
    daily_90d: days,
    recent_headlines: recentHeadlines,
    active_7d_forecast: activeForecast,
    user_posts_summary,
    vitals,
    order_flow: {
      '5m':  flowSummary(flow5m),
      '1h':  flowSummary(flow1h),
      '24h': flowSummary(flow24h),
    },
  };
}

async function buildAdvancedRecommendation() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  // HARD REQUIREMENT: the Opus buy/hodl call must be downstream of today's
  // Opus 7-day forecast. If the latest stored forecast isn't from today,
  // refuse and tell the user to run the 7-day prediction first.
  const opusMaxForecast = dbm.getLatestOpusMaxForecast?.() ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const forecastDate = opusMaxForecast?.generated_ts
    ? new Date(opusMaxForecast.generated_ts).toISOString().slice(0, 10)
    : null;
  if (!opusMaxForecast || forecastDate !== today) {
    const age = forecastDate ? `last one is from ${forecastDate}` : 'none on record';
    const err = new Error(`No Opus 7-day forecast from today (${age}). Run "🧠 Advanced Opus Prediction — Max Layers" in Forecast Generator first, then retry Buy/HODL.`);
    err.code = 'NEED_OPUS_FORECAST';
    throw err;
  }

  const context = gatherAdvancedContext(opusMaxForecast);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const resp = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 3000,
    system: ADV_SYSTEM_PROMPT,
    tools: [ADV_TOOL],
    tool_choice: { type: 'tool', name: 'submit_advanced_recommendation' },
    messages: [{ role: 'user', content: JSON.stringify(context) }],
  });

  const toolUse = resp.content?.find(c => c.type === 'tool_use' && c.name === 'submit_advanced_recommendation');
  if (!toolUse) throw new Error(`Opus skipped the tool (stop_reason=${resp.stop_reason})`);
  const rec = toolUse.input;
  rec.generated_ts = Date.now();
  rec.model = 'claude-opus-4-7';
  rec.prompt = {
    kind: 'buy_advice.opus_advanced',
    system: ADV_SYSTEM_PROMPT,
    prompt_hash: promptHash(ADV_SYSTEM_PROMPT),
  };
  rec.current_eth_price_usd = context.current_eth_price_usd;
  rec.context_snapshot = {
    stats_7d:  context.stats_7d,
    stats_30d: context.stats_30d,
    stats_90d: context.stats_90d,
    up_days_90d:  context.up_days_90d,
    down_days_90d: context.down_days_90d,
    avg_hope_90d:  context.avg_hope_90d,
    avg_macro_90d: context.avg_macro_90d,
    order_flow: context.order_flow,
    forecast_used: !!context.active_7d_forecast,
  };
  return rec;
}

async function getAdvancedRecommendation({ force = false } = {}) {
  // NEVER auto-call Claude Opus. Only the admin button (force=true) triggers it.
  if (!force) {
    if (advCache.data) return advCache.data;
    const seed = dbm.getLatestOpusBuyRecommendation?.() ?? null;
    if (seed) { advCache = { data: seed, ts: Date.now() }; return seed; }
    throw new Error('No Opus advice stored. Run "Advanced Opus" from the admin panel.');
  }
  const data = await buildAdvancedRecommendation();
  advCache = { data, ts: Date.now() };
  try { dbm.saveBuyRecommendation?.(data, 'opus'); } catch {}
  // Promote Opus result as the live main recommendation — Watch chip shows it.
  cache = { data, ts: Date.now() };
  return data;
}

module.exports = { getRecommendation, getAdvancedRecommendation, getCache: () => cache };
