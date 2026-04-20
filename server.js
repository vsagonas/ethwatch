require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const Parser = require('rss-parser');
const Anthropic = require('@anthropic-ai/sdk');
const dbm = require('./db');
const { buildMonthlySentiment, buildTodaySentiment, getDayDetail, rescoreRecentDays } = require('./services/monthly');
const { runOracle } = require('./services/oracle');
const orderflow = require('./services/orderflow');
const marketvitals = require('./services/marketvitals');
const buyadvisor = require('./services/buyadvisor');
const forecast = require('./services/forecast');
const masterpredict = require('./services/masterpredict');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const CACHE_TTL_PRICE   = 25000;  // 25s — price refreshes every 30s on client
const CACHE_TTL_HISTORY = 60000;  // 1 min — chart history
const CACHE_TTL_PATTERNS = 300000; // 5 min — 90-day patterns barely change

const cache = {
  price: { data: null, ts: 0 },
  history: {},
  patterns: {},
};

const CACHE_DIR = path.join(__dirname, 'cache');

function isCacheValid(entry, ttl) {
  return entry.data !== null && Date.now() - entry.ts < ttl;
}

function ensureCacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch {}
}

async function saveCacheFile(name, payload) {
  try {
    await fsp.writeFile(path.join(CACHE_DIR, name), JSON.stringify(payload));
  } catch (err) {
    console.warn(`Disk cache save failed (${name}):`, err.message);
  }
}

