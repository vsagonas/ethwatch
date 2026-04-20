'use strict';

// MASTER PREDICT — senior-strategist daily report that synthesizes every
// data source we have (90d sentiment, 14d headlines, vitals, order flow,
// user posts, sentiment aggregates) plus today's Opus 7-day forecast and
// Opus Buy/HODL advice, and produces a full elaborated markdown report
// with critical thinking and specific invalidation levels.

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const dbm = require('../db');

const promptHash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

const SYSTEM_PROMPT = `You are ETHWATCH's chief market strategist producing the MASTER DAILY REPORT for today. You receive every piece of intelligence the platform has gathered:

- 90 days of daily ETH sentiment: verdict, hope_score (0-100), macro_score (-100..+100), summaries, per-day ETH/BTC %.
- 14 days of headlines across crypto, macro (war/economy), and hope (humanitarian/breakthrough) categories.
- Market vitals: funding rate, OI, BTC dominance, ETH/BTC ratio, Fear & Greed, gas, hash, EMA20/50/200, MACD, Bollinger bandwidth.
- Live order flow: buy vs sell volumes over 5m / 1h / 24h.
- user_posts (last 30 days): community posts scored for hope, war, people_sentiment — retail pulse.
- latest_opus_forecast: today's Opus 7-day ETH price forecast (direction, confidence, trajectory, drivers, risks). May be absent.
- latest_opus_buy_advice: today's Opus Buy/HODL/SELL recommendation with reasoning. May be absent.
- sentiment_aggregates: precomputed 7d/30d hope & macro averages, momentums, war_days_14d.

YOUR JOB — produce a FULL master daily report that:

1. **Synthesizes** — integrate the signals into a single coherent view for today. Do not just list; weave.
2. **Elaborates with critical thinking** — if Opus forecast is bullish but retail hope is collapsing and funding is euphoric, NAME the contradiction and weigh which side to trust with evidence.
3. **Cites SPECIFIC numbers** — no "sentiment is weak" without the number. Every sentiment claim needs a hope/macro/war figure; every technical claim needs a price/indicator level.
4. **Aligns explicitly with the last Opus forecast and last Opus buy advice** — state whether you agree, partially agree, or contradict them, and why with data. If either is missing from context, say so.
5. **Names invalidation levels** — ETH price AND ETH/BTC ratio. Specify which kind of break would flip the call:
   - Slow grind on declining volume, no macro catalyst → provisional, wait for daily close + next-session follow-through.
   - Sharp break on a macro event (headline-driven, sell_vol 5m/1h spike, F&G gap, war/regulatory news) → act on the break itself.
6. **Gives today's FEELING** in 1-3 sentences — the intuitive read, grounded in data.
7. **Writes an elaborated narrative (report_markdown)** — 500-900 words of senior analyst morning-note quality, using markdown ## sections, with specific numbers and real reasoning. This is the centerpiece of the report; do NOT phone it in.

LANGUAGE CALIBRATION — match intensity to signal magnitude:
- Funding: "violent squeeze / coiled spring" only for < -0.02% per 8h or multi-day persistent negatives. Mildly negative = "friction is low, not fuel piled up".
- Bollinger squeeze only if bandwidth is in bottom quartile of 90-day range.
- F&G < 20 or > 80 = contrarian framing. In between = normal conditions.
- Don't say "capitulation" on a -1% day. Don't say "euphoria" on F&G 62.
- Hedge only when the data genuinely hedges.

Call submit_master_report exactly once. Every required field must be populated.`;

