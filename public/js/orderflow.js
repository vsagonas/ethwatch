/* ═══════════════════════════════════════════════════════════
   ETHWATCH — Live Order Flow Module (Binance WebSocket)
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ── STATE ──────────────────────────────────────────────────
let ws = null;
let wsReconnectTimer = null;
const MAX_ROWS = 1;
const WINDOW_5M = 5 * 60 * 1000;

const buys  = [];  // { price, qty, time }
const sells = [];

// ── HELPERS ────────────────────────────────────────────────
function fmtQty(q) {
  return q >= 100 ? q.toFixed(1) : q.toFixed(3);
}

// Binance feeds are USD-only. Convert to whatever currency the user has active.
function fmtPriceOF(usdPrice) {
  const fx  = window.fxFromUSD || 1;
  const cur = window.activeCurrency || 'usd';
  const sym = cur === 'eur' ? '€' : '$';
  const v = usdPrice * fx;
  return `${sym}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Remember the last trades in USD so we can repaint them when the currency changes.
let lastBuyUsd = null;
let lastSellUsd = null;
// Track the wall-clock timestamp (ms since epoch) of the most recent trade we
// actually used for each chip. Lets the 5s server-refresh overwrite a stale
// chip when the WS has silently lagged or dropped.
let lastShownBuyTs  = 0;
let lastShownSellTs = 0;
let lastWsMsgTs     = 0;

// ── STATUS ─────────────────────────────────────────────────
function setOFStatus(status) {
  const dot   = document.getElementById('ofDot');
  const label = document.getElementById('ofLabel');
  if (!dot) return;
  dot.className = `of-status-dot ${status}`;
  label.textContent = { live: 'Live', connecting: 'Connecting…', error: 'Disconnected' }[status] || status;
}

// ── ROLLING WINDOW ─────────────────────────────────────────
function trimWindow(arr) {
  const cutoff = Date.now() - WINDOW_5M;
  while (arr.length > 0 && arr[0].time < cutoff) arr.shift();
}

// Local 5m trend used only as a fallback if the server poll fails.
function computeLocalTrend() {
  trimWindow(buys);
  trimWindow(sells);
  return {
    buy_vol:  buys.reduce((s, t) => s + t.qty, 0),
    sell_vol: sells.reduce((s, t) => s + t.qty, 0),
  };
}

function applyTrend(buyVol, sellVol) {
  const total = buyVol + sellVol;
  const buyEl  = document.getElementById('of5mBuy');
  const sellEl = document.getElementById('of5mSell');
  const arrow  = document.getElementById('trendArrow');
  const text   = document.getElementById('trendText');
  const block  = document.getElementById('trendArrowBlock');
  if (!buyEl) return;

  buyEl.textContent  = total > 0 ? `${fmtQty(buyVol)} ETH` : '—';
  sellEl.textContent = total > 0 ? `${fmtQty(sellVol)} ETH` : '—';

  if (total === 0) { arrow.textContent = '→'; text.textContent = 'No data'; block.className = 'trend-arrow-block neutral'; return; }

  const ratio = buyVol / total;
  if (ratio > 0.55) {
    arrow.textContent = '↑'; text.textContent = 'Up Trend';  block.className = 'trend-arrow-block bullish';
  } else if (ratio < 0.45) {
    arrow.textContent = '↓'; text.textContent = 'Down Trend'; block.className = 'trend-arrow-block bearish';
  } else {
    arrow.textContent = '→'; text.textContent = 'Neutral';    block.className = 'trend-arrow-block neutral';
  }
}

let windowsCache = null;
let activeWindowKey = 'of5m';
const WINDOW_ALIAS = { 'of5m': '5m', 'of1h': '1h', 'of24h': '24h' };

function setActiveWindow(tabKey) {
  activeWindowKey = tabKey;
  document.querySelectorAll('#ofWindowTabs .of-tab').forEach(t => {
    t.classList.toggle('active', `of${t.dataset.window}` === tabKey);
  });
  renderActiveWindow();
}

function renderActiveWindow() {
  const key = WINDOW_ALIAS[activeWindowKey] || '5m';
  const w = windowsCache?.[key];
  const buyVol  = w?.buy_vol  || 0;
  const sellVol = w?.sell_vol || 0;
  const total   = buyVol + sellVol;

  document.getElementById('ofLabelBuy').textContent  = `${key.toUpperCase()} Buy`;
  document.getElementById('ofLabelSell').textContent = `${key.toUpperCase()} Sell`;
  document.getElementById('ofCurBuy').textContent    = total > 0 ? `${fmtQty(buyVol)} ETH`  : '—';
  document.getElementById('ofCurSell').textContent   = total > 0 ? `${fmtQty(sellVol)} ETH` : '—';

  const arrow = document.getElementById('ofTrendArrow');
  const text  = document.getElementById('ofTrendText');
  const block = document.getElementById('ofTrendBlock');
  if (total === 0) { arrow.textContent = '→'; text.textContent = '—'; block.className = 'trend-arrow-block neutral'; return; }
  const ratio = buyVol / total;
  if (ratio > 0.55)      { arrow.textContent = '↑'; text.textContent = 'Up';      block.className = 'trend-arrow-block bullish'; }
  else if (ratio < 0.45) { arrow.textContent = '↓'; text.textContent = 'Down';    block.className = 'trend-arrow-block bearish'; }
  else                   { arrow.textContent = '→'; text.textContent = 'Neutral'; block.className = 'trend-arrow-block neutral'; }
}

async function refreshTrendFromServer() {
  try {
    const res = await fetch('/api/order-flow/trends');
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed');
    windowsCache = json.windows || {};
    renderActiveWindow();

    // Overwrite whichever chip has an older timestamp than the server does.
    // The server keeps its own independent Binance WS → SQLite pipeline, so
    // when our in-page WS silently lags, the server is still current.
    const srvBuy  = json.last_buy;
    const srvSell = json.last_sell;
    if (srvBuy && typeof srvBuy.ts === 'number' && srvBuy.ts > lastShownBuyTs) {
      addRow('buyFeed',  srvBuy.price,  srvBuy.qty,  srvBuy.ts);
    }
    if (srvSell && typeof srvSell.ts === 'number' && srvSell.ts > lastShownSellTs) {
      addRow('sellFeed', srvSell.price, srvSell.qty, srvSell.ts);
    }
  } catch {
    const { buy_vol, sell_vol } = computeLocalTrend();
    windowsCache = { '5m': { buy_vol, sell_vol } };
    renderActiveWindow();
  }
}

// ── FEED ROWS (legacy — now writes to the compact chips) ─────────────
function addRow(feedId, priceUsd, qty, tradeTs /* ms since epoch — optional */) {
  const isBuy = feedId === 'buyFeed';
  const ts    = typeof tradeTs === 'number' ? tradeTs : Date.now();
  // Ignore updates older than what's already shown (can arrive from a stale
  // server refresh racing a newer WS trade).
  if (isBuy  && ts < lastShownBuyTs)  return;
  if (!isBuy && ts < lastShownSellTs) return;

  if (isBuy) { lastBuyUsd  = { price: priceUsd, qty }; lastShownBuyTs  = ts; }
  else       { lastSellUsd = { price: priceUsd, qty }; lastShownSellTs = ts; }

  const priceEl = document.getElementById(isBuy ? 'lastBuyPrice' : 'lastSellPrice');
  const qtyEl   = document.getElementById(isBuy ? 'lastBuyQty'   : 'lastSellQty');
  const chip    = priceEl?.closest('.lt-chip');
  if (priceEl) priceEl.textContent = fmtPriceOF(priceUsd);
  if (qtyEl)   qtyEl.textContent   = `${fmtQty(qty)} ETH`;
  if (chip)    { chip.classList.add('flash'); setTimeout(() => chip.classList.remove('flash'), 400); }
}

