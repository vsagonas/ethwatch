/* ═══════════════════════════════════════════════════════════
   ETHWATCH — Live Ethereum Tracker  |  Frontend App
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ── STATE ──────────────────────────────────────────────────
const state = {
  currency: 'usd',
  days: 7,
  theme: 'dark',
  darkMode: true,
  currentPrice: null,
  prevPrice: null,
  historyData: null,
  patterns: [],
  alerts: JSON.parse(localStorage.getItem('eth_alerts') || '[]'),
  indicators: { sma20: false, ema50: false, volume: false },
  refreshInterval: null,
  countdown: 30,
  countdownInterval: null,
};
window.state = state;

// ── CHART INSTANCES ────────────────────────────────────────
let priceChart = null;
let rsiChart = null;

// ── FORMATTING HELPERS ─────────────────────────────────────
const SYMBOLS = { usd: '$', eur: '€' };

function fmtPrice(v, currency) {
  if (v == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
}

function fmtLarge(v, currency) {
  if (v == null) return '—';
  const sym = SYMBOLS[currency] || '$';
  if (v >= 1e12) return `${sym}${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `${sym}${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6)  return `${sym}${(v / 1e6).toFixed(2)}M`;
  return `${sym}${v.toLocaleString()}`;
}

function fmtPct(v) {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function fmtDateShort(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── TOAST ──────────────────────────────────────────────────
function toast(msg, type = 'info', duration = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ── API CALLS ──────────────────────────────────────────────
async function apiFetch(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || 'API error');
  return json;
}

async function loadPrice() {
  const json = await apiFetch('/api/eth-price');
  return json.data;
}

async function loadHistory(days, currency) {
  const json = await apiFetch(`/api/eth-history?days=${days}&currency=${currency}`);
  return json;
}

async function loadPatterns(currency) {
  const json = await apiFetch(`/api/patterns?currency=${currency}`);
  return json.patterns;
}

async function loadInfo() {
  const json = await apiFetch('/api/eth-info');
  return json.data;
}

// ── STATUS INDICATOR ───────────────────────────────────────
function setStatus(state) {
  const dot = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  if (dot)   dot.className = `status-dot ${state}`;
  if (label) label.textContent = state === 'error' ? 'Error' : state === 'loading' ? 'Loading' : 'Live';
}

// ── PRICE DISPLAY ──────────────────────────────────────────
function updatePriceDisplay(priceData) {
  const cur = state.currency;
  const price = priceData[cur];
  const change = priceData[`${cur}_24h_change`];

  const prevPrice = state.currentPrice?.[cur];
  state.prevPrice = prevPrice;
  state.currentPrice = priceData;

  // FX rate for converting USD-only feeds (Binance order flow) into the
  // currently selected display currency. 1 when user is viewing USD.
  if (priceData.usd) {
    const active = priceData[cur];
    window.fxFromUSD = (active && cur !== 'usd') ? (active / priceData.usd) : 1;
  }
  window.activeCurrency = cur;

  const priceEl = document.getElementById('priceValue');
  const changeEl = document.getElementById('priceChange');
  const symbolEl = document.getElementById('priceSymbol');
  const updatedEl = document.getElementById('lastUpdated');

  symbolEl.textContent = SYMBOLS[cur];
  priceEl.textContent = price != null
    ? price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—';

  if (prevPrice != null && price != null) {
    priceEl.classList.remove('price-flash-up', 'price-flash-down');
    void priceEl.offsetWidth;
    priceEl.classList.add(price > prevPrice ? 'price-flash-up' : 'price-flash-down');
  }

  changeEl.textContent = fmtPct(change);
  changeEl.className = `price-change ${change >= 0 ? 'up' : 'down'}`;

  updatedEl.textContent = `Updated ${new Date().toLocaleTimeString()}`;

  checkAlerts(price, cur);
}

function updateStats(priceData, infoData) {
  const cur = state.currency;

  document.getElementById('statMarketCap').textContent =
    fmtLarge(priceData[`${cur}_market_cap`] ?? infoData?.marketCap?.[cur], cur);

  document.getElementById('statVolume').textContent =
    fmtLarge(priceData[`${cur}_24h_vol`], cur);

  if (infoData) {
    const chg7d = infoData.usd?.change7d;
    const chg30d = infoData.usd?.change30d;
    const el7d = document.getElementById('stat7d');
    const el30d = document.getElementById('stat30d');
    el7d.textContent = fmtPct(chg7d);
    el7d.style.color = chg7d >= 0 ? 'var(--gain)' : 'var(--loss)';
    el30d.textContent = fmtPct(chg30d);
    el30d.style.color = chg30d >= 0 ? 'var(--gain)' : 'var(--loss)';

    const athKey = cur === 'eur' ? 'eur' : 'usd';
    document.getElementById('statATH').textContent = fmtPrice(infoData[athKey]?.ath, cur);
    document.getElementById('statRank').textContent = `#${infoData.rank}`;
  }
}

// ── COLOR HELPERS ──────────────────────────────────────────
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function isDark() {
  return document.documentElement.getAttribute('data-theme') !== 'light';
}

// ── PRICE CHART ────────────────────────────────────────────
function buildPriceChart(histJson) {
  const canvas = document.getElementById('priceChart');
  const ctx = canvas.getContext('2d');
  const loader = document.getElementById('chartLoader');

  const prices = histJson.prices;
  const vols = histJson.volumes;
  const { sma20, ema50 } = histJson.indicators;

  const labels = prices.map(p => new Date(p.ts));
  const priceValues = prices.map(p => p.price);
  const volValues = vols.map(v => v.vol);

  // In 1M mode, default the visible window to the last 7 days so the user
  // sees week-level detail immediately (not only after panning). Setting
  // min/max here — instead of post-build zoomScale() — avoids the race where
  // the first render paints the full 30-day range before the zoom applies.
  // Pan limits are set to the full data range so the user can still scroll
  // left through the earlier ~23 days.
  let initialXMin, initialXMax, panLimitMin, panLimitMax;
  if (prices.length) {
    panLimitMin = prices[0].ts;
    panLimitMax = prices[prices.length - 1].ts;
  }
  // If a 7-day AI forecast is active AND we're on 1W view, extend the pan
  // right-limit by 8 days so the user can scroll forward into the prediction.
  // IMPORTANT: we still pin the INITIAL visible range to the 7-day history
  // only — otherwise Chart.js auto-fits to the full 15-day span (history +
  // forecast) and the real price line gets squished into half the canvas.
  if (state.days === 7 && prices.length) {
    initialXMin = prices[0].ts;
    initialXMax = prices[prices.length - 1].ts;
    if (window.activePrediction?.trajectory?.length) {
      panLimitMax = prices[prices.length - 1].ts + 8 * 86400000;
    }
  }
  if (state.days === 30 && prices.length) {
    initialXMax = prices[prices.length - 1].ts;
    initialXMin = initialXMax - 7 * 86400000;
  }

  // Gradient fill under price line
  const accentColor = isDark() ? '#58a6ff' : '#0969da';
  const gradient = ctx.createLinearGradient(0, 0, 0, 380);
  gradient.addColorStop(0, isDark() ? 'rgba(88,166,255,0.25)' : 'rgba(9,105,218,0.15)');
  gradient.addColorStop(1, isDark() ? 'rgba(88,166,255,0.01)' : 'rgba(9,105,218,0.01)');

  const tickColor = isDark() ? '#8b949e' : '#656d76';
  const gridColor = isDark() ? 'rgba(48,54,61,0.5)' : 'rgba(208,215,222,0.5)';

  const datasets = [
    {
      label: `ETH / ${state.currency.toUpperCase()}`,
      data: priceValues,
      borderColor: accentColor,
      backgroundColor: gradient,
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 5,
      fill: true,
      tension: 0.3,
      yAxisID: 'yPrice',
      order: 1,
    },
  ];

  if (state.indicators.sma20 && sma20) {
    datasets.push({
      label: 'SMA 20',
      data: sma20,
      borderColor: '#f0883e',
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
      yAxisID: 'yPrice',
      order: 2,
      borderDash: [4, 3],
    });
  }

  if (state.indicators.ema50 && ema50) {
    datasets.push({
      label: 'EMA 50',
      data: ema50,
      borderColor: '#bc8cff',
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
      yAxisID: 'yPrice',
      order: 3,
      borderDash: [2, 4],
    });
  }

  if (state.indicators.volume) {
    const volColors = priceValues.map((v, i) =>
      i === 0 ? 'rgba(88,166,255,0.4)' :
      v >= priceValues[i - 1] ? 'rgba(63,185,80,0.4)' : 'rgba(248,81,73,0.4)'
    );
    datasets.push({
      label: 'Volume',
      data: volValues,
      type: 'bar',
      backgroundColor: volColors,
      yAxisID: 'yVol',
      order: 10,
    });
  }

  if (priceChart) { priceChart.destroy(); priceChart = null; }

  priceChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: {
            color: tickColor,
            boxWidth: 24,
            boxHeight: 2,
            padding: 12,
            font: { size: 11 },
          },
        },
        tooltip: { enabled: false }, // custom #lineTooltip handles all hover display
        zoom: {
          // Zoom gestures are DISABLED per user request — only the Full Month
          // button can expand the view. Pan stays on so the user can scroll
          // horizontally through the 1M range at the default 1W zoom.
          zoom: {
            wheel: { enabled: false },
            pinch: { enabled: false },
            drag:  { enabled: false },
            mode: 'x',
          },
          pan: { enabled: true, mode: 'x' },
          // Pan limits use the FULL data range (not 'original', which would
          // collapse to the initial zoomed-in 7-day window and block pan).
          limits: {
            x: {
              min: panLimitMin != null ? panLimitMin : 'original',
              max: panLimitMax != null ? panLimitMax : 'original',
            },
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'PPp' },
          grid: { display: false },
          ticks: { color: tickColor, maxTicksLimit: 8, font: { size: 11 } },
          min: initialXMin,
          max: initialXMax,
        },
        yPrice: {
          position: 'right',
          grid: { display: false },
          ticks: {
            color: tickColor,
            font: { size: 11 },
            callback: v => fmtPrice(v, state.currency),
          },
        },
        yVol: {
          position: 'left',
          grid: { display: false },
          ticks: {
            color: isDark() ? 'rgba(139,148,158,0.4)' : 'rgba(101,109,118,0.5)',
            font: { size: 10 },
            callback: v => fmtLarge(v, state.currency),
            maxTicksLimit: 4,
          },
          max: volValues.reduce((a, b) => Math.max(a, b || 0), 0) * 5,
        },
      },
    },
    plugins: [{
      // Keep the aligned strip in sync with the chart's x-scale on every render
      // (pan, resize, data change).
      id: 'monthStripSync',
      afterRender(chart) { window.positionStripOnChart?.(chart); },
    }],
  });

  canvas.style.height = '340px';
  loader.classList.add('hidden');

  // ── Line chart crosshair tooltip ──────────────────────────
  // Matches the candle tooltip style. Handles two regions:
  //   • History  — shows close price + day % move
  //   • Forecast — shows forecast price + confidence + direction
  const lineTip = document.getElementById('lineTooltip');
  if (lineTip) {
    canvas.addEventListener('mousemove', e => {
      if (!priceChart || !lineTip) return;
      const rect   = canvas.getBoundingClientRect();
      const x      = e.clientX - rect.left;
      const y      = e.clientY - rect.top;
      const fx     = window.fxFromUSD || 1;
      const cur    = state.currency || 'usd';
      const sym    = cur === 'eur' ? '€' : '$';
      const fmt    = v => v == null ? '—' : `${sym}${(v * fx).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

      const labels      = priceChart.data.labels;
      const lastLabelTs = labels?.length ? +new Date(labels[labels.length - 1]) : 0;
      const hoverTs     = priceChart.scales?.x ? priceChart.scales.x.getValueForPixel(x) : 0;

      // ── FORECAST REGION ──────────────────────────────────
      if (lastLabelTs > 0 && hoverTs > lastLabelTs) {
        const prophecy = window.activePrediction;
        if (!prophecy?.trajectory?.length) { lineTip.style.display = 'none'; return; }

        const anchorMs = prophecy.anchor_ts || Date.now();
        // Find the two trajectory points that bracket hoverTs, interpolate price
        const absTraj = prophecy.trajectory
          .map(p => ({ ms: anchorMs + p.offset_hours * 3600000, price: p.expected_eth_price, low: p.low, high: p.high }))
          .sort((a, b) => a.ms - b.ms);

        let fcPrice = null, fcLow = null, fcHigh = null;
        for (let i = 0; i < absTraj.length - 1; i++) {
          const a = absTraj[i], b = absTraj[i + 1];
          if (hoverTs >= a.ms && hoverTs <= b.ms) {
            const t = (hoverTs - a.ms) / (b.ms - a.ms);
            fcPrice = a.price + (b.price - a.price) * t;
            if (a.low != null && b.low != null)   fcLow  = a.low  + (b.low  - a.low)  * t;
            if (a.high != null && b.high != null)  fcHigh = a.high + (b.high - a.high) * t;
            break;
          }
        }
        if (fcPrice == null && absTraj.length) {
          // past the last point — use final value
          const last = absTraj[absTraj.length - 1];
          if (hoverTs >= last.ms) { fcPrice = last.price; fcLow = last.low; fcHigh = last.high; }
        }
        if (fcPrice == null) { lineTip.style.display = 'none'; return; }

        const dir     = prophecy.direction || 'neutral';
        const conf    = prophecy.confidence != null ? Math.round(prophecy.confidence * 100) : null;
        const dirColor = dir === 'bullish' ? '#3fb950' : dir === 'bearish' ? '#f85149' : '#d29922';
        const dirSym   = dir === 'bullish' ? '▲' : dir === 'bearish' ? '▼' : '→';
        const dateStr  = new Date(hoverTs).toLocaleString('en-US', {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const rangeStr = (fcLow != null && fcHigh != null && Math.abs(fcHigh - fcLow) > 1)
          ? `<div class="lwt-ohlc"><span>Low <b>${fmt(fcLow)}</b></span><span>High <b>${fmt(fcHigh)}</b></span></div>` : '';
        const confStr  = conf != null ? ` <span class="lwt-move" style="color:${dirColor}">${conf}% conf</span>` : '';

        lineTip.innerHTML = `
          <div class="lwt-time">${dateStr} · FORECAST</div>
          <div class="lwt-close" style="color:${dirColor}">${fmt(fcPrice)} <span class="lwt-move">${dirSym} ${dir.toUpperCase()}</span>${confStr}</div>
          ${rangeStr}`;

        const W  = canvas.offsetWidth;
        const TW = 210;
        lineTip.style.left    = `${x + 14 + TW > W ? x - TW - 14 : x + 14}px`;
        lineTip.style.top     = `${y - 70 < 0 ? y + 10 : y - 70}px`;
        lineTip.style.display = '';
        return;
      }

      // ── HISTORY REGION ───────────────────────────────────
      const pts = priceChart.getElementsAtEventForMode(e, 'index', { intersect: false }, false);
      if (!pts.length) { lineTip.style.display = 'none'; return; }
      const ds0el = pts.find(p => p.datasetIndex === 0);
      if (!ds0el) { lineTip.style.display = 'none'; return; }
      const idx      = ds0el.index;
      const priceY   = priceChart.data.datasets[0]?.data?.[idx];
      const labelTs  = labels?.[idx];
      if (priceY == null || !labelTs) { lineTip.style.display = 'none'; return; }
      const price = Number(priceY);
      const ts    = new Date(labelTs);
      if (!isFinite(price) || isNaN(ts.getTime())) { lineTip.style.display = 'none'; return; }

      // compute day % change vs prev close
      const prevPrice = idx > 0 ? Number(priceChart.data.datasets[0]?.data?.[idx - 1]) : null;
      const movePct   = (prevPrice && isFinite(prevPrice) && prevPrice > 0)
        ? ((price - prevPrice) / prevPrice * 100) : null;
      const moveColor = movePct == null ? '' : movePct >= 0 ? '#3fb950' : '#f85149';
      const moveSym   = movePct == null ? '' : movePct >= 0 ? '▲' : '▼';
      const moveStr   = movePct != null
        ? ` <span class="lwt-move" style="color:${moveColor}">${moveSym} ${Math.abs(movePct).toFixed(2)}%</span>` : '';

      const dateStr = ts.toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      lineTip.innerHTML = `
        <div class="lwt-time">${dateStr}</div>
        <div class="lwt-close" style="color:${moveColor || 'inherit'}">${fmt(price)}${moveStr}</div>`;

      const W  = canvas.offsetWidth;
      const TW = 180;
      lineTip.style.left    = `${x + 14 + TW > W ? x - TW - 14 : x + 14}px`;
      lineTip.style.top     = `${y - 60 < 0 ? y + 10 : y - 60}px`;
      lineTip.style.display = '';
    });
    canvas.addEventListener('mouseleave', () => { lineTip.style.display = 'none'; });
  }

  window.priceChart = priceChart;
  window.buildPriceChart = buildPriceChart;

  // ── Pan buttons (‹ ›) ────────────────────────────────────
  const panStep = () => Math.round(canvas.offsetWidth * 0.2);
  document.getElementById('linePanLeft')?.addEventListener('click', () => {
    priceChart?.pan({ x: panStep() });
  });
  document.getElementById('linePanRight')?.addEventListener('click', () => {
    priceChart?.pan({ x: -panStep() });
  });

  // ── Two-finger trackpad horizontal scroll ────────────────
  canvas.addEventListener('wheel', e => {
    if (!priceChart) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      priceChart.pan({ x: -e.deltaX });
    }
  }, { passive: false });

  // If an Oracle prediction is currently active, re-attach its overlay.
  window.renderPredictionOverlay?.();
  window.positionStripOnChart?.(priceChart);
}

function updatePriceChart(histJson) {
  if (!priceChart) { buildPriceChart(histJson); return; }
  buildPriceChart(histJson);
}

// ── RSI CHART ──────────────────────────────────────────────
function buildRSIChart(histJson) {
  const canvas = document.getElementById('rsiChart');
  const ctx = canvas.getContext('2d');
  const { rsi } = histJson.indicators;
  const labels = histJson.prices.map(p => new Date(p.ts));
  const tickColor = isDark() ? '#8b949e' : '#656d76';
  const gridColor = isDark() ? 'rgba(48,54,61,0.3)' : 'rgba(208,215,222,0.3)';

  const rsiColors = rsi.map(v =>
    v == null ? 'transparent' :
    v > 70 ? 'rgba(248,81,73,0.8)' :
    v < 30 ? 'rgba(63,185,80,0.8)' : 'rgba(88,166,255,0.8)'
  );

  if (rsiChart) { rsiChart.destroy(); rsiChart = null; }

  rsiChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'RSI',
        data: rsi,
        borderColor: rsiColors,
        segment: {
          borderColor: ctx => {
            const v = ctx.p1.parsed.y;
            return v > 70 ? '#f85149' : v < 30 ? '#3fb950' : '#58a6ff';
          },
        },
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => fmtDate(items[0].parsed.x),
            label: item => ` RSI: ${item.raw?.toFixed(2) ?? '—'}`,
          },
        },
        annotation: {
          annotations: {
            ob: { type: 'line', yMin: 70, yMax: 70, borderColor: 'rgba(248,81,73,0.4)', borderWidth: 1, borderDash: [4,3] },
            os: { type: 'line', yMin: 30, yMax: 30, borderColor: 'rgba(63,185,80,0.4)', borderWidth: 1, borderDash: [4,3] },
          },
        },
      },
      scales: {
        x: {
          type: 'time',
          grid: { color: gridColor, drawBorder: false },
          ticks: { color: tickColor, maxTicksLimit: 8, font: { size: 10 } },
        },
        y: {
          min: 0, max: 100,
          position: 'right',
          grid: { color: gridColor, drawBorder: false },
          ticks: { color: tickColor, font: { size: 10 }, stepSize: 25 },
        },
      },
    },
  });

  canvas.style.height = '120px';
}

// ── PATTERNS ───────────────────────────────────────────────
function renderPatterns(patterns) {
  const grid = document.getElementById('patternsGrid');

  if (!patterns || patterns.length === 0) {
    grid.innerHTML = '';
    grid.closest('.patterns-section')?.style.setProperty('display', 'none');
    return;
  }
  grid.closest('.patterns-section')?.style.removeProperty('display');

  grid.innerHTML = '';

  patterns.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'pattern-card clickable';
    const isUp = p.priceChangePct >= 0;
    const iso = new Date(p.startTs).toISOString().slice(0, 10);
    card.dataset.date = iso;
    card.title = `Click for full news + sentiment on ${iso}`;

    card.innerHTML = `
      <div class="pattern-header">
        <div>
          <div class="pattern-date">${fmtDateShort(p.startTs)} – ${fmtDateShort(p.endTs)}</div>
          <div style="font-size:11px;color:var(--text2);margin-top:2px">
            Pattern match #${i + 1}
          </div>
        </div>
        <div class="pattern-similarity">${Math.round(p.similarity * 100)}% match</div>
      </div>
      <canvas id="miniChart${i}" class="pattern-mini-chart"></canvas>
      <div class="pattern-outcome">
        <span class="outcome-label">After outcome</span>
        <span class="outcome-value ${isUp ? 'up' : 'down'}">
          ${isUp ? '▲' : '▼'} ${Math.abs(p.priceChangePct).toFixed(2)}%
        </span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:11px;color:var(--text2)">
        <span>Max gain: <span style="color:var(--gain)">+${p.maxGain}%</span></span>
        <span>Max loss: <span style="color:var(--loss)">${p.maxLoss}%</span></span>
      </div>
    `;

    card.addEventListener('click', () => {
      window.openDayModal?.(iso, state.currency);
    });

    grid.appendChild(card);
    drawMiniChart(`miniChart${i}`, p.afterPrices);
  });
}

function drawMiniChart(canvasId, afterPrices) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const prices = afterPrices.map(p => p.price);
  const isUp = prices[prices.length - 1] >= prices[0];
  const color = isUp ? '#3fb950' : '#f85149';
  const fill = isUp ? 'rgba(63,185,80,0.1)' : 'rgba(248,81,73,0.1)';

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: afterPrices.map(p => p.ts),
      datasets: [{ data: prices, borderColor: color, backgroundColor: fill,
        borderWidth: 1.5, fill: true, tension: 0.3, pointRadius: 0 }],
    },
    options: {
      responsive: false,
      animation: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false },
      },
    },
  });
  canvas.style.height = '70px';
  canvas.style.width = '100%';
}

// ── ALERTS ─────────────────────────────────────────────────
function saveAlerts() {
  localStorage.setItem('eth_alerts', JSON.stringify(state.alerts));
}

function renderAlerts() {
  const list = document.getElementById('alertsList');
  if (state.alerts.length === 0) {
    list.innerHTML = '<div class="alerts-empty">No alerts set. Add one above.</div>';
    return;
  }

  list.innerHTML = '';
  state.alerts.forEach((alert, i) => {
    const item = document.createElement('div');
    item.className = `alert-item${alert.triggered ? ' triggered' : ''}`;
    const sym = SYMBOLS[alert.currency] || '$';
    const dir = alert.type === 'above' ? '▲ above' : '▼ below';
    item.innerHTML = `
      <div class="alert-text">
        <span class="alert-icon">${alert.triggered ? '🔔' : '🔕'}</span>
        <span>ETH ${dir} ${sym}${Number(alert.price).toLocaleString()} (${alert.currency.toUpperCase()})</span>
      </div>
      <button class="alert-remove" data-index="${i}" title="Remove alert">×</button>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.alert-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      state.alerts.splice(parseInt(btn.dataset.index), 1);
      saveAlerts();
      renderAlerts();
    });
  });
}

function checkAlerts(currentPrice, currency) {
  if (currentPrice == null) return;
  let triggered = false;
  state.alerts.forEach(alert => {
    if (alert.currency !== currency || alert.triggered) return;
    const cond = alert.type === 'above'
      ? currentPrice >= alert.price
      : currentPrice <= alert.price;
    if (cond) {
      alert.triggered = true;
      triggered = true;
      const sym = SYMBOLS[currency];
      const dir = alert.type === 'above' ? 'above' : 'below';
      toast(`🔔 ETH is ${dir} ${sym}${Number(alert.price).toLocaleString()}! Current: ${sym}${currentPrice.toLocaleString()}`, 'warn', 6000);
    }
  });
  if (triggered) { saveAlerts(); renderAlerts(); }
}

// ── COUNTDOWN ─────────────────────────────────────────────
function resetCountdown() {
  state.countdown = 30;
  document.getElementById('countdown').textContent = state.countdown;
}

function startCountdown() {
  if (state.countdownInterval) clearInterval(state.countdownInterval);
  state.countdownInterval = setInterval(() => {
    state.countdown = Math.max(0, state.countdown - 1);
    document.getElementById('countdown').textContent = state.countdown;
  }, 1000);
}

// ── MAIN DATA LOAD ─────────────────────────────────────────
let infoCache = null;
let consecutiveErrors = 0;

// Full history is refreshed at most every 5 minutes, or when the user changes
// range/currency. Between refreshes, each 30s tick just updates the live
// price point on the existing chart — no destroy/rebuild, no jitter.
const HISTORY_REFRESH_MS = 5 * 60 * 1000;
let historyFetchedTs = 0;
let historyFetchedKey = '';

function updateLastPricePoint(priceData) {
  if (!priceChart || !state.historyData?.prices?.length) return;
  const newPrice = priceData?.[state.currency]?.price;
  if (newPrice == null || !isFinite(newPrice)) return;

  const priceDataset = priceChart.data.datasets[0];
  if (!priceDataset || !priceDataset.data?.length) return;

  const lastIdx = priceDataset.data.length - 1;
  priceDataset.data[lastIdx] = newPrice;
  // Mirror into our history cache so pans/resizes read the fresh tail.
  state.historyData.prices[lastIdx].price = newPrice;

  priceChart.update('none');
}

async function loadAllData({ forceHistory = false } = {}) {
  const key = `${state.days}|${state.currency}`;
  const wantHistory =
    forceHistory ||
    !state.historyData ||
    historyFetchedKey !== key ||
    (Date.now() - historyFetchedTs) > HISTORY_REFRESH_MS;

  if (!state.historyData) setStatus('loading');
  try {
    const priceData = await loadPrice();
    const histJson = wantHistory
      ? await loadHistory(state.days, state.currency)
      : null;

    consecutiveErrors = 0;

    if (histJson) {
      state.historyData = histJson;
      historyFetchedTs  = Date.now();
      historyFetchedKey = key;
    }

    updatePriceDisplay(priceData);

    if (histJson) {
      updatePriceChart(histJson);
      buildRSIChart(histJson);
      window.repaintRsiChip?.();
    } else {
      // No history refetch — just nudge the tail of the existing chart.
      updateLastPricePoint(priceData);
    }

    if (!infoCache) {
      infoCache = await loadInfo().catch(() => null);
    }
    updateStats(priceData, infoCache);

    setStatus('live');
    resetCountdown();
  } catch (err) {
    consecutiveErrors++;
    console.error('Data load error:', err);
    if (consecutiveErrors >= 3) {
      setStatus('error');
      toast('Failed to fetch data — retrying…', 'error');
    } else {
      if (!state.historyData) setStatus('error');
    }
  }
}

async function loadPatternsData() {
  document.getElementById('patternsGrid').innerHTML =
    '<div class="patterns-loading"><div class="spinner"></div><span>Analyzing patterns…</span></div>';
  try {
    const patterns = await loadPatterns(state.currency);
    state.patterns = patterns;
    renderPatterns(patterns);
  } catch (err) {
    console.error('Pattern error:', err);
    document.getElementById('patternsGrid').innerHTML = '';
    document.querySelector('.patterns-section')?.style.setProperty('display', 'none');
  }
}

// ── THEME ──────────────────────────────────────────────────
// 4 themes in cycle order. Each has an icon + label shown in the header toggle.
const THEMES = [
  { id: 'dark',      label: 'DARK',      icon: '☾' },
  { id: 'light',     label: 'LIGHT',     icon: '☀' },
  { id: 'dystopian', label: 'DYSTOPIAN', icon: '⌬' },
  { id: 'matrix',    label: 'MATRIX',    icon: '⠇' },
];

function applyTheme(themeId) {
  // Back-compat: old code passed a boolean (dark=true/false).
  if (typeof themeId === 'boolean') themeId = themeId ? 'dark' : 'light';
  if (!THEMES.find(t => t.id === themeId)) themeId = 'dark';

  document.documentElement.setAttribute('data-theme', themeId);
  const def = THEMES.find(t => t.id === themeId);
  const icon = document.getElementById('themeIcon');
  const label = document.getElementById('themeLabel');
  if (icon)  icon.textContent  = def.icon;
  if (label) label.textContent = def.label;

  state.theme = themeId;
  state.darkMode = themeId !== 'light'; // keep legacy field meaningful
  localStorage.setItem('eth_theme', themeId);

  if (state.historyData) {
    updatePriceChart(state.historyData);
    buildRSIChart(state.historyData);
  }
  // Candlestick chart bakes colors at init — trigger a reload so it picks up the new palette.
  window.reloadCandles?.();
}

function cycleTheme() {
  const cur = state.theme || 'dark';
  const i = THEMES.findIndex(t => t.id === cur);
  const next = THEMES[(i + 1) % THEMES.length].id;
  applyTheme(next);
}

// ── EVENT LISTENERS ────────────────────────────────────────
function setupEvents() {
  // Currency toggle
  document.querySelectorAll('.currency-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.currency-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currency = btn.dataset.currency;
      await Promise.all([loadAllData(), loadPatternsData()]);
    });
  });

  // Time range — skip the zoom-out button (it's not a real range).
  document.querySelectorAll('.range-btn:not(#zoomOutBtn)').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.range-btn:not(#zoomOutBtn)').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.days = parseInt(btn.dataset.days);
      document.getElementById('zoomOutBtn').style.display = state.days === 30 ? '' : 'none';
      await loadAllData();
      window.syncDayInfo?.();
    });
  });

  // Zoom-out: expands whichever chart is active to its full 30-day window.
  document.getElementById('zoomOutBtn')?.addEventListener('click', () => {
    const candleActive = document.querySelector('.chart-type-btn[data-type="candles"]')?.classList.contains('active');
    if (candleActive && window.lwChartApi?.timeScale) {
      window.lwChartApi.timeScale().fitContent();
      window.positionCandleStrip?.();
    } else if (priceChart && state.historyData?.prices?.length) {
      // resetZoom() sometimes sticks to the initial zoomScale range; set
      // min/max explicitly to the data's first/last timestamp instead.
      const prices = state.historyData.prices;
      const firstTs = prices[0].ts;
      const lastTs  = prices[prices.length - 1].ts;
      if (typeof priceChart.zoomScale === 'function') {
        priceChart.zoomScale('x', { min: firstTs, max: lastTs }, 'none');
      } else {
        priceChart.options.scales.x.min = firstTs;
        priceChart.options.scales.x.max = lastTs;
        priceChart.update('none');
      }
      window.positionStripOnChart?.(priceChart);
    }
  });

  // Indicator toggles
  document.querySelectorAll('.ind-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      state.indicators[btn.dataset.indicator] = btn.classList.contains('active');
      if (state.historyData) updatePriceChart(state.historyData);
    });
  });

  // Theme toggle — cycles through all 4 themes.
  document.getElementById('themeToggle').addEventListener('click', () => {
    cycleTheme();
    saveServerPrefs();
  });


  // Add alert
  document.getElementById('alertAddBtn').addEventListener('click', () => {
    const type = document.getElementById('alertType').value;
    const price = parseFloat(document.getElementById('alertPrice').value);
    if (!price || isNaN(price) || price <= 0) {
      toast('Please enter a valid price.', 'error');
      return;
    }
    state.alerts.push({ type, price, currency: state.currency, triggered: false });
    saveAlerts();
    renderAlerts();
    document.getElementById('alertPrice').value = '';
    toast(`Alert set: ETH ${type} ${SYMBOLS[state.currency]}${price.toLocaleString()}`, 'success');
  });

  // Double-click chart to reset zoom
  document.getElementById('priceChart').addEventListener('dblclick', () => {
    priceChart?.resetZoom?.();
  });
}

// ── SERVER-SIDE PREFS ──────────────────────────────────────
async function loadServerPrefs() {
  try {
    const res = await fetch('/api/prefs');
    const json = await res.json();
    if (!json.success) return;
    const p = json.prefs || {};
    if (p.currency && ['usd','eur'].includes(p.currency)) state.currency = p.currency;
    if (p.days) {
      const d = parseInt(p.days);
      if ([1,7,30,90,365].includes(d)) state.days = d;
    }
    if (p.theme && THEMES.find(t => t.id === p.theme)) state.theme = p.theme;
    if (p.darkMode && !p.theme) state.darkMode = p.darkMode === 'true';
    // Indicators are permanently off — user removed the toggle chips. Ignore
    // any stale server-stored indicator prefs so they can't flip back on.
    state.indicators = { sma20: false, ema50: false, volume: false };
    // Restore day-details toggle state (defined in dayinfo.js).
    if (p.dayDetailsOn !== undefined) window.setDayDetailsOn?.(p.dayDetailsOn === 'true');
    // Reflect into DOM
    document.querySelectorAll('.currency-btn').forEach(b => b.classList.toggle('active', b.dataset.currency === state.currency));
    document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.days) === state.days));
    document.querySelectorAll('.ind-btn').forEach(b => b.classList.toggle('active', !!state.indicators[b.dataset.indicator]));
  } catch { /* offline/DB miss is fine */ }
}