const TOOL = {
  name: 'submit_master_report',
  description: 'Deliver the comprehensive master daily ETH market report.',
  input_schema: {
    type: 'object',
    properties: {
      today_verdict: { type: 'string', enum: ['BUY', 'HODL', 'SELL'] },
      today_bias:    { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
      confidence:    { type: 'number', description: '0 to 1' },
      timeframe:     { type: 'string', enum: ['24h', '3d', '7d', '30d'] },
      headline:      { type: 'string', description: 'One-sentence punchline shown at the top.' },
      today_feeling: { type: 'string', description: '1-3 sentences: the intuitive read, grounded in data.' },
      executive_summary: { type: 'string', description: '2-4 sentences summary.' },

      sentiment_analysis: {
        type: 'object',
        properties: {
          retail_mood:   { type: 'string', description: 'Read from user_posts hope/war/people_sentiment — cite numbers.' },
          macro_climate: { type: 'string', description: 'Read from macro_score 7d/30d + macro headlines + war_days_14d.' },
          hope_momentum: { type: 'string', description: 'Read from hope_momentum + recent hope headlines.' },
          war_risk:      { type: 'string', description: 'War/geopolitical risk level from war_days and headlines.' },
        },
        required: ['retail_mood', 'macro_climate', 'hope_momentum', 'war_risk'],
      },

      technical_analysis: { type: 'string', description: 'Price structure, EMA20/50/200, Bollinger, funding, MACD, order flow — cite concrete numbers and levels.' },

      forecast_alignment:   { type: 'string', description: 'How today\'s call relates to latest_opus_forecast — aligned / contradicting / missing — and why.' },
      buy_advice_alignment: { type: 'string', description: 'How today\'s call relates to latest_opus_buy_advice — aligned / contradicting / missing — and why.' },

      key_data_points: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label:          { type: 'string' },
            value:          { type: 'string' },
            interpretation: { type: 'string' },
          },
          required: ['label', 'value', 'interpretation'],
        },
        description: '6-10 most important data points driving the call today, each with label, value, and what it means.',
      },

      critical_contradictions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Signals disagreeing with each other — name them explicitly with both sides\' numbers.',
      },

      what_could_flip_this: {
        type: 'array',
        items: { type: 'string' },
        description: 'Specific events / levels / signals that would invalidate the call.',
      },

      invalidation_levels: {
        type: 'object',
        properties: {
          eth_price_level:   { type: 'string', description: 'e.g. "close below $3,180 on daily"' },
          eth_btc_ratio:     { type: 'string', description: 'e.g. "ratio breakdown below 0.0308 on volume"' },
          break_speed_note:  { type: 'string', description: 'Slow grind vs sharp break — what action for each.' },
        },
      },

      action_plan: {
        type: 'object',
        properties: {
          primary_action:      { type: 'string', description: 'Concrete action for today.' },
          if_bullish_confirms: { type: 'string', description: 'What to do if bullish confirmation lands.' },
          if_bearish_triggers: { type: 'string', description: 'What to do if bearish invalidation triggers.' },
        },
        required: ['primary_action'],
      },

      report_markdown: { type: 'string', description: '500-900 word elaborated master report in markdown with ## section headers. The centerpiece — senior analyst morning-note quality, specific numbers, real reasoning.' },
    },
    required: ['today_verdict', 'today_bias', 'confidence', 'timeframe', 'headline', 'today_feeling', 'executive_summary', 'sentiment_analysis', 'technical_analysis', 'forecast_alignment', 'buy_advice_alignment', 'key_data_points', 'what_could_flip_this', 'action_plan', 'report_markdown'],
  },
};

function avg(arr) {
  const nums = arr.filter(v => typeof v === 'number' && isFinite(v));
  if (!nums.length) return null;
  return +(nums.reduce((s, v) => s + v, 0) / nums.length).toFixed(2);
}

