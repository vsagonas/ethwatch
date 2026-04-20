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

// ── RUN FORECAST ─────────────────────────────────────────────────
function initRunForecast() {
  let selectedDays = 90;
  let selectedBias = 'neutral';

  // Bias picker
  document.querySelectorAll('#biasPicker .days-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#biasPicker .days-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedBias = btn.dataset.bias;
    });
  });

  // Days picker
  document.querySelectorAll('#daysPicker .days-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#daysPicker .days-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedDays = parseInt(btn.dataset.days);
    });
  });

  const btn    = document.getElementById('runForecastBtn');
  const status = document.getElementById('forecastStatus');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const biasLabel = selectedBias === 'bullish' ? 'UPWARD bias' : selectedBias === 'bearish' ? 'DOWNWARD bias' : 'neutral';
    const label = selectedDays === 90 ? '3 months' : selectedDays === 30 ? '1 month' : selectedDays === 15 ? '15 days' : '7 days';
    setStatus(status, `⏳ Running forecast (${biasLabel}, ${label} data)… 30–90s`, 'running');
    try {
      const res = await fetch('/api/admin/run-forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history_days: selectedDays, bias: selectedBias }),
      }).then(r => r.json());
      if (res.success) {
        const d = res.data;
        setStatus(status,
          `✓ Done — ${(d?.direction || '').toUpperCase()} ${fmtPct(d?.expected_move_pct)} · ${d?.history_days ?? selectedDays}d · ${biasLabel} · Live on Watch + Weather`,
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

// ── REFRESH BUY ADVICE ────────────────────────────────────────────
function initRefreshBuyAdvice() {
  const btn    = document.getElementById('refreshBuyBtn');
  const status = document.getElementById('buyAdviceStatus');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    setStatus(status, '⏳ Fetching fresh recommendation…', 'running');
    try {
      const res = await fetch('/api/buy-time?force=1').then(r => r.json());
      if (res.success) {
        const d = res.data;
        setStatus(status, `✓ ${(d?.verdict || '').toUpperCase()} · ${d?.confidence != null ? Math.round(d.confidence * 100) + '% conf' : ''} · Live on Watch`, 'ok');
        loadBuyHistory();
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

let allPredictions = [];
let shownCount = 0;
const PRED_PAGE_INIT = 5;
const PRED_PAGE_MORE = 10;

function buildPredRow(p, liveTs) {
  const fc       = p.raw_result;
  const headline = fc?.headline || p.narrative || '';
  const dir      = p.predicted_direction || '—';
  const isManual = p.source_ref === 'manual';
  const histDays = fc?.history_days;
  const dirCls   = dir === 'bullish' ? 'bullish' : dir === 'bearish' ? 'bearish' : 'neutral';
  const accHtml  = p.accuracy_score != null
    ? `<span class="acc-bar"><span class="acc-bar-fill" style="width:${p.accuracy_score}%"></span></span>${p.accuracy_score.toFixed(0)}`
    : '—';
  const rowTs  = fc?.generated_ts || fc?.anchor_ts;
  const isLive = liveTs && rowTs && Math.abs(rowTs - liveTs) < 5000;
  if (isLive) liveForecastId = p.id;

  const liveBtn = fc?.daily_breakdown?.length
    ? `<button class="adm-btn set-live-btn ${isLive ? 'primary' : ''}" data-id="${p.id}" title="Make this the live forecast on Watch+Weather">${isLive ? '✓ LIVE' : 'Set Live'}</button>`
    : '<span class="dim">—</span>';
  const delBtn = `<button class="adm-btn del-fc-btn" data-id="${p.id}" title="Delete this forecast" style="padding:2px 8px;font-size:0.7rem;color:var(--down);border-color:var(--down)">🗑</button>`;
  const promptBtn = fc?.prompt?.system
    ? `<button class="adm-btn view-prompt-btn" data-id="${p.id}" title="View the prompt used to generate this (hash: ${fc.prompt.prompt_hash || '—'})" style="padding:2px 8px;font-size:0.7rem">📝 ${fc.prompt.prompt_hash?.slice(0,6) || 'prompt'}</button>`
    : '<span class="dim" style="font-size:0.7rem">—</span>';

  return `<tr class="${isLive ? 'row-latest' : ''}">
    <td>${liveBtn}</td>
    <td>${delBtn}${promptBtn}</td>
    <td class="dim">${escHtml(fmtTs(p.created_ts))}</td>
    <td><span class="badge ${isManual ? 'manual' : 'ai'}">${isManual ? 'MANUAL' : 'AUTO'}</span>${histDays ? `<span style="font-size:0.65rem;color:var(--text-dim);margin-left:4px">${histDays}d</span>` : ''}</td>
    <td><span class="badge ${dirCls}">${escHtml(dir.toUpperCase())}</span></td>
    <td style="color:${dir==='bullish'?'var(--up)':dir==='bearish'?'var(--down)':'var(--neutral)'};font-weight:700">${fmtPct(p.predicted_move_pct)}</td>
    <td class="dim">${p.confidence != null ? p.confidence + '%' : '—'}</td>
    <td class="dim">${escHtml(p.target_date || '—')}</td>
    <td class="dim">${fmtPrice(p.eth_price_at_prediction)}</td>
    <td style="color:${(p.actual_move_pct??0)>=0?'var(--up)':'var(--down)'}">${fmtPct(p.actual_move_pct)}</td>
    <td>${accHtml}</td>
    <td class="td-headline" title="${escHtml(headline)}">${escHtml(headline.slice(0, 70))}${headline.length > 70 ? '…' : ''}</td>
  </tr>`;
}

function wirePredButtons(tbody) {
  tbody.querySelectorAll('.set-live-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = parseInt(btn.dataset.id);
      btn.disabled = true; btn.textContent = '…';
      try {
        const r = await fetch(`/api/admin/set-live-forecast/${id}`, { method: 'POST' }).then(x => x.json());
        if (r.success) { await loadPredictions(); }
        else { btn.textContent = '✗'; setTimeout(() => { btn.disabled = false; btn.textContent = 'Set Live'; }, 1500); }
      } catch { btn.textContent = '✗'; btn.disabled = false; }
    });
  });
  tbody.querySelectorAll('.del-fc-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this forecast from the database?')) return;
      const id = parseInt(btn.dataset.id);
      btn.disabled = true;
      try {
        const r = await fetch(`/api/admin/prediction/${id}`, { method: 'DELETE' }).then(x => x.json());
        if (r.success) { await loadPredictions(); }
        else { btn.textContent = '✗'; setTimeout(() => { btn.disabled = false; btn.textContent = '🗑'; }, 1500); }
      } catch { btn.textContent = '✗'; btn.disabled = false; }
    });
  });
  tbody.querySelectorAll('.view-prompt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id);
      const row = allPredictions.find(p => p.id === id);
      if (row?.raw_result?.prompt) openPromptViewer(row.raw_result.prompt, row);
    });
  });
}