let prefsSaveTimer = null;
function saveServerPrefs() {
  clearTimeout(prefsSaveTimer);
  prefsSaveTimer = setTimeout(() => {
    fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currency: state.currency,
        days: String(state.days),
        theme: state.theme || (state.darkMode ? 'dark' : 'light'),
        darkMode: String(state.darkMode),
        indicators: JSON.stringify(state.indicators),
      }),
    }).catch(() => {});
  }, 300);
}

// ── INIT ───────────────────────────────────────────────────
async function init() {
  // Restore theme preference (local-first so boot has no flash).
  const savedTheme = localStorage.getItem('eth_theme') || 'dark';
  state.theme = savedTheme;
  applyTheme(savedTheme);

  setupEvents();
  renderAlerts();

  // Sync any server-side prefs (DB-backed, persistent across devices).
  await loadServerPrefs();
  applyTheme(state.theme);

  // Rebuild candle chart with the correct range from server prefs.
  // applyChartType fires on DOMContentLoaded with the default 1W range
  // before prefs load, so we must re-trigger it once prefs are known.
  window.reloadCandles?.();

  // Persist prefs to server on any relevant button click
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.range-btn, .currency-btn, .ind-btn, #themeToggle');
    if (t) saveServerPrefs();
  });

  // Initial load
  await Promise.all([loadAllData(), loadPatternsData()]);

  // If server prefs restored 1D, the dayinfo card fires its 400ms timer before
  // loadAllData completes and gets swallowed. Re-sync now that data is ready.
  window.syncDayInfo?.();

  // Auto-refresh every 30s
  state.refreshInterval = setInterval(loadAllData, 30000);
  startCountdown();
}