function gatherMasterContext() {
  const now = Date.now();
  const today   = new Date(now).toISOString().slice(0, 10);
  const from90  = new Date(now - 90 * 86400000).toISOString().slice(0, 10);
  const from30  = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
  const from14  = new Date(now - 14 * 86400000).toISOString().slice(0, 10);

  const sentRows = dbm.getSentimentRange(from90, today);
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

  // 14 days of headlines
  const twDates = [];
  for (let d = new Date(from14); d <= new Date(today); d = new Date(d.getTime() + 86400000)) {
    twDates.push(d.toISOString().slice(0, 10));
  }
  const recent_headlines = twDates.map(d => ({
    date: d,
    crypto: dbm.getHeadlines(d, 3, 'crypto').map(h => ({ source: h.source, title: h.title })),
    macro:  dbm.getHeadlines(d, 3, 'macro').map(h => ({ source: h.source, title: h.title })),
    hope:   dbm.getHeadlines(d, 3, 'hope').map(h => ({ source: h.source, title: h.title })),
  }));

  const vitals = dbm.getLatestVitals?.() || null;
  const flow5m  = dbm.getTradeSummary(now - 5   * 60 * 1000);
  const flow1h  = dbm.getTradeSummary(now - 60  * 60 * 1000);
  const flow24h = dbm.getTradeSummary(now - 24 * 60 * 60 * 1000);
  const flowSum = (s) => ({
    buy_vol:  Math.round(s.buy_vol  * 100) / 100,
    sell_vol: Math.round(s.sell_vol * 100) / 100,
    buy_count: s.buy_count,
    sell_count: s.sell_count,
    ratio: (s.buy_vol + s.sell_vol) > 0 ? +(s.buy_vol / (s.buy_vol + s.sell_vol)).toFixed(3) : null,
  });

  const rawPosts = dbm.getUserPostsRange?.(from30, today) ?? [];
  const user_posts = rawPosts.map(p => ({
    date: p.date,
    source: p.source,
    hope_score: p.hope_score,
    war_score: p.war_score,
    people_sentiment: p.people_sentiment,
    summary: p.summary || p.content?.slice(0, 200),
  }));

  const last7  = days.slice(-7);
  const last14 = days.slice(-14);
  const last30 = days.slice(-30);
  const hope7   = avg(last7.map(d => d.hope_score));
  const hope30  = avg(last30.map(d => d.hope_score));
  const macro7  = avg(last7.map(d => d.macro_score));
  const macro30 = avg(last30.map(d => d.macro_score));
  const warDays14 = last14.filter(d => typeof d.macro_score === 'number' && d.macro_score <= -40).length;
  const postsRecent = rawPosts.filter(p => new Date(p.date).getTime() >= now - 14 * 86400000);

  const sentiment_aggregates = {
    hope_7d_avg:   hope7,
    hope_30d_avg:  hope30,
    hope_momentum: (hope7 != null && hope30 != null) ? +(hope7 - hope30).toFixed(2) : null,
    macro_7d_avg:  macro7,
    macro_30d_avg: macro30,
    macro_momentum: (macro7 != null && macro30 != null) ? +(macro7 - macro30).toFixed(2) : null,
    war_days_14d:  warDays14,
    user_post_hope_14d: avg(postsRecent.map(p => p.hope_score)),
    user_post_war_14d:  avg(postsRecent.map(p => p.war_score)),
    user_post_count_14d: postsRecent.length,
  };

  const latest_opus_forecast   = dbm.getLatestOpusMaxForecast?.() || null;
  const latest_opus_buy_advice = dbm.getLatestOpusBuyRecommendation?.() || null;

  const closes = days.map(d => d.eth_close).filter(x => x != null);
  const currentPrice = closes.length ? closes[closes.length - 1] : vitals?.technicals?.price ?? null;

  const stats = (n) => {
    const slice = closes.slice(-n);
    const first = slice[0], last = slice[slice.length - 1];
    return { move_pct: (first && last) ? +((last - first) / first * 100).toFixed(2) : null };
  };

  return {
    asof: new Date(now).toISOString(),
    today,
    current_eth_price_usd: currentPrice,
    price_stats: {
      stats_7d:  stats(7),
      stats_30d: stats(30),
      stats_90d: stats(90),
    },
    sentiment_aggregates,
    daily_90d: days,
    recent_headlines,
    user_posts,
    vitals,
    order_flow: { '5m': flowSum(flow5m), '1h': flowSum(flow1h), '24h': flowSum(flow24h) },
    latest_opus_forecast,
    latest_opus_buy_advice,
  };
}

// Strip bulky per-day and per-post arrays down to what fits cleanly alongside
// the report as a persistent audit record. Full raw arrays balloon the DB row
// and are reproducible from the original tables anyway.
function buildContextDigest(context) {
  return {
    asof: context.asof,
    today: context.today,
    current_eth_price_usd: context.current_eth_price_usd,
    price_stats: context.price_stats,
    sentiment_aggregates: context.sentiment_aggregates,
    vitals: context.vitals,
    order_flow: context.order_flow,
    daily_90d_count: (context.daily_90d || []).length,
    daily_90d_date_range: context.daily_90d?.length
      ? { from: context.daily_90d[0].date, to: context.daily_90d[context.daily_90d.length - 1].date }
      : null,
    recent_headlines_count: (context.recent_headlines || []).reduce(
      (n, d) => n + (d.crypto?.length || 0) + (d.macro?.length || 0) + (d.hope?.length || 0), 0,
    ),
    recent_headlines_date_range: context.recent_headlines?.length
      ? { from: context.recent_headlines[0].date, to: context.recent_headlines[context.recent_headlines.length - 1].date }
      : null,
    user_posts_count: (context.user_posts || []).length,
    user_posts_source_breakdown: (() => {
      const m = {};
      for (const p of context.user_posts || []) m[p.source || 'manual'] = (m[p.source || 'manual'] || 0) + 1;
      return m;
    })(),
    latest_opus_forecast_summary: context.latest_opus_forecast ? {
      direction:         context.latest_opus_forecast.direction,
      confidence:        context.latest_opus_forecast.confidence,
      expected_move_pct: context.latest_opus_forecast.expected_move_pct,
      generated_ts:      context.latest_opus_forecast.generated_ts,
      narrative:         context.latest_opus_forecast.narrative,
    } : null,
    latest_opus_buy_advice_summary: context.latest_opus_buy_advice ? {
      verdict:      context.latest_opus_buy_advice.verdict,
      confidence:   context.latest_opus_buy_advice.confidence,
      timeframe:    context.latest_opus_buy_advice.timeframe,
      headline:     context.latest_opus_buy_advice.headline,
      generated_ts: context.latest_opus_buy_advice.generated_ts,
    } : null,
  };
}

