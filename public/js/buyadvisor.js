/* BUY / HODL / SELL advisor — compact chip in the hero, full reasoning in a
   modal popup on click. Polls /api/buy-time every 5 min. */

'use strict';

function baEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function baFmtTs(ts) {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}
function baFmtPrice(usd) {
  if (usd == null) return '—';
  const fx  = window.fxFromUSD || 1;
  const cur = window.activeCurrency || 'usd';
  const sym = cur === 'eur' ? '€' : '$';
  const v = usd * fx;
  return `${sym}${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function setList(id, items) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = (items || []).map(s => `<li>${baEscape(s)}</li>`).join('') || '<li class="ba-empty">—</li>';
}

let latestRec = null;
let isAdviceStale = false;

const ADVICE_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours — chip falls back to HODL and the popup is disabled when advice is older than this.

function paintAdvisor(d) {
  latestRec = d;
  if (!d) return;
  const rawVerdict = (d.verdict || 'hodl').toLowerCase();
  const isStale = !!(d.generated_ts && (Date.now() - d.generated_ts) > ADVICE_STALE_MS);
  isAdviceStale = isStale;
  // Chip shows HODL when advice is older than 2h — stale signals are unsafe to act on.
  const chipVerdict = isStale ? 'hodl' : rawVerdict;

  // Compact chip
  const chip = document.getElementById('buyChip');
  if (chip) {
    chip.classList.remove('verdict-buy', 'verdict-hodl', 'verdict-sell');
    chip.classList.add(`verdict-${chipVerdict}`);
    chip.classList.toggle('advice-stale', isStale);
    chip.title = isStale ? 'Advice is older than 2h — no fresh AI prediction available' : '';
  }
  const verdictEl = document.getElementById('baVerdict');
  if (verdictEl) verdictEl.textContent = isStale ? 'HODL' : rawVerdict.toUpperCase();
  const confEl = document.getElementById('baConfidence');
  if (confEl) confEl.textContent = isStale ? 'stale' : (typeof d.confidence === 'number' ? `${Math.round(d.confidence * 100)}%` : '—');

  // Modal (in case it's already open)
  const modalVerdict = document.getElementById('baModalVerdict');
  if (modalVerdict) {
    modalVerdict.textContent = rawVerdict.toUpperCase();
    modalVerdict.className = `ba-modal-verdict verdict-${rawVerdict}`;
  }
  const tf = document.getElementById('baTimeframe');
  if (tf)    tf.textContent = d.timeframe || '—';
  const cm = document.getElementById('baModalConf');
  if (cm)    cm.textContent = typeof d.confidence === 'number' ? `${Math.round(d.confidence * 100)}%` : '—';
  const pm = document.getElementById('baModalPrice');
  if (pm)    pm.textContent = baFmtPrice(d.current_eth_price_usd);
  const hd = document.getElementById('baHeadline');
  if (hd)    hd.textContent = d.headline || '';
  const ts = document.getElementById('baGeneratedTs');
  if (ts)    ts.textContent = d.generated_ts ? `Updated ${baFmtTs(d.generated_ts)}` : '';

  setList('baPros',  d.pros);
  setList('baCons',  d.cons);
  setList('baRisks', d.risks);
  updateLivePrice();
}

// Runs continuously — shows the current ETH price on the chip + modal so
// the user always sees the latest tick, independent of the AI verdict.
// state.currentPrice[cur] is already in the active currency, so no fx math.
function updateLivePrice() {
  const cur = window.activeCurrency || 'usd';
  const live = window.state?.currentPrice?.[cur];
  const sym = cur === 'eur' ? '€' : '$';
  const txt = live == null
    ? '—'
    : `${sym}${Number(live).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const chipPrice  = document.getElementById('baChipPrice');
  const modalPrice = document.getElementById('baModalPrice');
  if (chipPrice)  chipPrice.textContent  = txt;
  if (modalPrice) modalPrice.textContent = txt;
}
window.updateBuyAdvisorLivePrice = updateLivePrice;

async function refreshAdvisor({ force = false } = {}) {
  const btn = document.getElementById('buyAdvisorRefresh');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Refreshing…'; }
  try {
    const res = await fetch(`/api/buy-time${force ? '?force=1' : ''}`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Failed');
    paintAdvisor(json.data);
  } catch (err) {
    const hd = document.getElementById('baHeadline');
    if (hd) hd.textContent = 'Advisor unavailable: ' + err.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
  }
}

function openBuyModal() {
  if (isAdviceStale) return; // Stale advice (>2h old) is non-actionable — suppress the popup entirely.
  document.getElementById('buyModal').style.display = 'flex';
  if (latestRec) paintAdvisor(latestRec); // ensure modal is painted
}
function closeBuyModal() {
  document.getElementById('buyModal').style.display = 'none';
}

// Poll /api/buy-time-ts every 30s to detect when admin pushes a new Opus
// result — only triggers a full refresh when the timestamp actually changes.
let lastKnownTs = null;
async function pollAdvisorTs() {
  try {
    const res  = await fetch('/api/buy-time-ts');
    const json = await res.json();
    if (json.ts && json.ts !== lastKnownTs) {
      lastKnownTs = json.ts;
      await refreshAdvisor(); // fetch the new recommendation and repaint
    }
  } catch {}
}

document.addEventListener('DOMContentLoaded', () => {
  // Initial load — fetch once from server cache/DB, no Claude call.
  refreshAdvisor().then(() => { lastKnownTs = latestRec?.generated_ts ?? null; });
  // Only re-fetch if admin has pushed a new result (ts changed).
  setInterval(pollAdvisorTs, 30 * 1000);
  // Re-evaluate staleness every minute so chip flips to HODL automatically.
  setInterval(() => { if (latestRec) paintAdvisor(latestRec); }, 60 * 1000);
  // Tick the live price every 5s on the chip / open modal.
  setInterval(updateLivePrice, 5000);

  document.getElementById('buyChip')?.addEventListener('click', openBuyModal);
  document.getElementById('buyModalClose')?.addEventListener('click', closeBuyModal);
  document.getElementById('buyModalBackdrop')?.addEventListener('click', closeBuyModal);
  // Re-render the cached recommendation whenever currency flips.
  document.querySelectorAll('.currency-btn').forEach(btn => {
    btn.addEventListener('click', () => setTimeout(() => { if (latestRec) paintAdvisor(latestRec); }, 50));
  });
});