// Chart.js time scale adapter (date-fns via CDN not needed — use built-in timestamp)
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// ── PREDICTION OVERLAY (Oracle + 7-day AI Forecast) ─────────
// Renders the trajectory from window.activePrediction as a faded dashed line
// overlay on whichever chart is currently active (line or candle). Supports
// both offset_days (Oracle, 30-day) and offset_hours (AI 7-day forecast).
// If `{ focus: true }` is passed, the chart is zoomed/scrolled so the
// prediction window fits in view.
function _offsetMsOf(p) {
  if (p.offset_hours != null) return p.offset_hours * 3600000;
  if (p.offset_days  != null) return p.offset_days  * 86400000;
  return 0;
}

window.renderPredictionOverlay = function renderPredictionOverlay({ focus = false } = {}) {
  const prophecy = window.activePrediction;

  // HARD RULE: the prediction only ever renders in 1W view. On 1D / 1M / 3M /
  // 1Y the overlay is stripped from both charts. User must switch to 1W to
  // see it — the AI Forecast button never forces a range change.
  const allowed = state.days === 7;

  // Line chart — mutate the existing Chart.js instance.
  if (priceChart) {
    const existingIdx = priceChart.data.datasets.findIndex(d => d.__prediction);
    if (existingIdx !== -1) priceChart.data.datasets.splice(existingIdx, 1);
    const existingBandIdx = priceChart.data.datasets.findIndex(d => d.__predictionBand);
    if (existingBandIdx !== -1) priceChart.data.datasets.splice(existingBandIdx, 1);

    if (allowed && prophecy?.trajectory?.length) {
      const hist = state.historyData?.prices;
      // The trajectory was computed at offset_hours from `prophecy.anchor_ts`
      // (when Claude produced it). Time may have passed since, so some of
      // those offsets now fall into the PAST and would overlap with real
      // history. Build absolute timestamps, then filter out anything that
      // isn't strictly after the most recent real price. Also re-anchor the
      // visual start of the dashed line to the tip of real history so there
      // is a clean handoff: solid price line → dashed forecast.
      const forecastAnchorMs = prophecy.anchor_ts || Date.now();
      const lastHistTs    = hist?.length ? hist[hist.length - 1].ts    : forecastAnchorMs;
      const lastHistPrice = hist?.length ? hist[hist.length - 1].price : prophecy.anchor_price;

      const absTraj = prophecy.trajectory
        .map(p => ({
          x: forecastAnchorMs + _offsetMsOf(p),
          y: p.expected_eth_price,
          low:  p.low  ?? p.expected_eth_price,
          high: p.high ?? p.expected_eth_price,
        }))
        .filter(p => p.x > lastHistTs)    // drop points already in the past
        .sort((a, b) => a.x - b.x);

      // If every trajectory point is in the past (stale forecast), bail.
      if (!absTraj.length) {
        priceChart.update('none');
        window.positionStripOnChart?.(priceChart);
        return;
      }

      const points = absTraj.map(p => ({ x: p.x, y: p.y }));
      if (lastHistPrice != null) {
        points.unshift({ x: lastHistTs, y: lastHistPrice });
      }

      const dir = prophecy.direction || 'neutral';
      const color = dir === 'bullish' ? '#3fb950' : dir === 'bearish' ? '#f85149' : '#d29922';

      const low  = absTraj.map(p => ({ x: p.x, y: p.low  }));
      const high = absTraj.map(p => ({ x: p.x, y: p.high }));
      const hasBand = absTraj.some(p => p.low !== p.y || p.high !== p.y);
      if (hasBand) {
        priceChart.data.datasets.push({
          __predictionBand: true,
          label: 'Prediction band',
          data: [...low, ...high.reverse()],
          borderColor: 'transparent',
          backgroundColor: color + '1A',
          pointRadius: 0,
          fill: true,
          tension: 0.2,
          yAxisID: 'yPrice',
          order: 5,
        });
      }
      priceChart.data.datasets.push({
        __prediction: true,
        label: prophecy.__kind === 'forecast7d' ? '7-day forecast' : 'Oracle prediction',
        data: points,
        borderColor: color,
        backgroundColor: 'transparent',
        borderDash: [6, 4],
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.25,
        yAxisID: 'yPrice',
        order: 4,
        spanGaps: true,
      });

      // Focus: zoom line chart so anchor → last prediction point is visible
      // with a bit of historical lead-in.
      if (focus && points.length > 1) {
        const firstX = points[0].x;
        const lastX  = points[points.length - 1].x;
        const span   = lastX - firstX;
        const pad    = Math.max(span * 0.4, 2 * 86400000);
        try {
          priceChart.zoomScale?.('x', { min: firstX - pad, max: lastX + span * 0.1 }, 'none');
        } catch {}
      }
    }
    priceChart.update('none');
    window.positionStripOnChart?.(priceChart);
  }

  // Candle chart — use Lightweight Charts addLineSeries.
  const lw = window.lwChartApi;
  if (lw?.addLineSeries) {
    const hadSeries = !!window._predSeries;
    if (window._predSeries) { try { lw.removeSeries(window._predSeries); } catch {} window._predSeries = null; }
    // When turning the overlay OFF, snap the candles' visible range back to
    // the underlying OHLC (no phantom 7-day forecast tail left at the right).
    if (hadSeries && !(allowed && prophecy?.trajectory?.length)) {
      try { lw.timeScale().fitContent(); } catch {}
    }
    if (allowed && prophecy?.trajectory?.length) {
      const ohlc = window.getCurrentOHLC?.() || [];
      const forecastAnchorMs = prophecy.anchor_ts || Date.now();
      const lastCandle   = ohlc.length ? ohlc[ohlc.length - 1] : null;
      const lastCandleMs = lastCandle ? lastCandle.time * 1000 : forecastAnchorMs;
      const lastCandleClose = lastCandle ? lastCandle.close : prophecy.anchor_price;

      const dir = prophecy.direction || 'neutral';
      const color = dir === 'bullish' ? '#3fb950' : dir === 'bearish' ? '#f85149' : '#d29922';
      const series = lw.addLineSeries({
        color,
        lineWidth: 3,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: true,
        title: prophecy.__kind === 'forecast7d' ? '7d forecast' : 'Oracle',
        crosshairMarkerVisible: true,
      });
      // Strip any trajectory points that fall BEFORE or AT the last candle —
      // they'd overlap with real OHLC that already happened. The dashed line
      // starts from the last candle's close so it visually connects cleanly.
      const data = prophecy.trajectory
        .map(p => ({ time: Math.floor((forecastAnchorMs + _offsetMsOf(p)) / 1000), value: p.expected_eth_price }))
        .filter(p => p.time * 1000 > lastCandleMs)
        .sort((a, b) => a.time - b.time);
      if (!data.length) return;
      if (lastCandleClose != null) {
        data.unshift({ time: Math.floor(lastCandleMs / 1000), value: lastCandleClose });
      }
      series.setData(data);
      window._predSeries = series;

      if (focus && data.length > 1) {
        const firstT = data[0].time;
        const lastT  = data[data.length - 1].time;
        const span   = lastT - firstT;
        const pad    = Math.max(Math.round(span * 0.4), 2 * 86400);
        try {
          lw.timeScale().setVisibleRange({ from: firstT - pad, to: lastT + Math.round(span * 0.1) });
        } catch {}
      }
    }
  }

  if (focus) {
    const host = document.querySelector('.chart-section');
    host?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

window.addEventListener('DOMContentLoaded', init);
