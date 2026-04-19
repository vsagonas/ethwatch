/* ═══════════════════════════════════════════════════════════
   ETHWATCH — 30-Day Sentiment Strip + Day Detail Modal
   ═══════════════════════════════════════════════════════════ */

'use strict';

const SYM = { usd: '$', eur: '€' };
let monthlyCache = null; // { days: [...], fetchedAt, currency }

function verdictClass(v) {
  if (v === 'bullish') return 'bull';
  if (v === 'bearish') return 'bear';
  if (v === 'neutral') return 'neutral';
  return 'pending';
}

function fmtMove(v) {
  if (v == null || !isFinite(v)) return '—';
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(2)}%`;
}

function fmtPriceVal(v, currency) {
  if (v == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency.toUpperCase(),
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(v);
}

function fmtDayLabel(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function injectTodayCard(strips, currency) {
  const today = new Date().toISOString().slice(0, 10);
  // Don't duplicate if API already returned today's row
  if (monthlyCache?.days?.some(d => d.date === today)) return;

  const ts  = new Date(today + 'T12:00:00Z').getTime();
  const cur = currency || 'usd';
  const priceObj = window.state?.currentPrice;
  const price    = priceObj?.[cur];
  const change   = priceObj?.[`${cur}_24h_change`];
  const sym      = cur === 'eur' ? '€' : '$';

  const moveCls = change == null ? '' : change >= 0 ? 'up' : 'down';
  const moveStr = change == null ? '—' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
  const priceStr = price != null ? `${sym}${Math.round(price).toLocaleString()}` : '—';

  const html = `
    <div class="day-col today-col" data-date="${today}" data-ts="${ts}" style="left:-9999px">
      <button class="day-tile today-tile" data-date="${today}" title="Today — ${today}">
        <div class="dt-date today-label">TODAY</div>
        <div class="dt-move ${moveCls}">${moveStr}</div>
        <div class="dt-verdict">LIVE</div>
        <div class="dt-extras">
          <div class="dt-hl"><span class="dt-h">${priceStr}</span></div>
        </div>
      </button>
      <div class="hope-cell pending" title="Today — live">
        <div class="hope-graph">
          <div class="hope-midline"></div>
          <div class="hope-bar" style="height:0%"></div>
        </div>
        <div class="hope-label">live</div>
      </div>
    </div>
  `;

  strips.forEach(s => {
    s.insertAdjacentHTML('beforeend', html);
    s.querySelector('.today-col .day-tile')
      ?.addEventListener('click', () => openDayModal(today, cur));
  });
}

// ── RENDER STRIP (day-cols are absolute-positioned, aligned to chart x) ──
const STRIP_IDS = ['monthStrip', 'candleMonthStrip'];
function renderStrip(days, currency) {
  const strips = STRIP_IDS.map(id => document.getElementById(id)).filter(Boolean);
  if (!strips.length) return;

  if (!days?.length) {
    strips.forEach(s => { s.innerHTML = '<div class="cs-empty">No world-signal data yet.</div>'; });
    return;
  }

  const markup = days.map(d => {
    const cls = verdictClass(d.verdict);
    const move = d.eth_move_pct;
    const moveCls = move == null ? '' : move >= 0 ? 'up' : 'down';

    const hope = typeof d.hope_score === 'number' ? d.hope_score : null;
    const hopeDelta = hope == null ? null : (hope - 50) * 2;
    const hopeCls = hope == null ? 'pending' : hopeDelta >= 0 ? 'up' : 'down';
    const hopeBarPct = hope == null ? 0 : Math.min(100, Math.abs(hopeDelta));
    // "Pending" is clearer than "—" for the common case of recent days
    // that Claude hasn't rated yet (NewsAPI 24h delay + rate limits).
    const hopeStr = hope == null
      ? '…'
      : `${hopeDelta >= 0 ? '+' : ''}${Math.round(hopeDelta)}%`;

    // UTC noon as the anchor — keeps each tile centered over the day's midpoint.
    const ts = new Date(d.date + 'T12:00:00Z').getTime();

    // Extra detail used in expanded mode (few tiles visible): day high, low,
    // and the % decline from intraday high to close.
    const fmtShort = v => v == null ? '—' : `$${Math.round(v).toLocaleString()}`;
    const decline = d.eth_decline_from_high_pct;
    const declineStr = decline == null ? '' : `from H ${decline >= 0 ? '+' : ''}${decline.toFixed(1)}%`;

    return `
      <div class="day-col" data-date="${d.date}" data-ts="${ts}" style="left:-9999px">
        <button class="day-tile ${cls}" data-date="${d.date}" title="${d.date}">
          <div class="dt-date">${fmtDayLabel(d.date)}</div>
          <div class="dt-move ${moveCls}">${fmtMove(move)}</div>
          <div class="dt-verdict">${d.verdict || '—'}</div>
          <div class="dt-extras">
            <div class="dt-hl">
              <span class="dt-h">H ${fmtShort(d.eth_high)}</span>
              <span class="dt-l">L ${fmtShort(d.eth_low)}</span>
            </div>
            ${declineStr ? `<div class="dt-decline ${decline >= 0 ? 'up' : 'down'}">${declineStr}</div>` : ''}
          </div>
        </button>
        <div class="hope-cell ${hopeCls}" title="Hope score: ${hope == null ? '—' : Math.round(hope)} / 100">
          <div class="hope-graph">
            <div class="hope-midline"></div>
            <div class="hope-bar ${hopeCls}" style="height:${hopeBarPct / 2}%"></div>
          </div>
          <div class="hope-label ${hopeCls}">${hopeStr}</div>
        </div>
      </div>
    `;
  }).join('');

  strips.forEach(s => { s.innerHTML = markup; });
  injectTodayCard(strips, currency);
  for (const s of strips) {
    s.querySelectorAll('.day-tile').forEach(tile => {
      tile.addEventListener('click', () => openDayModal(tile.dataset.date, currency));
    });
    s.querySelectorAll('.hope-cell').forEach(cell => {
      cell.addEventListener('click', () => {
        const col = cell.parentElement;
        if (col?.dataset?.date) openDayModal(col.dataset.date, currency);
      });
    });
  }

  // Align both strips against their respective chart's x-scale.
  window.positionStripOnChart?.();
  window.positionCandleStrip?.();

  // Re-inject forecast day tiles if a forecast overlay is active —
  // renderStrip wiped the DOM with innerHTML so tiles need to come back.
  if (window.activePrediction) {
    window.renderForecastDayCards?.(window.activePrediction);
  }
}

// Align every day-col to the current price-chart x-scale. Also flips the
// strip between `compact` and `expanded` modes based on how many tiles
// are currently visible — fewer tiles means more room per tile, so we
// surface intraday high, low, and decline-from-high.
function positionStripOnChart(chart) {
  chart = chart || window.priceChart || null;
  if (!chart) chart = (typeof priceChart !== 'undefined' ? priceChart : null);
  const strip = document.getElementById('monthStrip');
  if (!strip || !chart?.scales?.x) return;
  const xScale = chart.scales.x;

  const cols = strip.querySelectorAll('.day-col');
  let visible = 0;
  cols.forEach(col => {
    const ts = parseInt(col.dataset.ts);
    if (!isFinite(ts)) return;
    const x = xScale.getPixelForValue(ts);
    if (!isFinite(x) || x < xScale.left - 60 || x > xScale.right + 60) {
      col.style.display = 'none';
    } else {
      col.style.display = '';
      col.style.left = `${x}px`;
      visible++;
    }
  });
  // ≤ 14 tiles visible (about 2 weeks) → expanded detail; otherwise compact.
  const expanded = visible > 0 && visible <= 14;
  strip.classList.toggle('expanded-tiles', expanded);
}
window.positionStripOnChart = positionStripOnChart;

// Align the candle-chart strip via Lightweight Charts' timeToCoordinate().
// LW Charts' time is unix seconds (not ms).
function positionCandleStrip() {
  const strip = document.getElementById('candleMonthStrip');
  const chart = window.lwChartApi || null;
  if (!strip || !chart || typeof chart.timeScale !== 'function') return;
  const ts = chart.timeScale();
  const stripWidth = strip.clientWidth;
  let visible = 0;
  strip.querySelectorAll('.day-col').forEach(col => {
    const ms = parseInt(col.dataset.ts);
    if (!isFinite(ms)) return;
    const x = ts.timeToCoordinate(Math.floor(ms / 1000));
    if (x == null || x < -60 || x > stripWidth + 60) {
      col.style.display = 'none';
    } else {
      col.style.display = '';
      col.style.left = `${x}px`;
      visible++;
    }
  });
  // Mirror the line-chart strip: expand to 148px + show H/L detail when zoomed in.
  const expanded = visible > 0 && visible <= 14;
  strip.classList.toggle('expanded-tiles', expanded);
}
window.positionCandleStrip = positionCandleStrip;

// ── LOAD MONTHLY ──────────────────────────────────────────────
async function loadMonthly(currency, days = 30) {
  const strip = document.getElementById('monthStrip');
  if (strip) strip.innerHTML = `<div class="month-loading"><div class="spinner"></div><span>Loading ${days} days…</span></div>`;

  try {
    const res = await fetch(`/api/monthly-sentiment?days=${days}&currency=${currency}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed');
    monthlyCache = { days: json.days, fetchedAt: Date.now(), currency };
    renderStrip(json.days, currency);
  } catch (err) {
    if (strip) strip.innerHTML = `<div class="month-loading"><span>Failed: ${err.message}</span></div>`;
  }
}