// Repaint whatever is stored when the user changes currency.
function repaintLastTrades() {
  if (lastBuyUsd) {
    const el = document.getElementById('lastBuyPrice');
    if (el) el.textContent = fmtPriceOF(lastBuyUsd.price);
  }
  if (lastSellUsd) {
    const el = document.getElementById('lastSellPrice');
    if (el) el.textContent = fmtPriceOF(lastSellUsd.price);
  }
}
window.repaintLastTrades = repaintLastTrades;

// Rolling 10-second ETH/s rates.
// Spotlight = whichever side is currently dominant (higher rate).
// Both chips go dark when rates are equal or one is zero.
function updateRates() {
  const cutoff = Date.now() - 10000;
  const recentBuy  = buys.filter(t => t.time >= cutoff);
  const recentSell = sells.filter(t => t.time >= cutoff);
  const buyRate  = recentBuy.reduce((s, t) => s + t.qty, 0) / 10;
  const sellRate = recentSell.reduce((s, t) => s + t.qty, 0) / 10;

  const buyEl  = document.getElementById('ofBuyRate');
  const sellEl = document.getElementById('ofSellRate');
  if (buyEl)  buyEl.textContent  = buyRate  > 0 ? buyRate.toFixed(3)  : '—';
  if (sellEl) sellEl.textContent = sellRate > 0 ? sellRate.toFixed(3) : '—';

  const buyChip  = document.getElementById('ofBuyRateChip');
  const sellChip = document.getElementById('ofSellRateChip');
  const total = buyRate + sellRate;
  const buyDominant  = total > 0 && buyRate  > sellRate;
  const sellDominant = total > 0 && sellRate > buyRate;
  if (buyChip)  buyChip.classList.toggle('spotlight', buyDominant);
  if (sellChip) sellChip.classList.toggle('spotlight', sellDominant);
}

