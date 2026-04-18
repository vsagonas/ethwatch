'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const dbm = require('../db');
const { fetchDay } = require('./newsapi');

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';

// ── Utilities ──────────────────────────────────────────────────────────────
function toISODate(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function lastNDates(n) {
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = n; i >= 1; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    out.push(toISODate(d.getTime()));
  }
  return out;
}

// Bucket [[ts_ms, price], ...] into daily OHLC by UTC date.
function bucketDaily(pricePairs) {
  const byDate = new Map();
  for (const [ts, price] of pricePairs) {
    const d = toISODate(ts);
    if (!byDate.has(d)) byDate.set(d, { open: price, close: price, high: price, low: price, first_ts: ts, last_ts: ts });
    const b = byDate.get(d);
    if (ts < b.first_ts) { b.open = price; b.first_ts = ts; }
    if (ts > b.last_ts)  { b.close = price; b.last_ts = ts; }
    if (price > b.high) b.high = price;
    if (price < b.low)  b.low = price;
  }
  return byDate; // Map<dateISO, {open, close, high, low}>
}

// ── Coin fetchers — rely on the shared cgGet passed in from server. ───────
async function fetchCoinDaily(cgGet, coinId, days = 30, currency = 'usd') {
  const raw = await cgGet(`/coins/${coinId}/market_chart`, { vs_currency: currency, days });
  const pairs = raw?.prices ?? [];

  // Archive the raw hourly points + a daily-OHLC rollup so we build a
  // permanent SQL history for BTC alongside ETH.
  try {
    if (pairs.length) {
      dbm.saveHourlyPrices(coinId, currency, pairs);
      const byDate = bucketDaily(pairs);
      const rows = [];
      for (const [date, b] of byDate) {
        rows.push({ date, coin: coinId, currency, open: b.open, high: b.high, low: b.low, close: b.close, volume: null, fetched_ts: Date.now() });
      }
      dbm.saveDailyOhlc(rows);
    }
  } catch (err) { console.warn(`persist ${coinId} failed:`, err.message); }

  return bucketDaily(pairs);
}

// ── Claude batched per-day sentiment (tool-use → guaranteed JSON) ─────────
const SYSTEM_PROMPT = `You are a multi-beat analyst. For each day you receive:
- ETH + BTC % moves
- Up to 3 crypto headlines
- Up to 3 world-economy / war / geopolitics headlines (macro)
- Up to 3 world-hope / breakthrough / humanitarian headlines

Call the submit_verdicts tool exactly once. For each input day emit:
- verdict: crypto-market read (bullish / bearish / neutral). Weight price moves heavily; headlines explain WHY.
- score: -1 (very bearish) to 1 (very bullish).
- summary: one or two concrete sentences on the crypto day.
- hope_score: 0 (bleak) to 100 (hopeful). Consider ALL headlines, not just the "hope" bucket — de-escalation in macro, peace agreements, scientific breakthroughs, humanitarian wins all raise hope; escalations, disasters, regressive rulings lower it. Avoid 50 unless the day is genuinely balanced; if headlines are sparse, infer from the overall tone of whatever is present and lean to a direction.
- hope_summary: one sentence explaining the hope call.
- macro_score: -100 (catastrophe / escalation) to +100 (de-escalation / growth). Use ALL headlines as context; don't default to 0 — pick a direction based on what actually happened.
- macro_summary: one sentence on world economy + war posture.

Be concrete. Cite sources or named events when they matter. No hedging. No defaulting to midpoints unless the evidence is genuinely split.`;

const VERDICT_TOOL = {
  name: 'submit_verdicts',
  description: 'Record a verdict for each day in the batch.',
  input_schema: {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date:          { type: 'string', description: 'YYYY-MM-DD' },
            verdict:       { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
            score:         { type: 'number', description: '-1 to 1 crypto sentiment.' },
            summary:       { type: 'string' },
            hope_score:    { type: 'number', description: '0–100. 50 = neutral.' },
            hope_summary:  { type: 'string' },
            macro_score:   { type: 'number', description: '-100 to +100.' },
            macro_summary: { type: 'string' },
          },
          required: ['date', 'verdict', 'score', 'summary', 'hope_score', 'macro_score'],
        },
      },
    },
    required: ['verdicts'],
  },
};

