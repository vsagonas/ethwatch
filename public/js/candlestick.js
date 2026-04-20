/* ═══════════════════════════════════════════════════════════
   ETHWATCH — Candlestick Chart Module (TradingView Lightweight Charts)
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ── STATE ──────────────────────────────────────────────────
let lwChart = null;
let candleSeries = null;
let smaLineSeries = null;
let emaLineSeries = null;
let currentOHLC = [];

window.getCurrentOHLC  = () => currentOHLC;
window.reloadCandles   = () => {
  if (!document.querySelector('.chart-type-btn[data-type="candles"]')?.classList.contains('active')) return;
  const days = parseInt(document.querySelector('.range-btn.active')?.dataset.days || 7);
  const cur  = document.querySelector('.currency-btn.active')?.dataset.currency || 'usd';
  loadAndRenderCandlestick(days, cur);
};

// ── SMA / EMA FOR OHLC ─────────────────────────────────────
function calcSMAForOHLC(data, period) {
  return data.map((d, i) => {
    if (i < period - 1) return null;
    const avg = data.slice(i - period + 1, i + 1).reduce((s, c) => s + c.close, 0) / period;
    return { time: d.time, value: avg };
  }).filter(Boolean);
}

function calcEMAForOHLC(data, period) {
  const k = 2 / (period + 1);
  const result = [];
  let prev = data.slice(0, period).reduce((s, c) => s + c.close, 0) / period;
  result.push({ time: data[period - 1].time, value: prev });
  for (let i = period; i < data.length; i++) {
    prev = data[i].close * k + prev * (1 - k);
    result.push({ time: data[i].time, value: prev });
  }
  return result;
}

// ── INIT CHART ─────────────────────────────────────────────
function initCandlestickChart(ohlcData) {
  const container = document.getElementById('lwChart');
  const loader = document.getElementById('candleLoader');

  if (!container || !ohlcData || ohlcData.length === 0) {
    if (loader) loader.querySelector('span').textContent = 'No OHLC data available.';
    return;
  }

  currentOHLC = ohlcData;

  if (lwChart) {
    lwChart.remove();
    lwChart = null;
    candleSeries = null;
    smaLineSeries = null;
    emaLineSeries = null;
  }

  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  const bg    = dark ? '#161b22' : '#ffffff';
  const text  = dark ? '#8b949e' : '#656d76';
  const grid  = dark ? 'rgba(48,54,61,0.5)' : 'rgba(208,215,222,0.5)';
  const border = dark ? '#30363d' : '#d0d7de';

  lwChart = LightweightCharts.createChart(container, {
    width: container.offsetWidth,
    height: container.offsetHeight || 380,
    layout: { background: { color: bg }, textColor: text },
    grid: {
      vertLines: { color: grid },
      horzLines: { color: grid },
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border, timeVisible: true },
    // Zoom gestures OFF (user can't zoom). Pan stays on.
    handleScroll: {
      mouseWheel: true,          // trackpad/wheel → horizontal pan
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    },
    handleScale: {
      mouseWheel: false,
      pinch: false,
      axisPressedMouseMove: false,
      axisDoubleClickReset: false,
    },
  });

  candleSeries = lwChart.addCandlestickSeries({
    upColor:        '#3fb950',
    downColor:      '#f85149',
    borderUpColor:  '#3fb950',
    borderDownColor:'#f85149',
    wickUpColor:    '#3fb950',
    wickDownColor:  '#f85149',
  });

  candleSeries.setData(ohlcData);

  // SMA 20 / EMA 50 overlays intentionally removed — user opted for a clean
  // candle chart with no indicator lines. The helpers are still defined in
  // case a future toggle needs them.
  smaLineSeries = null;
  emaLineSeries = null;

  // ── Crosshair tooltip ──────────────────────────────────────
  const tooltip = document.getElementById('lwTooltip');
  lwChart.subscribeCrosshairMove(param => {
    if (!tooltip) return;
    if (!param.point || !param.time || param.point.x < 0 || param.point.y < 0) {
      tooltip.style.display = 'none';
      window.clearDayCardHighlight?.();
      return;
    }

    const fx  = window.fxFromUSD || 1;
    const cur = window.activeCurrency || 'usd';
    const sym = cur === 'eur' ? '€' : '$';
    const fmt = v => v == null ? '—' : `${sym}${(v * fx).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
    const fmtPct = (c, o) => o ? `${((c - o) / o * 100).toFixed(2)}%` : '—';

    const hoverMs = param.time * 1000;
    window.highlightDayCardByTs?.(hoverMs);
    const bar = param.seriesData.get(candleSeries);

    // ── FORECAST REGION (no candle data at this time) ──────
    const prophecy = window.activePrediction;
    if (!bar && prophecy?.trajectory?.length) {
      const anchorMs = prophecy.anchor_ts || Date.now();
      const absTraj  = prophecy.trajectory
        .map(p => ({ ms: anchorMs + p.offset_hours * 3600000, price: p.expected_eth_price, low: p.low, high: p.high }))
        .sort((a, b) => a.ms - b.ms);

      let fcPrice = null, fcLow = null, fcHigh = null;
      for (let i = 0; i < absTraj.length - 1; i++) {
        const a = absTraj[i], b = absTraj[i + 1];
        if (hoverMs >= a.ms && hoverMs <= b.ms) {
          const t = (hoverMs - a.ms) / (b.ms - a.ms);
          fcPrice = a.price + (b.price - a.price) * t;
          if (a.low != null && b.low != null)  fcLow  = a.low  + (b.low  - a.low)  * t;
          if (a.high != null && b.high != null) fcHigh = a.high + (b.high - a.high) * t;
          break;
        }
      }
      if (fcPrice == null) {
        const last = absTraj[absTraj.length - 1];
        if (last && hoverMs >= last.ms) { fcPrice = last.price; fcLow = last.low; fcHigh = last.high; }
      }
      if (fcPrice == null) { tooltip.style.display = 'none'; return; }

      const dir      = prophecy.direction || 'neutral';
      const conf     = prophecy.confidence != null ? Math.round(prophecy.confidence * 100) : null;
      const dirColor = dir === 'bullish' ? '#3fb950' : dir === 'bearish' ? '#f85149' : '#d29922';
      const dirSym   = dir === 'bullish' ? '▲' : dir === 'bearish' ? '▼' : '→';
      const dateStr  = new Date(hoverMs).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const rangeStr = (fcLow != null && fcHigh != null && Math.abs(fcHigh - fcLow) > 1)
        ? `<div class="lwt-ohlc"><span>Low <b>${fmt(fcLow)}</b></span><span>High <b>${fmt(fcHigh)}</b></span></div>` : '';
      const confStr  = conf != null ? ` <span class="lwt-move" style="color:${dirColor}">${conf}% conf</span>` : '';

      tooltip.innerHTML = `
        <div class="lwt-time">${dateStr} · FORECAST</div>
        <div class="lwt-close" style="color:${dirColor}">${fmt(fcPrice)} <span class="lwt-move">${dirSym} ${dir.toUpperCase()}</span>${confStr}</div>
        ${rangeStr}`;

      const W = container.offsetWidth;
      const TW = 210, TH = 90;
      tooltip.style.left    = `${param.point.x + 14 + TW > W ? param.point.x - TW - 14 : param.point.x + 14}px`;
      tooltip.style.top     = `${param.point.y - TH < 0 ? param.point.y + 10 : param.point.y - TH}px`;
      tooltip.style.display = '';
      return;
    }

    if (!bar) { tooltip.style.display = 'none'; return; }

    // ── HISTORY REGION ────────────────────────────────────
    const ts = new Date(param.time * 1000);
    const dateStr = ts.toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    });

    const move = bar.close - bar.open;
    const moveColor = move >= 0 ? '#3fb950' : '#f85149';
    const moveSym   = move >= 0 ? '▲' : '▼';

    // Add forecast confidence badge if this bar is near the forecast anchor
    let fcBadge = '';
    if (prophecy?.confidence != null) {
      const conf = Math.round(prophecy.confidence * 100);
      const dir  = prophecy.direction || 'neutral';
      const dc   = dir === 'bullish' ? '#3fb950' : dir === 'bearish' ? '#f85149' : '#d29922';
      fcBadge = `<div class="lwt-ohlc" style="margin-top:6px;border-top:1px solid rgba(255,255,255,0.08);padding-top:4px"><span style="color:${dc}">${dir.toUpperCase()} · ${conf}% conf</span></div>`;
    }

    tooltip.innerHTML = `
      <div class="lwt-time">${dateStr}</div>
      <div class="lwt-close" style="color:${moveColor}">${fmt(bar.close)} <span class="lwt-move">${moveSym} ${fmtPct(bar.close, bar.open)}</span></div>
      <div class="lwt-ohlc">
        <span>O <b>${fmt(bar.open)}</b></span>
        <span>H <b>${fmt(bar.high)}</b></span>
        <span>L <b>${fmt(bar.low)}</b></span>
      </div>${fcBadge}`;

    const W = container.offsetWidth;
    const TH = fcBadge ? 110 : 80;
    const TW = 200;
    tooltip.style.left    = `${param.point.x + 14 + TW > W ? param.point.x - TW - 14 : param.point.x + 14}px`;
    tooltip.style.top     = `${param.point.y - TH < 0 ? param.point.y + 10 : param.point.y - TH}px`;
    tooltip.style.display = '';
  });

  // Responsive resize
  const ro = new ResizeObserver(() => {
    if (lwChart) lwChart.resize(container.offsetWidth, container.offsetHeight || 380);
    window.positionCandleStrip?.();
  });
  ro.observe(container);

  if (loader) loader.classList.add('hidden');

  // Set visible range based on days selection.
  const days = parseInt(document.querySelector('.range-btn.active')?.dataset.days || 7);
  if (days === 30 && ohlcData.length) {
    const lastTime = ohlcData[ohlcData.length - 1].time;
    const weekAgo  = lastTime - 7 * 86400;
    lwChart.timeScale().setVisibleRange({ from: weekAgo, to: lastTime });
  } else {
    lwChart.timeScale().fitContent();
  }

  // 1D: lock the view — no panning needed, the day fits the screen.
  if (days === 1) {
    lwChart.applyOptions({
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: false,
        horzTouchDrag: false,
        vertTouchDrag: false,
      },
    });
  }

  // Avoid the `window.lwChart` name — there is a <div id="lwChart"> which
  // browsers auto-expose at that key, which would shadow the chart instance.
  window.lwChartApi = lwChart;

  // ── Pan buttons (‹ ›) ──────────────────────────────────
  const candlePanStep = () => {
    const range = lwChart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const step = (range.to - range.from) * 0.2;
    lwChart.timeScale().setVisibleLogicalRange({ from: range.from - step, to: range.to - step });
  };
  const candlePanRight = () => {
    const range = lwChart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    const step = (range.to - range.from) * 0.2;
    lwChart.timeScale().setVisibleLogicalRange({ from: range.from + step, to: range.to + step });
  };
  document.getElementById('candlePanLeft')?.addEventListener('click', candlePanStep);
  document.getElementById('candlePanRight')?.addEventListener('click', candlePanRight);

  // ── Two-finger trackpad horizontal scroll ───────────────
  container.addEventListener('wheel', e => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const range = lwChart.timeScale().getVisibleLogicalRange();
      if (!range) return;
      const span  = range.to - range.from;
      const delta = (e.deltaX / container.offsetWidth) * span;
      lwChart.timeScale().setVisibleLogicalRange({ from: range.from + delta, to: range.to + delta });
    }
  }, { passive: false });

  lwChart.timeScale().subscribeVisibleTimeRangeChange(() => window.positionCandleStrip?.());
  // Logical range fires more continuously during an active pan gesture,
  // keeping day cards glued to the chart frame-by-frame (not just at the
  // end of the pan).
  lwChart.timeScale().subscribeVisibleLogicalRangeChange?.(() => window.positionCandleStrip?.());
  // First alignment (and make sure monthly data is loaded for this strip too).
  window.positionCandleStrip?.();
  window.loadMonthly?.(document.querySelector('.currency-btn.active')?.dataset.currency || 'usd');
  // Re-attach any active Oracle prediction overlay.
  window._predSeries = null; // old series belonged to the destroyed chart
  window.renderPredictionOverlay?.();
}

function escapeHtmlLite(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" }[c]));
}

// ── LOAD OHLC DATA ─────────────────────────────────────────
let _candleSeq = 0;

async function loadAndRenderCandlestick(days, currency) {
  const seq = ++_candleSeq;
  const loader = document.getElementById('candleLoader');
  if (loader) { loader.classList.remove('hidden'); loader.querySelector('span').textContent = 'Loading candles…'; }

  try {
    const res = await fetch(`/api/eth-ohlc?days=${days}&currency=${currency}`);
    const json = await res.json();
    if (seq !== _candleSeq) return; // stale — a newer call already won
    if (!json.success) throw new Error(json.error);
    initCandlestickChart(json.data);
  } catch (err) {
    if (seq !== _candleSeq) return;
    if (loader) { loader.classList.remove('hidden'); loader.querySelector('span').textContent = 'Failed to load candles: ' + err.message; }
  }

  if (seq === _candleSeq) window.syncDayInfo?.();
}


// ── WIRE UP EVENTS ─────────────────────────────────────────
const CHART_TYPE_LS_KEY = 'eth_chart_type';

function moveStripToContainer(containerId) {
  const strip = document.getElementById('monthStrip');
  if (!strip) return;
  const wrapper = document.getElementById(containerId);
  if (!wrapper) return;
  const canvasHolder = wrapper.querySelector('.chart-canvas-holder');
  if (canvasHolder) {
    wrapper.insertBefore(strip, canvasHolder);
  } else {
    wrapper.appendChild(strip);
  }
  // Hide every tile until the next positioning pass — stale `left` values
  // from the other chart's coordinate space would place cards off-screen.
  strip.querySelectorAll('.day-col').forEach(c => { c.style.display = 'none'; });
}

function applyChartType(type) {
  const lineWrapper   = document.getElementById('lineChartWrapper');
  const candleWrapper = document.getElementById('candleChartWrapper');
  const lineHint      = document.getElementById('lineChartHint');

  document.querySelectorAll('.chart-type-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.type === type);
  });

  if (type === 'candles') {
    if (lineWrapper)   lineWrapper.style.display   = 'none';
    if (candleWrapper) candleWrapper.style.display = '';
    if (lineHint)      lineHint.style.display      = 'none';
    moveStripToContainer('candleChartWrapper');
    const days = parseInt(document.querySelector('.range-btn.active:not(#zoomOutBtn)')?.dataset.days || 7);
    const cur  = document.querySelector('.currency-btn.active')?.dataset.currency || 'usd';
    loadAndRenderCandlestick(days, cur);
  } else {
    if (lineWrapper)   lineWrapper.style.display   = '';
    if (candleWrapper) candleWrapper.style.display = 'none';
    if (lineHint)      lineHint.style.display      = '';
    moveStripToContainer('lineChartWrapper');
    // Re-align strip to line chart after move.
    window.positionStripOnChart?.();
    // syncDayInfo (dayinfo.js) handles visibility on chart-type-btn click.
  }

  try { localStorage.setItem(CHART_TYPE_LS_KEY, type); } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  // Chart type toggle — persisted across reloads. Default = candles.
  document.querySelectorAll('.chart-type-btn').forEach(btn => {
    btn.addEventListener('click', () => applyChartType(btn.dataset.type));
  });

  let savedType = 'candles';
  try { savedType = localStorage.getItem(CHART_TYPE_LS_KEY) || 'candles'; } catch {}
  if (savedType !== 'line' && savedType !== 'candles') savedType = 'candles';
  applyChartType(savedType);

  // Refresh candles when range changes while in candle mode.
  // Skip #zoomOutBtn — it's not a real range, its handler lives in app.js.
  document.querySelectorAll('.range-btn:not(#zoomOutBtn)').forEach(btn => {
    btn.addEventListener('click', () => {
      if (document.querySelector('.chart-type-btn[data-type="candles"]')?.classList.contains('active')) {
        const days = parseInt(btn.dataset.days);
        if (!Number.isFinite(days)) return;
        loadAndRenderCandlestick(days, window.state?.currency || 'usd');
      }
    });
  });

  // Also refresh on currency change
  document.querySelectorAll('.currency-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (document.querySelector('.chart-type-btn[data-type="candles"]')?.classList.contains('active')) {
        setTimeout(() => {
          const days = parseInt(document.querySelector('.range-btn.active:not(#zoomOutBtn)')?.dataset.days || 7);
          loadAndRenderCandlestick(days, window.state?.currency || 'usd');
        }, 100);
      }
    });
  });
});