function openPromptViewer(prompt, row) {
  const backdrop = document.getElementById('promptViewerBackdrop');
  if (!backdrop) return;
  document.getElementById('pvKind').textContent = prompt.kind || '—';
  document.getElementById('pvHash').textContent = prompt.prompt_hash || '—';
  document.getElementById('pvModel').textContent = row?.raw_result?.model || '—';
  document.getElementById('pvCreated').textContent = fmtTs(row?.created_ts);
  document.getElementById('pvSystem').textContent = prompt.system || '—';
  const extraEl = document.getElementById('pvExtra');
  const extras = [];
  if (prompt.user_bias_directive)  extras.push(`USER BIAS DIRECTIVE:\n${prompt.user_bias_directive}`);
  if (prompt.sub_forecast_system)  extras.push(`SUB-FORECAST SYSTEM:\n${prompt.sub_forecast_system}`);
  extraEl.textContent = extras.join('\n\n——————\n\n');
  extraEl.style.display = extras.length ? '' : 'none';
  backdrop.style.display = 'flex';
}
function closePromptViewer() { document.getElementById('promptViewerBackdrop').style.display = 'none'; }
window.closePromptViewer = closePromptViewer;

function renderPredRows(liveTs) {
  const tbody = document.getElementById('predTbody');
  const slice = allPredictions.slice(0, shownCount);
  const remaining = allPredictions.length - shownCount;

  const rowsHtml = slice.map(p => buildPredRow(p, liveTs)).join('');
  const moreBtn = remaining > 0
    ? `<tr id="loadMoreRow"><td colspan="12" style="text-align:center;padding:10px">
        <button class="adm-btn" id="loadMoreBtn">Load ${Math.min(remaining, PRED_PAGE_MORE)} more (${remaining} remaining)</button>
       </td></tr>`
    : '';

  tbody.innerHTML = rowsHtml + moreBtn;
  wirePredButtons(tbody);

  document.getElementById('loadMoreBtn')?.addEventListener('click', () => {
    shownCount = Math.min(shownCount + PRED_PAGE_MORE, allPredictions.length);
    renderPredRows(liveTs);
  });
}