async function claudeBatch(days) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  if (!days.length) return [];

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Trim the payload: 3 headlines per category keeps prompt compact and
  // fits comfortably within Haiku's output budget for 30 days.
  const userPayload = days.map(d => ({
    date: d.date,
    eth_move_pct: d.eth_move_pct,
    btc_move_pct: d.btc_move_pct,
    crypto_headlines: (d.headlines       || []).slice(0, 3).map(h => ({ source: h.source, title: h.title })),
    macro_headlines:  (d.macro_headlines || []).slice(0, 3).map(h => ({ source: h.source, title: h.title })),
    hope_headlines:   (d.hope_headlines  || []).slice(0, 3).map(h => ({ source: h.source, title: h.title })),
  }));

  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000, // 30 days × 4 fields per day ≈ 6000 tokens — leave headroom.
    system: SYSTEM_PROMPT,
    tools: [VERDICT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_verdicts' },
    messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
  });

  const toolUse = resp.content?.find(c => c.type === 'tool_use' && c.name === 'submit_verdicts');
  if (!toolUse) {
    const kinds = (resp.content || []).map(c => c.type).join(',');
    throw new Error(`Claude skipped the tool (stop_reason=${resp.stop_reason}, content=${kinds})`);
  }
  const vs = toolUse.input?.verdicts;
  if (!Array.isArray(vs)) {
    // Response was truncated mid-tool-call — typical when max_tokens is tight.
    throw new Error(`Claude tool_use missing verdicts[] (stop_reason=${resp.stop_reason})`);
  }
  return vs;
}

// ── Main orchestrator ──────────────────────────────────────────────────────
// Response-level cache so rapid refreshes (e.g., user toggles tabs) don't
// re-do the whole pipeline each time. DB remains the source of truth —
// this is purely a hot path optimization.
const _monthlyMem = new Map(); // key: `${days}-${currency}` -> { rows, ts }
const MONTHLY_MEM_TTL = 60 * 1000;

