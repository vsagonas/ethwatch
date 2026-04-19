'use strict';

// ETHWATCH Admin Panel

let currentDays = 30;
let statsData   = null;

// ── HELPERS ───────────────────────────────────────────────────────
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmtTs(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtPrice(n) {
  if (n == null) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtPct(n, decimals = 2) {
  if (n == null || !isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + Number(n).toFixed(decimals) + '%';
}
function setStatus(el, msg, cls) {
  el.textContent = msg;
  el.className   = 'acc-status ' + (cls || '');
}

// ── STATS ─────────────────────────────────────────────────────────
async function loadStats(days) {
  currentDays = days;
  document.getElementById('climateLabel').textContent = days;

  try {
    const res = await fetch(`/api/admin/stats?days=${days}`).then(r => r.json());
    if (!res.success) return;
    statsData = res;

    const total = res.total_days || 1;

    // stat cards
    const bullPct = res.verdict_pct?.bullish ?? 0;
    const bearPct = res.verdict_pct?.bearish ?? 0;
    const neuPct  = res.verdict_pct?.neutral ?? 0;

    setCard('sc-bullish', res.verdicts?.bullish ?? '—', bullPct.toFixed(1) + '% of days', 'up');
    setCard('sc-bearish', res.verdicts?.bearish ?? '—', bearPct.toFixed(1) + '% of days', 'down');
    setCard('sc-neutral', res.verdicts?.neutral ?? '—', neuPct.toFixed(1) + '% of days', '');
    setCard('sc-hope',  res.avg_hope_score  != null ? res.avg_hope_score  : '—', '0=bleak · 100=hopeful', res.avg_hope_score >= 55 ? 'up' : res.avg_hope_score < 40 ? 'down' : '');
    setCard('sc-macro', res.avg_macro_score != null ? res.avg_macro_score : '—', '−100=crisis · +100=boom', res.avg_macro_score >= 0 ? 'up' : 'down');
    setCard('sc-war',   res.war_days ?? '—', res.war_pct + '% of days (macro < −30)', res.war_pct > 30 ? 'warn' : '');
    setCard('sc-acc',   res.avg_accuracy != null ? res.avg_accuracy + '/100' : '—', res.resolved_predictions + ' resolved', res.avg_accuracy >= 70 ? 'up' : res.avg_accuracy >= 50 ? '' : 'down');
    setCard('sc-preds', res.total_predictions ?? '—', res.resolved_predictions + ' resolved', '');

    // climate bars
    renderBars(res);
  } catch (err) {
    console.error('Stats error:', err);
  }
}

function setCard(id, val, sub, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.querySelector('.asc-val').textContent = val;
  el.querySelector('.asc-val').className   = 'asc-val ' + (cls || '');
  el.querySelector('.asc-sub').textContent = sub || '';
}

function renderBars(s) {
  const container = document.getElementById('climateBars');
  const total     = s.total_days || 1;
  const hope      = s.avg_hope_score  ?? 50;
  const macro     = s.avg_macro_score ?? 0;
  const warPct    = s.war_pct ?? 0;
  const bullPct   = s.verdict_pct?.bullish ?? 0;
  const bearPct   = s.verdict_pct?.bearish ?? 0;
  const neuPct    = s.verdict_pct?.neutral ?? 0;

  container.innerHTML = [
    bar('BULLISH %',  bullPct, 100, '#3fb950'),
    bar('BEARISH %',  bearPct, 100, '#f85149'),
    bar('NEUTRAL %',  neuPct,  100, '#8b949e'),
    bar('AVG HOPE',   hope,    100, '#58a6ff'),
    bar('AVG MACRO',  Math.max(0, macro + 100) / 2, 100, macro >= 0 ? '#3fb950' : '#f85149'),
    bar('WAR / CRISIS %', warPct, 100, '#d29922'),
  ].join('');
}

function bar(label, val, max, color) {
  const pct  = Math.min(100, Math.max(0, (val / max) * 100));
  const disp = typeof val === 'number' ? val.toFixed(1) : val;
  return `<div class="adm-bar-row">
    <div class="abr-label">${escHtml(label)}</div>
    <div class="abr-track"><div class="abr-fill" style="width:${pct}%;background:${color}"></div></div>
    <div class="abr-val" style="color:${color}">${escHtml(disp)}</div>
  </div>`;
}

// ── PERIOD PICKER ─────────────────────────────────────────────────
function initPeriodPicker() {
  document.querySelectorAll('.period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadStats(parseInt(btn.dataset.days));
    });
  });
}

