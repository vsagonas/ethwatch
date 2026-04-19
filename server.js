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

app.get('/api/eth-info', async (req, res) => {
  try {
    const data = await cgGet('/coins/ethereum', {
      localization: false,
      tickers: false,
      market_data: true,
      community_data: false,
      developer_data: false,
    });
    const market = data.market_data;
    res.json({
      success: true,
      data: {
        name: data.name,
        symbol: data.symbol.toUpperCase(),
        image: data.image?.small,
        rank: data.market_cap_rank,
        usd: {
          price: market.current_price?.usd,
          ath: market.ath?.usd,
          atl: market.atl?.usd,
          change7d: market.price_change_percentage_7d,
          change30d: market.price_change_percentage_30d,
          change1y: market.price_change_percentage_1y,
        },
        eur: {
          price: market.current_price?.eur,
          ath: market.ath?.eur,
          atl: market.atl?.eur,
        },
        marketCap: { usd: market.market_cap?.usd, eur: market.market_cap?.eur },
        circulatingSupply: market.circulating_supply,
        totalSupply: market.total_supply,
      },
      serverTs: Date.now(),
    });
  } catch (err) {
    console.error('Info fetch error:', err.message);
    res.status(502).json({ success: false, error: 'Failed to fetch ETH info', detail: err.message });
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
      model: 'claude-sonnet-4-6',
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
    const rows = await buildMonthlySentiment(cgGet, { days, currency });
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
    const todayISO = new Date().toISOString().slice(0, 10);
    if (date === todayISO) {
      // Actively index today (prices + headlines + Claude) so the 1D card always shows real data.
      await buildTodaySentiment(cgGet, currency).catch(err => console.warn('buildTodaySentiment:', err.message));
    }
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

// ── ADMIN: run new AI forecast (force) ───────────────────────────────────
app.post('/api/admin/run-forecast', async (req, res) => {
  const historyDays = Math.max(7, Math.min(90, parseInt(req.body?.history_days) || 90));
  try {
    const data = await forecast.getForecast({ force: true, historyDays });
    res.json({ success: true, data });
  } catch (err) {
    res.status(502).json({ success: false, error: err.message });
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

app.listen(PORT, () => {
  console.log(`ETH Price Tracker running → http://localhost:${PORT}`);
  hydrateDiskCache();
  warmCaches();
  orderflow.start();
});