async function buildMonthlySentiment(cgGet, { days = 30, currency = 'usd', allowClaude = true } = {}) {
  const memKey = `${days}-${currency}`;
  const mem = _monthlyMem.get(memKey);
  if (mem && Date.now() - mem.ts < MONTHLY_MEM_TTL) return mem.rows;
  const dates = lastNDates(days);
  const todayISO     = toISODate(Date.now());
  const yesterdayISO = toISODate(Date.now() - 86400000);

  // 1. Load whatever we already have in the DB so we can skip external calls.
  const existing = new Map();
  for (const d of dates) {
    const r = dbm.getSentiment(d);
    if (r) existing.set(d, r);
  }

  // Re-fetch prices only if a historical day is missing, or for today/yesterday
  // which are still "moving" (ETH/BTC prices ticking).
  const needEthFetch = dates.some(d => {
    const r = existing.get(d);
    return !r?.eth_price || d === todayISO || d === yesterdayISO;
  });
  const needBtcFetch = dates.some(d => {
    const r = existing.get(d);
    return !r?.btc_price || d === todayISO || d === yesterdayISO;
  });

  let ethDaily = new Map();
  let btcDaily = new Map();
  const cgCalls = [];
  if (needEthFetch) cgCalls.push(fetchCoinDaily(cgGet, 'ethereum', days, currency).then(m => { ethDaily = m; }).catch(err => console.warn('ETH daily fetch failed:', err.message)));
  if (needBtcFetch) cgCalls.push(fetchCoinDaily(cgGet, 'bitcoin',  days, currency).then(m => { btcDaily = m; }).catch(err => console.warn('BTC daily fetch failed:', err.message)));
  await Promise.all(cgCalls);

  // 2. Ensure headlines for every (day, category). Historical (date, cat)
  //    pairs that already have rows are skipped entirely — no API call.
  //    Remaining requests run with a small concurrency pool so the first
  //    backfill finishes in seconds instead of minutes.
  const CATS = ['crypto', 'macro', 'hope'];
  const tasks = [];
  for (const d of dates) {
    for (const cat of CATS) {
      if (dbm.countHeadlines(d, cat) === 0) tasks.push({ d, cat });
    }
  }
  if (tasks.length) {
    const POOL = 6;
    for (let i = 0; i < tasks.length; i += POOL) {
      const batch = tasks.slice(i, i + POOL);
      await Promise.all(batch.map(({ d, cat }) => fetchDay(d, { category: cat }).catch(() => null)));
    }
  }

  // SQL archive of daily OHLC — lets us populate high/low even when this
  // request didn't need to re-fetch CoinGecko (historical days).
  const ohlcByDate = new Map();
  try {
    for (const r of dbm.getDailyOhlcRange(dates[0], dates[dates.length - 1], 'ethereum', currency)) {
      ohlcByDate.set(r.date, r);
    }
  } catch {}

  // 3. Compute per-day rows + figure out which still need Claude.
  const rows = [];
  const needsClaude = [];
  for (const d of dates) {
    const eth = ethDaily.get(d);
    const btc = btcDaily.get(d);
    const eth_move_pct = eth ? ((eth.close - eth.open) / eth.open) * 100 : null;
    const btc_move_pct = btc ? ((btc.close - btc.open) / btc.open) * 100 : null;

    const headlines      = dbm.getHeadlines(d, 5, 'crypto');
    const macroHeadlines = dbm.getHeadlines(d, 5, 'macro');
    const hopeHeadlines  = dbm.getHeadlines(d, 5, 'hope');

    // Persist price data immediately (so we have it even if Claude fails).
    dbm.upsertSentiment({
      date: d,
      eth_price: eth?.close ?? null,
      eth_open:  eth?.open  ?? null,
      eth_move_pct,
      btc_price: btc?.close ?? null,
      btc_open:  btc?.open  ?? null,
      btc_move_pct,
    });

    const existing = dbm.getSentiment(d);
    // Stale if ANY of the three verdict dimensions are missing.
    const needs = !existing?.verdict || !existing?.summary
      || existing?.hope_score == null || existing?.macro_score == null;
    if (needs) {
      needsClaude.push({
        date: d, eth_move_pct, btc_move_pct,
        headlines, macro_headlines: macroHeadlines, hope_headlines: hopeHeadlines,
      });
    }

    const archived = ohlcByDate.get(d);
    rows.push({
      date: d,
      eth_price: eth?.close ?? archived?.close ?? existing?.eth_price ?? null,
      eth_open:  eth?.open  ?? archived?.open  ?? existing?.eth_open  ?? null,
      eth_high:  eth?.high  ?? archived?.high  ?? null,
      eth_low:   eth?.low   ?? archived?.low   ?? null,
      eth_move_pct: eth_move_pct ?? existing?.eth_move_pct ?? null,
      // % decline from intraday high to close — the "how much did we give back".
      eth_decline_from_high_pct: (() => {
        const high  = eth?.high  ?? archived?.high;
        const close = eth?.close ?? archived?.close;
        return (high && close) ? ((close - high) / high) * 100 : null;
      })(),
      btc_price: btc?.close ?? existing?.btc_price ?? null,
      btc_move_pct: btc_move_pct ?? existing?.btc_move_pct ?? null,
      verdict: existing?.verdict ?? null,
      verdict_score: existing?.verdict_score ?? null,
      summary: existing?.summary ?? null,
      hope_score:    existing?.hope_score    ?? null,
      hope_summary:  existing?.hope_summary  ?? null,
      macro_score:   existing?.macro_score   ?? null,
      macro_summary: existing?.macro_summary ?? null,
      headline_count:       dbm.countHeadlines(d, 'crypto'),
      hope_headline_count:  dbm.countHeadlines(d, 'hope'),
      macro_headline_count: dbm.countHeadlines(d, 'macro'),
      top_headlines: headlines.slice(0, 3),
      top_macro_headlines: macroHeadlines.slice(0, 3),
      top_hope_headlines:  hopeHeadlines.slice(0, 3),
    });
  }

  // 4. Batched Claude call for days missing a verdict.
  if (allowClaude && needsClaude.length && process.env.ANTHROPIC_API_KEY) {
    try {
      const verdicts = await claudeBatch(needsClaude);
      const ts = Date.now();
      for (const v of verdicts) {
        if (!v?.date) continue;
        dbm.upsertSentiment({
          date: v.date,
          verdict: v.verdict,
          verdict_score: typeof v.score === 'number' ? v.score : null,
          summary: v.summary,
          claude_ts: ts,
          hope_score:    typeof v.hope_score    === 'number' ? v.hope_score    : null,
          hope_summary:  v.hope_summary  ?? null,
          macro_score:   typeof v.macro_score   === 'number' ? v.macro_score   : null,
          macro_summary: v.macro_summary ?? null,
        });
        const idx = rows.findIndex(r => r.date === v.date);
        if (idx !== -1) {
          rows[idx].verdict = v.verdict;
          rows[idx].verdict_score = typeof v.score === 'number' ? v.score : null;
          rows[idx].summary = v.summary;
          if (typeof v.hope_score    === 'number') rows[idx].hope_score    = v.hope_score;
          if (typeof v.macro_score   === 'number') rows[idx].macro_score   = v.macro_score;
          if (v.hope_summary)  rows[idx].hope_summary  = v.hope_summary;
          if (v.macro_summary) rows[idx].macro_summary = v.macro_summary;
        }
      }
    } catch (err) {
      console.warn('Claude batch failed:', err.message);
    }
  }

  _monthlyMem.set(memKey, { rows, ts: Date.now() });
  return rows;
}