// ── WEBSOCKET ──────────────────────────────────────────────
function connectOrderFlow() {
  if (ws) { ws.close(); ws = null; }
  clearTimeout(wsReconnectTimer);
  setOFStatus('connecting');

  ws = new WebSocket('wss://stream.binance.com:9443/ws/ethusdt@aggTrade');

  ws.onopen = () => {
    setOFStatus('live');
  };

  ws.onmessage = (event) => {
    const t = JSON.parse(event.data);
    if (t.e !== 'aggTrade') return;

    const price  = parseFloat(t.p);
    const qty    = parseFloat(t.q);
    const isSell = t.m; // buyer is maker → sell pressure
    const tradeTs = typeof t.T === 'number' ? t.T : Date.now();
    lastWsMsgTs   = Date.now();

    if (isSell) {
      sells.push({ price, qty, time: tradeTs });
      addRow('sellFeed', price, qty, tradeTs);
    } else {
      buys.push({ price, qty, time: tradeTs });
      addRow('buyFeed', price, qty, tradeTs);
    }
  };

  ws.onerror = () => setOFStatus('error');

  ws.onclose = () => {
    setOFStatus('error');
    wsReconnectTimer = setTimeout(connectOrderFlow, 5000);
  };
}

// ── TREND TICKER ──────────────────────────────────────────
// Server is the source of truth (always-on Binance consumer → SQL). We pull
// fresh aggregate stats every 5s so the trend reflects EVERY trade, not just
// what this browser has seen since it connected.
setInterval(refreshTrendFromServer, 5000);
setInterval(updateRates, 1000);
// Watchdog: ETHUSDT fires many aggTrades per second. If we go > 30s without a
// single message, the socket has silently hung — force a reconnect so chips
// don't freeze at an old price while the rest of the page updates.
setInterval(() => {
  if (!lastWsMsgTs) return; // haven't received a first trade yet — normal at boot
  if (Date.now() - lastWsMsgTs > 30000) {
    setOFStatus('error');
    connectOrderFlow();
  }
}, 15000);

// ── INIT ───────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  refreshTrendFromServer(); // populate instantly from SQL cache
  connectOrderFlow();       // then attach the live feed for last buy/sell rows
  document.querySelectorAll('#ofWindowTabs .of-tab').forEach(tab => {
    tab.addEventListener('click', () => setActiveWindow(`of${tab.dataset.window}`));
  });
  // Repaint USD-only feeds whenever the user toggles currency.
  document.querySelectorAll('.currency-btn').forEach(btn => {
    btn.addEventListener('click', () => setTimeout(repaintLastTrades, 50));
  });
});
