/* ═══════════════════════════════════════════════════════════
   ETHWATCH — AI 7-Day Forecast
   Fetches /api/forecast-7d, renders the full modal, and paints
   the 28-point trajectory onto whichever chart is active.
   ═══════════════════════════════════════════════════════════ */

'use strict';

// v2: invalidate any v1 entries that may have been saved with stale anchors.
const FORECAST_LS_KEY  = 'eth_forecast_v2';
const OVERLAY_LS_KEY   = 'eth_forecast_overlay_v2';
// A 7d forecast older than 24h is stale — don't auto-restore.
const FORECAST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let currentForecast = null;

function loadSavedForecast() {
  try {
    const raw = localStorage.getItem(FORECAST_LS_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved?.generated_ts) return null;
    if (Date.now() - saved.generated_ts > FORECAST_MAX_AGE_MS) return null;
    return saved;
  } catch { return null; }
}

function saveForecast(data) {
  try { localStorage.setItem(FORECAST_LS_KEY, JSON.stringify(data)); } catch {}
}

function loadOverlayPref() {
  try { return localStorage.getItem(OVERLAY_LS_KEY) === 'on'; } catch { return false; }
}
function saveOverlayPref(on) {
  try { localStorage.setItem(OVERLAY_LS_KEY, on ? 'on' : 'off'); } catch {}
}

function fcEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function fcFmtPrice(usd) {
  if (usd == null) return '—';
  const fx  = window.fxFromUSD || 1;
  const cur = window.activeCurrency || 'usd';
  const sym = cur === 'eur' ? '€' : '$';
  return `${sym}${(usd * fx).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fcFmtPct(v) {
  if (v == null || !isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
}

function fcFmtTs(ts) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

function setBtnBusy(busy) {
  const btn = document.getElementById('aiVerdictBigBtn');
  if (btn) btn.classList.toggle('busy', busy);
}

// The button label is ALWAYS "FORECAST" — no verdict info inside.
// Direction is revealed inside the popup and on the chart overlay only.
function paintChipSummary() { /* no-op */ }

function renderForecastModal(data) {
  currentForecast = data;
  const dir = (data.direction || 'neutral').toLowerCase();

  const verdictEl = document.getElementById('fcVerdict');
  verdictEl.textContent = dir.toUpperCase();
  verdictEl.className = `fc-verdict dir-${dir}`;

  document.getElementById('fcConfidence').textContent =
    typeof data.confidence === 'number' ? `${Math.round(data.confidence * 100)}%` : '—';
  document.getElementById('fcMove').textContent = fcFmtPct(data.expected_move_pct);
  document.getElementById('fcAnchor').textContent = fcFmtPrice(data.anchor_price);
  document.getElementById('forecastGeneratedTs').textContent =
    data.generated_ts ? `Generated ${fcFmtTs(data.generated_ts)}` : '';
  document.getElementById('fcHeadline').textContent = data.headline || '';
  document.getElementById('fcNarrative').textContent = data.narrative || '';

  // Pattern match block
  const pm = data.pattern_match;
  const pmBlock = document.getElementById('fcPatternBlock');
  if (pm && (pm.analog_dates || pm.similarity || pm.outcome)) {
    pmBlock.style.display = '';
    document.getElementById('fcPatternDates').textContent = pm.analog_dates || '—';
    document.getElementById('fcPatternSim').textContent   = pm.similarity || '';
    document.getElementById('fcPatternOut').textContent   = pm.outcome ? `Then: ${pm.outcome}` : '';
  } else {
    pmBlock.style.display = 'none';
  }

  // Daily breakdown — show ABSOLUTE dates + expected end-of-day price.
  // Dates are computed from anchor_ts (when the forecast was generated):
  // D1 = anchor + 24h, D2 = anchor + 48h, ..., D7 = anchor + 168h.
  // Prices come from the 28-point trajectory at offset_hours == day*24.
  // Falls back to compounding daily_breakdown.expected_move_pct from
  // anchor_price when the trajectory is missing / sparse.
  const anchorTs = data.anchor_ts || data.generated_ts || Date.now();
  const anchorPrice = data.anchor_price;
  const trajByHour = new Map(
    (data.trajectory || []).map(p => [Math.round(p.offset_hours), p.expected_eth_price])
  );

  let compound = anchorPrice;
  const daysEl = document.getElementById('fcDays');
  daysEl.innerHTML = (data.daily_breakdown || []).map(d => {
    const pct = d.expected_move_pct;
    const cls = pct > 0.1 ? 'up' : pct < -0.1 ? 'down' : 'neutral';
    const ico = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '→';
    const dayDate = new Date(anchorTs + d.day * 86400000);
    const dateLabel = dayDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    const hourKey = d.day * 24;
    let eodPrice = trajByHour.get(hourKey);
    if (eodPrice == null && anchorPrice != null && isFinite(pct)) {
      compound = compound * (1 + pct / 100);
      eodPrice = compound;
    }

    return `
      <div class="fc-day ${cls}">
        <div class="fc-day-head">
          <span class="fc-day-num">D${d.day} · ${dateLabel}</span>
          <span class="fc-day-move">${ico} ${fcFmtPct(pct)}</span>
        </div>
        <div class="fc-day-price">${fcFmtPrice(eodPrice)}</div>
        <div class="fc-day-text">${fcEscape(d.narrative || '')}</div>
        ${d.key_event ? `<div class="fc-day-event">⚡ ${fcEscape(d.key_event)}</div>` : ''}
      </div>`;
  }).join('');

  const drivers = document.getElementById('fcDrivers');
  drivers.innerHTML = (data.key_drivers || []).map(s => `<li>${fcEscape(s)}</li>`).join('') || '<li class="ba-empty">—</li>';
  const risks = document.getElementById('fcRisks');
  risks.innerHTML = (data.risks || []).map(s => `<li>${fcEscape(s)}</li>`).join('') || '<li class="ba-empty">—</li>';
}

function openForecastModal() {
  document.getElementById('forecastModal').style.display = 'flex';
}
function closeForecastModal() {
  document.getElementById('forecastModal').style.display = 'none';
}

function setAsActivePrediction(data, { persistPref = true } = {}) {
  const tagged = { ...data, __kind: 'forecast7d' };
  const wasActive = !!window.activePrediction;
  window.activePredictionSetId = '__forecast7d__';
  window.activePrediction = tagged;
  updateBtnActiveClass(true);
  if (persistPref) saveOverlayPref(true);
  if (!wasActive && window.state?.days === 7 && window.state?.historyData) {
    window.buildPriceChart?.(window.state.historyData);
  } else {
    window.renderPredictionOverlay?.({ focus: false });
  }
  renderForecastDayCards(tagged);
}

function clearActiveForecast({ persistPref = true } = {}) {
  window.activePredictionSetId = null;
  window.activePrediction = null;
  updateBtnActiveClass(false);
  if (persistPref) saveOverlayPref(false);
  if (window.state?.days === 7 && window.state?.historyData) {
    window.buildPriceChart?.(window.state.historyData);
  } else {
    window.renderPredictionOverlay?.();
  }
  removeForecastDayCards();
}

// ── Forecast day cards in the chart-aligned strip ─────────────
// Inject 7 forecast tiles (one per day) into BOTH monthStrip and
// candleMonthStrip so the dashed overlay line always has matching tiles
// beneath it regardless of which chart mode is active.
// Tiles are absolutely-positioned via each chart's coordinate system and
// move with pan/zoom because the strip-position hooks hit all .day-col nodes.
// Click → popup with narrative + reasoning for that day.
function removeForecastDayCards() {
  document.querySelectorAll('.day-col.forecast-col').forEach(el => el.remove());
}

function renderForecastDayCards(forecast) {
  removeForecastDayCards();
  if (!forecast?.daily_breakdown?.length) return;
  // Only hide if the strip itself is hidden (1D day-info card mode).
  // For all other ranges (1W/1M/3M/1Y) the strip is visible, so inject.
  if (window.state?.days === 1) return;

  const anchorTs = forecast.anchor_ts || forecast.generated_ts || Date.now();
  const anchorPrice = forecast.anchor_price;
  const trajByHour = new Map(
    (forecast.trajectory || []).map(p => [Math.round(p.offset_hours), p.expected_eth_price])
  );

  // Build the tile data once, then stamp it into both strips.
  let compound = anchorPrice;
  const tiles = forecast.daily_breakdown.map(d => {
    const dayTs  = anchorTs + d.day * 86400000;
    const pct    = d.expected_move_pct;
    const cls    = pct > 0.1 ? 'up' : pct < -0.1 ? 'down' : 'neutral';
    const hourKey = d.day * 24;
    let eodPrice  = trajByHour.get(hourKey);
    if (eodPrice == null && anchorPrice != null && isFinite(pct)) {
      compound = compound * (1 + pct / 100);
      eodPrice = compound;
    }
    const dayLabel = new Date(dayTs).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const priceStr = eodPrice != null ? `$${Math.round(eodPrice).toLocaleString('en-US')}` : '—';
    return { d, dayTs, pct, cls, dayLabel, priceStr };
  });

  ['monthStrip', 'candleMonthStrip'].forEach(stripId => {
    const strip = document.getElementById(stripId);
    if (!strip) return;
    tiles.forEach(({ d, dayTs, pct, cls, dayLabel, priceStr }) => {
      const col = document.createElement('div');
      col.className = 'day-col forecast-col';
      col.dataset.ts  = String(dayTs);
      col.dataset.day = String(d.day);
      col.innerHTML = `
        <div class="day-tile forecast-tile ${cls}">
          <div class="dt-date">D${d.day} · ${dayLabel}</div>
          <div class="dt-move">${pct >= 0 ? '+' : ''}${Number(pct).toFixed(2)}%</div>
          <div class="dt-verdict">FORECAST</div>
          <div class="dt-fc-price">${priceStr}</div>
          <div class="dt-extras">
            ${d.narrative ? `<div class="dt-fc-narrative">${fcEscape(d.narrative)}</div>` : ''}
            ${d.key_event ? `<div class="dt-key-event">⚡ ${fcEscape(d.key_event)}</div>` : ''}
          </div>
        </div>
      `;
      col.addEventListener('click', (e) => {
        e.stopPropagation();
        openForecastDayPopup(forecast, d.day);
      });
      strip.appendChild(col);
    });
  });

  // Re-align immediately in both chart modes.
  window.positionStripOnChart?.();
  window.positionCandleStrip?.();
}
// Expose so monthly.js can re-inject after renderStrip rebuilds the DOM.
window.renderForecastDayCards = renderForecastDayCards;

function openForecastDayPopup(forecast, dayNum) {
  const d = (forecast.daily_breakdown || []).find(x => x.day === dayNum);
  if (!d) return;
  const anchorTs = forecast.anchor_ts || forecast.generated_ts || Date.now();
  const dateLabel = new Date(anchorTs + dayNum * 86400000).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'short', day: 'numeric',
  });
  const dir = (forecast.direction || 'neutral').toLowerCase();
  const panel = document.getElementById('forecastDayPanel');
  if (!panel) return;
  const pct = d.expected_move_pct;
  const cls = pct > 0.1 ? 'dir-bullish' : pct < -0.1 ? 'dir-bearish' : 'dir-neutral';

  panel.querySelector('.fdp-date').textContent    = dateLabel;
  panel.querySelector('.fdp-day').textContent     = `Day ${dayNum}`;
  panel.querySelector('.fdp-move').textContent    = `${pct >= 0 ? '+' : ''}${Number(pct).toFixed(2)}%`;
  panel.querySelector('.fdp-move').className      = `fdp-move ${cls}`;
  panel.querySelector('.fdp-narrative').textContent = d.narrative || '';
  panel.querySelector('.fdp-event').textContent   = d.key_event ? `Key event: ${d.key_event}` : '';
  panel.querySelector('.fdp-event').style.display = d.key_event ? '' : 'none';

  // Reasoning section — pull from the overall forecast (headline + pattern match + drivers).
  panel.querySelector('.fdp-headline').textContent  = forecast.headline || '';
  const pm = forecast.pattern_match;
  panel.querySelector('.fdp-pattern').textContent   = pm
    ? `Analog: ${pm.analog_dates || '—'} — ${pm.similarity || ''} Then: ${pm.outcome || ''}`.trim()
    : '';
  const driversUl = panel.querySelector('.fdp-drivers');
  driversUl.innerHTML = (forecast.key_drivers || []).map(s => `<li>${fcEscape(s)}</li>`).join('') || '<li class="ba-empty">—</li>';
  panel.querySelector('.fdp-direction-badge').textContent = dir.toUpperCase();
  panel.querySelector('.fdp-direction-badge').className = `fdp-direction-badge ${cls}`;

  document.getElementById('forecastDayModal').style.display = 'flex';
}

function updateBtnActiveClass(active) {
  const btn = document.getElementById('aiVerdictBigBtn');
  if (btn) btn.classList.toggle('active', !!active);
}

async function runForecast({ force = false } = {}) {
  setBtnBusy(true);
  try {
    const res = await fetch(`/api/forecast-7d${force ? '?force=1' : ''}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Forecast failed');
    currentForecast = json.data;
    saveForecast(json.data);
    renderForecastModal(json.data);
    setAsActivePrediction(json.data);
    openForecastModal();
    window.reloadPredHistory?.();
    return json.data;
  } catch (err) {
    window.toast?.('Forecast failed: ' + err.message, 'error');
    throw err;
  } finally {
    setBtnBusy(false);
  }
}

