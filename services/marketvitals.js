'use strict';

// Aggregates a snapshot of market-wide + ETH-specific stats for the hero
// "Market Vitals" frame. Every external call is wrapped so any one source
// being down degrades gracefully — the user sees whatever we managed to fetch.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dbm = require('../db');
const { ema, macd, bollinger, latest } = require('./indicators');

const TTL = 5 * 60 * 1000;   // 5 min — rate-friendly for all these APIs
let cache = { data: null, ts: 0 };

async function safeGet(url, params, headers) {
  try {
    const r = await axios.get(url, { params, headers, timeout: 8000 });
    return r.data;
  } catch {
    return null;
  }
}

// ── External sources ──────────────────────────────────────────────────────
async function fetchBinanceFunding() {
  const d = await safeGet('https://fapi.binance.com/fapi/v1/premiumIndex', { symbol: 'ETHUSDT' });
  if (!d) return null;
  return {
    funding_rate: parseFloat(d.lastFundingRate),
    mark_price:   parseFloat(d.markPrice),
    next_funding_ts: Number(d.nextFundingTime),
  };
}

async function fetchBinanceOI() {
  const d = await safeGet('https://fapi.binance.com/fapi/v1/openInterest', { symbol: 'ETHUSDT' });
  if (!d?.openInterest) return null;
  return { open_interest_eth: parseFloat(d.openInterest) };
}

async function fetchCoinGeckoGlobal() {
  const d = await safeGet('https://api.coingecko.com/api/v3/global');
  if (!d?.data) return null;
  return {
    btc_dominance:       d.data.market_cap_percentage?.btc,
    eth_dominance:       d.data.market_cap_percentage?.eth,
    total_market_cap_usd:d.data.total_market_cap?.usd,
    global_volume_24h:   d.data.total_volume?.usd,
    active_cryptos:      d.data.active_cryptocurrencies,
  };
}

async function fetchFearGreed() {
  const d = await safeGet('https://api.alternative.me/fng/?limit=1');
  const row = d?.data?.[0];
  if (!row) return null;
  return {
    fg_value: parseInt(row.value),
    fg_label: row.value_classification,
    fg_ts:    parseInt(row.timestamp) * 1000,
  };
}

async function fetchBtcHashRate() {
  const d = await safeGet('https://mempool.space/api/v1/mining/hashrate/3d');
  if (!d?.currentHashrate) return null;
  return { btc_hash_rate: d.currentHashrate }; // H/s
}

async function fetchEthGas() {
  const d = await safeGet('https://api.owlracle.info/v4/eth/gas');
  const speeds = d?.speeds;
  if (!Array.isArray(speeds) || !speeds.length) return null;
  const std = speeds.find(s => s.acceptance === 0.6) || speeds[1] || speeds[0];
  return {
    gas_gwei:       std?.gasPrice != null ? Math.round(std.gasPrice) : null,
    gas_base_fee:   d?.baseFee != null ? Math.round(d.baseFee) : null,
  };
}

async function fetchEthBtcRatio() {
  const d = await safeGet('https://api.coingecko.com/api/v3/simple/price', {
    ids: 'ethereum,bitcoin', vs_currencies: 'usd,btc',
  });
  const r = d?.ethereum?.btc;
  if (!r) return null;
  return { eth_btc_ratio: r, eth_usd: d.ethereum?.usd, btc_usd: d.bitcoin?.usd };
}

// ── Indicators — computed from cached 30-day ETH hourly history ───────────
function readHourlyPrices(currency = 'usd') {
  try {
    const p = path.join(__dirname, '..', 'cache', `history-30-${currency}.json`);
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (json?.data?.prices || []).map(([, price]) => price);
  } catch { return []; }
}

function computeTechnicals(currency = 'usd') {
  const values = readHourlyPrices(currency);
  if (values.length < 60) return null;

  const ema20Arr  = ema(values, 20);
  const ema50Arr  = ema(values, 50);
  const ema200Arr = ema(values, 200);
  const { macd: macdArr, signal: signalArr, histogram } = macd(values);
  const bb = bollinger(values, 20, 2);

  const lastPrice = values[values.length - 1];
  const lastEma20  = latest(ema20Arr);
  const lastEma50  = latest(ema50Arr);
  const lastEma200 = latest(ema200Arr);
  const lastMacd   = latest(macdArr);
  const lastSignal = latest(signalArr);
  const lastHist   = latest(histogram);
  const lastBBW    = latest(bb.width);

  let macd_cross = 'none';
  if (lastMacd != null && lastSignal != null) {
    if (lastHist > 0 && histogram[histogram.length - 2] != null && histogram[histogram.length - 2] <= 0) macd_cross = 'bullish_cross';
    else if (lastHist < 0 && histogram[histogram.length - 2] != null && histogram[histogram.length - 2] >= 0) macd_cross = 'bearish_cross';
    else macd_cross = lastHist > 0 ? 'bull' : 'bear';
  }

  return {
    price: lastPrice,
    ema20: lastEma20,
    ema50: lastEma50,
    ema200: lastEma200,
    ema20_vs_price_pct:  lastEma20  != null ? ((lastPrice - lastEma20)  / lastEma20)  * 100 : null,
    ema50_vs_price_pct:  lastEma50  != null ? ((lastPrice - lastEma50)  / lastEma50)  * 100 : null,
    ema200_vs_price_pct: lastEma200 != null ? ((lastPrice - lastEma200) / lastEma200) * 100 : null,
    macd: lastMacd,
    macd_signal: lastSignal,
    macd_hist: lastHist,
    macd_cross,
    bb_width_pct: lastBBW,
    bb_squeeze: lastBBW != null && lastBBW < 4, // tight bands — volatility coiled
  };
}

// ── Aggregate + cache ─────────────────────────────────────────────────────
async function buildVitals() {
  const settled = await Promise.allSettled([
    fetchBinanceFunding(),
    fetchBinanceOI(),
    fetchCoinGeckoGlobal(),
    fetchFearGreed(),
    fetchBtcHashRate(),
    fetchEthGas(),
    fetchEthBtcRatio(),
  ]);
  const vals = settled.map(s => s.status === 'fulfilled' ? s.value : null);
  const merged = Object.assign({}, ...vals.filter(Boolean));

  const technicals = computeTechnicals('usd');
  if (technicals) merged.technicals = technicals;

  merged.generated_ts = Date.now();
  return merged;
}

async function getVitals({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.ts < TTL) return cache.data;
  const data = await buildVitals();
  cache = { data, ts: Date.now() };
  // Archive — one JSON snapshot per build so we have a full history.
  try { dbm.saveMarketVitals?.(data); } catch {}
  return data;
}

module.exports = { getVitals };
