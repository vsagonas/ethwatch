/* ═══════════════════════════════════════════════════════════
   ETHWATCH — Day Info Strip
   Replaces the chart-aligned-strip in 1D view (same height).
   Shows verdict, stats, summary inline. News panel expands below.
   ═══════════════════════════════════════════════════════════ */

'use strict';

let _dayInfoCache = { date: null, data: null, ts: 0 };
const DAY_INFO_TTL = 5 * 60 * 1000;

function diEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function diFmtPct(v) {
  if (v == null || !isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
}
function diFmtPrice(usd, currency) {
  if (usd == null) return '—';
  const fx  = window.fxFromUSD || 1;
  const sym = currency === 'eur' ? '€' : '$';
  return `${sym}${(usd * fx).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// Hide every piece of day-detail content: cards AND aligned strips.
function hideAllDayContent() {
  document.getElementById('dayInfoCard')?.style.setProperty('display','none');
  document.getElementById('dayInfoCardLine')?.style.setProperty('display','none');
  document.getElementById('candleMonthStrip')?.style.setProperty('display','none');
  document.getElementById('monthStrip')?.style.setProperty('display','none');
}

// Legacy name — used by candlestick.js; just delegates to hideAllDayContent
// so switching chart type doesn't bypass the toggle state.
function hideDayInfo() {
  hideAllDayContent();
}

// Set a strip to "loading / live" state.
function _applyEmpty(ids, reason) {
  const cur = window.state?.currency || window.activeCurrency || 'usd';
  const price = window.state?.currentPrice?.[cur];
  const sym = cur === 'eur' ? '€' : '$';
  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  for (const { date, verdict, stats, summary } of ids) {
    const dateEl   = document.getElementById(date);
    const verdEl   = document.getElementById(verdict);
    const statsEl  = document.getElementById(stats);
    const summEl   = document.getElementById(summary);
    if (dateEl)  dateEl.textContent = dateStr;
    if (verdEl)  { verdEl.textContent = 'LIVE'; verdEl.className = 'dis-verdict'; }
    if (statsEl) statsEl.innerHTML = price != null
      ? `<div class="dic-stat"><span class="dic-stat-label">Current</span><strong>${sym}${price.toLocaleString('en-US',{maximumFractionDigits:0})}</strong></div>`
      : '';
    if (summEl)  summEl.textContent = reason || 'Loading…';
  }
}

function showEmptyDayInfo(reason) {
  _applyEmpty([
    { date:'dicDate', verdict:'dicVerdict', stats:'dicStats', summary:'dicSummary' },
    { date:'dicDateLine', verdict:'dicVerdictLine', stats:'dicStatsLine', summary:'dicSummaryLine' },
  ], reason);
  _showActiveStrip();
}

// Show the correct day-info card variant for the active chart type (1D only).
// Only runs when the toggle is ON — bail out silently if toggled off.
function _showActiveStrip() {
  if (!_dayDetailsOn) return;
  const inCandleMode = document.querySelector('.chart-type-btn[data-type="candles"]')?.classList.contains('active');
  // Always hide the aligned strips when the day-info card is visible.
  document.getElementById('candleMonthStrip')?.style.setProperty('display','none');
  document.getElementById('monthStrip')?.style.setProperty('display','none');
  if (inCandleMode) {
    const el = document.getElementById('dayInfoCard');
    if (el) el.style.display = 'flex';
    document.getElementById('dayInfoCardLine')?.style.setProperty('display','none');
  } else {
    const el = document.getElementById('dayInfoCardLine');
    if (el) el.style.display = 'flex';
    document.getElementById('dayInfoCard')?.style.setProperty('display','none');
  }
}

function renderDayInfo(data, currency) {
  const date = data.date;
  const sent = data.sentiment || {};
  const verdict = (sent.verdict || 'live').toLowerCase();
  const verdictLabels = { bullish: 'BULLISH', bearish: 'BEARISH', neutral: 'NEUTRAL', live: 'LIVE' };

  const dateStr = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });

  const stats = [
    { label: 'Move',  value: diFmtPct(sent.eth_move_pct), cls: sent.eth_move_pct > 0 ? 'up' : sent.eth_move_pct < 0 ? 'down' : '' },
    { label: 'High',  value: diFmtPrice(sent.eth_high,  currency) },
    { label: 'Low',   value: diFmtPrice(sent.eth_low,   currency) },
    { label: 'Close', value: diFmtPrice(sent.eth_price, currency) },
    { label: 'BTC',   value: diFmtPct(sent.btc_move_pct), cls: sent.btc_move_pct > 0 ? 'up' : sent.btc_move_pct < 0 ? 'down' : '' },
    { label: 'Hope',  value: sent.hope_score  != null ? `${Math.round(sent.hope_score)}/100` : '—' },
    { label: 'Macro', value: sent.macro_score != null ? `${sent.macro_score > 0 ? '+' : ''}${Math.round(sent.macro_score)}` : '—' },
  ];
  const statsHtml = stats.map(s =>
    `<div class="dic-stat ${s.cls || ''}"><span class="dic-stat-label">${s.label}</span><strong>${diEscape(s.value)}</strong></div>`
  ).join('');

  const top = (arr, n) => (arr || []).slice(0, n);
  const hlItem = h => `<li><a href="${diEscape(h.url)}" target="_blank" rel="noopener"><span class="dic-hl-src">${diEscape(h.source)}</span> ${diEscape(h.title)}</a></li>`;
  const newsHtml = {
    crypto: top(data.headlines, 5).map(hlItem).join('') || '<li class="dic-empty">—</li>',
    macro:  top(data.macro_headlines, 5).map(hlItem).join('') || '<li class="dic-empty">—</li>',
    hope:   top(data.hope_headlines, 5).map(hlItem).join('') || '<li class="dic-empty">—</li>',
  };
  const hasNews = (data.headlines?.length || data.macro_headlines?.length || data.hope_headlines?.length) > 0;

  // Apply to news lists (shared between both strip variants via same IDs).
  const cryptoEl = document.getElementById('dicNewsCrypto');
  const macroEl  = document.getElementById('dicNewsMacro');
  const hopeEl   = document.getElementById('dicNewsHope');
  if (cryptoEl) cryptoEl.innerHTML = newsHtml.crypto;
  if (macroEl)  macroEl.innerHTML  = newsHtml.macro;
  if (hopeEl)   hopeEl.innerHTML   = newsHtml.hope;

  // Update the news panel visibility toggle.
  const newsPanel = document.getElementById('dicNews');
  if (newsPanel) newsPanel.style.display = hasNews ? '' : 'none';

  // Update both strip variants.
  for (const [dateId, verdId, statsId, summId] of [
    ['dicDate',     'dicVerdict',     'dicStats',     'dicSummary'],
    ['dicDateLine', 'dicVerdictLine', 'dicStatsLine', 'dicSummaryLine'],
  ]) {
    const dateEl  = document.getElementById(dateId);
    const verdEl  = document.getElementById(verdId);
    const statsEl = document.getElementById(statsId);
    const summEl  = document.getElementById(summId);
    if (dateEl)  dateEl.textContent = dateStr;
    if (verdEl)  { verdEl.textContent = verdictLabels[verdict] || verdict.toUpperCase(); verdEl.className = `dis-verdict dir-${verdict}`; }
    if (statsEl) statsEl.innerHTML = statsHtml;
    if (summEl)  summEl.textContent = sent.summary || '';
  }

  _showActiveStrip();
}

async function loadDayInfo(force = false) {
  const date = todayIso();
  const currency = window.state?.currency || window.activeCurrency || 'usd';

  showEmptyDayInfo('Loading today\'s sentiment…');

  if (!force && _dayInfoCache.date === date && (Date.now() - _dayInfoCache.ts) < DAY_INFO_TTL) {
    renderDayInfo(_dayInfoCache.data, currency);
    return;
  }
  try {
    const res  = await fetch(`/api/day-detail?date=${date}&currency=${currency}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed');
    const hasAnything = json.sentiment?.eth_price != null
      || json.sentiment?.eth_move_pct != null
      || json.sentiment?.verdict
      || json.headlines?.length
      || json.macro_headlines?.length
      || json.hope_headlines?.length;
    if (!hasAnything) {
      showEmptyDayInfo('Today\'s data is still coming in — check back in a few minutes.');
      return;
    }
    _dayInfoCache = { date, data: json, ts: Date.now() };
    renderDayInfo(json, currency);
  } catch (err) {
    console.warn('dayinfo load failed:', err);
    showEmptyDayInfo('Could not load today\'s data: ' + err.message);
  }
}