function loadCacheFileSync(name) {
  try {
    const raw = fs.readFileSync(path.join(CACHE_DIR, name), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

function hydrateDiskCache() {
  ensureCacheDir();
  let loaded = 0;

  const price = loadCacheFileSync('price.json');
  if (price?.data) { cache.price = price; loaded++; }

  let files = [];
  try { files = fs.readdirSync(CACHE_DIR); } catch {}

  for (const f of files) {
    if (f.startsWith('history-') && f.endsWith('.json')) {
      const key = f.slice('history-'.length, -'.json'.length); // e.g. "7-usd" or "max-usd"
      const entry = loadCacheFileSync(f);
      if (entry?.data) { cache.history[key] = entry; loaded++; }
    } else if (f.startsWith('ohlc-') && f.endsWith('.json')) {
      const key = f.slice('ohlc-'.length, -'.json'.length);
      const entry = loadCacheFileSync(f);
      if (entry?.data) { ohlcCache[key] = entry; loaded++; }
    }
  }
  if (loaded) console.log(`Disk cache loaded: ${loaded} entries`);
}

async function cgGet(url, params = {}) {
  const headers = { 'Accept': 'application/json' };
  try {
    const response = await axios.get(`${COINGECKO_BASE}${url}`, { params, headers, timeout: 10000 });
    return response.data;
  } catch (err) {
    if (err.response?.status === 429) {
      throw Object.assign(new Error('Rate limited by CoinGecko (429)'), { isRateLimit: true });
    }
    throw err;
  }
}

async function fetchCurrentPrice() {
  if (isCacheValid(cache.price, CACHE_TTL_PRICE)) return cache.price.data;
  try {
    const data = await cgGet('/simple/price', {
      ids: 'ethereum',
      vs_currencies: 'usd,eur',
      include_24hr_change: true,
      include_market_cap: true,
      include_24hr_vol: true,
      include_last_updated_at: true,
    });
    cache.price = { data: data.ethereum, ts: Date.now() };
    saveCacheFile('price.json', cache.price);
    // Persistent time-series log: one snapshot per cache miss, per currency.
    const eth = data.ethereum;
    const nowTs = cache.price.ts;
    for (const cur of ['usd', 'eur']) {
      dbm.savePriceSnapshot({
        ts: nowTs, coin: 'ethereum', currency: cur,
        price: eth?.[cur],
        market_cap: eth?.[`${cur}_market_cap`],
        volume_24h: eth?.[`${cur}_24h_vol`],
        change_24h_pct: eth?.[`${cur}_24h_change`],
      });
    }
    return cache.price.data;
  } catch (err) {
    if (err.isRateLimit && cache.price.data) return cache.price.data; // serve stale
    throw err;
  }
}

async function fetchHistory(days, currency) {
  const key = `${days}-${currency}`;
  if (!cache.history[key]) cache.history[key] = { data: null, ts: 0 };
  // `max` is historical — won't change often; treat it like the 90-day+ bucket.
  const isLongRange = days === 'max' || Number(days) >= 90;
  const ttl = isLongRange ? CACHE_TTL_PATTERNS : CACHE_TTL_HISTORY;
  if (isCacheValid(cache.history[key], ttl)) return cache.history[key].data;

  try {
    // CoinGecko's free tier auto-selects granularity from `days` alone.
    // Passing `interval=minutely|hourly` is Enterprise-only and 401s on 1D.
    const data = await cgGet('/coins/ethereum/market_chart', { vs_currency: currency, days });
    cache.history[key] = { data, ts: Date.now() };
    saveCacheFile(`history-${key}.json`, cache.history[key]);
    persistHistoryToSql('ethereum', currency, data);
    return data;
  } catch (err) {
    if (err.isRateLimit && cache.history[key].data) return cache.history[key].data; // serve stale
    throw err;
  }
}

// Fold a /market_chart payload into the SQL archive: every hourly point is
// upserted into hourly_price, and we roll the points up into daily OHLC.
function persistHistoryToSql(coin, currency, data) {
  try {
    const pairs = data?.prices;
    if (!pairs?.length) return;
    dbm.saveHourlyPrices(coin, currency, pairs);

    // Daily rollup: first/last/min/max price per UTC date.
    const byDate = new Map();
    for (const [ts, price] of pairs) {
      const d = new Date(ts).toISOString().slice(0, 10);
      if (!byDate.has(d)) byDate.set(d, { date: d, coin, currency, open: price, high: price, low: price, close: price, _firstTs: ts, _lastTs: ts, volume: null });
      const b = byDate.get(d);
      if (ts < b._firstTs) { b.open = price; b._firstTs = ts; }
      if (ts > b._lastTs)  { b.close = price; b._lastTs  = ts; }
      if (price > b.high) b.high = price;
      if (price < b.low)  b.low  = price;
    }
    // Attach volume where we have it.
    for (const [ts, vol] of (data.total_volumes || [])) {
      const d = new Date(ts).toISOString().slice(0, 10);
      if (byDate.has(d)) byDate.get(d).volume = (byDate.get(d).volume || 0) + vol;
    }
    dbm.saveDailyOhlc([...byDate.values()]);
  } catch (err) {
    console.warn('persistHistoryToSql failed:', err.message);
  }
}

function getReturns(prices) {
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    returns.push(prev !== 0 ? (prices[i] - prev) / prev : 0);
  }
  return returns;
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function analyzePatterns(prices, windowSize = 24) {
  if (prices.length < windowSize * 2) return [];

  const refWindow = prices.slice(-windowSize);
  const refReturns = getReturns(refWindow.map(p => p.price));
  const refStart = refWindow[0].price;
  const refEnd = refWindow[refWindow.length - 1].price;

  const results = [];

  for (let i = 0; i <= prices.length - windowSize * 2; i++) {
    const window = prices.slice(i, i + windowSize);
    const windowReturns = getReturns(window.map(p => p.price));
    const similarity = cosineSimilarity(refReturns, windowReturns);

    if (similarity > 0.65) {
      const afterWindow = prices.slice(i + windowSize, i + windowSize * 2);
      if (afterWindow.length >= Math.floor(windowSize / 2)) {
        const afterPrices = afterWindow.map(p => p.price);
        const lastAfter = afterPrices[afterPrices.length - 1];
        const firstAfter = afterPrices[0];
        const priceChangePct = ((lastAfter - firstAfter) / firstAfter) * 100;
        const maxAfter = Math.max(...afterPrices);
        const minAfter = Math.min(...afterPrices);

        results.push({
          startTs: window[0].ts,
          endTs: window[windowSize - 1].ts,
          similarity: Math.round(similarity * 100) / 100,
          patternChange: ((refEnd - refStart) / refStart) * 100,
          afterPrices: afterWindow.map(p => ({ ts: p.ts, price: p.price })),
          priceChangePct: Math.round(priceChangePct * 100) / 100,
          maxGain: Math.round(((maxAfter - firstAfter) / firstAfter) * 10000) / 100,
          maxLoss: Math.round(((minAfter - firstAfter) / firstAfter) * 10000) / 100,
        });
      }
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
}

function calculateRSI(prices, period = 14) {
  if (prices.length < period + 1) return [];
  const rsi = new Array(period).fill(null);
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const delta = prices[i] - prices[i - 1];
    if (delta > 0) avgGain += delta;
    else avgLoss += Math.abs(delta);
  }
  avgGain /= period;
  avgLoss /= period;

  rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < prices.length; i++) {
    const delta = prices[i] - prices[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function calculateSMA(prices, period) {
  return prices.map((_, i) => {
    if (i < period - 1) return null;
    const slice = prices.slice(i - period + 1, i + 1);
    return slice.reduce((s, v) => s + v, 0) / period;
  });
}

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = new Array(period - 1).fill(null);
  let prev = prices.slice(0, period).reduce((s, v) => s + v, 0) / period;
  ema.push(prev);
  for (let i = period; i < prices.length; i++) {
    prev = prices[i] * k + prev * (1 - k);
    ema.push(prev);
  }
  return ema;
}

// --- Routes ---

app.get('/api/eth-price', async (req, res) => {
  try {
    const data = await fetchCurrentPrice();
    res.json({ success: true, data, serverTs: Date.now() });
  } catch (err) {
    console.error('Price fetch error:', err.message);
    res.status(502).json({ success: false, error: 'Failed to fetch price data', detail: err.message });
  }
});

app.get('/api/eth-history', async (req, res) => {
  const rawDays = String(req.query.days || '7').toLowerCase();
  const currency = (req.query.currency || 'usd').toLowerCase();
  if (!['usd', 'eur'].includes(currency)) {
    return res.status(400).json({ success: false, error: 'Invalid currency. Use usd or eur.' });
  }
  const validDays = [1, 7, 30, 90, 365];
  const parsed = parseInt(rawDays);
  const d = rawDays === 'max' ? 'max' : (validDays.includes(parsed) ? parsed : 7);

  try {
    const raw = await fetchHistory(d, currency);
    const prices = raw.prices.map(([ts, price]) => ({ ts, price }));
    const priceValues = prices.map(p => p.price);

    const sma20 = calculateSMA(priceValues, 20);
    const ema50 = calculateEMA(priceValues, 50);
    const rsi = calculateRSI(priceValues, 14);
    const volumes = raw.total_volumes.map(([ts, vol]) => ({ ts, vol }));

    res.json({
      success: true,
      currency,
      days: d,
      prices,
      volumes,
      indicators: { sma20, ema50, rsi },
      serverTs: Date.now(),
    });
  } catch (err) {
    console.error('History fetch error:', err.message);
    res.status(502).json({ success: false, error: 'Failed to fetch history', detail: err.message });
  }
});

app.get('/api/patterns', async (req, res) => {
  const currency = (req.query.currency || 'usd').toLowerCase();
  if (!['usd', 'eur'].includes(currency)) {
    return res.status(400).json({ success: false, error: 'Invalid currency' });
  }
  try {
    const raw = await fetchHistory(90, currency);
    const prices = raw.prices.map(([ts, price]) => ({ ts, price }));
    const patterns = analyzePatterns(prices, 24);
    res.json({ success: true, currency, patterns, serverTs: Date.now() });
  } catch (err) {
    console.error('Patterns error:', err.message);
    res.status(502).json({ success: false, error: 'Failed to analyze patterns', detail: err.message });
  }
});

let infoCache = { data: null, ts: 0 };
const INFO_TTL = 5 * 60 * 1000;

app.get('/api/eth-info', async (req, res) => {
  if (infoCache.data && Date.now() - infoCache.ts < INFO_TTL) {
    return res.json({ success: true, data: infoCache.data, serverTs: Date.now(), cached: true });
  }
  try {
    const data = await cgGet('/coins/ethereum', {
      localization: false,
      tickers: false,
      market_data: true,
      community_data: false,
      developer_data: false,
    });
    const market = data.market_data;
    const payload = {
      name: data.name,
      symbol: data.symbol.toUpperCase(),
      image: data.image?.small,
      rank: data.market_cap_rank,
      usd: {
        price: market.current_price?.usd,
        ath: market.ath?.usd,
        atl: market.atl?.usd,
        high_24h: market.high_24h?.usd,
        low_24h:  market.low_24h?.usd,
        change7d: market.price_change_percentage_7d,
        change30d: market.price_change_percentage_30d,
        change1y: market.price_change_percentage_1y,
      },
      eur: {
        price: market.current_price?.eur,
        ath: market.ath?.eur,
        atl: market.atl?.eur,
        high_24h: market.high_24h?.eur,
        low_24h:  market.low_24h?.eur,
      },
      marketCap: { usd: market.market_cap?.usd, eur: market.market_cap?.eur },
      circulatingSupply: market.circulating_supply,
      totalSupply: market.total_supply,
    };
    infoCache = { data: payload, ts: Date.now() };
    res.json({ success: true, data: payload, serverTs: Date.now() });
  } catch (err) {
    console.error('Info fetch error:', err.message);
    // Serve stale cache rather than a blank response
    if (infoCache.data) {
      return res.json({ success: true, data: infoCache.data, serverTs: Date.now(), stale: true });
    }
    res.status(502).json({ success: false, error: 'Failed to fetch ETH info', detail: err.message });
  }
});

// ── Weather chip explanations (AI, cached per key) ─────────────────────────
const CHIP_META = {
  rsi:       { name: 'Temperature (RSI-14)', icon: '🌡️', what: 'RSI-14 (Relative Strength Index) — a momentum oscillator from 0–100 measuring whether ETH is overbought or oversold based on recent price moves.' },
  volume:    { name: 'Humidity (24h Volume)', icon: '💧', what: '24-hour trading volume across all exchanges — a measure of market participation and conviction behind price moves.' },
  funding:   { name: 'Wind (Funding Rate)', icon: '🌬️', what: 'Perpetual futures funding rate — the periodic payment between longs and shorts that keeps the futures price anchored to spot. Positive = longs pay shorts (bullish bias). Negative = shorts pay longs (bearish bias).' },
  btcdom:    { name: 'Pressure (BTC Dominance)', icon: '🧭', what: "Bitcoin's share of total crypto market cap. High dominance means capital is concentrated in BTC; low dominance signals altcoin season where ETH and others often outperform." },
  feargreed: { name: 'Lightning (Fear & Greed)', icon: '⚡', what: 'Crypto Fear & Greed Index (0–100) from Alternative.me — composite of volatility, momentum, social media, dominance, and trends. Extreme fear often signals buying opportunities; extreme greed signals caution.' },
  oi:        { name: 'Tide (Open Interest)', icon: '🌊', what: 'Total value of all open ETH perpetual futures contracts — measures leveraged exposure in the market. Rising OI with rising price = strong trend. Rising OI with falling price = potential short squeeze.' },
  bbwidth:   { name: 'Visibility (BB Width)', icon: '🌫️', what: 'Bollinger Band Width % — the spread between upper and lower Bollinger Bands relative to the middle band. Low width = price coiling (volatility squeeze, breakout incoming). High width = volatility expanding.' },
  gas:       { name: 'Gas (Network Fee)', icon: '⛽', what: 'Current Ethereum network base gas price in Gwei. High gas = network congestion from heavy DeFi/NFT activity. Low gas = quiet network. Also affects the cost of on-chain transactions.' },
  mktcap:    { name: 'Market Cap', icon: '💰', what: "ETH's total market capitalisation: current price × circulating supply. A proxy for the network's overall economic weight and investor confidence." },
  vol24h:    { name: '24h Volume', icon: '📊', what: 'Total USD value of ETH traded across all exchanges in the last 24 hours. High relative to market cap signals strong interest; low signals thin, potentially manipulated moves.' },
  change7d:  { name: '7-Day Change', icon: '📈', what: "ETH's price change over the last 7 days. A weekly perspective that smooths out daily noise and shows the dominant short-term trend." },
  change30d: { name: '30-Day Change', icon: '📅', what: "ETH's price change over the last 30 days — a monthly view that captures macro momentum and whether ETH is in a sustained uptrend or downtrend." },
  ath:       { name: 'All-Time High', icon: '🏔️', what: "ETH's highest ever recorded price. Comparing the current price to the ATH shows how far below peak valuation the market sits — relevant for long-term perspective and cycle analysis." },
  rank:      { name: 'Market Cap Rank', icon: '🏅', what: "ETH's rank among all cryptocurrencies by market capitalisation. Rank #1 is Bitcoin. ETH is persistently #2, but this can change during strong altcoin cycles." },
};
const vitalExplainCache = new Map(); // key -> { text, ts }
const VITAL_EXPLAIN_TTL = 4 * 60 * 60 * 1000; // 4 hours

app.post('/api/weather/chip-explain', async (req, res) => {
  const { key, value, desc } = req.body || {};
  if (!key || !CHIP_META[key]) return res.status(400).json({ success: false, error: 'unknown key' });

  const cached = vitalExplainCache.get(key);
  if (cached && Date.now() - cached.ts < VITAL_EXPLAIN_TTL) {
    return res.json({ success: true, text: cached.text, icon: CHIP_META[key].icon, name: CHIP_META[key].name, cached: true });
  }

  const meta = CHIP_META[key];
  if (!process.env.ANTHROPIC_API_KEY) {
    const text = `${meta.what} Current reading: ${value || '—'} — ${desc || ''}.`;
    return res.json({ success: true, text, icon: meta.icon, name: meta.name });
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 160,
      messages: [{
        role: 'user',
        content: `You explain crypto metrics on ETHWEATHER, a weather-themed Ethereum tracker where market data maps to weather phenomena.

Metric: ${meta.name}
What it measures: ${meta.what}
Current value: ${value || '—'}
Current status: ${desc || '—'}

Write 2–3 clear sentences: what this metric is, and what today's reading specifically signals for ETH right now. Plain text, no markdown, no bullet points. Be direct and useful.`,
      }],
    });
    const text = msg.content[0]?.text?.trim() || meta.what;
    vitalExplainCache.set(key, { text, ts: Date.now() });
    res.json({ success: true, text, icon: meta.icon, name: meta.name });
  } catch (err) {
    console.error('chip-explain error:', err.message);
    const text = `${meta.what} Current reading: ${value || '—'}.`;
    vitalExplainCache.set(key, { text, ts: Date.now() }); // cache fallback too
    res.json({ success: true, text, icon: meta.icon, name: meta.name, fallback: true });
  }
});

// ── OHLC (Candlestick data) ─────────────────────────────────────────────────
const ohlcCache = {};
const CACHE_TTL_OHLC = 60000;

// Bucket a [[ts_ms, price], ...] series into OHLC candles.
// Used as a fallback when the CoinGecko OHLC endpoint is unavailable (429s)
// but we already have cached history data for the same range.
function synthesizeOhlc(pricesPairs, days) {
  if (!pricesPairs?.length) return [];
  const targetCandles =
    days === 1      ? 48 :
    days <= 7       ? 56 :
    days <= 30      ? 60 :
    days <= 90      ? 90 :
    days <= 365     ? 60 : 80;
  const bucketSize = Math.max(1, Math.floor(pricesPairs.length / targetCandles));
  const candles = [];
  for (let i = 0; i < pricesPairs.length; i += bucketSize) {
    const bucket = pricesPairs.slice(i, i + bucketSize);
    if (!bucket.length) continue;
    const vals = bucket.map(p => p[1]);
    candles.push({
      time: Math.floor(bucket[0][0] / 1000),
      open: vals[0],
      high: Math.max(...vals),
      low: Math.min(...vals),
      close: vals[vals.length - 1],
    });
  }
  return candles;
}

app.get('/api/eth-ohlc', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const currency = (req.query.currency || 'usd').toLowerCase();
  if (!['usd', 'eur'].includes(currency)) return res.status(400).json({ success: false, error: 'Invalid currency' });
  const validDays = [1, 7, 14, 30, 90, 180, 365];
  const d = validDays.includes(days) ? days : 7;
  const key = `${d}-${currency}`;
  if (!ohlcCache[key]) ohlcCache[key] = { data: null, ts: 0 };
  if (isCacheValid(ohlcCache[key], CACHE_TTL_OHLC)) return res.json({ success: true, data: ohlcCache[key].data });
  try {
    const raw = await cgGet('/coins/ethereum/ohlc', { vs_currency: currency, days: d });
    // raw: [[timestamp_ms, open, high, low, close], ...]
    const data = raw.map(([ts, open, high, low, close]) => ({
      time: Math.floor(ts / 1000), open, high, low, close,
    }));
    ohlcCache[key] = { data, ts: Date.now() };
    saveCacheFile(`ohlc-${key}.json`, ohlcCache[key]);
    // Archive each daily OHLC row permanently.
    try {
      const rollup = new Map();
      for (const c of data) {
        const iso = new Date(c.time * 1000).toISOString().slice(0, 10);
        const prev = rollup.get(iso);
        if (!prev) {
          rollup.set(iso, { date: iso, coin: 'ethereum', currency, open: c.open, high: c.high, low: c.low, close: c.close, volume: null, fetched_ts: Date.now() });
        } else {
          if (c.high > prev.high) prev.high = c.high;
          if (c.low  < prev.low)  prev.low  = c.low;
          prev.close = c.close;
        }
      }
      dbm.saveDailyOhlc([...rollup.values()]);
    } catch (e) { console.warn('OHLC SQL persist failed:', e.message); }
    res.json({ success: true, data, serverTs: Date.now() });
  } catch (err) {
    // Serve any stale OHLC we have first.
    if (ohlcCache[key].data) return res.json({ success: true, data: ohlcCache[key].data, stale: true });
    // Last resort: synthesize candles from cached history prices.
    const hist = cache.history[`${d}-${currency}`];
    if (hist?.data?.prices?.length) {
      const synth = synthesizeOhlc(hist.data.prices, d);
      if (synth.length) return res.json({ success: true, data: synth, synthetic: true, serverTs: Date.now() });
    }
    console.error('OHLC error:', err.message);
    res.status(502).json({ success: false, error: 'Failed to fetch OHLC', detail: err.message });
  }
});

// ── NEWS FEEDS ──────────────────────────────────────────────────────────────
const rssParser = new Parser({ timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } });
const newsCache = { data: null, ts: 0 };
const NEWS_TTL = 300000; // 5 min

const NEWS_SOURCES = [
  { name: 'CoinDesk',       url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { name: 'Cointelegraph',  url: 'https://cointelegraph.com/rss' },
  { name: 'CryptoSlate',    url: 'https://cryptoslate.com/feed/' },
  { name: 'Decrypt',        url: 'https://decrypt.co/feed' },
  { name: 'CryptoPotato',   url: 'https://cryptopotato.com/feed/' },
];

const ETH_KEYWORDS = ['ethereum', 'eth ', 'ether ', 'vitalik', 'defi', 'eip-', 'proof of stake', 'layer 2', 'l2'];

async function fetchNewsSource(source) {
  try {
    const feed = await rssParser.parseURL(source.url);
    return feed.items.slice(0, 20).map(item => ({
      source: source.name,
      title: item.title || '',
      link: item.link || item.guid || '',
      pubDate: item.isoDate ? new Date(item.isoDate).getTime() : Date.now(),
      summary: item.contentSnippet?.slice(0, 200) || item.content?.replace(/<[^>]+>/g, '').slice(0, 200) || '',
    }));
  } catch { return []; }
}

async function fetchCoinGeckoNews() {
  try {
    const data = await cgGet('/news', {});
    return (data.data || []).slice(0, 20).map(item => ({
      source: item.news_site || 'CoinGecko',
      title: item.title || '',
      link: item.url || '',
      pubDate: (item.created_at || 0) * 1000,
      summary: item.description?.slice(0, 200) || '',
    }));
  } catch { return []; }
}

async function getNews() {
  if (isCacheValid(newsCache, NEWS_TTL)) return newsCache.data;
  const [rssResults, cgNews] = await Promise.all([
    Promise.all(NEWS_SOURCES.map(fetchNewsSource)),
    fetchCoinGeckoNews(),
  ]);
  const all = [...rssResults.flat(), ...cgNews];
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const filtered = all
    .filter(item => item.title && item.link)
    .filter(item => {
      const text = (item.title + ' ' + item.summary).toLowerCase();
      return ETH_KEYWORDS.some(kw => text.includes(kw));
    })
    .sort((a, b) => b.pubDate - a.pubDate)
    .slice(0, 40);
  newsCache.data = { items: filtered, last24h: filtered.filter(n => n.pubDate >= cutoff24h) };
  newsCache.ts = Date.now();
  return newsCache.data;
}

app.get('/api/news', async (req, res) => {
  try {
    const data = await getNews();
    res.json({ success: true, ...data, serverTs: Date.now() });
  } catch (err) {
    console.error('News error:', err.message);
    res.status(502).json({ success: false, error: 'Failed to fetch news', detail: err.message });
  }
});

// ── AI NEWS SUMMARY ─────────────────────────────────────────────────────────
const aiSummaryCache = { data: null, ts: 0 };
const AI_SUMMARY_TTL = 1800000; // 30 min

app.post('/api/news/ai-summary', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
  }
  if (isCacheValid(aiSummaryCache, AI_SUMMARY_TTL)) {
    return res.json({ success: true, ...aiSummaryCache.data, cached: true });
  }
  try {
    const newsData = await getNews();
    const headlines = newsData.last24h.slice(0, 20).map(n =>
      `[${n.source}] ${n.title}${n.summary ? ' — ' + n.summary : ''}`
    ).join('\n');

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `You are a crypto analyst. Analyze these ETH-related news headlines from the last 24 hours and give a concise assessment:\n\n${headlines}\n\nProvide:\n1. Overall ETH sentiment: Bullish / Bearish / Neutral (pick one)\n2. Confidence: High / Medium / Low\n3. Key themes (2-3 bullet points, max 10 words each)\n4. Most impactful headline for ETH price (one sentence)\n5. Summary (2-3 sentences, actionable insight)\n\nFormat as JSON: { sentiment, confidence, themes: [], topHeadline, summary }`,
      }],
    });

    const text = message.content[0].type === 'text' ? message.content[0].text : '';
    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { sentiment: 'Neutral', confidence: 'Low', themes: [], topHeadline: '', summary: text };
    } catch {
      parsed = { sentiment: 'Neutral', confidence: 'Low', themes: [], topHeadline: '', summary: text };
    }

    const result = { ...parsed, generatedAt: Date.now(), newsCount: newsData.last24h.length };
    aiSummaryCache.data = result;
    aiSummaryCache.ts = Date.now();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('AI summary error:', err.message);
    res.status(500).json({ success: false, error: 'AI analysis failed', detail: err.message });
  }
});

