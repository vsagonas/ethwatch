'use strict';

// Server-side consumer of Binance's ETHUSDT aggTrade stream. Persists every
// trade to SQLite so the 5-minute trend is always available to fresh browser
// sessions instantly, and we build a permanent trade-history archive.

const axios = require('axios');
const dbm = require('../db');

const STREAM_URL = 'wss://stream.binance.com:9443/ws/ethusdt@aggTrade';
const RECONNECT_MS = 5000;
const FLUSH_MS = 1000;
const MAX_BATCH = 200;

let ws = null;
let buffer = [];
let flushTimer = null;
let reconnectTimer = null;
let lastError = null;
let connectedAt = 0;

function flush() {
  if (!buffer.length) return;
  const batch = buffer;
  buffer = [];
  try { dbm.insertTradesBatch(batch); }
  catch (err) { console.warn('Order-flow flush failed:', err.message); }
}

function handleMessage(raw) {
  let t;
  try { t = JSON.parse(raw); } catch { return; }
  if (t.e !== 'aggTrade') return;
  buffer.push({
    agg_id: Number(t.a),
    ts: Number(t.T),
    price: parseFloat(t.p),
    qty: parseFloat(t.q),
    is_sell: t.m ? 1 : 0,
  });
  if (buffer.length >= MAX_BATCH) flush();
}

function connect() {
  clearTimeout(reconnectTimer);
  try {
    // Node 22+ ships the whatwg WebSocket globally; fall back to `ws` lib if absent.
    const WS = global.WebSocket || require('ws');
    ws = new WS(STREAM_URL);
  } catch (err) {
    lastError = err.message;
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
    return;
  }

  // Normalize between browser-style (onmessage) and ws-lib (on('message')) APIs.
  const onMsg = (ev) => handleMessage(typeof ev === 'string' ? ev : (ev?.data ?? ev));
  if (typeof ws.on === 'function') {
    ws.on('open',    () => { connectedAt = Date.now(); lastError = null; });
    ws.on('message', (data) => handleMessage(typeof data === 'string' ? data : data.toString('utf8')));
    ws.on('close',   () => scheduleReconnect());
    ws.on('error',   (err) => { lastError = err?.message || String(err); try { ws.close(); } catch {} });
  } else {
    ws.onopen    = () => { connectedAt = Date.now(); lastError = null; };
    ws.onmessage = (ev) => onMsg(ev.data ?? ev);
    ws.onclose   = () => scheduleReconnect();
    ws.onerror   = (err) => { lastError = err?.message || 'ws error'; try { ws.close(); } catch {} };
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, RECONNECT_MS);
}

function start() {
  if (flushTimer) return; // already running
  flushTimer = setInterval(flush, FLUSH_MS);
  connect();
  console.log('Order-flow consumer started (Binance ETHUSDT aggTrade → SQLite).');
}

function status() {
  return {
    connected: !!ws && (ws.readyState === 1),
    connected_at: connectedAt || null,
    buffered: buffer.length,
    last_error: lastError,
  };
}

// ── Historical buy/sell windows via Binance 1-minute klines ───────────────
// Klines expose taker-buy volume per minute which lets us split buy vs sell
// for arbitrary windows without needing 24h of our own archive. One HTTP
// call of 1440 1-min rows covers 5m / 1h / 24h, and is cached 60s.
let klineCache = { data: null, ts: 0 };
const KLINE_TTL_MS = 60 * 1000;

async function fetchKlines1440() {
  if (klineCache.data && Date.now() - klineCache.ts < KLINE_TTL_MS) return klineCache.data;
  try {
    const r = await axios.get('https://api.binance.com/api/v3/klines', {
      params: { symbol: 'ETHUSDT', interval: '1m', limit: 1440 },
      timeout: 8000,
    });
    klineCache = { data: r.data, ts: Date.now() };
    return r.data;
  } catch (err) {
    if (klineCache.data) return klineCache.data; // serve stale on rate limit
    throw err;
  }
}

function summarizeWindow(klines, minutes) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  let buyVol = 0, sellVol = 0, buyCount = 0, sellCount = 0;
  for (const k of klines) {
    if (Number(k[0]) < cutoff) continue;
    const vol = parseFloat(k[5]);
    const takerBuy = parseFloat(k[9]);
    const trades = parseInt(k[8]);
    buyVol  += takerBuy;
    sellVol += Math.max(0, vol - takerBuy);
    if (vol > 0) {
      const r = takerBuy / vol;
      buyCount  += trades * r;
      sellCount += trades * (1 - r);
    }
  }
  return {
    buy_vol: buyVol, sell_vol: sellVol,
    buy_count: Math.round(buyCount), sell_count: Math.round(sellCount),
  };
}

async function getHistoricalWindows() {
  const klines = await fetchKlines1440();
  return {
    '5m':  summarizeWindow(klines, 5),
    '1h':  summarizeWindow(klines, 60),
    '24h': summarizeWindow(klines, 1440),
  };
}

module.exports = { start, status, getHistoricalWindows };
