'use strict';

(function () {
  const LIST_ID = 'predHistList';
  const FILTER_ID = 'predHistFilter';

  function directionIcon(d) {
    if (d === 'bullish') return '↑';
    if (d === 'bearish') return '↓';
    return '→';
  }

  function directionClass(d) {
    if (d === 'bullish') return 'ph-bull';
    if (d === 'bearish') return 'ph-bear';
    return 'ph-neutral';
  }

  function typeLabel(t) {
    if (t === 'oracle') return 'Oracle';
    if (t === 'ai_forecast') return 'Forecast';
    if (t === 'pattern') return 'Pattern';
    return t;
  }

  function fmtDate(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtPct(v) {
    if (v == null) return '—';
    const sign = v >= 0 ? '+' : '';
    return `${sign}${v.toFixed(2)}%`;
  }

  function accuracyLabel(score) {
    if (score == null) return null;
    if (score >= 80) return { text: 'Excellent', cls: 'ph-acc-excellent' };
    if (score >= 55) return { text: 'Good', cls: 'ph-acc-good' };
    if (score >= 30) return { text: 'Fair', cls: 'ph-acc-fair' };
    return { text: 'Missed', cls: 'ph-acc-miss' };
  }

  function buildCard(p) {
    const acc = p.resolved_ts ? accuracyLabel(p.accuracy_score) : null;
    const resolvedBadge = acc
      ? `<span class="ph-badge ${acc.cls}">${acc.text} (${Math.round(p.accuracy_score)})</span>`
      : (p.target_date ? `<span class="ph-badge ph-pending">Pending · resolves ${p.target_date}</span>` : '');

    const actualRow = p.resolved_ts
      ? `<div class="ph-actual">Actual move: <strong class="${p.actual_move_pct >= 0 ? 'ph-bull' : 'ph-bear'}">${fmtPct(p.actual_move_pct)}</strong> · ETH at resolution: <strong>$${p.actual_eth_price?.toFixed(2) ?? '—'}</strong></div>`
      : '';

    const narrative = p.narrative
      ? `<div class="ph-narrative">${p.narrative}</div>`
      : '';

    return `
      <div class="ph-card">
        <div class="ph-card-header">
          <div class="ph-meta">
            <span class="ph-type-badge">${typeLabel(p.type)}</span>
            <span class="ph-source">${p.source_ref ?? ''}</span>
            <span class="ph-ts">${fmtDate(p.created_ts)}</span>
          </div>
          <div class="ph-badges">${resolvedBadge}</div>
        </div>
        <div class="ph-card-body">
          <div class="ph-direction ${directionClass(p.predicted_direction)}">
            ${directionIcon(p.predicted_direction)} ${p.predicted_direction ?? '—'}
          </div>
          <div class="ph-stats">
            <span>Expected: <strong>${fmtPct(p.predicted_move_pct)}</strong></span>
            <span>Confidence: <strong>${p.confidence != null ? p.confidence + '%' : '—'}</strong></span>
            <span>Horizon: <strong>${p.horizon ?? '—'}</strong></span>
            <span>ETH at call: <strong>$${p.eth_price_at_prediction?.toFixed(2) ?? '—'}</strong></span>
          </div>
          ${actualRow}
          ${narrative}
        </div>
      </div>`;
  }

  async function load(type = null) {
    const list = document.getElementById(LIST_ID);
    if (!list) return;
    list.innerHTML = `<div class="patterns-loading"><div class="spinner"></div><span>Loading…</span></div>`;

    try {
      const url = `/api/predictions/history?limit=500${type ? '&type=' + type : ''}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!json.success) throw new Error(json.error);

      if (!json.predictions.length) {
        list.innerHTML = `<div class="oracle-empty">No predictions yet. Run the Oracle, Forecast, or Pattern Prediction to start building history.</div>`;
        return;
      }

      list.innerHTML = json.predictions.map(buildCard).join('');
    } catch (err) {
      list.innerHTML = `<div class="oracle-empty">Failed to load: ${err.message}</div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    load();

    const filter = document.getElementById(FILTER_ID);
    if (filter) {
      filter.addEventListener('change', () => load(filter.value || null));
    }
  });

  window.reloadPredHistory = () => {
    const filter = document.getElementById(FILTER_ID);
    load(filter?.value || null);
  };
})();