// ── AI CANDLE PATTERN PREDICTION ────────────────────────────────────────────
app.post('/api/predict-pattern', async (req, res) => {
  const { ohlcData, markedTimes, currency } = req.body;
  if (!ohlcData || !markedTimes || markedTimes.length === 0) {
    return res.status(400).json({ success: false, error: 'ohlcData and markedTimes required' });
  }

  // Similarity-based prediction (no API key needed)
  const marked = ohlcData.filter(c => markedTimes.includes(c.time));
  const allPrices = ohlcData.map(c => c.close);
  const windowSize = 8;
  const predictions = [];

  for (const mc of marked) {
    const idx = ohlcData.findIndex(c => c.time === mc.time);
    if (idx < windowSize) continue;
    const refWindow = allPrices.slice(idx - windowSize + 1, idx + 1);
    const refReturns = getReturns(refWindow);

    for (let i = windowSize - 1; i < ohlcData.length - windowSize; i++) {
      if (Math.abs(i - idx) < windowSize) continue;
      const w = allPrices.slice(i - windowSize + 1, i + 1);
      const wReturns = getReturns(w);
      const sim = cosineSimilarity(refReturns, wReturns);
      if (sim > 0.7) {
        const afterSlice = allPrices.slice(i + 1, i + windowSize + 1);
        if (afterSlice.length >= 4) {
          predictions.push({
            refTime: mc.time,
            matchTime: ohlcData[i].time,
            similarity: Math.round(sim * 100),
            afterChange: ((afterSlice[afterSlice.length - 1] - afterSlice[0]) / afterSlice[0]) * 100,
            afterPrices: ohlcData.slice(i + 1, i + windowSize + 1).map(c => ({ time: c.time, close: c.close })),
          });
        }
      }
    }
  }

  predictions.sort((a, b) => b.similarity - a.similarity);
  const top = predictions.slice(0, 6);
  const upCount = top.filter(p => p.afterChange > 0).length;
  const avgChange = top.length ? top.reduce((s, p) => s + p.afterChange, 0) / top.length : 0;
  const signal = upCount > top.length * 0.6 ? 'Bullish' : upCount < top.length * 0.4 ? 'Bearish' : 'Neutral';

  let aiAnalysis = null;
  if (process.env.ANTHROPIC_API_KEY && marked.length > 0) {
    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const candleDesc = marked.map(c =>
        `O:${c.open.toFixed(0)} H:${c.high.toFixed(0)} L:${c.low.toFixed(0)} C:${c.close.toFixed(0)}`
      ).join(', ');
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `ETH candlestick analysis. User marked these OHLC candles as a bullish setup:\n${candleDesc}\n\nSimilarity search found ${signal} signal (avg predicted change: ${avgChange.toFixed(2)}%).\n\nIn 2-3 sentences: What candlestick pattern is this? Is the bullish expectation reasonable? Keep it very concise.`,
        }],
      });
      aiAnalysis = msg.content[0].type === 'text' ? msg.content[0].text : null;
    } catch { /* AI optional, don't fail */ }
  }

  // Persist to prediction history
  const currentPrice = marked.length ? marked[marked.length - 1].close : null;
  const direction = signal === 'Bullish' ? 'bullish' : signal === 'Bearish' ? 'bearish' : 'neutral';
  try {
    dbm.savePrediction({
      type: 'pattern',
      source_ref: `${marked.length} marked candle${marked.length !== 1 ? 's' : ''}`,
      predicted_direction: direction,
      predicted_move_pct: Math.round(avgChange * 100) / 100,
      confidence: top.length ? Math.round((upCount / top.length) * 100) : null,
      horizon: '8 candles',
      target_date: null,
      eth_price_at_prediction: currentPrice,
      narrative: aiAnalysis,
      raw_result: { signal, avgChange, upCount, total: top.length, matches: top.slice(0, 3) },
    });
  } catch { /* non-fatal */ }

  res.json({ success: true, signal, avgChange: Math.round(avgChange * 100) / 100, upCount, total: top.length, matches: top, aiAnalysis });
});

