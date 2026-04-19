'use strict';

// ETHWEATHER — Ethereum Climate Intelligence

const state = {
  currency: 'usd',
  price: null,
  forecast: null,
  history: [],
  vitals: null,
  todayDetail: null,
};

// ── WEATHER MAPPINGS ──────────────────────────────────────────────
const WEATHER_MAP = [
  { min:  8,    icon: '🌈', cond: 'CLEAR SKIES',    sky: 'rainbow' },
  { min:  4,    icon: '☀️',  cond: 'SUNNY',          sky: 'sunny'   },
  { min:  1,    icon: '🌤️', cond: 'PARTLY SUNNY',   sky: 'sunny'   },
  { min:  0,    icon: '⛅',  cond: 'OVERCAST',       sky: 'cloudy'  },
  { min: -2,    icon: '🌥️', cond: 'LIGHT CLOUDS',   sky: 'cloudy'  },
  { min: -5,    icon: '🌧️', cond: 'LIGHT RAIN',     sky: 'rainy'   },
  { min: -8,    icon: '⛈️',  cond: 'THUNDERSTORM',  sky: 'stormy'  },
  { min: -Infinity, icon: '🌪️', cond: 'SEVERE STORM', sky: 'stormy' },
];

function getWeather(pct) {
  for (const w of WEATHER_MAP) {
    if (pct >= w.min) return w;
  }
  return WEATHER_MAP[WEATHER_MAP.length - 1];
}