async function runMasterPredict() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');

  const context = gatherMasterContext();
  // Longer explicit timeout + a couple of retries for transient network blips.
  // "Connection error" from the SDK typically means ECONNRESET or fetch abort
  // from the underlying HTTP client — not an API-level error.
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 300000,   // 5 minutes per request (Opus at 6k tokens can take > 1 min)
    maxRetries: 3,
  });

  // Use STREAMING. Non-streaming holds the HTTP request idle for the full
  // generation time (2-5 min for Opus at 6k tokens), which intermediaries
  // (ISP NAT, corporate firewall, cloud LB) commonly drop as ECONNRESET.
  // Streaming sends periodic SSE events from Anthropic → keeps the socket
  // alive and also lets us retry on mid-stream failures more gracefully.
  let resp;
  const attemptOnce = async () => {
    const stream = client.messages.stream({
      model: 'claude-opus-4-7',
      max_tokens: 6000,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      tool_choice: { type: 'tool', name: 'submit_master_report' },
      messages: [{ role: 'user', content: JSON.stringify(context) }],
    });
    return await stream.finalMessage();
  };

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      resp = await attemptOnce();
      break;
    } catch (err) {
      const cause = err?.cause?.code || err?.code || '';
      const isTransient = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED'].includes(cause)
        || /connection error/i.test(err?.message || '');
      console.error(`Master predict attempt ${attempt}/${MAX_ATTEMPTS} failed:`, err?.status, err?.message, cause);
      if (!isTransient || attempt === MAX_ATTEMPTS) {
        const detail = cause ? ` [${cause}]` : '';
        throw new Error(`Claude call failed: ${err?.message || 'unknown'}${detail}`);
      }
      // Exponential backoff between retries: 4s, 12s.
      await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }

  const toolUse = resp.content?.find(c => c.type === 'tool_use' && c.name === 'submit_master_report');
  if (!toolUse) throw new Error(`Opus skipped the tool (stop_reason=${resp.stop_reason})`);

  const report = toolUse.input;
  report.model = 'claude-opus-4-7';
  report.generated_ts = Date.now();
  report.generated_date = new Date().toISOString().slice(0, 10);
  report.current_eth_price_usd = context.current_eth_price_usd;
  report.used_opus_forecast_ts   = context.latest_opus_forecast?.generated_ts   ?? null;
  report.used_opus_buy_advice_ts = context.latest_opus_buy_advice?.generated_ts ?? null;
  report.has_opus_forecast   = !!context.latest_opus_forecast;
  report.has_opus_buy_advice = !!context.latest_opus_buy_advice;

  // Full audit trail: exact prompt + tool schema + digest of the data fed in.
  report.prompt = {
    kind: 'master_predict.opus',
    model: 'claude-opus-4-7',
    system: SYSTEM_PROMPT,
    prompt_hash: promptHash(SYSTEM_PROMPT),
    tool_schema: TOOL,
  };
  report.context_digest = buildContextDigest(context);
  // Token-usage & stop reason for later audit.
  report.response_meta = {
    stop_reason: resp.stop_reason,
    usage: resp.usage || null,
  };

  try {
    const targetDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    dbm.savePrediction({
      type: 'master_report',
      source_ref: `master:${report.generated_date}`,
      predicted_direction: report.today_bias,
      predicted_move_pct: null,
      confidence: report.confidence != null ? Math.round(report.confidence * 100) : null,
      horizon: report.timeframe || '7d',
      target_date: targetDate,
      eth_price_at_prediction: context.current_eth_price_usd,
      narrative: report.executive_summary || report.headline,
      raw_result: report,
    });
  } catch (err) {
    console.warn('Master predict DB save failed:', err.message);
  }

  return report;
}

function getLatestMasterReport() {
  try {
    const rows = dbm.getPredictions(1, 'master_report');
    return rows?.[0]?.raw_result || null;
  } catch { return null; }
}

module.exports = { runMasterPredict, getLatestMasterReport };