// ── Monthly sentiment (per-day news + Claude verdict + ETH/BTC moves) ─────
app.get('/api/monthly-sentiment', async (req, res) => {
  const days = Math.max(1, Math.min(60, parseInt(req.query.days) || 30));
  const currency = (req.query.currency || 'usd').toLowerCase();
  if (!['usd', 'eur'].includes(currency)) {
    return res.status(400).json({ success: false, error: 'Invalid currency' });
  }
  try {
    // NEVER auto-call Claude for missing verdicts. Admin triggers rescore explicitly.
    const rows = await buildMonthlySentiment(cgGet, { days, currency, allowClaude: false });
    res.json({ success: true, days: rows, currency, serverTs: Date.now() });
  } catch (err) {
    console.error('Monthly sentiment error:', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

app.post('/api/monthly-sentiment/rescore', async (req, res) => {
  const days = Math.max(1, Math.min(60, parseInt(req.body?.days) || 30));
  const currency = (req.body?.currency || 'usd').toLowerCase();
  try {
    const cleared = rescoreRecentDays(days);
    // Kick the pipeline so Claude re-runs before client polls.
    const rows = await buildMonthlySentiment(cgGet, { days, currency });
    res.json({ success: true, cleared, days: rows });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

app.get('/api/day-detail', async (req, res) => {
  const date = String(req.query.date || '');
  const currency = (req.query.currency || 'usd').toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
  }
  try {
    // NEVER auto-call Claude. Today's card shows whatever is already in the DB.
    // Admin runs Rescore Sentiment explicitly to fill in today's verdict.
    const detail = await getDayDetail(date, currency);
    res.json({ success: true, ...detail });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// ── User preferences ──────────────────────────────────────────────────────
app.get('/api/prefs', (req, res) => {
  res.json({ success: true, prefs: dbm.getAllPrefs() });
});

app.post('/api/prefs', (req, res) => {
  const updates = req.body || {};
  if (typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ success: false, error: 'Body must be an object of key/value prefs' });
  }
  for (const [k, v] of Object.entries(updates)) {
    if (typeof k !== 'string' || k.length > 64) continue;
    const sv = typeof v === 'string' ? v : JSON.stringify(v);
    if (sv.length > 4096) continue;
    dbm.setPref(k, sv);
  }
  res.json({ success: true, prefs: dbm.getAllPrefs() });
});

// ── Marker sets + ORACLE ──────────────────────────────────────────────────
app.get('/api/marker-sets', (req, res) => {
  try {
    const sets = dbm.listMarkerSets().map(s => ({
      ...s,
      oracle_result: s.oracle_result ? JSON.parse(s.oracle_result) : null,
    }));
    res.json({ success: true, sets });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/marker-sets/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
  const record = dbm.getMarkerSet(id);
  if (!record) return res.status(404).json({ success: false, error: 'Not found' });
  record.set.oracle_result = record.set.oracle_result ? JSON.parse(record.set.oracle_result) : null;
  res.json({ success: true, ...record });
});

app.post('/api/marker-sets', (req, res) => {
  const { name, description, prediction, currency = 'usd', points } = req.body || {};
  if (!name || typeof name !== 'string' || name.length > 120) {
    return res.status(400).json({ success: false, error: 'name required (max 120 chars)' });
  }
  if (!Array.isArray(points) || !points.length) {
    return res.status(400).json({ success: false, error: 'points must be a non-empty array' });
  }
  try {
    const normalized = points.map(p => ({
      candle_time: parseInt(p.candle_time),
      date: p.date || new Date(parseInt(p.candle_time) * 1000).toISOString().slice(0, 10),
      eth_price: p.eth_price ?? p.eth_close ?? null,
      eth_open:  p.eth_open  ?? null,
      eth_high:  p.eth_high  ?? null,
      eth_low:   p.eth_low   ?? null,
      eth_close: p.eth_close ?? null,
    })).filter(p => Number.isFinite(p.candle_time));
    if (!normalized.length) {
      return res.status(400).json({ success: false, error: 'No valid points after normalization' });
    }
    const id = dbm.createMarkerSet(
      { name, description, prediction, currency },
      normalized
    );
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/marker-sets/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
  const ok = dbm.deleteMarkerSet(id);
  res.json({ success: ok });
});

app.post('/api/marker-sets/:id/oracle', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid id' });
  try {
    const prophecy = await runOracle(id);
    res.json({ success: true, prophecy });
  } catch (err) {
    console.error('Oracle error:', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

// ── BUY / HODL AI advisor ────────────────────────────────────────────────
app.get('/api/buy-time', async (req, res) => {
  const force = req.query.force === '1';
  try {
    const data = await buyadvisor.getRecommendation({ force });
    res.json({ success: true, data });
  } catch (err) {
    // Fall back to the last stored recommendation if Claude is down.
    const stale = dbm.getLatestBuyRecommendation();
    if (stale) return res.json({ success: true, data: stale, stale: true, error: err.message });
    res.status(502).json({ success: false, error: err.message });
  }
});

// Cheap poll endpoint — returns only the generated_ts so the client can
// detect when a new recommendation (e.g. Opus from admin) has gone live.
app.get('/api/buy-time-ts', (req, res) => {
  const cache = buyadvisor.getCache?.();
  const ts = cache?.data?.generated_ts ?? dbm.getLatestBuyRecommendation()?.generated_ts ?? null;
  res.json({ ts });
});

// ── BUY/HODL recommendation history ──────────────────────────────────────
app.get('/api/buy-time-history', (req, res) => {
  try {
    const rows = dbm.getBuyRecommendationHistory();
    res.json({ success: true, rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/buy-time-delete', (req, res) => {
  try {
    const ts = parseInt(req.body?.ts);
    if (!isFinite(ts)) return res.status(400).json({ success: false, error: 'Invalid ts' });
    const changed = dbm.deleteBuyRecommendation(ts);
    const c = buyadvisor.getCache?.();
    if (c?.data?.generated_ts === ts) { c.data = null; c.ts = 0; }
    res.json({ success: true, deleted: changed > 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ADVANCED OPUS BUY/HODL advisor (90d + live forecast) ─────────────────
app.get('/api/buy-time-advanced', async (req, res) => {
  const force = req.query.force === '1';
  try {
    const data = await buyadvisor.getAdvancedRecommendation({ force });
    res.json({ success: true, data });
  } catch (err) {
    // 412 Precondition Failed → client knows the fix is "run Opus forecast first".
    const status = err.code === 'NEED_OPUS_FORECAST' ? 412 : 502;
    res.status(status).json({ success: false, error: err.message, code: err.code || null });
  }
});

// ── USER POSTS: freeform import ──────────────────────────────────────────
// Fast path: JSON-looking input is parsed locally → only the scoring goes to
// Sonnet (in small batches, fixed output size). Slow path: non-JSON prose
// goes through Sonnet once for extraction. Either way, no request hangs.

const USER_POSTS_SCORE_BATCH = 10;
const USER_POSTS_TIMEOUT_MS  = 90 * 1000; // per Sonnet call

const USER_POSTS_SCORE_TOOL = {
  name: 'score_posts',
  description: 'Score community / retail posts for hope, war/fear, and people sentiment.',
  input_schema: {
    type: 'object',
    properties: {
      posts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index:            { type: 'number', description: 'Zero-based index matching the input list.' },
            hope_score:       { type: 'number', description: '0=despair, 50=neutral, 100=euphoric.' },
            war_score:        { type: 'number', description: '0=calm, 100=panic/war/crisis fear.' },
            people_sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
            summary:          { type: 'string', description: 'One sentence.' },
          },
          required: ['index', 'hope_score', 'war_score', 'people_sentiment', 'summary'],
        },
      },
    },
    required: ['posts'],
  },
};

const USER_POSTS_EXTRACT_TOOL = {
  name: 'extract_and_score_posts',
  description: 'Parse freeform non-JSON text into discrete posts and score each.',
  input_schema: {
    type: 'object',
    properties: {
      posts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date:             { type: 'string' },
            content:          { type: 'string' },
            source:           { type: 'string' },
            hope_score:       { type: 'number' },
            war_score:        { type: 'number' },
            people_sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
            summary:          { type: 'string' },
          },
          required: ['date', 'content', 'hope_score', 'war_score', 'people_sentiment', 'summary'],
        },
      },
    },
    required: ['posts'],
  },
};

const USER_POSTS_SCORE_SYSTEM = `Score each community / retail post about the crypto/ETH market for hope, war/fear, and sentiment. Read all posts together to catch sarcasm, copium, memes, FUD. Output exactly one entry per input post, matching its index.
- hope_score 0-100 (0=despair, 100=euphoric/FOMO)
- war_score  0-100 (0=calm, 100=panic/crisis)
- people_sentiment: positive|neutral|negative
- summary: one sentence.
Call score_posts exactly once.`;

const USER_POSTS_EXTRACT_SYSTEM = `Parse freeform text into discrete community posts about crypto/ETH, then score each. Always return at least one post if the input has content. Split on blank lines, numbered markers, speaker tags; if nothing separates them emit the whole thing as a single post. For each post: date (YYYY-MM-DD, fall back to import_date), verbatim content, source if identifiable, and the four scores (hope_score 0-100, war_score 0-100, people_sentiment, one-sentence summary). Read siblings together for sarcasm/FUD context. Call extract_and_score_posts exactly once.`;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms/1000)}s`)), ms);
    promise.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

// Parse paste as JSON (strict → loose recovery). Returns { items, meta } where
// items is an array of post-like objects and meta may hold fallback fields
// (e.g. a snapshot date found in a wrapper object).
function tryParseJson(text) {
  const s = text.trim();
  if (!/^[\[\{]/.test(s)) return null;
  const parseAny = (str) => {
    try { return JSON.parse(str); } catch {}
    try {
      const fixed = str.replace(/,\s*([}\]])/g, '$1').replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');
      return JSON.parse(fixed);
    } catch {}
    return undefined;
  };
  const parsed = parseAny(s);
  if (parsed === undefined) return null;

  // 1. Raw array of posts
  if (Array.isArray(parsed)) return { items: parsed, meta: {} };

  if (parsed && typeof parsed === 'object') {
    // 2. Look for a posts array under any common wrapper key.
    const WRAPPER_KEYS = ['posts', 'items', 'entries', 'data', 'results', 'messages', 'tweets', 'threads', 'comments', 'records'];
    let items = null;
    for (const k of WRAPPER_KEYS) {
      if (Array.isArray(parsed[k])) { items = parsed[k]; break; }
    }
    // Or: any top-level key whose value is an array of objects
    if (!items) {
      for (const v of Object.values(parsed)) {
        if (Array.isArray(v) && v.length && typeof v[0] === 'object' && !Array.isArray(v[0])) {
          items = v; break;
        }
      }
    }
    // Pull fallback date from any metadata-like wrapper
    const meta = {};
    const metaObj = parsed.snapshot_metadata || parsed.metadata || parsed.meta || parsed;
    const metaDate = metaObj?.snapshot_date || metaObj?.date || metaObj?.day || metaObj?.as_of || null;
    if (typeof metaDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(metaDate)) meta.fallback_date = metaDate.slice(0, 10);

    if (items) return { items, meta };
    // Fallback: single object → single post
    return { items: [parsed], meta };
  }
  return null;
}

const POST_CONTENT_KEYS = ['content', 'text', 'body', 'message', 'post', 'tweet', 'description'];
const POST_DATE_KEYS    = ['date', 'calculated_date', 'timestamp', 'created_at', 'ts', 'day', 'published', 'published_at', 'time'];
const POST_SOURCE_KEYS  = ['source', 'platform', 'author', 'site', 'channel'];

// Any value (string, number, object, array) → readable flat text.
function valueToText(v, depth = 0) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (depth > 3) return '';
  if (Array.isArray(v)) return v.map(x => valueToText(x, depth + 1)).filter(Boolean).join(' | ');
  if (typeof v === 'object') {
    return Object.entries(v)
      .map(([k, val]) => { const t = valueToText(val, depth + 1); return t ? `${k}: ${t}` : ''; })
      .filter(Boolean)
      .join(' · ');
  }
  return String(v);
}

function normalizePreparsedPost(obj, importDate, fallbackDate) {
  if (!obj || typeof obj !== 'object') return null;

  // Build content from whatever fields exist. Aggregate everything that looks
  // like signal so nuance in nested objects isn't lost.
  const title   = valueToText(obj.title);
  const summary = valueToText(obj.content_summary ?? obj.summary);
  const notes   = valueToText(obj.notes ?? obj.note);
  let primary = '';
  for (const k of POST_CONTENT_KEYS) {
    if (obj[k] != null) { primary = valueToText(obj[k]); if (primary) break; }
  }
  const parts = [];
  if (title)   parts.push(`TITLE: ${title}`);
  if (primary && (!summary || !summary.includes(primary))) parts.push(primary);
  if (summary && summary !== primary) parts.push(`SUMMARY: ${summary}`);
  if (notes)   parts.push(`NOTES: ${notes}`);
  if (obj.sentiment)  parts.push(`SENTIMENT_HINT: ${valueToText(obj.sentiment)}`);
  if (obj.flair)      parts.push(`FLAIR: ${valueToText(obj.flair)}`);
  if (obj.upvotes != null || obj.comments != null) {
    parts.push(`ENGAGEMENT: ${obj.upvotes ?? '—'} up / ${obj.comments ?? '—'} comments`);
  }
  if (obj.key_data)       parts.push(`KEY_DATA: ${valueToText(obj.key_data)}`);
  if (obj.signals)        parts.push(`SIGNALS: ${valueToText(obj.signals)}`);
  if (obj.market_implication) parts.push(`MARKET_IMPLICATION: ${valueToText(obj.market_implication)}`);
  if (!parts.length) parts.push(valueToText(obj));

  const content = parts.join('\n').trim();
  if (!content) return null;

  // Date resolution
  let date = fallbackDate || importDate;
  for (const k of POST_DATE_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) { date = v.slice(0, 10); break; }
    if (typeof v === 'number' && isFinite(v)) {
      const iso = new Date(v > 1e12 ? v : v * 1000).toISOString();
      date = iso.slice(0, 10); break;
    }
  }

  // Source resolution
  let source = 'manual';
  for (const k of POST_SOURCE_KEYS) {
    if (typeof obj[k] === 'string' && obj[k].trim()) { source = obj[k].trim().slice(0, 60); break; }
  }

  return { date, content: content.slice(0, 6000), source };
}

async function scoreBatch(client, batch) {
  const payload = batch.map((p, i) => ({ index: i, date: p.date, source: p.source, content: p.content }));
  const resp = await withTimeout(
    client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system: USER_POSTS_SCORE_SYSTEM,
      tools: [USER_POSTS_SCORE_TOOL],
      tool_choice: { type: 'tool', name: 'score_posts' },
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    }),
    USER_POSTS_TIMEOUT_MS,
    'Sonnet scoring',
  );
  const toolUse = resp.content?.find(c => c.type === 'tool_use' && c.name === 'score_posts');
  if (!toolUse) throw new Error(`Sonnet skipped score_posts (stop_reason=${resp.stop_reason})`);
  const raw = toolUse.input?.posts;
  // Sonnet occasionally returns an object keyed by index instead of an array —
  // coerce so the caller can always .find() safely.
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return Object.values(raw);
  return [];
}

async function extractAndScoreProse(client, text, importDate) {
  const resp = await withTimeout(
    client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: USER_POSTS_EXTRACT_SYSTEM,
      tools: [USER_POSTS_EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_and_score_posts' },
      messages: [{ role: 'user', content: `import_date (fallback): ${importDate}\n\n--- PASTED INPUT ---\n${text}` }],
    }),
    USER_POSTS_TIMEOUT_MS,
    'Sonnet extraction',
  );
  const toolUse = resp.content?.find(c => c.type === 'tool_use' && c.name === 'extract_and_score_posts');
  if (!toolUse) throw new Error(`Sonnet skipped extract_and_score_posts (stop_reason=${resp.stop_reason})`);
  return toolUse.input.posts || [];
}

app.post('/api/user-posts/import', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ success: false, error: 'text must be a non-empty string' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
  }

  const importDate = new Date().toISOString().slice(0, 10);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const scored = [];
  const dbg = { mode: null, pre_parsed: 0, extracted: 0, dropped: 0, batches: 0 };

  try {
    const parsed = tryParseJson(text);

    if (parsed && parsed.items?.length) {
      // FAST PATH: JSON detected (raw array OR wrapped {posts:[...]}). Extract locally, score in batches.
      dbg.mode = 'json';
      dbg.wrapper_meta_date = parsed.meta?.fallback_date ?? null;
      const fallbackDate = parsed.meta?.fallback_date || importDate;
      const normalized = parsed.items.map(p => normalizePreparsedPost(p, importDate, fallbackDate)).filter(Boolean);
      dbg.pre_parsed = normalized.length;
      dbg.raw_items = parsed.items.length;
      if (!normalized.length) {
        return res.json({ success: true, imported: 0, posts: [], note: `JSON parsed (${parsed.items.length} items) but no entries produced content. First item keys: ${Object.keys(parsed.items[0] || {}).join(', ') || '—'}`, debug: dbg });
      }
      for (let i = 0; i < normalized.length; i += USER_POSTS_SCORE_BATCH) {
        const batch = normalized.slice(i, i + USER_POSTS_SCORE_BATCH);
        dbg.batches++;
        let scores = [];
        try {
          const r = await scoreBatch(client, batch);
          scores = Array.isArray(r) ? r : [];
        } catch (err) {
          console.warn('scoreBatch failed:', err.message);
        }
        for (let j = 0; j < batch.length; j++) {
          const p  = batch[j];
          const sc = scores.find(s => s && s.index === j) || scores[j] || {};
          const row = {
            date: p.date, content: p.content, source: p.source || 'manual',
            imported_ts: Date.now(),
            hope_score:       typeof sc.hope_score === 'number' ? sc.hope_score : null,
            war_score:        typeof sc.war_score  === 'number' ? sc.war_score  : null,
            people_sentiment: sc.people_sentiment || null,
            summary:          sc.summary || null,
          };
          const id = dbm.saveUserPost(row);
          scored.push({ id, ...row });
        }
      }
    } else {
      // SLOW PATH: prose / markdown / etc. Single extraction call.
      dbg.mode = 'prose';
      const extracted = await extractAndScoreProse(client, text, importDate);
      dbg.extracted = extracted.length;
      for (const p of extracted) {
        if (!p?.content) { dbg.dropped++; continue; }
        const date = /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : importDate;
        const row = {
          date, content: p.content, source: p.source || 'manual',
          imported_ts: Date.now(),
          hope_score:       typeof p.hope_score === 'number' ? p.hope_score : null,
          war_score:        typeof p.war_score  === 'number' ? p.war_score  : null,
          people_sentiment: p.people_sentiment || null,
          summary:          p.summary || null,
        };
        const id = dbm.saveUserPost(row);
        scored.push({ id, ...row });
      }
    }

    if (!scored.length) {
      return res.json({ success: true, imported: 0, posts: [], note: 'Nothing was saved. See debug.', debug: dbg });
    }
    res.json({ success: true, imported: scored.length, posts: scored, debug: dbg });
  } catch (err) {
    console.error('User posts import error:', err.message, dbg);
    res.status(500).json({ success: false, error: err.message, debug: dbg });
  }
});

app.get('/api/user-posts/counts', (req, res) => {
  try {
    const counts = dbm.getUserPostDateCounts();
    res.json({ success: true, counts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── REDDIT RSS PULL — fetch subreddit feeds and score through the same pipeline
const REDDIT_FEEDS_DEFAULT = [
  'https://www.reddit.com/r/news/.rss',
  'https://www.reddit.com/r/cryptomarket/.rss',
  'https://www.reddit.com/r/bitcoin/.rss',
  'https://www.reddit.com/r/etherium/.rss',
];

// Reddit aggressively 403s non-browser UAs. rss-parser's internal fetch
// sometimes gets blocked where axios doesn't (different Accept / missing
// headers). We use axios + xml2js directly so every header we set actually
// reaches Reddit, and we get real error bodies on failure.
const xml2js = require('xml2js');

const REDDIT_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

function parseSubredditFromUrl(url) {
  return (url.match(/\/r\/([^/]+)/) || [])[1] || 'unknown';
}

// Reddit .rss is an Atom feed — <entry> elements with <title>, <content>, <published>.
async function parseAtomFeed(xml) {
  const parser = new xml2js.Parser({ explicitArray: false, ignoreAttrs: false });
  const out = await parser.parseStringPromise(xml);
  const entries = out?.feed?.entry;
  if (!entries) return [];
  const arr = Array.isArray(entries) ? entries : [entries];
  return arr.map(e => ({
    title:     typeof e.title === 'object' ? (e.title._ || '') : (e.title || ''),
    content:   typeof e.content === 'object' ? (e.content._ || '') : (e.content || ''),
    published: e.published || e.updated || null,
  }));
}

function itemsToPosts(items, subreddit, maxItems) {
  return (items || []).slice(0, maxItems).map(item => {
    const title   = (item.title || '').trim();
    const rawBody = (item.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const snippet = rawBody.slice(0, 600);
    const content = snippet && snippet !== title ? `${title}\n${snippet}` : title;
    const pubTs   = item.published ? new Date(item.published).getTime() : Date.now();
    const date    = new Date(pubTs || Date.now()).toISOString().slice(0, 10);
    return { content, date, source: `reddit:r/${subreddit}` };
  }).filter(p => p.content);
}

function jsonChildrenToPosts(children, subreddit, maxItems) {
  return (children || []).slice(0, maxItems).map(c => {
    const d = c.data || {};
    const title   = (d.title || '').trim();
    const rawBody = (d.selftext || '').trim();
    const snippet = rawBody.slice(0, 600);
    const content = snippet && snippet !== title ? `${title}\n${snippet}` : title;
    const pubTs   = d.created_utc ? d.created_utc * 1000 : Date.now();
    const date    = new Date(pubTs).toISOString().slice(0, 10);
    return { content, date, source: `reddit:r/${subreddit}` };
  }).filter(p => p.content);
}

async function fetchRedditFeed(url, maxItems = 15) {
  const subreddit = parseSubredditFromUrl(url);
  const attempts = [
    { label: 'www-rss', url, kind: 'rss' },
    { label: 'old-rss', url: url.replace('www.reddit.com', 'old.reddit.com'), kind: 'rss' },
    { label: 'json',    url: `https://www.reddit.com/r/${subreddit}/.json?limit=${maxItems}`, kind: 'json' },
    { label: 'old-json',url: `https://old.reddit.com/r/${subreddit}/.json?limit=${maxItems}`, kind: 'json' },
  ];

  const errors = [];
  for (const a of attempts) {
    try {
      const resp = await axios.get(a.url, {
        headers: REDDIT_BROWSER_HEADERS,
        timeout: 15000,
        // Accept any status so we can read 403 bodies; we throw manually below.
        validateStatus: () => true,
        responseType: a.kind === 'json' ? 'json' : 'text',
      });
      if (resp.status !== 200) {
        errors.push(`${a.label}:${resp.status}`);
        continue;
      }
      if (a.kind === 'json') {
        const children = resp.data?.data?.children || [];
        const posts = jsonChildrenToPosts(children, subreddit, maxItems);
        if (posts.length) return posts;
        errors.push(`${a.label}:empty`);
      } else {
        const items = await parseAtomFeed(resp.data);
        const posts = itemsToPosts(items, subreddit, maxItems);
        if (posts.length) return posts;
        errors.push(`${a.label}:empty`);
      }
    } catch (err) {
      errors.push(`${a.label}:${err.code || err.message?.slice(0, 40) || 'err'}`);
    }
  }
  const err = new Error(`all endpoints failed (${errors.join(', ')})`);
  err.statusCode = 403;
  throw err;
}

app.post('/api/user-posts/fetch-reddit', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ success: false, error: 'ANTHROPIC_API_KEY not configured' });
  }
  const requestedFeeds = Array.isArray(req.body?.feeds) && req.body.feeds.length
    ? req.body.feeds.filter(u => typeof u === 'string' && u.trim()).map(u => u.trim())
    : REDDIT_FEEDS_DEFAULT;
  const maxPerFeed = Math.min(25, Math.max(1, parseInt(req.body?.max_per_feed) || 15));
  const scoreOn    = req.body?.score !== false;

  const feedResults = [];
  const allPosts = [];
  for (const url of requestedFeeds) {
    try {
      const posts = await fetchRedditFeed(url, maxPerFeed);
      feedResults.push({ url, ok: true, fetched: posts.length });
      allPosts.push(...posts);
    } catch (err) {
      const status = err.response?.status || err.statusCode || null;
      feedResults.push({ url, ok: false, error: err.message, http_status: status });
    }
  }

  if (!allPosts.length) {
    const blocked = feedResults.some(f => !f.ok && (f.http_status === 403 || f.http_status === 429 || /blocked|forbidden|too many/i.test(f.error || '')));
    return res.json({
      success: true,
      feeds: feedResults,
      fetched: 0,
      imported: 0,
      note: blocked
        ? 'Reddit blocked the requests (403/429). Consider a delay between pulls or a different User-Agent.'
        : 'No posts fetched — feeds may be empty, typo\'d (e.g. r/etherium vs r/ethereum), or all failed.',
    });
  }

  if (!scoreOn) {
    return res.json({ success: true, feeds: feedResults, fetched: allPosts.length, preview: allPosts.slice(0, 30) });
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const saved = [];
  for (let i = 0; i < allPosts.length; i += USER_POSTS_SCORE_BATCH) {
    const batch = allPosts.slice(i, i + USER_POSTS_SCORE_BATCH);
    let scores = [];
    try {
      const r = await scoreBatch(client, batch);
      scores = Array.isArray(r) ? r : [];
    } catch (err) {
      console.warn('scoreBatch (reddit) failed:', err.message);
    }
    for (let j = 0; j < batch.length; j++) {
      const p  = batch[j];
      const sc = scores.find(s => s && s.index === j) || scores[j] || {};
      const row = {
        date: p.date,
        content: p.content,
        source: p.source || 'reddit',
        imported_ts: Date.now(),
        hope_score:       typeof sc.hope_score === 'number' ? sc.hope_score : null,
        war_score:        typeof sc.war_score  === 'number' ? sc.war_score  : null,
        people_sentiment: sc.people_sentiment || null,
        summary:          sc.summary || null,
      };
      const id = dbm.saveUserPost(row);
      saved.push({ id, ...row });
    }
  }

  res.json({ success: true, feeds: feedResults, fetched: allPosts.length, imported: saved.length });
});

// ── 7-DAY AI FORECAST — Claude pattern-completion engine ──────────────────
app.get('/api/forecast-7d', async (req, res) => {
  const force = req.query.force === '1';
  try {
    const data = await forecast.getForecast({ force });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Forecast error:', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

// ── FORECAST HISTORY — past ai_forecast rows from DB ──────────────────────
app.get('/api/forecast-7d/history', (req, res) => {
  try {
    const limit = Math.min(20, parseInt(req.query.limit) || 10);
    const rows = dbm.getPredictions(limit, 'ai_forecast');
    res.json({ success: true, forecasts: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ADMIN: set a specific forecast as live (promotes it to cache) ──────────
app.post('/api/admin/set-live-forecast/:id', (req, res) => {
  try {
    const id   = parseInt(req.params.id);
    const rows = dbm.getPredictions(200, 'ai_forecast');
    const row  = rows.find(r => r.id === id);
    if (!row?.raw_result) return res.status(404).json({ success: false, error: 'Forecast not found' });
    // Promote to in-memory cache so all clients immediately get it
    forecast.getCache().data = row.raw_result;
    forecast.getCache().ts   = Date.now();
    res.json({ success: true, id, direction: row.raw_result.direction });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Market vitals — 24h stats bar (funding, OI, BTC dom, gas, F&G, indicators)
app.get('/api/market-vitals', async (req, res) => {
  const force = req.query.force === '1';
  try {
    const data = await marketvitals.getVitals({ force });
    res.json({ success: true, data });
  } catch (err) {
    // Fallback to the last persisted snapshot if everything live is down.
    const stale = dbm.getLatestVitals();
    if (stale) return res.json({ success: true, data: stale, stale: true });
    res.status(502).json({ success: false, error: err.message });
  }
});

// ── Order flow (server-side consumer → SQLite cache) ──────────────────────
app.get('/api/order-flow/trend', (req, res) => {
  const windowSec = Math.min(86400, Math.max(30, parseInt(req.query.window) || 300));
  const fromTs = Date.now() - windowSec * 1000;
  try {
    const s = dbm.getTradeSummary(fromTs);
    res.json({
      success: true,
      window_sec: windowSec,
      from_ts: fromTs,
      buy_vol: s.buy_vol,
      sell_vol: s.sell_vol,
      buy_count: s.buy_count,
      sell_count: s.sell_count,
      last_buy:  s.last_buy,
      last_sell: s.last_sell,
      status: orderflow.status(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bundled 5m / 1h / 24h trend summaries. Source-of-truth is Binance's
// 1-minute klines (taker-buy volume per bar — lets us split buy vs sell
// for any window without 24h of our own archive). Falls back to local SQL
// if Binance is unreachable.
app.get('/api/order-flow/trends', async (req, res) => {
  try {
    const now = Date.now();
    let windows;
    try {
      windows = await orderflow.getHistoricalWindows();
    } catch {
      windows = null;
    }
    // SQL fallback for each window that Binance didn't provide.
    if (!windows) {
      windows = {};
      for (const [key, secs] of [['5m', 300], ['1h', 3600], ['24h', 86400]]) {
        const s = dbm.getTradeSummary(now - secs * 1000);
        windows[key] = { buy_vol: s.buy_vol, sell_vol: s.sell_vol, buy_count: s.buy_count, sell_count: s.sell_count };
      }
    }
    const last = dbm.getTradeSummary(now - 86400 * 1000);
    res.json({
      success: true, now, windows,
      last_buy: last.last_buy, last_sell: last.last_sell,
      status: orderflow.status(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PREDICTION HISTORY ────────────────────────────────────────────────────
app.get('/api/predictions/history', async (req, res) => {
  try {
    const limit = Math.min(1000, parseInt(req.query.limit) || 500);
    const type = req.query.type || null;

    // Auto-resolve any predictions whose target date has passed
    const unresolved = dbm.getUnresolvedPredictions();
    for (const p of unresolved) {
      try {
        const priceData = await cgGet('/simple/price', { ids: 'ethereum', vs_currencies: 'usd' });
        const currentPrice = priceData?.ethereum?.usd;
        if (currentPrice && p.eth_price_at_prediction) {
          const actual_move_pct = ((currentPrice - p.eth_price_at_prediction) / p.eth_price_at_prediction) * 100;
          const predicted = p.predicted_move_pct ?? 0;
          const error = Math.abs(actual_move_pct - predicted);
          const accuracy_score = Math.max(0, 100 - Math.min(100, error * 5));
          dbm.resolvePrediction(p.id, { actual_eth_price: currentPrice, actual_move_pct, accuracy_score });
        }
      } catch { /* non-fatal */ }
    }

    const rows = dbm.getPredictions(limit, type);
    res.json({ success: true, predictions: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/weather', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'weather.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── ADMIN: stats overview ─────────────────────────────────────────────────
app.get('/api/admin/stats', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const today = new Date().toISOString().slice(0, 10);
    const from  = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const rows  = dbm.getSentimentRange(from, today);

    const verdicts = { bullish: 0, bearish: 0, neutral: 0, pending: 0 };
    let hopeSum = 0, hopeCount = 0, macroSum = 0, macroCount = 0;
    let warDays = 0; // macro_score < -30 = geopolitical stress
    rows.forEach(r => {
      const v = (r.verdict || 'pending').toLowerCase();
      verdicts[v] = (verdicts[v] || 0) + 1;
      if (r.hope_score != null)  { hopeSum  += r.hope_score;  hopeCount++;  }
      if (r.macro_score != null) { macroSum += r.macro_score; macroCount++; }
      if (r.macro_score != null && r.macro_score < -30) warDays++;
    });
    const total = rows.length || 1;
    const preds = dbm.getPredictions(100, 'ai_forecast');
    const resolved = preds.filter(p => p.accuracy_score != null);
    const avgAccuracy = resolved.length ? resolved.reduce((s, p) => s + p.accuracy_score, 0) / resolved.length : null;

    res.json({
      success: true,
      period_days: days,
      total_days: rows.length,
      verdicts,
      verdict_pct: {
        bullish: +(verdicts.bullish / total * 100).toFixed(1),
        bearish: +(verdicts.bearish / total * 100).toFixed(1),
        neutral: +(verdicts.neutral / total * 100).toFixed(1),
      },
      avg_hope_score:  hopeCount  ? +(hopeSum  / hopeCount).toFixed(1)  : null,
      avg_macro_score: macroCount ? +(macroSum / macroCount).toFixed(1) : null,
      war_days: warDays,
      war_pct:  +(warDays / total * 100).toFixed(1),
      total_predictions: preds.length,
      resolved_predictions: resolved.length,
      avg_accuracy: avgAccuracy != null ? +avgAccuracy.toFixed(1) : null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ADMIN: posts + RSS stats (imported user_posts + today's sentiment/flow)
app.get('/api/admin/posts-stats', (req, res) => {
  try {
    const now = Date.now();
    const today      = new Date(now).toISOString().slice(0, 10);
    const sevenAgo   = new Date(now - 7 * 86400000).toISOString().slice(0, 10);
    const yesterday  = new Date(now - 1 * 86400000).toISOString().slice(0, 10);

    const allPosts = dbm.getUserPostsRange(sevenAgo, today);
    const todayPosts = allPosts.filter(p => p.date === today);

    const summarize = (posts) => {
      const hopes  = posts.map(p => p.hope_score).filter(n => typeof n === 'number');
      const wars   = posts.map(p => p.war_score).filter(n => typeof n === 'number');
      const sents  = { bullish: 0, bearish: 0, neutral: 0, mixed: 0, other: 0 };
      for (const p of posts) {
        const s = (p.people_sentiment || '').toLowerCase();
        if      (s.includes('bull'))   sents.bullish++;
        else if (s.includes('bear') || s.includes('fear') || s.includes('panic')) sents.bearish++;
        else if (s.includes('neutral')) sents.neutral++;
        else if (s.includes('mixed'))   sents.mixed++;
        else                            sents.other++;
      }
      const sourceMap = {};
      for (const p of posts) {
        const src = p.source || 'manual';
        sourceMap[src] = (sourceMap[src] || 0) + 1;
      }
      const top_sources = Object.entries(sourceMap)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6);
      const avg = (arr) => arr.length ? +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1) : null;
      return {
        post_count:   posts.length,
        hope_avg:     avg(hopes),
        war_avg:      avg(wars),
        sentiment:    sents,
        bull_bear_ratio: (sents.bullish + sents.bearish) > 0
          ? +(sents.bullish / (sents.bullish + sents.bearish)).toFixed(2) : null,
        top_sources,
      };
    };

    const todayStats = summarize(todayPosts);
    const weekStats  = summarize(allPosts);

    // Daily sentiment layer (NewsAPI-scored days).
    const sentRows = dbm.getSentimentRange(sevenAgo, today);
    const todayRow = sentRows.find(r => r.date === today) || null;
    const hopeVals  = sentRows.map(r => r.hope_score).filter(n => typeof n === 'number');
    const macroVals = sentRows.map(r => r.macro_score).filter(n => typeof n === 'number');
    const sentAvg = (arr) => arr.length ? +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(1) : null;
    const daily_sentiment = {
      today: todayRow ? {
        verdict:     todayRow.verdict,
        hope_score:  todayRow.hope_score,
        macro_score: todayRow.macro_score,
        eth_move_pct: todayRow.eth_move_pct,
      } : null,
      week_avg: {
        hope_score:  sentAvg(hopeVals),
        macro_score: sentAvg(macroVals),
        bullish_days: sentRows.filter(r => r.verdict === 'bullish').length,
        bearish_days: sentRows.filter(r => r.verdict === 'bearish').length,
        neutral_days: sentRows.filter(r => r.verdict === 'neutral').length,
      },
    };

    // Headline counts per category.
    const headlineCounts = { today: {}, week: {} };
    for (const cat of ['crypto', 'macro', 'hope']) {
      headlineCounts.today[cat] = dbm.countHeadlines(today, cat);
      let weekSum = 0;
      for (let i = 0; i < 7; i++) {
        const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
        weekSum += dbm.countHeadlines(d, cat);
      }
      headlineCounts.week[cat] = weekSum;
    }

    // Order flow (last 24h and last 7d).
    const flow24h = dbm.getTradeSummary(now - 24 * 60 * 60 * 1000);
    const flow7d  = dbm.getTradeSummary(now -  7 * 24 * 60 * 60 * 1000);
    const flowDigest = (s) => ({
      buy_vol:  Math.round(s.buy_vol  * 100) / 100,
      sell_vol: Math.round(s.sell_vol * 100) / 100,
      buy_count: s.buy_count,
      sell_count: s.sell_count,
      ratio: (s.buy_vol + s.sell_vol) > 0
        ? +(s.buy_vol / (s.buy_vol + s.sell_vol)).toFixed(3) : null,
      net_pressure: (s.buy_vol + s.sell_vol) > 0
        ? (s.buy_vol > s.sell_vol ? 'buy' : (s.sell_vol > s.buy_vol ? 'sell' : 'even')) : null,
    });

    res.json({
      success: true,
      today:    { ...todayStats, daily_sentiment: daily_sentiment.today, headlines: headlineCounts.today, flow: flowDigest(flow24h) },
      last_7d:  { ...weekStats,  daily_sentiment: daily_sentiment.week_avg, headlines: headlineCounts.week, flow: flowDigest(flow7d) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ADMIN: MASTER PREDICT — senior-strategist daily report ───────────────
app.post('/api/admin/master-predict', async (req, res) => {
  try {
    const data = await masterpredict.runMasterPredict();
    res.json({ success: true, data });
  } catch (err) {
    console.error('Master predict error:', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

// SSE variant — holds the connection open with keepalive pings so the browser
// never times out on long Opus runs (3-8 min). Client uses EventSource.
app.get('/api/admin/master-predict-stream', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if proxied
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const startTs = Date.now();

  // Ping every 10s so proxies/browsers keep the socket alive during the long
  // Opus generation. Each ping tells the client how many seconds have elapsed.
  const ping = setInterval(() => {
    send({ tick: true, elapsed_sec: Math.round((Date.now() - startTs) / 1000) });
  }, 10000);

  send({ phase: 'starting', elapsed_sec: 0 });

  try {
    const data = await masterpredict.runMasterPredict();
    send({ done: true, elapsed_sec: Math.round((Date.now() - startTs) / 1000), data });
  } catch (err) {
    console.error('Master predict SSE error:', err.message);
    send({ error: err.message });
  } finally {
    clearInterval(ping);
    res.end();
  }
});

app.get('/api/admin/master-predict/latest', (req, res) => {
  try {
    const rows = dbm.getPredictions(5, 'master_report');
    const reports = rows.map(r => ({
      id: r.id,
      created_ts: r.created_ts,
      eth_price_at_prediction: r.eth_price_at_prediction,
      predicted_direction: r.predicted_direction,
      confidence: r.confidence,
      raw_result: r.raw_result,
    }));
    res.json({ success: true, reports });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ADMIN: run new AI forecast (force) ───────────────────────────────────
app.post('/api/admin/run-forecast', async (req, res) => {
  const historyDays = Math.max(7, Math.min(90, parseInt(req.body?.history_days) || 90));
  const bias = ['bullish', 'bearish', 'neutral'].includes(req.body?.bias) ? req.body.bias : 'neutral';
  try {
    const data = await forecast.getForecast({ force: true, historyDays, bias });
    res.json({ success: true, data });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// ── ADMIN: combined multi-window forecast (SSE streaming) ────────────────
app.get('/api/admin/run-combined-forecast', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const result = await forecast.buildCombinedForecast({
      onProgress: (p) => send(p),
    });
    send({ done: true, pct: 100, result });
  } catch (err) {
    send({ error: err.message });
  } finally {
    res.end();
  }
});

// ── ADMIN: Opus max-layers forecast (SSE streaming) ──────────────────────
// Same pipeline as combined, but uses claude-opus-4-7 for every sub-run and
// the synthesis, and adds a 5th 90-day layer for deeper macro context.
app.get('/api/admin/run-opus-forecast', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const result = await forecast.buildCombinedForecast({
      model: 'claude-opus-4-7',
      windows: [7, 15, 30, 60, 90],
      onProgress: (p) => send(p),
    });
    send({ done: true, pct: 100, result });
  } catch (err) {
    send({ error: err.message });
  } finally {
    res.end();
  }
});

// ── ADMIN: delete a forecast ──────────────────────────────────────────────
app.delete('/api/admin/prediction/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const changes = dbm.deletePrediction(id);
    if (!changes) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, id });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── ADMIN: rescore sentiment ──────────────────────────────────────────────
app.post('/api/admin/rescore-sentiment', async (req, res) => {
  const days = Math.max(1, Math.min(60, parseInt(req.body?.days) || 7));
  try {
    const cleared = rescoreRecentDays(days);
    const rows = await buildMonthlySentiment(cgGet, { days, currency: 'usd' });
    res.json({ success: true, cleared, days_processed: rows.length });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
  }
});

// ── ADMIN: manual prediction ──────────────────────────────────────────────
app.post('/api/admin/prediction', (req, res) => {
  try {
    const { direction, expected_move_pct, confidence, horizon, narrative, headline } = req.body || {};
    if (!direction || !['bullish', 'bearish', 'neutral'].includes(direction)) {
      return res.status(400).json({ success: false, error: 'direction must be bullish|bearish|neutral' });
    }
    const now        = Date.now();
    const targetDate = new Date(now + 7 * 86400000).toISOString().slice(0, 10);
    let currentPrice = null;
    try { currentPrice = forecast.getCache()?.data?.anchor_price ?? null; } catch {}

    const raw = {
      direction, expected_move_pct, confidence,
      headline: headline || narrative || '',
      narrative: narrative || '',
      generated_ts: now, anchor_ts: now, anchor_price: currentPrice,
      horizon: horizon || '7d',
      model: 'manual',
      daily_breakdown: [], trajectory: [],
    };
    const id = dbm.savePrediction({
      type: 'ai_forecast',
      source_ref: 'manual',
      predicted_direction: direction,
      predicted_move_pct: expected_move_pct != null ? parseFloat(expected_move_pct) : null,
      confidence: confidence != null ? Math.round(parseFloat(confidence) * 100) : null,
      horizon: horizon || '7d',
      target_date: targetDate,
      eth_price_at_prediction: currentPrice,
      narrative: narrative || '',
      raw_result: raw,
    });
    res.json({ success: true, id, raw });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
const delay = ms => new Promise(r => setTimeout(r, ms));

// Priority order: user-facing defaults (USD 7D) fetched first; long tails last.
// Everything persists to disk so this only has to succeed once — future boots skip.
// `max` isn't listed — CoinGecko's free/demo tier 401s on it. If a user hits
// /api/eth-history?days=max we'll still try, but don't waste warm calls.
const WARM_HISTORY = [
  [7, 'usd'], [30, 'usd'], [1, 'usd'], [90, 'usd'], [365, 'usd'],
  [7, 'eur'], [30, 'eur'], [1, 'eur'], [90, 'eur'], [365, 'eur'],
];
const WARM_OHLC = [
  [7, 'usd'], [30, 'usd'], [1, 'usd'], [90, 'usd'], [365, 'usd'],
  [7, 'eur'], [30, 'eur'], [1, 'eur'], [90, 'eur'], [365, 'eur'],
];

const WARM_SPACING_MS    = 8000;   // between successful calls
const WARM_COOLDOWN_MS   = 60000;  // extra wait after a 429

async function warmOhlc(days, currency) {
  const key = `${days}-${currency}`;
  if (ohlcCache[key]?.data) return false;
  const raw = await cgGet('/coins/ethereum/ohlc', { vs_currency: currency, days });
  const data = raw.map(([ts, o, h, l, c]) => ({ time: Math.floor(ts / 1000), open: o, high: h, low: l, close: c }));
  ohlcCache[key] = { data, ts: Date.now() };
  saveCacheFile(`ohlc-${key}.json`, ohlcCache[key]);
  return true;
}

async function warmCaches() {
  // Current price — always refresh on boot so the first page load is instant.
  try { await fetchCurrentPrice(); console.log('Cache warmed: price'); }
  catch (err) { console.warn('Price warm failed:', err.message); }
  await delay(WARM_SPACING_MS);

  for (const [days, currency] of WARM_HISTORY) {
    const key = `${days}-${currency}`;
    if (cache.history[key]?.data) continue; // already on disk — skip permanently
    try {
      const raw = await fetchHistory(days, currency);
      console.log(`Cache warmed: history ${key} (${raw.prices.length} points)`);
      await delay(WARM_SPACING_MS);
    } catch (err) {
      console.warn(`History warm failed ${key}:`, err.message);
      // Back off hard on rate limit, otherwise just space normally.
      await delay(err.isRateLimit ? WARM_COOLDOWN_MS : WARM_SPACING_MS);
    }
  }

  // OHLC warms in background after history; same backoff pattern.
  (async () => {
    for (const [days, currency] of WARM_OHLC) {
      const key = `${days}-${currency}`;
      if (ohlcCache[key]?.data) continue;
      try {
        const warmed = await warmOhlc(days, currency);
        if (warmed) console.log(`Cache warmed: OHLC ${key} (${ohlcCache[key].data.length} candles)`);
        await delay(WARM_SPACING_MS);
      } catch (err) {
        console.warn(`OHLC warm failed ${key}:`, err.message);
        await delay(err.isRateLimit ? WARM_COOLDOWN_MS : WARM_SPACING_MS);
      }
    }
  })();
}

// ── TODAY-SENTIMENT HOURLY TIMER ────────────────────────────────────────
// The only server-side auto-AI cadence. Refreshes today's verdict / hope /
// macro every hour so /api/monthly-sentiment and forecast-context queries
// always see a current row for today. Persists to daily_sentiment so it
// feeds every downstream prediction.
const TODAY_SENTIMENT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function refreshTodaySentiment() {
  try {
    await buildTodaySentiment(cgGet, 'usd');
    console.log(`[today-sentiment] refreshed @ ${new Date().toISOString()}`);
  } catch (err) {
    console.warn('[today-sentiment] refresh failed:', err.message);
  }
}

app.listen(PORT, () => {
  console.log(`ETH Price Tracker running → http://localhost:${PORT}`);
  hydrateDiskCache();
  warmCaches();
  orderflow.start();

  // First run after 60s so the server has finished warming caches.
  setTimeout(refreshTodaySentiment, 60 * 1000);
  setInterval(refreshTodaySentiment, TODAY_SENTIMENT_INTERVAL_MS);
});