// Whether the unified day-details layer (card + month strip) is visible.
let _dayDetailsOn = false;

function _updateToggleBtn() {
  const btn = document.getElementById('dayInfoToggleBtn');
  if (!btn) return;
  btn.textContent = _dayDetailsOn ? '📋 Hide Days' : '📋 Day Details';
  btn.classList.toggle('active', _dayDetailsOn);
}

// Map the active range (days) to how many days of strip data to load.
// Cap at 90 so we don't request 365 tiles for 1Y.
function _stripDays() {
  const d = window.state?.days || 7;
  return Math.min(d, 90);
}

function syncDayInfo() {
  const days = window.state?.days || 7;
  const cur  = document.querySelector('.currency-btn.active')?.dataset.currency || 'usd';

  if (!_dayDetailsOn) {
    hideAllDayContent();
  } else if (days === 1) {
    // 1D: show the day-info chip card, hide the aligned strips.
    document.getElementById('candleMonthStrip')?.style.setProperty('display','none');
    document.getElementById('monthStrip')?.style.setProperty('display','none');
    loadDayInfo();
  } else {
    // 1W / 1M / 3M / 1Y: hide day-info card, show the aligned day-list strip.
    document.getElementById('dayInfoCard')?.style.setProperty('display','none');
    document.getElementById('dayInfoCardLine')?.style.setProperty('display','none');
    document.getElementById('candleMonthStrip')?.style.removeProperty('display');
    document.getElementById('monthStrip')?.style.removeProperty('display');
    window.loadMonthly?.(cur, _stripDays());
  }
  _updateToggleBtn();
}