// ── Price-at-time lookup (for 1h-after impact) ─────────────────────────────
// Reads the cached hourly ETH history (30-day window) from disk.
let _hourlyCache = { prices: [], ts: 0 };
function getHourlyPrices(currency = 'usd') {
  const stale = Date.now() - _hourlyCache.ts > 5 * 60 * 1000;
  if (!stale && _hourlyCache.currency === currency) return _hourlyCache.prices;
  try {
    const p = path.join(__dirname, '..', 'cache', `history-30-${currency}.json`);
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    const prices = json?.data?.prices ?? [];
    _hourlyCache = { prices, ts: Date.now(), currency };
    return prices;
  } catch { return []; }
}

function priceAtMs(prices, targetMs) {
  if (!prices.length) return null;
  let lo = 0, hi = prices.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prices[mid][0] < targetMs) lo = mid + 1;
    else hi = mid;
  }
  const a = prices[lo];
  const b = lo > 0 ? prices[lo - 1] : null;
  if (!b) return a[1];
  return (Math.abs(a[0] - targetMs) <= Math.abs(b[0] - targetMs)) ? a[1] : b[1];
}

function enrichHeadlineWithImpact(h, prices) {
  if (!h.published_at) return h;
  const publishMs = Date.parse(h.published_at);
  if (!isFinite(publishMs)) return h;
  const p0 = priceAtMs(prices, publishMs);
  const p1 = priceAtMs(prices, publishMs + 3600000);
  if (p0 == null || p1 == null) return h;
  // Skip if the 1h-later point is outside our available data window
  // (heuristic: nearest point is > 90min away).
  const lastTs = prices[prices.length - 1][0];
  if (publishMs + 3600000 > lastTs + 90 * 60 * 1000) return h;

  const delta = ((p1 - p0) / p0) * 100;
  return {
    ...h,
    eth_price_at_publish: p0,
    eth_price_1h_later: p1,
    eth_delta_1h_pct: delta,
    impact: delta > 0.3 ? 'up' : delta < -0.3 ? 'down' : 'flat',
  };
}

// ── Today-only indexer ─────────────────────────────────────────────────────
// Called from the day-detail endpoint when date === today.
// Uses the disk-cached hourly prices to avoid hitting CoinGecko again.
let _todayFetchTs = 0;
const TODAY_FETCH_TTL = 10 * 60 * 1000;

function _bucketTodayFromDisk(currency) {
  const todayISO = toISODate(Date.now());
  const prices = getHourlyPrices(currency); // reads history-1-{cur}.json from disk
  const todayPrices = prices.filter(([ts]) => toISODate(ts) === todayISO);
  if (!todayPrices.length) return null;
  const vals = todayPrices.map(([, p]) => p);
  return {
    open:  todayPrices[0][1],
    close: todayPrices[todayPrices.length - 1][1],
    high:  Math.max(...vals),
    low:   Math.min(...vals),
  };
}