// Restore any persisted forecast — always auto-activate the overlay.
// If no saved forecast, fetch from server silently.
function restoreSavedForecast() {
  const saved = loadSavedForecast();
  const attach = (data) => {
    if (!window.priceChart && !window.lwChartApi) {
      setTimeout(() => attach(data), 200);
      return;
    }
    setAsActivePrediction(data, { persistPref: false });
  };
  if (saved) {
    currentForecast = saved;
    attach(saved);
    // Also silently refresh from server in background to pick up any newer forecast
    fetch('/api/forecast-7d').then(r => r.json()).then(json => {
      if (json.success && json.data && json.data.generated_ts !== saved.generated_ts) {
        currentForecast = json.data;
        saveForecast(json.data);
        attach(json.data);
      }
    }).catch(() => {});
    return;
  }
  // No saved forecast — fetch silently
  fetch('/api/forecast-7d').then(r => r.json()).then(json => {
    if (!json.success || !json.data) return;
    currentForecast = json.data;
    saveForecast(json.data);
    attach(json.data);
  }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
  restoreSavedForecast();

  // Close the forecast day-detail popup.
  const closeDayModal = () => {
    const m = document.getElementById('forecastDayModal');
    if (m) m.style.display = 'none';
  };
  document.getElementById('forecastDayClose')?.addEventListener('click', closeDayModal);
  document.getElementById('forecastDayBackdrop')?.addEventListener('click', closeDayModal);

  // Re-sync forecast day tiles when the user changes range.
  // Show tiles on all ranges except 1D (where the strip is hidden).
  document.querySelectorAll('.range-btn:not(#zoomOutBtn)').forEach(btn => {
    btn.addEventListener('click', () => {
      setTimeout(() => {
        if (window.activePrediction && window.state?.days !== 1) {
          renderForecastDayCards(window.activePrediction);
        } else {
          removeForecastDayCards();
        }
      }, 200);
    });
  });

  document.getElementById('forecastClose')?.addEventListener('click', closeForecastModal);
  document.getElementById('forecastModalBackdrop')?.addEventListener('click', closeForecastModal);
  document.getElementById('forecastShowOnChart')?.addEventListener('click', () => {
    if (currentForecast) {
      setAsActivePrediction(currentForecast);
      closeForecastModal();
    }
  });
});