// Allow app.js to restore the saved pref before the first syncDayInfo fires.
window.setDayDetailsOn = (v) => { _dayDetailsOn = !!v; _updateToggleBtn(); };

window.syncDayInfo = syncDayInfo;
window.hideDayInfo  = hideDayInfo;

function _saveDayPref() {
  fetch('/api/prefs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dayDetailsOn: String(_dayDetailsOn) }),
  }).catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => {
  // syncDayInfo is called explicitly after OHLC renders and after prefs load.

  // Re-sync on currency change (refresh day-info data or strip data).
  document.querySelectorAll('.currency-btn').forEach(btn => {
    btn.addEventListener('click', () => setTimeout(() => {
      if (_dayDetailsOn) syncDayInfo();
    }, 100));
  });

  // Re-sync when chart type (Line/Candles) toggles.
  document.querySelectorAll('.chart-type-btn').forEach(btn => {
    btn.addEventListener('click', () => setTimeout(() => syncDayInfo(), 50));
  });

  // Toggle button — always visible, controls the whole day-details layer.
  document.getElementById('dayInfoToggleBtn')?.addEventListener('click', () => {
    _dayDetailsOn = !_dayDetailsOn;
    syncDayInfo();
    _saveDayPref();
  });

  // Click the day-info card to expand/collapse the news panel.
  document.getElementById('dayInfoCard')?.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const panel = document.getElementById('dicNews');
    if (panel) panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });
});