// ── DAY MODAL ─────────────────────────────────────────────────
async function openDayModal(date, currency) {
  const modal = document.getElementById('dayModal');
  const panel = document.getElementById('dayModalPanel');
  if (!modal || !panel) return;

  const stripRow = monthlyCache?.days?.find(d => d.date === date);
  panel.innerHTML = renderDayModalSkeleton(date, stripRow, currency);
  modal.style.display = 'flex';
  wireModalClose();

  try {
    const res = await fetch(`/api/day-detail?date=${date}&currency=${currency}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed');
    panel.innerHTML = renderDayModal(date, stripRow, json, currency);
    wireModalClose();
    wireModalTabs();
  } catch (err) {
    const body = panel.querySelector('.dm-body');
    if (body) body.innerHTML = `<div class="dm-error">Failed: ${err.message}</div>`;
  }
}

function renderDayModalSkeleton(date, row, currency) {
  return `
    <div class="dm-header">
      <div>
        <div class="dm-date">${fmtDayLabel(date)}</div>
        <div class="dm-date-sub">${date} · UTC</div>
      </div>
      <button class="close-btn" id="dayModalClose">✕ Close</button>
    </div>
    <div class="dm-body">
      ${renderDaySummaryBlock(row, currency)}
      <div class="dm-loading"><div class="spinner"></div><span>Loading headlines…</span></div>
    </div>
  `;
}

// Compact title-only headline row with a green/red frame, impact icon,
// and the 1-hour ETH price delta that followed.
function renderHeadlineList(items) {
  if (!items?.length) return '<div class="dm-empty">Nothing stored yet.</div>';
  return items.map(h => {
    const impact = h.impact || null; // 'up' | 'down' | 'flat' | null
    const delta  = typeof h.eth_delta_1h_pct === 'number' ? h.eth_delta_1h_pct : null;
    const icon   = impact === 'up' ? '▲' : impact === 'down' ? '▼' : impact === 'flat' ? '→' : '·';
    const cls    = impact === 'up' ? 'impact-up' : impact === 'down' ? 'impact-down' : impact === 'flat' ? 'impact-flat' : 'impact-none';
    const deltaStr = delta == null ? '' : `${delta >= 0 ? '+' : ''}${delta.toFixed(2)}%`;
    const time = h.published_at
      ? new Date(h.published_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
      : '';
    const title = h.impact === 'up'
      ? `ETH +${delta.toFixed(2)}% in the hour after`
      : h.impact === 'down'
        ? `ETH ${delta.toFixed(2)}% in the hour after`
        : h.impact === 'flat'
          ? `ETH ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}% in the hour after (flat)`
          : 'No 1h price data';
    return `
      <a class="dm-headline-compact ${cls}" href="${escapeAttr(h.url)}" target="_blank" rel="noopener" title="${escapeAttr(title)}">
        <span class="dmh-icon" aria-hidden="true">${icon}</span>
        <span class="dmh-title">${escapeHtml(h.title)}</span>
        <span class="dmh-meta">
          ${time ? `<span class="dmh-time">${time}</span>` : ''}
          <span class="dmh-src">${escapeHtml(h.source || '—')}</span>
          ${deltaStr ? `<span class="dmh-delta ${cls}">${deltaStr}</span>` : ''}
        </span>
      </a>
    `;
  }).join('');
}

function renderDayModal(date, row, detail, currency) {
  const sent = detail.sentiment || row || {};
  const crypto = detail.headlines        || [];
  const macro  = detail.macro_headlines  || [];
  const hope   = detail.hope_headlines   || [];

  const hopeScore  = typeof sent.hope_score  === 'number' ? sent.hope_score  : null;
  const macroScore = typeof sent.macro_score === 'number' ? sent.macro_score : null;
  const hopeDelta  = hopeScore  == null ? null : Math.round((hopeScore - 50) * 2);
  const hopeCls    = hopeDelta == null ? 'neutral' : hopeDelta >= 0 ? 'up' : 'down';
  const macroCls   = macroScore == null ? 'neutral' : macroScore >= 0 ? 'up' : 'down';

  return `
    <div class="dm-header">
      <div>
        <div class="dm-date">${fmtDayLabel(date)}</div>
        <div class="dm-date-sub">${date} · UTC</div>
      </div>
      <button class="close-btn" id="dayModalClose">✕ Close</button>
    </div>
    <div class="dm-body">
      ${renderDaySummaryBlock(sent, currency)}
      <div class="dm-score-grid">
        <div class="dm-score ${hopeCls}">
          <div class="dm-score-label">🕊 World Hope</div>
          <div class="dm-score-value">${hopeScore == null ? '—' : Math.round(hopeScore) + ' / 100'}</div>
          <div class="dm-score-delta ${hopeCls}">${hopeDelta == null ? '' : (hopeDelta >= 0 ? '+' : '') + hopeDelta + '%'}</div>
          ${sent.hope_summary ? `<div class="dm-score-summary">${escapeHtml(sent.hope_summary)}</div>` : ''}
        </div>
        <div class="dm-score ${macroCls}">
          <div class="dm-score-label">🌍 Macro / War</div>
          <div class="dm-score-value">${macroScore == null ? '—' : (macroScore >= 0 ? '+' : '') + Math.round(macroScore)}</div>
          <div class="dm-score-delta ${macroCls}">${macroScore == null ? '' : (macroScore >= 0 ? 'De-escalation' : 'Stress')}</div>
          ${sent.macro_summary ? `<div class="dm-score-summary">${escapeHtml(sent.macro_summary)}</div>` : ''}
        </div>
      </div>
      ${sent.summary ? `<div class="dm-ai-summary"><strong>Crypto verdict:</strong> ${escapeHtml(sent.summary)}</div>` : ''}

      <div class="dm-tabs" role="tablist">
        <button class="dm-tab active" role="tab" data-cat="crypto">📈 Crypto <span class="dm-tab-count">${crypto.length}</span></button>
        <button class="dm-tab"        role="tab" data-cat="macro">🌍 Macro / War <span class="dm-tab-count">${macro.length}</span></button>
        <button class="dm-tab"        role="tab" data-cat="hope">🕊 World Hope <span class="dm-tab-count">${hope.length}</span></button>
      </div>
      <div class="dm-tab-panel active" data-cat="crypto">${renderHeadlineList(crypto)}</div>
      <div class="dm-tab-panel"        data-cat="macro">${renderHeadlineList(macro)}</div>
      <div class="dm-tab-panel"        data-cat="hope">${renderHeadlineList(hope)}</div>
    </div>
  `;
}

function wireModalTabs() {
  const tabs   = document.querySelectorAll('#dayModalPanel .dm-tab');
  const panels = document.querySelectorAll('#dayModalPanel .dm-tab-panel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const cat = tab.dataset.cat;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      panels.forEach(p => p.classList.toggle('active', p.dataset.cat === cat));
    });
  });
}

function renderDaySummaryBlock(row, currency) {
  if (!row) return '';
  const cls = verdictClass(row.verdict);
  const ethMove = row.eth_move_pct;
  const btcMove = row.btc_move_pct;
  return `
    <div class="dm-summary-grid">
      <div class="dm-verdict ${cls}">
        <div class="dm-verdict-label">Sentiment</div>
        <div class="dm-verdict-value">${(row.verdict || 'pending').toUpperCase()}</div>
      </div>
      <div class="dm-metric">
        <div class="dm-metric-label">ETH Close</div>
        <div class="dm-metric-value">${fmtPriceVal(row.eth_price, currency)}</div>
        <div class="dm-metric-move ${ethMove == null ? '' : ethMove >= 0 ? 'up' : 'down'}">${fmtMove(ethMove)}</div>
      </div>
      <div class="dm-metric">
        <div class="dm-metric-label">BTC Close</div>
        <div class="dm-metric-value">${fmtPriceVal(row.btc_price, currency)}</div>
        <div class="dm-metric-move ${btcMove == null ? '' : btcMove >= 0 ? 'up' : 'down'}">${fmtMove(btcMove)}</div>
      </div>
    </div>
  `;
}

function wireModalClose() {
  const modal = document.getElementById('dayModal');
  const close = document.getElementById('dayModalClose');
  const backdrop = document.getElementById('dayModalBackdrop');
  const hide = () => { modal.style.display = 'none'; };
  close?.addEventListener('click', hide);
  backdrop?.addEventListener('click', hide);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { hide(); document.removeEventListener('keydown', esc); }
  });
}

// ── HTML ESCAPING ────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ── RANGE BUTTON HOOK ────────────────────────────────────────
function getActiveDays() {
  const btn = document.querySelector('.range-btn.active');
  return parseInt(btn?.dataset.days || '7');
}
function getActiveCurrency() {
  const btn = document.querySelector('.currency-btn.active');
  return btn?.dataset.currency || 'usd';
}

function toggleMonthlyVisibility() {
  // Strip now lives inside the chart wrapper and is visible at ALL ranges.
  // We still refetch on currency change, and after 10 min to keep scores warm.
  const currency = getActiveCurrency();
  const stale = !monthlyCache || Date.now() - monthlyCache.fetchedAt > 600000 || monthlyCache.currency !== currency;
  if (stale) loadMonthly(currency);
  else window.positionStripOnChart?.();
}

// Expose for cross-module use (e.g., candlestick synced news strip clicks).
window.openDayModal = openDayModal;
window.getMonthlyCache = () => monthlyCache;
window.loadMonthly = loadMonthly;

async function rescoreMonth() {
  const btn = document.getElementById('rescoreBtn');
  const original = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Rescoring…'; }
  try {
    const currency = getActiveCurrency();
    const res = await fetch('/api/monthly-sentiment/rescore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 30, currency }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Rescore failed');
    monthlyCache = { days: json.days, fetchedAt: Date.now(), currency };
    renderStrip(json.days, currency);
    window.toast?.('Verdicts refreshed.', 'success');
  } catch (err) {
    window.toast?.('Rescore failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Initial state: 7D default, so hidden. React to range/currency clicks.
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setTimeout(toggleMonthlyVisibility, 0);
    });
  });
  document.querySelectorAll('.currency-btn').forEach(btn => {
    btn.addEventListener('click', () => setTimeout(toggleMonthlyVisibility, 0));
  });
  document.getElementById('rescoreBtn')?.addEventListener('click', rescoreMonth);
  setTimeout(toggleMonthlyVisibility, 500);
});