function fmtPrice(n, cur) {
  if (n == null || !isFinite(n)) return '—';
  const sym = cur === 'eur' ? '€' : '$';
  if (n >= 1e9)  return sym + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return sym + (n / 1e6).toFixed(2) + 'M';
  return sym + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n, decimals = 2) {
  if (n == null || !isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return sign + Number(n).toFixed(decimals) + '%';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── RAIN EFFECT ───────────────────────────────────────────────────
function buildRain() {
  const layer = document.getElementById('rainLayer');
  layer.innerHTML = '';
  for (let i = 0; i < 80; i++) {
    const d = document.createElement('div');
    d.className = 'raindrop';
    d.style.left     = Math.random() * 100 + 'vw';
    d.style.animationDuration  = (0.6 + Math.random() * 0.8) + 's';
    d.style.animationDelay     = (-Math.random() * 2) + 's';
    d.style.opacity  = 0.3 + Math.random() * 0.4;
    layer.appendChild(d);
  }
}

// ── LIGHTNING ─────────────────────────────────────────────────────
let lightningTimer = null;
function startLightning() {
  const layer = document.getElementById('lightningLayer');
  function flash() {
    layer.style.background = 'rgba(200,220,255,0.18)';
    setTimeout(() => { layer.style.background = 'transparent'; }, 80);
    lightningTimer = setTimeout(flash, 3000 + Math.random() * 8000);
  }
  clearTimeout(lightningTimer);
  flash();
}
function stopLightning() {
  clearTimeout(lightningTimer);
  const layer = document.getElementById('lightningLayer');
  if (layer) layer.style.background = 'transparent';
}

// ── SKY STATE ─────────────────────────────────────────────────────
function setSky(sky) {
  document.documentElement.dataset.weather = sky;
  buildRain();
  if (sky === 'stormy') startLightning(); else stopLightning();
}

// ── DATA FETCHING ─────────────────────────────────────────────────
async function fetchAll() {
  // Forecast is fetched separately (can be slow — serves cached instantly)
  const [priceRes, historyRes, vitalsRes] = await Promise.allSettled([
    fetch('/api/eth-price').then(r => r.json()),
    fetch('/api/monthly-sentiment?days=30').then(r => r.json()),
    fetch('/api/market-vitals').then(r => r.json()),
  ]);

  if (priceRes.status === 'fulfilled' && priceRes.value.success) {
    state.price = priceRes.value.data;
  }
  if (historyRes.status === 'fulfilled' && historyRes.value.success) {
    state.history = historyRes.value.data || [];
  }
  if (vitalsRes.status === 'fulfilled' && vitalsRes.value?.success) {
    state.vitals = vitalsRes.value.data || vitalsRes.value;
  }

  // fetch today's detail for alerts
  const today = new Date().toISOString().slice(0, 10);
  try {
    const det = await fetch(`/api/day-detail?date=${today}`).then(r => r.json());
    if (det.success) state.todayDetail = det.data;
  } catch {}
}

async function fetchForecastAndHistory() {
  // Load past forecasts from DB immediately (no generation needed)
  try {
    const histRes = await fetch('/api/forecast-7d/history?limit=10').then(r => r.json());
    if (histRes.success && histRes.forecasts?.length) {
      state.forecastHistory = histRes.forecasts;
      // Use the most recent as current if we don't have one yet
      if (!state.forecast) {
        const latest = histRes.forecasts[0];
        if (latest?.raw_result) {
          state.forecast = latest.raw_result;
        }
      }
      renderForecast();
      renderAlternates();
    }
  } catch {}

  // Now fetch live (served from 30min in-memory cache — fast if warm)
  try {
    const fcRes = await fetch('/api/forecast-7d').then(r => r.json());
    if (fcRes.success && fcRes.data) {
      state.forecast = fcRes.data;
      renderForecast();
    }
  } catch (err) {
    if (!state.forecast) {
      document.getElementById('forecastStrip').innerHTML =
        `<div class="wx-loading">Forecast unavailable: ${escHtml(err.message)}. Click RE-RUN to generate.</div>`;
    }
  }
}

// ── CURRENT CONDITIONS ────────────────────────────────────────────
async function renderCurrent() {
  const p = state.price;
  if (!p) return;

  const cur   = state.currency;
  const price = cur === 'eur' ? p.eur : p.usd;
  const pct24 = p.usd_24h_change;
  const wx    = getWeather(pct24);

  setSky(wx.sky);

  document.getElementById('bigIcon').textContent        = wx.icon;
  document.getElementById('hdrIcon').textContent        = wx.icon;
  document.getElementById('currentPrice').textContent   = fmtPrice(price, cur);
  document.getElementById('conditionLabel').textContent = wx.cond;

  const ch24el = document.getElementById('change24h');
  ch24el.textContent = fmtPct(pct24) + ' (24h)';
  ch24el.className   = 'wx-change ' + (pct24 >= 0 ? 'up' : 'down');

  // fetch eth-info for fuller stats
  try {
    const info = await fetch('/api/eth-info').then(r => r.json());
    if (info.success || info.data) {
      const d = info.data || info;
      const uf = cur === 'eur' ? d.eur : d.usd;
      document.getElementById('change7d').textContent  = fmtPct(uf?.change7d  ?? d.usd?.change7d);
      document.getElementById('change30d').textContent = fmtPct(uf?.change30d ?? d.usd?.change30d);
      document.getElementById('ath').textContent       = fmtPrice(uf?.ath ?? d.usd?.ath, cur);
      document.getElementById('rank').textContent      = '#' + (d.rank ?? '—');
    }
  } catch {}

  document.getElementById('mktCap').textContent = p.usd_market_cap
    ? fmtPrice(p.usd_market_cap, cur) : '—';
  document.getElementById('vol24h').textContent = p.usd_24h_vol
    ? fmtPrice(p.usd_24h_vol, cur) : '—';
}

// ── FORECAST STRIP ────────────────────────────────────────────────
function renderForecast() {
  const fc     = state.forecast;
  const strip  = document.getElementById('forecastStrip');
  const meta   = document.getElementById('forecastMeta');
  if (!fc?.daily_breakdown?.length) {
    strip.innerHTML = '<div class="wx-loading">No forecast available. Visit <a href="/admin" style="color:inherit">Admin</a> to generate one.</div>';
    return;
  }

  // meta banner
  meta.style.display = 'block';
  document.getElementById('fmHeadline').textContent = fc.headline || '—';
  const dirEl = document.getElementById('fmDirection');
  dirEl.textContent  = (fc.direction || '').toUpperCase();
  dirEl.className    = 'fm-badge ' + (fc.direction || '');
  const genTs = fc.generated_ts || fc.anchor_ts;
  const genLabel = genTs ? new Date(genTs).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  document.getElementById('fmConf').textContent = (fc.confidence != null ? 'Confidence: ' + Math.round(fc.confidence * 100) + '%' : '') + (genLabel ? '  ·  Generated ' + genLabel : '');
  const moveEl = document.getElementById('fmMove');
  const movePct = fc.expected_move_pct;
  moveEl.textContent = movePct != null ? fmtPct(movePct) + ' over 7d' : '—';
  moveEl.className   = 'fm-move ' + (movePct >= 0 ? 'up' : 'down');
  document.getElementById('fmNarrative').textContent = fc.narrative || '';
  const pm = fc.pattern_match;
  document.getElementById('fmPattern').textContent  = pm ? ('Analog: ' + (pm.analog_dates || '') + ' — ' + (pm.similarity || '')) : '';

  // day cards
  const anchorTs    = fc.anchor_ts || fc.generated_ts || Date.now();
  const anchorPrice = fc.anchor_price;
  const trajByHour  = new Map((fc.trajectory || []).map(p => [Math.round(p.offset_hours), p]));
  let compound = anchorPrice;

  strip.innerHTML = '';

  // TODAY card — current conditions
  const todayPct = state.price?.usd_24h_change ?? 0;
  const todayWx  = getWeather(todayPct);
  const todayCls = todayPct > 0.1 ? 'up' : todayPct < -0.1 ? 'down' : 'neutral';
  const todayPrice = state.currency === 'eur' ? state.price?.eur : state.price?.usd;
  const todayCard = document.createElement('div');
  todayCard.className = 'wx-fc-card glass today';
  todayCard.innerHTML = `
    <div class="fc-day">TODAY</div>
    <div class="fc-icon">${todayWx.icon}</div>
    <div class="fc-cond">${escHtml(todayWx.cond)}</div>
    <div class="fc-move ${todayCls}">${fmtPct(todayPct)}</div>
    <div class="fc-price">${todayPrice != null ? fmtPrice(todayPrice, state.currency) : '—'}</div>
  `;
  strip.appendChild(todayCard);

  fc.daily_breakdown.forEach(d => {
    const pct    = d.expected_move_pct;
    const wx     = getWeather(pct);
    const dayTs  = anchorTs + d.day * 86400000;
    const label  = new Date(dayTs).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const hourKey = d.day * 24;
    let traj = trajByHour.get(hourKey);
    let eodPrice = traj?.expected_eth_price;
    if (eodPrice == null && anchorPrice != null && isFinite(pct)) {
      compound = compound * (1 + pct / 100);
      eodPrice = compound;
    }
    const cls = pct > 0.1 ? 'up' : pct < -0.1 ? 'down' : 'neutral';

    const card = document.createElement('div');
    card.className = 'wx-fc-card glass' + (d.day === 1 ? ' today' : '');
    card.innerHTML = `
      <div class="fc-day">Day ${d.day} · ${escHtml(label)}</div>
      <div class="fc-icon">${wx.icon}</div>
      <div class="fc-cond">${escHtml(wx.cond)}</div>
      <div class="fc-move ${cls}">${fmtPct(pct)}</div>
      <div class="fc-price">${eodPrice != null ? fmtPrice(eodPrice, state.currency) : '—'}</div>
    `;
    card.addEventListener('click', () => openFcDayModal(d, wx, eodPrice, traj, fc));
    strip.appendChild(card);
  });
}

// ── VITALS ────────────────────────────────────────────────────────
function renderVitals() {
  const v = state.vitals;
  if (!v) return;
  const t = v.technicals || v;
  const d = v.derivatives || {};
  const m = v.market || {};

  // RSI → temperature
  const rsi = t.rsi14 ?? t.rsi;
  if (rsi != null) {
    document.getElementById('vtRsi').textContent = rsi.toFixed(1);
    document.getElementById('vtRsiDesc').textContent = rsi > 70 ? 'OVERHEATED' : rsi < 30 ? 'ICY COLD' : 'COMFORTABLE';
  }

  // Volume → humidity
  const vol = (state.price?.usd_24h_vol);
  if (vol) {
    document.getElementById('vtVol').textContent    = fmtPrice(vol, 'usd');
    document.getElementById('vtVolDesc').textContent = vol > 2e10 ? 'HIGH HUMIDITY' : vol > 5e9 ? 'MODERATE' : 'DRY';
  }

  // Funding → wind
  const fr = d.funding_rate ?? v.funding_rate;
  if (fr != null) {
    document.getElementById('vtFunding').textContent    = (fr * 100).toFixed(4) + '%';
    document.getElementById('vtFundingDesc').textContent = fr > 0.001 ? 'STRONG TAILWIND' : fr < -0.001 ? 'HEADWIND' : 'CALM';
  }

  // BTC dom → pressure
  const btcdom = d.btc_dominance ?? v.btc_dominance ?? m.btc_dominance;
  if (btcdom != null) {
    document.getElementById('vtBtcDom').textContent    = btcdom.toFixed(1) + '%';
    document.getElementById('vtBtcDomDesc').textContent = btcdom > 55 ? 'HIGH PRESSURE (BTC heavy)' : btcdom < 45 ? 'LOW PRESSURE (alt season)' : 'BALANCED';
  }

  // F&G → lightning
  const fg = d.fear_greed ?? v.fear_greed;
  if (fg != null) {
    const fgVal = typeof fg === 'object' ? (fg.value ?? fg.index) : fg;
    document.getElementById('vtFg').textContent    = fgVal + '/100';
    document.getElementById('vtFgDesc').textContent = fgVal >= 75 ? 'EXTREME GREED ⚡' : fgVal >= 55 ? 'GREED' : fgVal <= 25 ? 'EXTREME FEAR 🌪️' : fgVal <= 45 ? 'FEAR' : 'NEUTRAL';
  }

  // OI → tide
  const oi = d.open_interest ?? v.open_interest;
  if (oi != null) {
    document.getElementById('vtOi').textContent    = fmtPrice(oi, 'usd');
    document.getElementById('vtOiDesc').textContent = 'Open positions in market';
  }

  // BB width → visibility
  const bb = t.bollinger_bw ?? t.bb_width;
  if (bb != null) {
    document.getElementById('vtBb').textContent    = bb.toFixed(2) + '%';
    document.getElementById('vtBbDesc').textContent = bb < 5 ? 'DENSE FOG (low volatility)' : bb > 15 ? 'CLEAR (high vol)' : 'PATCHY CLOUDS';
  }

  // Gas
  const gas = v.gas ?? v.gas_gwei;
  if (gas != null) {
    document.getElementById('vtGas').textContent    = gas + ' gwei';
    document.getElementById('vtGasDesc').textContent = gas > 50 ? 'CONGESTED' : gas > 20 ? 'MODERATE' : 'SMOOTH';
  }
}

// ── STORM ALERTS ──────────────────────────────────────────────────
function renderAlerts() {
  const det = state.todayDetail;
  const container = document.getElementById('alertsContainer');
  const items = [];

  const addItems = (arr, cat) => {
    (arr || []).forEach(h => {
      items.push({ cat, title: h.title, source: h.source || h.s || '' });
    });
  };

  if (det) {
    addItems(det.headlines       || det.top_headlines,       'crypto');
    addItems(det.macro_headlines || det.top_macro_headlines, 'macro');
    addItems(det.hope_headlines  || det.top_hope_headlines,  'hope');
  }

  if (!items.length) {
    container.innerHTML = '<div class="wx-loading">No alerts today.</div>';
    return;
  }

  const ICONS = { crypto: '🚨', macro: '⚠️', hope: '🌱' };
  const LABELS = { crypto: 'CRYPTO ADVISORY', macro: 'MACRO STORM WARNING', hope: 'HOPE SIGNAL' };

  container.innerHTML = items.map(it => `
    <div class="wx-alert ${escHtml(it.cat)}">
      <div class="wa-icon">${ICONS[it.cat] || '📰'}</div>
      <div class="wa-content">
        <div class="wa-level">${LABELS[it.cat] || it.cat.toUpperCase()}</div>
        <div class="wa-title">${escHtml(it.title)}</div>
        ${it.source ? `<div class="wa-source">${escHtml(it.source)}</div>` : ''}
      </div>
    </div>
  `).join('');
}

// ── CLIMATE HISTORY ───────────────────────────────────────────────
function renderClimate() {
  const strip = document.getElementById('climateStrip');
  const days  = state.history;
  if (!days.length) {
    strip.innerHTML = '<div class="wx-loading">No history.</div>';
    return;
  }

  strip.innerHTML = '';
  days.slice().reverse().forEach(day => {
    const pct  = day.eth_move_pct;
    const wx   = getWeather(pct ?? 0);
    const cls  = (pct ?? 0) > 0.05 ? 'up' : (pct ?? 0) < -0.05 ? 'down' : 'neutral';
    const dd   = new Date(day.date);
    const lbl  = dd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const hope = day.hope_score;
    const hopeH = hope != null ? Math.abs(hope - 50) * 2 : 0;
    const hopeColor = hope != null ? (hope >= 50 ? 'rgba(52,211,153,0.6)' : 'rgba(248,113,113,0.5)') : 'transparent';

    const card = document.createElement('div');
    card.className = 'wx-cl-card';
    card.innerHTML = `
      <div class="cl-date">${escHtml(lbl)}</div>
      <div class="cl-icon">${wx.icon}</div>
      <div class="cl-move ${cls}">${fmtPct(pct)}</div>
      <div class="cl-hope" style="background:${hopeColor}; height:${Math.max(2, hopeH * 0.15)}px"></div>
    `;
    card.addEventListener('click', () => openDayModal(day, wx));
    strip.appendChild(card);
  });
}

// ── DAY MODAL ─────────────────────────────────────────────────────
function openDayModal(day, wx) {
  const modal = document.getElementById('dayModal');
  document.getElementById('dmIcon').textContent      = wx?.icon || '⛅';
  document.getElementById('dmDate').textContent      = day.date;
  document.getElementById('dmCondition').textContent = wx?.cond || '';

  const cur = state.currency;
  let html = '';

  html += `<h4>MARKET DATA</h4>`;
  html += stat('ETH Close', fmtPrice(day.eth_price, cur));
  html += stat('ETH Move', fmtPct(day.eth_move_pct));
  html += stat('BTC Move', fmtPct(day.btc_move_pct));
  html += stat('Verdict', day.verdict || '—');
  if (day.hope_score != null) html += stat('Hope Score', day.hope_score + '/100');
  if (day.macro_score != null) html += stat('Macro Score', day.macro_score + '/100 (−100..+100)');

  if (day.summary) {
    html += `<h4>CLIMATE SUMMARY</h4><div class="mo-narrative">${escHtml(day.summary)}</div>`;
  }
  if (day.hope_summary) {
    html += `<h4>HOPE REPORT</h4><div class="mo-narrative">${escHtml(day.hope_summary)}</div>`;
  }
  if (day.macro_summary) {
    html += `<h4>MACRO CONDITIONS</h4><div class="mo-narrative">${escHtml(day.macro_summary)}</div>`;
  }

  const headlines = day.top_headlines || [];
  const macro     = day.top_macro_headlines || [];
  const hope      = day.top_hope_headlines || [];

  if (headlines.length) {
    html += `<h4>🚨 CRYPTO ADVISORIES</h4>`;
    headlines.forEach(h => { html += newsItem(h); });
  }
  if (macro.length) {
    html += `<h4>⚠️ MACRO STORM WARNINGS</h4>`;
    macro.forEach(h => { html += newsItem(h); });
  }
  if (hope.length) {
    html += `<h4>🌱 HOPE SIGNALS</h4>`;
    hope.forEach(h => { html += newsItem(h); });
  }

  document.getElementById('dmBody').innerHTML = html;
  modal.style.display = 'flex';
}

// ── FORECAST DAY MODAL ────────────────────────────────────────────
function openFcDayModal(d, wx, eodPrice, traj, fc) {
  const modal = document.getElementById('fcDayModal');
  const anchorTs = fc.anchor_ts || fc.generated_ts || Date.now();
  const dayTs    = anchorTs + d.day * 86400000;
  const label    = new Date(dayTs).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

  document.getElementById('fcdIcon').textContent      = wx.icon;
  document.getElementById('fcdDate').textContent      = `Day ${d.day} — ${label}`;
  document.getElementById('fcdCondition').textContent = wx.cond + ' (' + fmtPct(d.expected_move_pct) + ')';

  let html = '';
  html += `<h4>FORECAST</h4>`;
  html += stat('Expected Move', fmtPct(d.expected_move_pct));
  html += stat('Projected Price', eodPrice != null ? fmtPrice(eodPrice, state.currency) : '—');
  if (traj?.low && traj?.high) {
    html += stat('Range (80%CI)', fmtPrice(traj.low, state.currency) + ' – ' + fmtPrice(traj.high, state.currency));
  }

  if (d.key_event) {
    html += `<h4>KEY EVENT</h4><div class="mo-key-event">⚡ ${escHtml(d.key_event)}</div>`;
  }
  if (d.narrative) {
    html += `<h4>NARRATIVE</h4><div class="mo-narrative">${escHtml(d.narrative)}</div>`;
  }

  // Show trajectory points for this day (offsets within the day)
  const dayStartH = (d.day - 1) * 24;
  const dayEndH   = d.day * 24;
  const dayTraj   = (fc.trajectory || []).filter(p => p.offset_hours > dayStartH && p.offset_hours <= dayEndH);
  if (dayTraj.length) {
    html += `<h4>6H TRAJECTORY</h4><div class="mo-traj">`;
    dayTraj.forEach(p => {
      const timeLabel = new Date(anchorTs + p.offset_hours * 3600000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      html += `<div class="mo-traj-pt">
        <div class="tp-lbl">+${p.offset_hours}h · ${timeLabel}</div>
        <div class="tp-price">${fmtPrice(p.expected_eth_price, state.currency)}</div>
        ${p.low && p.high ? `<div class="tp-range">${fmtPrice(p.low, state.currency)}–${fmtPrice(p.high, state.currency)}</div>` : ''}
      </div>`;
    });
    html += `</div>`;
  }

  if (fc.key_drivers?.length && d.day === 1) {
    html += `<h4>KEY DRIVERS</h4>`;
    fc.key_drivers.forEach(dr => { html += `<div class="mo-driver">${escHtml(dr)}</div>`; });
  }
  if (fc.risks?.length && d.day >= 6) {
    html += `<h4>RISK FACTORS</h4>`;
    fc.risks.forEach(r => { html += `<div class="mo-risk">${escHtml(r)}</div>`; });
  }

  document.getElementById('fcdBody').innerHTML = html;
  modal.style.display = 'flex';
}

// ── HELPERS ───────────────────────────────────────────────────────
function stat(label, val) {
  return `<div class="mo-stat"><span>${escHtml(label)}</span><span>${escHtml(String(val))}</span></div>`;
}
function newsItem(h) {
  const src = h.source || h.s || '';
  const ttl = h.title  || h.t || '';
  return `<div class="mo-news-item">${src ? `<div class="mo-src">${escHtml(src)}</div>` : ''}<div>${escHtml(ttl)}</div></div>`;
}

// ── ALTERNATE FORECASTS ───────────────────────────────────────────
function renderAlternates() {
  const history = state.forecastHistory || [];
  let container = document.getElementById('alternatesSection');
  if (!container) return;

  // Filter to past forecasts that differ from current (skip the very latest if it's the active one)
  const current = state.forecast;
  const currentTs = current?.generated_ts || current?.anchor_ts || 0;
  const alts = history.filter(row => {
    const fc = row.raw_result;
    if (!fc?.daily_breakdown?.length) return false;
    const ts = fc.generated_ts || fc.anchor_ts || row.created_ts;
    return Math.abs(ts - currentTs) > 60000; // skip if same minute
  });

  if (!alts.length) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  const list = document.getElementById('alternatesList');
  list.innerHTML = alts.map((row, i) => {
    const fc  = row.raw_result;
    const ts  = fc?.generated_ts || fc?.anchor_ts || row.created_ts;
    const lbl = ts ? new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const dir = fc?.direction || row.predicted_direction || '—';
    const pct = fc?.expected_move_pct ?? row.predicted_move_pct;
    const cls = dir === 'bullish' ? 'up' : dir === 'bearish' ? 'down' : 'neutral';
    const wx  = pct != null ? getWeather(pct) : { icon: '⛅' };
    return `<div class="alt-fc-card glass" data-alt-index="${i}">
      <div class="alt-icon">${wx.icon}</div>
      <div class="alt-info">
        <div class="alt-date">${escHtml(lbl)}</div>
        <div class="alt-dir ${cls}">${escHtml(dir.toUpperCase())} ${pct != null ? fmtPct(pct) : ''}</div>
        <div class="alt-head">${escHtml((fc?.headline || row.narrative || '').slice(0, 80))}</div>
      </div>
      <button class="alt-load-btn" data-alt-index="${i}">VIEW</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.alt-load-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.altIndex);
      const fc  = alts[idx]?.raw_result;
      if (!fc) return;
      state.forecast = fc;
      renderForecast();
      container.querySelectorAll('.alt-fc-card').forEach((c, ci) => {
        c.classList.toggle('active', ci === idx);
      });
    });
  });
}

// ── RE-RUN FORECAST ───────────────────────────────────────────────
async function rerunForecast() {
  const btn     = document.getElementById('rerunForecastBtn');
  const spinner = document.getElementById('forecastSpinner');
  btn.disabled  = true;
  spinner.classList.add('active');
  document.getElementById('forecastMeta').style.display = 'none';
  document.getElementById('forecastStrip').innerHTML = '<div class="wx-loading">Generating AI forecast… (may take 30-60s)</div>';

  try {
    const res = await fetch('/api/forecast-7d?force=1').then(r => r.json());
    if (res.success) {
      state.forecast = res.data;
      renderForecast();
      // Refresh history list to include the new forecast
      const histRes = await fetch('/api/forecast-7d/history?limit=10').then(r => r.json());
      if (histRes.success) { state.forecastHistory = histRes.forecasts; renderAlternates(); }
    } else {
      document.getElementById('forecastStrip').innerHTML = `<div class="wx-loading">Error: ${escHtml(res.error || 'Unknown error')}</div>`;
    }
  } catch (err) {
    document.getElementById('forecastStrip').innerHTML = `<div class="wx-loading">Network error: ${escHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    spinner.classList.remove('active');
  }
}

// ── CURRENCY TOGGLE ───────────────────────────────────────────────
function initCurrencyToggle() {
  document.querySelectorAll('.cur-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cur-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currency = btn.dataset.cur;
      renderCurrent();
      renderForecast();
    });
  });
}

// ── MODALS ────────────────────────────────────────────────────────
function initModals() {
  document.getElementById('dayModalClose').addEventListener('click', () => {
    document.getElementById('dayModal').style.display = 'none';
  });
  document.getElementById('fcDayModalClose').addEventListener('click', () => {
    document.getElementById('fcDayModal').style.display = 'none';
  });
  document.getElementById('dayModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  document.getElementById('fcDayModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      document.getElementById('dayModal').style.display   = 'none';
      document.getElementById('fcDayModal').style.display = 'none';
    }
  });
}

// ── PRICE REFRESH ─────────────────────────────────────────────────
async function refreshPrice() {
  try {
    const res = await fetch('/api/eth-price').then(r => r.json());
    if (res.success) {
      state.price = res.data;
      renderCurrent();
    }
  } catch {}
}

// ── INIT ──────────────────────────────────────────────────────────
async function init() {
  buildRain();
  initCurrencyToggle();
  initModals();

  // Render other sections immediately (don't block on forecast)
  await fetchAll();
  renderCurrent();
  renderVitals();
  renderAlerts();
  renderClimate();

  // Forecast loads asynchronously: DB history first, then live cache
  fetchForecastAndHistory();

  setInterval(refreshPrice, 30000);
}

document.addEventListener('DOMContentLoaded', init);