async function buildTodaySentiment(cgGet, currency = 'usd') {
  const todayISO = toISODate(Date.now());

  // Skip if already scored and not stale.
  const prev = dbm.getSentiment(todayISO);
  const alreadyScored = prev?.verdict && prev?.eth_price != null;
  if (alreadyScored && (Date.now() - _todayFetchTs) < TODAY_FETCH_TTL) return;
  _todayFetchTs = Date.now();

  // 1. ETH prices — prefer disk cache, fall back to live CoinGecko fetch.
  let eth = _bucketTodayFromDisk(currency);
  if (!eth) {
    const ethMap = await fetchCoinDaily(cgGet, 'ethereum', 1, currency).catch(() => new Map());
    eth = ethMap.get(todayISO) ?? null;
  }

  // 2. BTC — try to read from SQLite daily_ohlc archive first, then CoinGecko.
  let btc = null;
  try {
    const rows = dbm.getDailyOhlcRange(todayISO, todayISO, 'bitcoin', currency);
    if (rows?.length) btc = rows[0];
  } catch {}
  if (!btc) {
    const btcMap = await fetchCoinDaily(cgGet, 'bitcoin', 1, currency).catch(() => new Map());
    btc = btcMap.get(todayISO) ?? null;
  }

  const eth_move_pct = eth ? ((eth.close - eth.open) / eth.open) * 100 : null;
  const btc_move_pct = btc ? ((btc.close - btc.open) / btc.open) * 100 : null;

  if (eth) {
    dbm.upsertSentiment({
      date: todayISO,
      eth_price: eth.close,
      eth_open:  eth.open,
      eth_high:  eth.high ?? null,
      eth_low:   eth.low  ?? null,
      eth_move_pct,
      btc_price: btc?.close ?? null,
      btc_open:  btc?.open  ?? null,
      btc_move_pct,
    });
  }

  // 3. Headlines — free NewsAPI has ~24h delay; these may still be empty today.
  await Promise.all(['crypto', 'macro', 'hope'].map(cat =>
    fetchDay(todayISO, { category: cat }).catch(() => null)
  ));

  // 4. Claude verdict — only if we have at least price data.
  const existing = dbm.getSentiment(todayISO);
  const needsClaude = !existing?.verdict || !existing?.summary
    || existing?.hope_score == null || existing?.macro_score == null;

  if (needsClaude && process.env.ANTHROPIC_API_KEY && existing?.eth_price != null) {
    const headlines      = dbm.getHeadlines(todayISO, 5, 'crypto');
    const macroHeadlines = dbm.getHeadlines(todayISO, 5, 'macro');
    const hopeHeadlines  = dbm.getHeadlines(todayISO, 5, 'hope');
    try {
      const verdicts = await claudeBatch([{
        date: todayISO, eth_move_pct, btc_move_pct,
        headlines, macro_headlines: macroHeadlines, hope_headlines: hopeHeadlines,
      }]);
      const v = verdicts?.[0];
      if (v?.date) {
        dbm.upsertSentiment({
          date: v.date,
          verdict: v.verdict,
          verdict_score: typeof v.score === 'number' ? v.score : null,
          summary: v.summary,
          claude_ts: Date.now(),
          hope_score:    typeof v.hope_score  === 'number' ? v.hope_score  : null,
          hope_summary:  v.hope_summary  ?? null,
          macro_score:   typeof v.macro_score === 'number' ? v.macro_score : null,
          macro_summary: v.macro_summary ?? null,
        });
      }
    } catch (err) { console.warn('Today Claude verdict failed:', err.message); }
  }
}

async function getDayDetail(date, currency = 'usd') {
  const sent = dbm.getSentiment(date);
  const raw = {
    crypto: dbm.getHeadlines(date, 30, 'crypto'),
    macro:  dbm.getHeadlines(date, 20, 'macro'),
    hope:   dbm.getHeadlines(date, 20, 'hope'),
  };
  const prices = getHourlyPrices(currency);
  const enrich = arr => arr.map(h => enrichHeadlineWithImpact(h, prices));

  return {
    date,
    sentiment: sent || null,
    headlines:       enrich(raw.crypto),
    macro_headlines: enrich(raw.macro),
    hope_headlines:  enrich(raw.hope),
  };
}

// Clears Claude-generated fields for the last N days so the next
// /api/monthly-sentiment call re-runs Claude with the current prompt.
function rescoreRecentDays(days = 30) {
  const dates = lastNDates(days);
  const stmt = dbm.db.prepare(`
    UPDATE daily_sentiment
    SET verdict = NULL, verdict_score = NULL, summary = NULL,
        hope_score = NULL, hope_summary = NULL,
        macro_score = NULL, macro_summary = NULL,
        claude_ts = NULL
    WHERE date = ?
  `);
  const txn = dbm.db.transaction((ds) => { for (const d of ds) stmt.run(d); });
  txn(dates);
  _monthlyMem.clear();
  return dates.length;
}

module.exports = { buildMonthlySentiment, buildTodaySentiment, getDayDetail, lastNDates, rescoreRecentDays };
