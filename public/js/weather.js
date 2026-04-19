'use strict';

// ETHWEATHER — Ethereum Climate Intelligence

const state = {
  currency: 'usd',
  price: null,
  forecast: null,
  vitals: null,
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
  const [priceRes, vitalsRes] = await Promise.allSettled([
    fetch('/api/eth-price').then(r => r.json()),
    fetch('/api/market-vitals').then(r => r.json()),
  ]);

  if (priceRes.status === 'fulfilled' && priceRes.value.success) {
    state.price = priceRes.value.data;
  }
  if (vitalsRes.status === 'fulfilled' && vitalsRes.value?.success) {
    state.vitals = vitalsRes.value.data || vitalsRes.value;
  }
}

async function fetchForecast() {
  try {
    const fcRes = await fetch('/api/forecast-7d').then(r => r.json());
    if (fcRes.success && fcRes.data) {
      state.forecast = fcRes.data;
      renderForecast();
    }
  } catch (err) {
    document.getElementById('forecastStrip').innerHTML =
      `<div class="wx-loading">Forecast unavailable: ${escHtml(err.message)}. Visit <a href="/admin" style="color:inherit">Admin</a> to generate one.</div>`;
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
  const fr = v.funding_rate;
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
  const fg = v.fg_value;
  if (fg != null) {
    document.getElementById('vtFg').textContent    = fg + '/100';
    document.getElementById('vtFgDesc').textContent = fg >= 75 ? 'EXTREME GREED ⚡' : fg >= 55 ? 'GREED' : fg <= 25 ? 'EXTREME FEAR 🌪️' : fg <= 45 ? 'FEAR' : 'NEUTRAL';
  }

  // OI → tide
  const oiEth = v.open_interest_eth;
  const ethUsd = v.eth_usd;
  if (oiEth != null && ethUsd != null) {
    document.getElementById('vtOi').textContent    = fmtPrice(oiEth * ethUsd, 'usd');
    document.getElementById('vtOiDesc').textContent = 'Open positions in market';
  }

  // BB width → visibility
  const bb = t.bb_width_pct;
  if (bb != null) {
    document.getElementById('vtBb').textContent    = bb.toFixed(2) + '%';
    document.getElementById('vtBbDesc').textContent = bb < 5 ? 'DENSE FOG (low volatility)' : bb > 15 ? 'CLEAR (high vol)' : 'PATCHY CLOUDS';
  }

  // Gas
  const gas = v.gas_gwei;
  if (gas != null) {
    document.getElementById('vtGas').textContent    = gas + ' gwei';
    document.getElementById('vtGasDesc').textContent = gas > 50 ? 'CONGESTED' : gas > 20 ? 'MODERATE' : 'SMOOTH';
  }
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
  document.getElementById('fcDayModalClose').addEventListener('click', () => {
    document.getElementById('fcDayModal').style.display = 'none';
  });
  document.getElementById('fcDayModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.getElementById('fcDayModal').style.display = 'none';
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

  await fetchAll();
  await renderCurrent();
  renderVitals();

  fetchForecast();

  setInterval(refreshPrice, 30000);
}

document.addEventListener('DOMContentLoaded', init);