// ── RUN NEW AI FORECAST ───────────────────────────────────────────
function initRunForecast() {
  let selectedDays = 90;

  // Days picker
  document.querySelectorAll('.days-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.days-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedDays = parseInt(btn.dataset.days);
    });
  });

  const btn    = document.getElementById('runForecastBtn');
  const status = document.getElementById('forecastStatus');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const label = selectedDays === 90 ? '3 months' : selectedDays === 30 ? '1 month' : selectedDays === 15 ? '15 days' : '7 days';
    setStatus(status, `⏳ Running Claude forecast using last ${label} of data (30–90s)…`, 'running');
    try {
      const res = await fetch('/api/admin/run-forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history_days: selectedDays }),
      }).then(r => r.json());
      if (res.success) {
        const d = res.data;
        setStatus(status,
          `✓ Done — ${(d?.direction || '').toUpperCase()} ${fmtPct(d?.expected_move_pct)} · ${d?.history_days ?? selectedDays}d window · Now live on Watch + Weather`,
          'ok');
        loadPredictions();
      } else {
        setStatus(status, '✗ Error: ' + escHtml(res.error), 'err');
      }
    } catch (err) {
      setStatus(status, '✗ ' + escHtml(err.message), 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

// ── RESCORE SENTIMENT ─────────────────────────────────────────────
function initRescore() {
  const btn    = document.getElementById('rescoreBtn');
  const status = document.getElementById('rescoreStatus');
  btn.addEventListener('click', async () => {
    const days = parseInt(document.getElementById('rescoreDays').value) || 7;
    btn.disabled = true;
    setStatus(status, `⏳ Rescoring last ${days} days…`, 'running');
    try {
      const res = await fetch('/api/admin/rescore-sentiment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days }),
      }).then(r => r.json());
      if (res.success) {
        setStatus(status, `✓ Cleared ${res.cleared} rows, rebuilt ${res.days_processed} days`, 'ok');
        loadStats(currentDays);
      } else {
        setStatus(status, '✗ ' + escHtml(res.error), 'err');
      }
    } catch (err) {
      setStatus(status, '✗ ' + escHtml(err.message), 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

// ── MANUAL PREDICTION ─────────────────────────────────────────────
function initManualPrediction() {
  let selectedDir = '';

  document.querySelectorAll('.dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedDir = btn.dataset.dir;
      document.getElementById('predDirection').value = selectedDir;

      // auto-fill move sign hint
      const moveEl = document.getElementById('predMove');
      if (!moveEl.value) {
        moveEl.placeholder = selectedDir === 'bullish' ? '+5.5' : selectedDir === 'bearish' ? '-8' : '0';
      }
    });
  });

  document.getElementById('savePredBtn').addEventListener('click', async () => {
    const btn      = document.getElementById('savePredBtn');
    const status   = document.getElementById('predStatus');
    const direction = selectedDir;
    const move      = document.getElementById('predMove').value;
    const conf      = document.getElementById('predConf').value;
    const headline  = document.getElementById('predHeadline').value.trim();
    const narrative = document.getElementById('predNarrative').value.trim();

    if (!direction) { setStatus(status, '✗ Select a direction first', 'err'); return; }
    if (!headline && !narrative) { setStatus(status, '✗ Add at least a headline or narrative', 'err'); return; }

    btn.disabled = true;
    setStatus(status, '⏳ Saving…', 'running');
    try {
      const res = await fetch('/api/admin/prediction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          direction,
          expected_move_pct: move ? parseFloat(move) : null,
          confidence:        conf ? parseFloat(conf) : null,
          headline,
          narrative,
          horizon: '7d',
        }),
      }).then(r => r.json());
      if (res.success) {
        setStatus(status, `✓ Saved (ID ${res.id}) — now active on Watch & Weather`, 'ok');
        // reset form
        document.querySelectorAll('.dir-btn').forEach(b => b.classList.remove('active'));
        selectedDir = '';
        ['predMove','predConf','predHeadline','predNarrative'].forEach(id => { document.getElementById(id).value = ''; });
        loadPredictions();
      } else {
        setStatus(status, '✗ ' + escHtml(res.error), 'err');
      }
    } catch (err) {
      setStatus(status, '✗ ' + escHtml(err.message), 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

// ── PREDICTION TABLE ──────────────────────────────────────────────
let liveForecastId = null; // track which row is currently set as live

async function loadPredictions() {
  const tbody = document.getElementById('predTbody');
  try {
    // Get current live forecast to mark it
    const liveRes = await fetch('/api/forecast-7d').then(r => r.json()).catch(() => null);
    const liveTs  = liveRes?.data?.generated_ts || liveRes?.data?.anchor_ts || null;

    const res = await fetch('/api/predictions/history?limit=200&type=ai_forecast').then(r => r.json());
    if (!res.success) { tbody.innerHTML = `<tr><td colspan="11" class="adm-loading">Error: ${escHtml(res.error)}</td></tr>`; return; }
    const rows = res.predictions || [];
    document.getElementById('predCount').textContent = `(${rows.length})`;

    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="11" class="adm-loading">No predictions yet.</td></tr>'; return; }

    tbody.innerHTML = rows.map((p, i) => {
      const fc       = p.raw_result;
      const headline = fc?.headline || p.narrative || '';
      const dir      = p.predicted_direction || '—';
      const isManual = p.source_ref === 'manual';
      const histDays = fc?.history_days;
      const dirCls   = dir === 'bullish' ? 'bullish' : dir === 'bearish' ? 'bearish' : 'neutral';
      const accHtml  = p.accuracy_score != null
        ? `<span class="acc-bar"><span class="acc-bar-fill" style="width:${p.accuracy_score}%"></span></span>${p.accuracy_score.toFixed(0)}`
        : '—';
      // Detect if this row is currently live (match by generated_ts)
      const rowTs  = fc?.generated_ts || fc?.anchor_ts;
      const isLive = liveTs && rowTs && Math.abs(rowTs - liveTs) < 5000;
      if (isLive) liveForecastId = p.id;

      const liveBtn = fc?.daily_breakdown?.length
        ? `<button class="adm-btn set-live-btn ${isLive ? 'primary' : ''}" data-id="${p.id}" title="Make this the live forecast on Watch+Weather">${isLive ? '✓ LIVE' : 'Set Live'}</button>`
        : '<span class="dim">—</span>';

      return `<tr class="${isLive ? 'row-latest' : ''}">
        <td>${liveBtn}</td>
        <td class="dim">${escHtml(fmtTs(p.created_ts))}</td>
        <td><span class="badge ${isManual ? 'manual' : 'ai'}">${isManual ? 'MANUAL' : 'AI'}</span>${histDays ? `<span style="font-size:0.65rem;color:var(--text-dim);margin-left:4px">${histDays}d</span>` : ''}</td>
        <td><span class="badge ${dirCls}">${escHtml(dir.toUpperCase())}</span></td>
        <td style="color:${dir==='bullish'?'var(--up)':dir==='bearish'?'var(--down)':'var(--neutral)'};font-weight:700">${fmtPct(p.predicted_move_pct)}</td>
        <td class="dim">${p.confidence != null ? p.confidence + '%' : '—'}</td>
        <td class="dim">${escHtml(p.target_date || '—')}</td>
        <td class="dim">${fmtPrice(p.eth_price_at_prediction)}</td>
        <td style="color:${(p.actual_move_pct??0)>=0?'var(--up)':'var(--down)'}">${fmtPct(p.actual_move_pct)}</td>
        <td>${accHtml}</td>
        <td class="td-headline" title="${escHtml(headline)}">${escHtml(headline.slice(0, 70))}${headline.length > 70 ? '…' : ''}</td>
      </tr>`;
    }).join('');

    // Wire Set Live buttons
    tbody.querySelectorAll('.set-live-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = parseInt(btn.dataset.id);
        btn.disabled = true;
        btn.textContent = '…';
        try {
          const r = await fetch(`/api/admin/set-live-forecast/${id}`, { method: 'POST' }).then(x => x.json());
          if (r.success) {
            await loadPredictions(); // reload table to show updated LIVE badge
          } else {
            btn.textContent = '✗';
            setTimeout(() => { btn.disabled = false; btn.textContent = 'Set Live'; }, 1500);
          }
        } catch { btn.textContent = '✗'; btn.disabled = false; }
      });
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="11" class="adm-loading">${escHtml(err.message)}</td></tr>`;
  }
}

// ── INIT ──────────────────────────────────────────────────────────
function init() {
  initPeriodPicker();
  initRunForecast();
  initRescore();
  initManualPrediction();
  loadStats(30);
  loadPredictions();
}

document.addEventListener('DOMContentLoaded', init);
