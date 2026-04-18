/* ═══════════════════════════════════════════════════════════
   ETHWATCH — ORACLE: save marker sets, run Claude pattern prophecy
   ═══════════════════════════════════════════════════════════ */

'use strict';

const ORACLE = {
  sets: [],
};

// ── HELPERS ────────────────────────────────────────────────
function ocEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function ocFmtPct(v) {
  if (v == null || !isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}%`;
}
function ocFmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── SAVE DIALOG ────────────────────────────────────────────
function openSaveDialog() {
  const marks = [...(window.getMarkedTimes?.() || [])];
  if (!marks.length) {
    window.toast?.('Mark at least one candle first.', 'warn');
    return;
  }
  document.getElementById('oracleSaveMarkCount').textContent = marks.length;
  document.getElementById('oracleSaveName').value = '';
  document.getElementById('oracleSaveDesc').value = '';
  document.getElementById('oracleSavePred').value = '';
  document.getElementById('oracleSaveModal').style.display = 'flex';
}
function closeSaveDialog() {
  document.getElementById('oracleSaveModal').style.display = 'none';
}

async function submitSave() {
  const name = document.getElementById('oracleSaveName').value.trim();
  if (!name) { window.toast?.('Name is required.', 'error'); return; }
  const description = document.getElementById('oracleSaveDesc').value.trim();
  const prediction  = document.getElementById('oracleSavePred').value.trim();

  const marks = [...(window.getMarkedTimes?.() || [])];
  const ohlc  = window.getCurrentOHLC?.() || [];
  const byTime = new Map(ohlc.map(c => [c.time, c]));

  const points = marks.map(t => {
    const c = byTime.get(t);
    return {
      candle_time: t,
      date: new Date(t * 1000).toISOString().slice(0, 10),
      eth_price: c ? c.close : null,
      eth_open:  c?.open  ?? null,
      eth_high:  c?.high  ?? null,
      eth_low:   c?.low   ?? null,
      eth_close: c?.close ?? null,
    };
  });

  const currency = document.querySelector('.currency-btn.active')?.dataset.currency || 'usd';

  try {
    const res = await fetch('/api/marker-sets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, prediction, currency, points }),
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Save failed');
    window.toast?.(`Pattern saved: ${name}`, 'success');
    closeSaveDialog();
    await loadSets();
  } catch (err) {
    window.toast?.('Save failed: ' + err.message, 'error');
  }
}

// ── LIST + RENDER SETS ─────────────────────────────────────
async function loadSets() {
  try {
    const res = await fetch('/api/marker-sets');
    const json = await res.json();
    if (!json.success) return;
    ORACLE.sets = json.sets || [];
    renderSets();
  } catch { /* silent */ }
}

function renderSets() {
  const host = document.getElementById('oracleSetsList');
  if (!host) return;
  if (!ORACLE.sets.length) {
    host.innerHTML = '<div class="oracle-empty">No Oracle sets yet. Mark candles in the chart, then click <strong>Save as Oracle Set</strong>.</div>';
    return;
  }
  host.innerHTML = ORACLE.sets.map(s => renderSetCard(s)).join('');

  host.querySelectorAll('[data-action="run"]').forEach(b => b.addEventListener('click', () => runOracle(parseInt(b.dataset.id))));
  host.querySelectorAll('[data-action="delete"]').forEach(b => b.addEventListener('click', () => deleteSet(parseInt(b.dataset.id))));
  host.querySelectorAll('[data-action="toggle-chart"]').forEach(b => b.addEventListener('click', () => toggleSetOnChart(parseInt(b.dataset.id))));
}

function renderSetCard(s) {
  const created = ocFmtDate(s.created_ts);
  const prophecy = s.oracle_result;
  const directionCls = prophecy ? prophecy.direction : 'pending';
  const isActive = window.activePredictionSetId === s.id;
  const hasTraj = prophecy?.trajectory?.length > 0;
  return `
    <div class="oracle-card ${directionCls}${isActive ? ' active-prediction' : ''}">
      <div class="oracle-card-header">
        <div>
          <div class="oracle-card-title">${ocEscape(s.name)}</div>
          <div class="oracle-card-meta">${s.point_count} markers · created ${created}</div>
        </div>
        <div class="oracle-card-actions">
          <button class="predict-btn" data-action="run" data-id="${s.id}">
            <svg class="oracle-icon" viewBox="0 0 24 24" width="14" height="14"><circle cx="12" cy="12" r="2.5" fill="currentColor"/><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M12 1.5v2.5M12 20v2.5M1.5 12h2.5M20 12h2.5" stroke="currentColor" stroke-width="1.2"/></svg>
            Invoke Oracle
          </button>
          ${hasTraj ? `<button class="save-set-btn" data-action="toggle-chart" data-id="${s.id}" title="Show this prediction on the chart">${isActive ? '👁 Hide on chart' : '👁 Show on chart'}</button>` : ''}
          <button class="clear-marks-btn" data-action="delete" data-id="${s.id}" title="Delete set">✕</button>
        </div>
      </div>
      ${s.description ? `<div class="oracle-card-desc"><strong>Shared trait:</strong> ${ocEscape(s.description)}</div>` : ''}
      ${s.prediction  ? `<div class="oracle-card-desc"><strong>User prediction:</strong> ${ocEscape(s.prediction)}</div>` : ''}
      <div class="oracle-prophecy">${prophecy ? renderProphecy(prophecy) : '<div class="oracle-placeholder">Click <em>Invoke Oracle</em> to generate a prophecy.</div>'}</div>
    </div>
  `;
}

function renderProphecy(p) {
  const sig = p.direction || 'neutral';
  const arrow = sig === 'bullish' ? '▲' : sig === 'bearish' ? '▼' : '→';
  const conf = typeof p.confidence === 'number' ? Math.round(p.confidence * 100) : null;
  const move = typeof p.expected_move_pct === 'number' ? ocFmtPct(p.expected_move_pct) : '—';
  const userV = p.user_hypothesis_verdict || '—';

  return `
    <div class="prophecy-head">
      <div class="prophecy-dir ${sig}">
        <span class="prophecy-arrow">${arrow}</span>
        <span>${sig.toUpperCase()}</span>
      </div>
      <div class="prophecy-metrics">
        <div><span>Confidence</span><strong>${conf != null ? conf + '%' : '—'}</strong></div>
        <div><span>Horizon</span><strong>${ocEscape(p.horizon || '—')}</strong></div>
        <div><span>Expected move</span><strong>${move}</strong></div>
        <div><span>Your call</span><strong class="hypothesis-${userV}">${ocEscape(userV)}</strong></div>
      </div>
    </div>
    <div class="prophecy-narrative">${ocEscape(p.narrative || '')}</div>
    ${(p.key_signals?.length) ? `
      <div class="prophecy-list">
        <div class="prophecy-list-title">Key signals</div>
        <ul>${p.key_signals.map(s => `<li>${ocEscape(s)}</li>`).join('')}</ul>
      </div>` : ''}
    ${(p.risk_factors?.length) ? `
      <div class="prophecy-list">
        <div class="prophecy-list-title">Risk factors</div>
        <ul>${p.risk_factors.map(s => `<li>${ocEscape(s)}</li>`).join('')}</ul>
      </div>` : ''}
  `;
}

async function runOracle(id) {
  const btn = document.querySelector(`[data-action="run"][data-id="${id}"]`);
  const original = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Consulting Oracle…'; }
  try {
    const res = await fetch(`/api/marker-sets/${id}/oracle`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Oracle failed');
    window.toast?.('Oracle prophecy generated.', 'success');
    // Auto-show this prophecy's trajectory on the chart as a faded overlay.
    setActivePrediction(id, json.prophecy);
    await loadSets();
    window.reloadPredHistory?.();
  } catch (err) {
    window.toast?.('Oracle failed: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.innerHTML = original; }
  }
}

function toggleSetOnChart(id) {
  const set = ORACLE.sets.find(s => s.id === id);
  if (!set?.oracle_result?.trajectory?.length) {
    window.toast?.('No trajectory yet — run the Oracle first.', 'warn');
    return;
  }
  if (window.activePredictionSetId === id) {
    clearActivePrediction();
  } else {
    setActivePrediction(id, set.oracle_result);
  }
  renderSets();
}

function setActivePrediction(setId, prophecy) {
  window.activePredictionSetId = setId;
  window.activePrediction = prophecy;
  window.renderPredictionOverlay?.({ focus: true });
}
function clearActivePrediction() {
  window.activePredictionSetId = null;
  window.activePrediction = null;
  window.renderPredictionOverlay?.();
}
window.setActivePrediction = setActivePrediction;
window.clearActivePrediction = clearActivePrediction;

async function deleteSet(id) {
  if (!confirm('Delete this Oracle set?')) return;
  try {
    const res = await fetch(`/api/marker-sets/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!json.success) throw new Error('Delete failed');
    await loadSets();
  } catch (err) {
    window.toast?.('Delete failed: ' + err.message, 'error');
  }
}

// ── WIRE UP ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('saveSetBtn')?.addEventListener('click', openSaveDialog);
  document.getElementById('oracleSaveClose')?.addEventListener('click', closeSaveDialog);
  document.getElementById('oracleSaveBackdrop')?.addEventListener('click', closeSaveDialog);
  document.getElementById('oracleSaveCancel')?.addEventListener('click', closeSaveDialog);
  document.getElementById('oracleSaveSubmit')?.addEventListener('click', submitSave);
  loadSets();
});