async function loadPredictions() {
  const tbody = document.getElementById('predTbody');
  try {
    const liveRes = await fetch('/api/forecast-7d').then(r => r.json()).catch(() => null);
    const liveTs  = liveRes?.data?.generated_ts || liveRes?.data?.anchor_ts || null;

    const res = await fetch('/api/predictions/history?limit=200&type=ai_forecast').then(r => r.json());
    if (!res.success) { tbody.innerHTML = `<tr><td colspan="12" class="adm-loading">Error: ${escHtml(res.error)}</td></tr>`; return; }

    allPredictions = res.predictions || [];
    document.getElementById('predCount').textContent = `(${allPredictions.length})`;

    if (!allPredictions.length) { tbody.innerHTML = '<tr><td colspan="12" class="adm-loading">No predictions yet.</td></tr>'; return; }

    shownCount = PRED_PAGE_INIT;
    renderPredRows(liveTs);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="11" class="adm-loading">${escHtml(err.message)}</td></tr>`;
  }
}

// ── RUN STREAMED FORECAST (combined Sonnet or Opus max-layers) ────
function runStreamedForecast(btn, url, doneLabel) {
  const backdrop = document.getElementById('progressBackdrop');
  const fill = document.getElementById('apmFill');
  const pctEl = document.getElementById('apmPct');
  const steps = document.getElementById('apmSteps');
  const result = document.getElementById('apmResult');
  const closeBtn = document.getElementById('apmClose');

  backdrop.style.display = 'flex';
  fill.style.width = '0%';
  pctEl.textContent = '0%';
  steps.innerHTML = '';
  result.style.display = 'none';
  closeBtn.style.display = 'none';
  btn.disabled = true;

  const es = new EventSource(url);
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.error) {
      steps.innerHTML += `<div class="apm-step err">✗ ${escHtml(d.error)}</div>`;
      closeBtn.style.display = '';
      es.close();
      btn.disabled = false;
      return;
    }
    fill.style.width = d.pct + '%';
    pctEl.textContent = d.pct + '%';
    if (d.label) steps.innerHTML += `<div class="apm-step${d.done ? ' done' : ''}">${d.done ? '✓' : '…'} ${escHtml(d.label || '')}</div>`;
    if (d.done && d.result) {
      const r = d.result;
      result.style.display = '';
      result.innerHTML = `<strong>${(r.direction||'').toUpperCase()}</strong> · ${fmtPct(r.expected_move_pct)} · ${r.confidence != null ? Math.round(r.confidence*100)+'% conf' : ''}<br><span style="font-size:0.78rem;color:var(--text-dim)">${escHtml(r.headline||'')}</span>`;
      setStatus(document.getElementById('forecastStatus'), `✓ ${doneLabel} — ${(r.direction||'').toUpperCase()} ${fmtPct(r.expected_move_pct)} · Live on Watch`, 'ok');
      loadPredictions();
      closeBtn.style.display = '';
      es.close();
      btn.disabled = false;
    }
  };
  es.onerror = () => {
    steps.innerHTML += `<div class="apm-step err">✗ Connection lost</div>`;
    closeBtn.style.display = '';
    es.close();
    btn.disabled = false;
  };

  closeBtn.addEventListener('click', () => { backdrop.style.display = 'none'; }, { once: true });
}

function initRunCombined() {
  const btn = document.getElementById('runCombinedBtn');
  btn.addEventListener('click', () => {
    runStreamedForecast(btn, '/api/admin/run-combined-forecast', 'Combined done');
  });
}

function initRunOpus() {
  const btn = document.getElementById('runOpusBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!confirm('Run Opus max-layers prediction? This runs 5 independent sub-forecasts plus synthesis on Opus — slower and more expensive than Sonnet.')) return;
    runStreamedForecast(btn, '/api/admin/run-opus-forecast', 'Opus max-layers done');
  });
}

// ── BUY / HODL HISTORY ───────────────────────────────────────────
let buyHistoryRows = [];

async function loadBuyHistory() {
  const list  = document.getElementById('buyRecList');
  const count = document.getElementById('buyRecCount');
  if (!list) return;
  try {
    const res = await fetch('/api/buy-time-history').then(r => r.json());
    if (!res.success) throw new Error(res.error);
    buyHistoryRows = res.rows || [];
    if (count) count.textContent = `(${buyHistoryRows.length})`;
    if (!buyHistoryRows.length) {
      list.innerHTML = '<div class="adm-loading" style="padding:12px 0">No history yet.</div>';
      return;
    }
    list.innerHTML = buyHistoryRows.map((r, i) => {
      const v      = (r.verdict || '').toLowerCase();
      const dt     = r.ts ? new Date(r.ts).toLocaleString() : '—';
      const cf     = r.confidence != null ? Math.round(r.confidence * 100) + '%' : '';
      const isOpus = r.source === 'opus';
      const srcBadge = isOpus
        ? '<span class="buy-rec-badge opus-badge">Opus</span>'
        : '<span class="buy-rec-badge sonnet-badge">Sonnet</span>';
      const vClass = v === 'buy' ? 'verdict-buy' : v === 'sell' ? 'verdict-sell' : 'verdict-hodl';
      return `<div class="buy-rec-row" data-idx="${i}" data-ts="${r.ts}" tabindex="0" role="button">
        <span class="buy-rec-verdict ${vClass}">${v.toUpperCase()}</span>
        ${srcBadge}
        <span class="buy-rec-conf">${cf}</span>
        <span class="buy-rec-dt">${escHtml(dt)}</span>
        <span class="buy-rec-hl">${escHtml(r.headline || '—')}</span>
        <span class="buy-rec-arrow">›</span>
        <button class="buy-rec-del" data-ts="${r.ts}" title="Delete this record">✕</button>
      </div>`;
    }).join('');

    list.querySelectorAll('.buy-rec-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.buy-rec-del')) return; // handled separately
        openBuyDetail(+row.dataset.idx);
      });
      row.addEventListener('keydown', e => { if (e.key === 'Enter') openBuyDetail(+row.dataset.idx); });
    });
    list.querySelectorAll('.buy-rec-del').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); deleteBuyRecord(+btn.dataset.ts); });
    });
  } catch (err) {
    list.innerHTML = `<div class="adm-loading" style="padding:12px 0">Error: ${escHtml(err.message)}</div>`;
  }
}

async function deleteBuyRecord(ts) {
  if (!confirm('Delete this advice record?')) return;
  try {
    const res = await fetch('/api/buy-time-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts }),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error || 'Delete failed');
    await loadBuyHistory();
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

function openBuyDetail(idx) {
  const r = buyHistoryRows[idx];
  if (!r) return;
  const v = (r.verdict || '').toLowerCase();
  const vColor = v === 'buy' ? 'var(--up)' : v === 'sell' ? 'var(--down)' : 'var(--neutral)';
  const isOpus = r.source === 'opus';

  document.getElementById('bdTitle').textContent = isOpus ? '🧠 Opus Advanced Advice' : 'Sonnet Advice';
  document.getElementById('bdMeta').textContent  =
    (r.ts ? new Date(r.ts).toLocaleString() : '') +
    (r.timeframe ? ` · horizon ${r.timeframe}` : '') +
    (r.confidence != null ? ` · ${Math.round(r.confidence * 100)}% confidence` : '');

  const vEl = document.getElementById('bdVerdict');
  vEl.textContent = v.toUpperCase();
  vEl.style.color = vColor;

  document.getElementById('bdHeadline').textContent = r.headline || '';

  const macroEl = document.getElementById('bdMacro');
  if (r.macro_context) { macroEl.textContent = r.macro_context; macroEl.style.display = ''; }
  else macroEl.style.display = 'none';

  const fcRow = document.getElementById('bdFcRow');
  if (r.forecast_alignment) {
    document.getElementById('bdFcAlign').textContent = r.forecast_alignment;
    fcRow.style.display = '';
  } else fcRow.style.display = 'none';

  const renderList = (items, label) => {
    if (!items?.length) return '';
    const shown = items.slice(0, 4);
    const extra = items.length - shown.length;
    return `<div class="buy-detail-list-col">
      <div class="buy-detail-list-label">${label}</div>
      <ul>${shown.map(s => `<li>${escHtml(s)}</li>`).join('')}
        ${extra > 0 ? `<li class="buy-detail-more">+${extra} more</li>` : ''}
      </ul>
    </div>`;
  };
  document.getElementById('bdLists').innerHTML =
    renderList(r.pros,  'Pros') +
    renderList(r.cons,  'Cons') +
    renderList(r.risks, 'Risks');

  // Surface the prompt hash + "View Prompt" button in the meta line if present.
  const rawRow = buyHistoryRows[idx];
  const promptAnchor = document.getElementById('bdPromptAnchor');
  if (promptAnchor) {
    if (rawRow?.prompt?.system) {
      promptAnchor.style.display = '';
      promptAnchor.innerHTML =
        `<button class="adm-btn" id="bdViewPromptBtn" style="padding:3px 10px;font-size:0.7rem">📝 View Prompt (${escHtml(rawRow.prompt.prompt_hash || '—')})</button>`;
      document.getElementById('bdViewPromptBtn').addEventListener('click', () =>
        openPromptViewer(rawRow.prompt, { raw_result: { model: rawRow.model || null }, created_ts: rawRow.ts }),
      );
    } else {
      promptAnchor.style.display = 'none';
      promptAnchor.innerHTML = '';
    }
  }

  document.getElementById('buyDetailBackdrop').style.display = 'flex';
}

function closeBuyDetail() {
  document.getElementById('buyDetailBackdrop').style.display = 'none';
}
window.closeBuyDetail = closeBuyDetail;

// ── ADVANCED OPUS BUY ADVICE ──────────────────────────────────────
function initOpusBuyAdvice() {
  const btn    = document.getElementById('opusBuyBtn');
  const status = document.getElementById('buyAdviceStatus');
  const result = document.getElementById('opusBuyResult');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!confirm('Run Advanced Opus Buy/HODL analysis? This uses Claude Opus and 90 days of data.')) return;
    btn.disabled = true;
    setStatus(status, '⏳ Running Opus 90-day analysis…', 'running');
    if (result) result.style.display = 'none';
    try {
      const res = await fetch('/api/buy-time-advanced?force=1').then(r => r.json());
      if (!res.success) {
        if (res.code === 'NEED_OPUS_FORECAST') {
          setStatus(status, '⚠ ' + escHtml(res.error), 'err');
          if (result) {
            result.style.display = '';
            result.innerHTML = `<strong>Action required:</strong> ${escHtml(res.error)}<br><br>Scroll up to <em>Forecast Generator</em> → click <strong>🧠 Advanced Opus Prediction — Max Layers</strong>, then retry this button.`;
          }
          return;
        }
        throw new Error(res.error || 'Failed');
      }
      const d = res.data;
      const verdict = (d?.verdict || '').toUpperCase();
      const conf    = d?.confidence != null ? Math.round(d.confidence * 100) + '%' : '';
      setStatus(status, `✓ Opus · ${verdict} ${conf} · ${d?.timeframe || ''} — now live on Watch`, 'ok');
      if (result) {
        result.style.display = '';
        result.innerHTML = [
          `<strong>${verdict}</strong> — ${escHtml(d?.headline || '')}`,
          d?.macro_context      ? `<br><br><em>Macro (90d):</em> ${escHtml(d.macro_context)}`           : '',
          d?.forecast_alignment ? `<br><br><em>Forecast alignment:</em> ${escHtml(d.forecast_alignment)}` : '',
        ].join('');
      }
      loadBuyHistory(); // refresh history table
    } catch (err) {
      setStatus(status, '✗ ' + escHtml(err.message), 'err');
    } finally {
      btn.disabled = false;
    }
  });
}

// ── USER POSTS IMPORT ─────────────────────────────────────────────
function initUserPostsImport() {
  const openBtn    = document.getElementById('openUserPostsBtn');
  const backdrop   = document.getElementById('userPostsBackdrop');
  const closeBtn   = document.getElementById('userPostsClose');
  const importBtn  = document.getElementById('userPostsImportBtn');
  const textarea   = document.getElementById('userPostsJson');
  const status     = document.getElementById('userPostsStatus');
  const countsList = document.getElementById('userPostsCountsList');

  if (!openBtn) return;

  async function loadPostCounts() {
    try {
      const res = await fetch('/api/user-posts/counts').then(r => r.json());
      if (!res.success || !res.counts?.length) {
        countsList.innerHTML = '<div class="adm-loading" style="padding:8px 0">No posts imported yet.</div>';
        return;
      }
      countsList.innerHTML = res.counts.slice(0, 20).map(c =>
        `<div class="up-count-row"><span class="up-date">${escHtml(c.date)}</span><span class="up-n">${c.count} post${c.count > 1 ? 's' : ''}</span></div>`
      ).join('');
    } catch {}
  }

  openBtn.addEventListener('click', () => {
    backdrop.style.display = 'flex';
    loadPostCounts();
  });
  closeBtn.addEventListener('click', () => { backdrop.style.display = 'none'; });
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.style.display = 'none'; });

  importBtn.addEventListener('click', async () => {
    const text = (textarea?.value || '').trim();
    if (!text) { status.textContent = '✗ Paste some text first'; status.className = 'acc-status err'; return; }

    importBtn.disabled = true;
    status.className = 'acc-status running';

    // Live elapsed-seconds counter so the user sees it's not frozen.
    let seconds = 0;
    const updateMsg = () => { status.textContent = `⏳ Sonnet parsing & scoring… ${seconds}s`; };
    updateMsg();
    const tick = setInterval(() => { seconds++; updateMsg(); }, 1000);

    // Client-side timeout (3 min) so a stuck fetch doesn't hang forever.
    const ctrl = new AbortController();
    const abortTimer = setTimeout(() => ctrl.abort(), 3 * 60 * 1000);

    try {
      const res = await fetch('/api/user-posts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: ctrl.signal,
      }).then(r => r.json());
      if (!res.success) throw new Error(res.error || 'Import failed');
      if (!res.imported) {
        const dbgStr = res.debug ? ` [${JSON.stringify(res.debug)}]` : '';
        status.textContent = 'ℹ ' + (res.note || 'No posts imported.') + dbgStr;
        status.className = 'acc-status err';
        console.warn('User posts import returned 0:', res);
      } else {
        const mode = res.debug?.mode === 'json' ? 'JSON fast-path' : 'prose extraction';
        status.textContent = `✓ Imported ${res.imported} post${res.imported > 1 ? 's' : ''} via ${mode} in ${seconds}s`;
        status.className = 'acc-status ok';
        textarea.value = '';
      }
      loadPostCounts();
      loadPostsStats();
    } catch (err) {
      if (err.name === 'AbortError') {
        status.textContent = '✗ Request aborted after 3 min — try fewer posts or check server logs';
      } else {
        status.textContent = '✗ ' + escHtml(err.message);
      }
      status.className = 'acc-status err';
    } finally {
      clearInterval(tick);
      clearTimeout(abortTimer);
      importBtn.disabled = false;
    }
  });

  // ── Reddit RSS pull ─────────────────────────────────────────────
  const redditBtn    = document.getElementById('redditPullBtn');
  const redditFeeds  = document.getElementById('redditFeedsList');
  const redditStatus = document.getElementById('redditPullStatus');
  const redditList   = document.getElementById('redditFeedResults');

  if (redditBtn) {
    redditBtn.addEventListener('click', async () => {
      const feeds = (redditFeeds?.value || '')
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean);

      redditBtn.disabled = true;
      redditStatus.className = 'acc-status running';
      redditList.innerHTML = '';
      let seconds = 0;
      const updateMsg = () => { redditStatus.textContent = `⏳ Fetching feeds & scoring… ${seconds}s`; };
      updateMsg();
      const tick = setInterval(() => { seconds++; updateMsg(); }, 1000);

      const ctrl = new AbortController();
      const abortTimer = setTimeout(() => ctrl.abort(), 4 * 60 * 1000);

      try {
        const res = await fetch('/api/user-posts/fetch-reddit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feeds }),
          signal: ctrl.signal,
        }).then(r => r.json());

        if (!res.success) throw new Error(res.error || 'Reddit pull failed');

        if (Array.isArray(res.feeds)) {
          redditList.innerHTML = res.feeds.map(f => {
            const label = escHtml(f.url.replace(/^https?:\/\/www\.reddit\.com/, ''));
            if (f.ok) return `<div>✓ <strong>${label}</strong> — ${f.fetched} item${f.fetched === 1 ? '' : 's'}</div>`;
            const code = f.http_status ? ` [${f.http_status}]` : '';
            return `<div style="color:var(--red,#f77)">✗ <strong>${label}</strong>${code} — ${escHtml(f.error || 'failed')}</div>`;
          }).join('');
        }

        if (!res.imported) {
          redditStatus.textContent = 'ℹ ' + (res.note || `Fetched ${res.fetched || 0}, imported 0.`);
          redditStatus.className = 'acc-status err';
        } else {
          redditStatus.textContent = `✓ Imported ${res.imported} of ${res.fetched} fetched in ${seconds}s`;
          redditStatus.className = 'acc-status ok';
        }
        loadPostCounts();
      loadPostsStats();
      } catch (err) {
        if (err.name === 'AbortError') {
          redditStatus.textContent = '✗ Request aborted after 4 min';
        } else {
          redditStatus.textContent = '✗ ' + escHtml(err.message);
        }
        redditStatus.className = 'acc-status err';
      } finally {
        clearInterval(tick);
        clearTimeout(abortTimer);
        redditBtn.disabled = false;
      }
    });
  }
}

// ── INIT ──────────────────────────────────────────────────────────
function init() {
  initPeriodPicker();
  initRunForecast();
  initRefreshBuyAdvice();
  initOpusBuyAdvice();
  initRescore();
  initManualPrediction();
  initRunCombined();
  initRunOpus();
  initUserPostsImport();
  initPostsStats();
  initMasterPredict();
  loadStats(30);
  loadPostsStats();
  loadPredictions();
  loadBuyHistory();
}

// ── MASTER PREDICT ───────────────────────────────────────────────
function mdToHtml(md) {
  if (!md) return '';
  let s = escHtml(md);
  // Code
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headings
  s = s.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^## (.+)$/gm,  '<h2>$1</h2>');
  s = s.replace(/^# (.+)$/gm,   '<h1>$1</h1>');
  // Bold + italic
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  // Bullets
  s = s.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>' + m.replace(/\n+/g, '') + '</ul>');
  // Paragraphs: wrap non-tag lines
  s = s.split(/\n{2,}/).map(chunk => {
    if (/^<(h\d|ul|ol|li|pre|blockquote)/.test(chunk.trim())) return chunk;
    return '<p>' + chunk.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');
  return s;
}

function renderMasterReport(report) {
  if (!report) return '<em>No report yet.</em>';
  const verdict = (report.today_verdict || '—').toUpperCase();
  const bias    = (report.today_bias || '—').toLowerCase();
  const conf    = report.confidence != null ? Math.round(report.confidence * 100) + '%' : '—';
  const price   = report.current_eth_price_usd != null ? '$' + Math.round(report.current_eth_price_usd).toLocaleString() : '—';
  const biasCls = bias === 'bullish' ? 'up' : bias === 'bearish' ? 'down' : 'warn';
  const vCls    = verdict === 'BUY' ? 'up' : verdict === 'SELL' ? 'down' : 'warn';

  const strip = `
    <div class="mr-verdict-strip">
      <div class="mr-verdict-item"><div class="mr-verdict-label">Verdict</div><div class="mr-verdict-value ${vCls}">${escHtml(verdict)}</div></div>
      <div class="mr-verdict-item"><div class="mr-verdict-label">Bias</div><div class="mr-verdict-value ${biasCls}">${escHtml(bias.toUpperCase())}</div></div>
      <div class="mr-verdict-item"><div class="mr-verdict-label">Confidence</div><div class="mr-verdict-value">${conf}</div></div>
      <div class="mr-verdict-item"><div class="mr-verdict-label">Timeframe</div><div class="mr-verdict-value">${escHtml(report.timeframe || '—')}</div></div>
      <div class="mr-verdict-item"><div class="mr-verdict-label">ETH Price</div><div class="mr-verdict-value">${price}</div></div>
      <div class="mr-verdict-item"><div class="mr-verdict-label">Uses Opus Forecast</div><div class="mr-verdict-value ${report.has_opus_forecast ? 'up' : 'down'}">${report.has_opus_forecast ? 'YES' : 'NO'}</div></div>
      <div class="mr-verdict-item"><div class="mr-verdict-label">Uses Opus Advice</div><div class="mr-verdict-value ${report.has_opus_buy_advice ? 'up' : 'down'}">${report.has_opus_buy_advice ? 'YES' : 'NO'}</div></div>
    </div>`;

  const headline = report.headline ? `<h2 style="margin-top:0">${escHtml(report.headline)}</h2>` : '';
  const feeling = report.today_feeling
    ? `<div class="mr-feeling"><div class="mr-section-head">Today's Feeling</div>${escHtml(report.today_feeling)}</div>` : '';
  const summary = report.executive_summary
    ? `<div style="margin:10px 0"><div class="mr-section-head">Executive Summary</div>${escHtml(report.executive_summary)}</div>` : '';

  const kdp = Array.isArray(report.key_data_points) && report.key_data_points.length
    ? `<div class="mr-section-head" style="margin-top:14px">Key Data Points</div>
       <div class="mr-kdp-grid">
         ${report.key_data_points.map(d => `
           <div class="mr-kdp">
             <div class="mr-kdp-label">${escHtml(d.label || '')}</div>
             <div class="mr-kdp-val">${escHtml(d.value || '')}</div>
             <div class="mr-kdp-note">${escHtml(d.interpretation || '')}</div>
           </div>`).join('')}
       </div>` : '';

  const sa = report.sentiment_analysis || {};
  const sentiment = (sa.retail_mood || sa.macro_climate) ? `
    <h2>Sentiment Analysis</h2>
    ${sa.retail_mood   ? `<p><strong>Retail mood:</strong> ${escHtml(sa.retail_mood)}</p>`     : ''}
    ${sa.macro_climate ? `<p><strong>Macro climate:</strong> ${escHtml(sa.macro_climate)}</p>` : ''}
    ${sa.hope_momentum ? `<p><strong>Hope momentum:</strong> ${escHtml(sa.hope_momentum)}</p>` : ''}
    ${sa.war_risk      ? `<p><strong>War risk:</strong> ${escHtml(sa.war_risk)}</p>`           : ''}
  ` : '';

  const technical = report.technical_analysis ? `
    <h2>Technical Analysis</h2>
    <p>${escHtml(report.technical_analysis)}</p>` : '';

  const forecastAlign = report.forecast_alignment ? `
    <h2>Alignment with Opus 7-Day Forecast</h2>
    <p>${escHtml(report.forecast_alignment)}</p>` : '';

  const buyAlign = report.buy_advice_alignment ? `
    <h2>Alignment with Opus Buy/HODL Advice</h2>
    <p>${escHtml(report.buy_advice_alignment)}</p>` : '';

  const contradictions = Array.isArray(report.critical_contradictions) && report.critical_contradictions.length ? `
    <div class="mr-contradictions">
      <div class="mr-section-head">Critical Contradictions</div>
      <ul>${report.critical_contradictions.map(c => `<li>${escHtml(c)}</li>`).join('')}</ul>
    </div>` : '';

  const iv = report.invalidation_levels || {};
  const invalidation = (iv.eth_price_level || iv.eth_btc_ratio || iv.break_speed_note) ? `
    <div class="mr-invalid-box">
      <div class="mr-section-head">Invalidation Levels</div>
      ${iv.eth_price_level  ? `<p><strong>ETH price:</strong> ${escHtml(iv.eth_price_level)}</p>` : ''}
      ${iv.eth_btc_ratio    ? `<p><strong>ETH/BTC:</strong> ${escHtml(iv.eth_btc_ratio)}</p>`     : ''}
      ${iv.break_speed_note ? `<p><strong>Break speed:</strong> ${escHtml(iv.break_speed_note)}</p>` : ''}
    </div>` : '';

  const flip = Array.isArray(report.what_could_flip_this) && report.what_could_flip_this.length ? `
    <h3>What Could Flip This</h3>
    <ul>${report.what_could_flip_this.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>` : '';

  const ap = report.action_plan || {};
  const actionPlan = ap.primary_action ? `
    <div class="mr-action-box">
      <div class="mr-section-head">Action Plan</div>
      <p><strong>Primary action:</strong> ${escHtml(ap.primary_action)}</p>
      ${ap.if_bullish_confirms ? `<p><strong>If bullish confirms:</strong> ${escHtml(ap.if_bullish_confirms)}</p>` : ''}
      ${ap.if_bearish_triggers ? `<p><strong>If bearish triggers:</strong> ${escHtml(ap.if_bearish_triggers)}</p>` : ''}
    </div>` : '';

  const narrative = report.report_markdown ? `
    <h2>Full Master Report</h2>
    <div>${mdToHtml(report.report_markdown)}</div>` : '';

  const cd = report.context_digest;
  const dataUsed = cd ? `
    <h2>Data Used for This Prediction</h2>
    <div class="mr-kdp-grid">
      <div class="mr-kdp"><div class="mr-kdp-label">Daily Sentiment Rows</div><div class="mr-kdp-val">${cd.daily_90d_count ?? '—'}</div><div class="mr-kdp-note">${cd.daily_90d_date_range ? cd.daily_90d_date_range.from + ' → ' + cd.daily_90d_date_range.to : ''}</div></div>
      <div class="mr-kdp"><div class="mr-kdp-label">Headlines Used</div><div class="mr-kdp-val">${cd.recent_headlines_count ?? '—'}</div><div class="mr-kdp-note">${cd.recent_headlines_date_range ? cd.recent_headlines_date_range.from + ' → ' + cd.recent_headlines_date_range.to : ''}</div></div>
      <div class="mr-kdp"><div class="mr-kdp-label">User Posts</div><div class="mr-kdp-val">${cd.user_posts_count ?? 0}</div><div class="mr-kdp-note">${Object.entries(cd.user_posts_source_breakdown || {}).map(([k,v]) => `${escHtml(k)}:${v}`).join(' · ') || '—'}</div></div>
      <div class="mr-kdp"><div class="mr-kdp-label">Opus 7d Forecast</div><div class="mr-kdp-val ${cd.latest_opus_forecast_summary ? 'up' : 'down'}">${cd.latest_opus_forecast_summary ? (cd.latest_opus_forecast_summary.direction || '').toUpperCase() : 'NONE'}</div><div class="mr-kdp-note">${cd.latest_opus_forecast_summary?.generated_ts ? new Date(cd.latest_opus_forecast_summary.generated_ts).toLocaleString() : ''}</div></div>
      <div class="mr-kdp"><div class="mr-kdp-label">Opus Buy Advice</div><div class="mr-kdp-val ${cd.latest_opus_buy_advice_summary ? 'up' : 'down'}">${cd.latest_opus_buy_advice_summary ? (cd.latest_opus_buy_advice_summary.verdict || '').toUpperCase() : 'NONE'}</div><div class="mr-kdp-note">${cd.latest_opus_buy_advice_summary?.generated_ts ? new Date(cd.latest_opus_buy_advice_summary.generated_ts).toLocaleString() : ''}</div></div>
      <div class="mr-kdp"><div class="mr-kdp-label">Hope 7d / 30d</div><div class="mr-kdp-val">${cd.sentiment_aggregates?.hope_7d_avg ?? '—'} / ${cd.sentiment_aggregates?.hope_30d_avg ?? '—'}</div><div class="mr-kdp-note">Momentum: ${cd.sentiment_aggregates?.hope_momentum ?? '—'}</div></div>
      <div class="mr-kdp"><div class="mr-kdp-label">Macro 7d / 30d</div><div class="mr-kdp-val">${cd.sentiment_aggregates?.macro_7d_avg ?? '—'} / ${cd.sentiment_aggregates?.macro_30d_avg ?? '—'}</div><div class="mr-kdp-note">War days (14d): ${cd.sentiment_aggregates?.war_days_14d ?? '—'}</div></div>
    </div>
    <p style="font-size:0.72rem;color:var(--text-dim);margin-top:8px">
      <strong>Prompt:</strong> <code>${escHtml(report.prompt?.kind || '')}</code> · hash <code>${escHtml(report.prompt?.prompt_hash || '')}</code> · generated ${report.generated_date || ''}
      ${report.response_meta?.usage ? ` · tokens in: ${report.response_meta.usage.input_tokens ?? '—'}, out: ${report.response_meta.usage.output_tokens ?? '—'}` : ''}
    </p>` : '';

  return strip + headline + feeling + summary + kdp + sentiment + technical +
         forecastAlign + buyAlign + contradictions + invalidation + flip + actionPlan + narrative + dataUsed;
}

let _currentMasterReport = null;

function openMasterReport(report, subtitle) {
  const backdrop = document.getElementById('masterReportBackdrop');
  const title    = document.getElementById('mrTitle');
  const sub      = document.getElementById('mrSub');
  const body     = document.getElementById('masterReportBody');
  if (!backdrop || !body) return;
  _currentMasterReport = report;
  title.textContent = '🎯 Master Prediction Report';
  const ts = report?.generated_ts ? new Date(report.generated_ts).toLocaleString() : '';
  sub.textContent = subtitle || `${report?.model || 'opus'} · ${ts}${report?.prompt?.prompt_hash ? ' · ' + report.prompt.prompt_hash : ''}`;
  body.innerHTML = renderMasterReport(report);
  document.getElementById('masterReportJsonPane').style.display = 'none';
  backdrop.style.display = 'flex';
  body.scrollTop = 0;
}

function initMasterPredict() {
  const btn     = document.getElementById('masterPredictBtn');
  const status  = document.getElementById('masterPredictStatus');
  const viewBtn = document.getElementById('viewLastMasterBtn');
  const closeBtn = document.getElementById('masterReportClose');

  if (closeBtn) closeBtn.addEventListener('click', () => {
    document.getElementById('masterReportBackdrop').style.display = 'none';
  });

  const copyBtn     = document.getElementById('masterReportCopyJson');
  const dlBtn       = document.getElementById('masterReportDownloadJson');
  const viewBtnJson = document.getElementById('masterReportViewJson');
  const jsonPane    = document.getElementById('masterReportJsonPane');
  const jsonText    = document.getElementById('masterReportJsonText');
  const jsonCloseBtn = document.getElementById('masterReportJsonClose');

  const getJsonStr = () => _currentMasterReport ? JSON.stringify(_currentMasterReport, null, 2) : '';

  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const text = getJsonStr();
    if (!text) return;
    const orig = copyBtn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = '✓ Copied';
    } catch {
      // Fallback: open the JSON pane + select the text so the user can copy manually
      jsonPane.style.display = 'block';
      jsonText.value = text;
      jsonText.focus(); jsonText.select();
      copyBtn.textContent = '⚠ Select+Copy';
    }
    setTimeout(() => { copyBtn.textContent = orig; }, 1800);
  });

  if (dlBtn) dlBtn.addEventListener('click', () => {
    const text = getJsonStr();
    if (!text) return;
    const date = _currentMasterReport?.generated_date || new Date().toISOString().slice(0, 10);
    const blob = new Blob([text], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `master-report-${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  if (viewBtnJson) viewBtnJson.addEventListener('click', () => {
    const show = jsonPane.style.display === 'none';
    if (show) { jsonText.value = getJsonStr(); jsonPane.style.display = 'block'; jsonText.focus(); jsonText.select(); }
    else jsonPane.style.display = 'none';
  });
  if (jsonCloseBtn) jsonCloseBtn.addEventListener('click', () => { jsonPane.style.display = 'none'; });

  if (viewBtn) viewBtn.addEventListener('click', async () => {
    try {
      const r = await fetch('/api/admin/master-predict/latest');
      if (r.status === 404) throw new Error('Endpoint missing — restart server');
      const text = await r.text();
      let res;
      try { res = JSON.parse(text); }
      catch { throw new Error(`Non-JSON (${r.status}) — restart server`); }
      if (!res.success) throw new Error(res.error || 'Failed');
      if (!res.reports?.length) { window.alert?.('No master reports saved yet — run one first.'); return; }
      openMasterReport(res.reports[0].raw_result);
    } catch (err) {
      setStatus(status, '✗ ' + err.message, 'err');
    }
  });

  if (!btn) return;
  btn.addEventListener('click', () => {
    if (!confirm('Run MASTER PREDICT? This calls Claude Opus with the full dataset (sentiment, headlines, vitals, flows, user posts, latest Opus forecast + advice). Opus at 6k tokens typically takes 2-5 minutes.')) return;
    btn.disabled = true;

    // SSE stream — avoids any client/proxy timeout on multi-minute Opus runs.
    // Server sends {tick,elapsed_sec} every 10s, then final {done,data} or {error}.
    let tickerSec = 0;
    const localTicker = setInterval(() => {
      tickerSec++;
      setStatus(status, `⏳ Opus synthesizing full report… ${tickerSec}s`, 'running');
    }, 1000);
    setStatus(status, '⏳ Opus synthesizing full report… 0s', 'running');

    const es = new EventSource('/api/admin/master-predict-stream');
    let finished = false;
    const cleanup = () => {
      clearInterval(localTicker);
      es.close();
      btn.disabled = false;
    };

    es.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.error) {
        finished = true;
        setStatus(status, '✗ ' + msg.error, 'err');
        cleanup();
        return;
      }
      if (msg.tick) {
        // Prefer server's elapsed counter (monotonic, survives tab sleep).
        if (typeof msg.elapsed_sec === 'number') tickerSec = msg.elapsed_sec;
        return;
      }
      if (msg.done && msg.data) {
        finished = true;
        setStatus(status, `✓ Master report ready · ${msg.elapsed_sec ?? tickerSec}s`, 'ok');
        openMasterReport(msg.data);
        loadPredictions();
        cleanup();
      }
    };

    es.onerror = () => {
      if (finished) return; // normal close after 'done'
      setStatus(status, '✗ Stream connection error (server restart?)', 'err');
      cleanup();
    };
  });
}

// ── POSTS & FEEDS STATS ───────────────────────────────────────────
function initPostsStats() {
  const btn = document.getElementById('refreshPostsStatsBtn');
  if (btn) btn.addEventListener('click', loadPostsStats);
}

function renderPostsStatsCol(el, stats, isWeek) {
  const fmt = (v, sfx = '') => (v == null ? '—' : v + sfx);
  const fmtPctLocal = (v) => (v == null ? '—' : (v >= 0 ? '+' : '') + v + '%');

  const sentiment  = stats.sentiment || {};
  const flow       = stats.flow || {};
  const daily      = stats.daily_sentiment || {};
  const headlines  = stats.headlines || {};
  const sources    = stats.top_sources || [];

  const ratioCls = stats.bull_bear_ratio == null ? ''
    : (stats.bull_bear_ratio > 0.55 ? 'up' : stats.bull_bear_ratio < 0.45 ? 'down' : '');
  const flowCls  = flow.net_pressure === 'buy' ? 'up' : flow.net_pressure === 'sell' ? 'down' : '';
  const hopeCls  = stats.hope_avg == null ? '' : stats.hope_avg >= 55 ? 'up' : stats.hope_avg <= 40 ? 'down' : '';
  const warCls   = stats.war_avg  == null ? '' : stats.war_avg >= 55 ? 'down' : stats.war_avg <= 30 ? 'up' : '';

  const macroVal = isWeek ? daily.macro_score : daily.macro_score;
  const hopeDailyVal = isWeek ? daily.hope_score : daily.hope_score;
  const macroCls = macroVal == null ? '' : macroVal >= 20 ? 'up' : macroVal <= -20 ? 'down' : '';

  const html = `
    <div class="pst-metric-row">
      <div class="pst-metric">
        <div class="pst-metric-label">POSTS IMPORTED</div>
        <div class="pst-metric-val">${fmt(stats.post_count)}</div>
        <div class="pst-metric-sub">${sources.length} source${sources.length === 1 ? '' : 's'}</div>
      </div>
      <div class="pst-metric">
        <div class="pst-metric-label">AVG HOPE (posts)</div>
        <div class="pst-metric-val ${hopeCls}">${fmt(stats.hope_avg)}</div>
        <div class="pst-metric-sub">0 bleak · 100 euphoric</div>
      </div>
      <div class="pst-metric">
        <div class="pst-metric-label">AVG WAR (posts)</div>
        <div class="pst-metric-val ${warCls}">${fmt(stats.war_avg)}</div>
        <div class="pst-metric-sub">0 calm · 100 panic</div>
      </div>
      <div class="pst-metric">
        <div class="pst-metric-label">BULL / BEAR RATIO</div>
        <div class="pst-metric-val ${ratioCls}">${stats.bull_bear_ratio == null ? '—' : stats.bull_bear_ratio}</div>
        <div class="pst-metric-sub"><span class="pst-bull">${sentiment.bullish || 0}↑</span> · <span class="pst-bear">${sentiment.bearish || 0}↓</span> · ${sentiment.neutral || 0}=</div>
      </div>
    </div>

    <div class="pst-section-title">Daily Sentiment (NewsAPI-scored)</div>
    <div class="pst-metric-row">
      <div class="pst-metric">
        <div class="pst-metric-label">${isWeek ? 'AVG HOPE 7D' : 'HOPE TODAY'}</div>
        <div class="pst-metric-val">${fmt(hopeDailyVal)}</div>
      </div>
      <div class="pst-metric">
        <div class="pst-metric-label">${isWeek ? 'AVG MACRO 7D' : 'MACRO TODAY'}</div>
        <div class="pst-metric-val ${macroCls}">${fmt(macroVal)}</div>
      </div>
      <div class="pst-metric">
        <div class="pst-metric-label">${isWeek ? 'VERDICT MIX' : 'VERDICT'}</div>
        <div class="pst-metric-val">${isWeek
          ? `<span class="pst-bull">${daily.bullish_days || 0}↑</span> <span class="pst-bear">${daily.bearish_days || 0}↓</span> ${daily.neutral_days || 0}=`
          : escHtml((daily.verdict || '—').toUpperCase())}</div>
        ${!isWeek && daily.eth_move_pct != null ? `<div class="pst-metric-sub">ETH ${fmtPctLocal(daily.eth_move_pct.toFixed(2))}</div>` : ''}
      </div>
      <div class="pst-metric">
        <div class="pst-metric-label">HEADLINES</div>
        <div class="pst-metric-val">${(headlines.crypto || 0) + (headlines.macro || 0) + (headlines.hope || 0)}</div>
        <div class="pst-metric-sub">C:${headlines.crypto || 0} · M:${headlines.macro || 0} · H:${headlines.hope || 0}</div>
      </div>
    </div>

    <div class="pst-section-title">Order Flow (${isWeek ? 'last 7d' : 'last 24h'})</div>
    <div class="pst-metric-row">
      <div class="pst-metric">
        <div class="pst-metric-label">BUY VOL (ETH)</div>
        <div class="pst-metric-val up">${fmt(flow.buy_vol)}</div>
        <div class="pst-metric-sub">${flow.buy_count || 0} trades</div>
      </div>
      <div class="pst-metric">
        <div class="pst-metric-label">SELL VOL (ETH)</div>
        <div class="pst-metric-val down">${fmt(flow.sell_vol)}</div>
        <div class="pst-metric-sub">${flow.sell_count || 0} trades</div>
      </div>
      <div class="pst-metric">
        <div class="pst-metric-label">BUY SHARE</div>
        <div class="pst-metric-val ${flowCls}">${flow.ratio == null ? '—' : (flow.ratio * 100).toFixed(1) + '%'}</div>
        <div class="pst-metric-sub">${flow.net_pressure ? flow.net_pressure.toUpperCase() + ' dominant' : '—'}</div>
      </div>
    </div>

    ${sources.length ? `
    <div class="pst-section-title">Top Post Sources</div>
    <div class="pst-tags">
      ${sources.map(s => `<span class="pst-tag">${escHtml(s.name)}<span class="pst-tag-count">${s.count}</span></span>`).join('')}
    </div>` : ''}
  `;
  el.innerHTML = html;
}

async function loadPostsStats() {
  const todayEl = document.querySelector('#pstCol-today .pst-body');
  const weekEl  = document.querySelector('#pstCol-week  .pst-body');
  if (!todayEl || !weekEl) return;
  todayEl.innerHTML = '<div class="adm-loading">Loading…</div>';
  weekEl.innerHTML  = '<div class="adm-loading">Loading…</div>';
  try {
    const r = await fetch('/api/admin/posts-stats');
    if (r.status === 404) throw new Error('Endpoint missing — restart server to load new code');
    const text = await r.text();
    let res;
    try { res = JSON.parse(text); }
    catch { throw new Error(`Non-JSON response (${r.status}) — server may need restart`); }
    if (!res.success) throw new Error(res.error || 'Failed');
    renderPostsStatsCol(todayEl, res.today   || {}, false);
    renderPostsStatsCol(weekEl,  res.last_7d || {}, true);
  } catch (err) {
    todayEl.innerHTML = `<div class="acc-status err">✗ ${escHtml(err.message)}</div>`;
    weekEl.innerHTML  = '';
  }
}

document.addEventListener('DOMContentLoaded', init);
