/* ═══════════════════════════════════════════════════════════
   ETHWATCH — News Feed + AI Sentiment Module
   ═══════════════════════════════════════════════════════════ */

'use strict';

let cachedNews = [];

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function escapeNews(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Build one lap of marquee content: headlines interleaved with a live
// ETH price ticker every few items.
function buildMarqueeItems(items) {
  const out = [];
  const every = 5;
  items.slice(0, 40).forEach((item, i) => {
    out.push(`<a class="mq-item" href="${escapeNews(item.link)}" target="_blank" rel="noopener">
      <span class="mq-src">${escapeNews(item.source)}</span>
      <span class="mq-dot">●</span>
      <span class="mq-title">${escapeNews(item.title)}</span>
      <span class="mq-time">${timeAgo(item.pubDate)}</span>
    </a>`);
    if ((i + 1) % every === 0) out.push(renderPriceTicker());
  });
  return out.join('<span class="mq-sep">·</span>');
}

function renderPriceTicker() {
  const cur = window.activeCurrency || 'usd';
  const price = window.state?.currentPrice?.[cur];
  const change = window.state?.currentPrice?.[`${cur}_24h_change`];
  const sym = cur === 'eur' ? '€' : '$';
  if (price == null) return '<span class="mq-live">ETH live…</span>';
  const chgCls = change == null ? '' : change >= 0 ? 'up' : 'down';
  const chgStr = change == null ? '' : ` (${change >= 0 ? '+' : ''}${change.toFixed(2)}%)`;
  return `<span class="mq-live ${chgCls}">● ETH ${sym}${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}<span class="mq-live-chg">${chgStr}</span></span>`;
}

function paintMarquee(items) {
  const a = document.getElementById('marqueeTrackA');
  const b = document.getElementById('marqueeTrackB');
  if (a && b) {
    if (!items?.length) {
      a.innerHTML = b.innerHTML = '<span class="mq-item">Loading news…</span>';
    } else {
      const html = buildMarqueeItems(items);
      a.innerHTML = html;
      b.innerHTML = html;
      [a, b].forEach(t => {
        t.style.animation = 'none';
        // eslint-disable-next-line no-unused-expressions
        t.offsetWidth;
        t.style.animation = '';
      });
    }
  }
  // Also paint the floating popup body.
  paintNewsPopup(items);
}

function paintNewsPopup(items) {
  const body = document.getElementById('newsPopupBody');
  if (!body) return;
  if (!items?.length) {
    body.innerHTML = '<div class="news-popup-loading">No news available.</div>';
    return;
  }
  body.innerHTML = items.slice(0, 60).map(item => `
    <a class="np-item" href="${escapeNews(item.link)}" target="_blank" rel="noopener">
      <div class="np-item-row1">
        <span class="np-src">${escapeNews(item.source)}</span>
        <span class="np-time">${timeAgo(item.pubDate)}</span>
      </div>
      <div class="np-title">${escapeNews(item.title)}</div>
    </a>
  `).join('');
  const dot = document.getElementById('newsFabDot');
  if (dot) dot.style.display = '';
}

function renderNewsGrid(items) { /* legacy no-op: the grid is hidden now */ paintMarquee(items); }

async function loadNews() {
  try {
    const res  = await fetch('/api/news');
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    cachedNews = json.items || [];
    renderNewsGrid(cachedNews);

    const sourcesEl = document.getElementById('newsSourcesLabel');
    if (sourcesEl) {
      const sources = [...new Set(cachedNews.map(n => n.source))];
      sourcesEl.textContent = `${cachedNews.length} stories · ${sources.length} sources`;
    }
  } catch (err) {
    const grid = document.getElementById('newsGrid');
    if (grid) grid.innerHTML = `<div class="news-empty">News unavailable: ${err.message}</div>`;
  }
}

function renderAISummary(data) {
  const el = document.getElementById('aiSummaryContent');
  if (!el) return;

  const sentClass = data.sentiment === 'Bullish' ? 'up' : data.sentiment === 'Bearish' ? 'down' : 'neutral-text';
  const sentIcon  = data.sentiment === 'Bullish' ? '▲' : data.sentiment === 'Bearish' ? '▼' : '→';

  el.innerHTML = `
    <div class="ai-sentiment-row">
      <div class="ai-sentiment ${sentClass}">
        <span class="ai-sent-icon">${sentIcon}</span>
        <span>${data.sentiment}</span>
      </div>
      <div class="ai-confidence">Confidence: ${data.confidence || '—'}</div>
      ${data.newsCount ? `<div class="ai-news-count">Based on ${data.newsCount} articles (24h)</div>` : ''}
    </div>
    ${data.themes?.length ? `
      <div class="ai-themes">
        ${data.themes.map(t => `<div class="ai-theme">• ${t}</div>`).join('')}
      </div>` : ''}
    ${data.topHeadline ? `
      <div class="ai-top-headline">
        <span class="ai-label">Key headline:</span> ${data.topHeadline}
      </div>` : ''}
    ${data.summary ? `<div class="ai-summary-text">${data.summary}</div>` : ''}
    <div class="ai-generated-at">Generated ${data.generatedAt ? timeAgo(data.generatedAt) : 'now'}${data.cached ? ' (cached)' : ''}</div>
  `;
}

async function runAISummary() {
  const panel = document.getElementById('aiSummaryPanel');
  const btn   = document.getElementById('aiAnalyzeBtn');
  if (!panel) return;

  panel.style.display = '';
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  btn.disabled = true;
  btn.textContent = '⏳ Analyzing…';

  document.getElementById('aiSummaryContent').innerHTML =
    '<div class="ai-loading"><div class="spinner"></div> Analyzing news…</div>';

  try {
    const res  = await fetch('/api/news/ai-summary', { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || json.detail);
    renderAISummary(json);
  } catch (err) {
    document.getElementById('aiSummaryContent').innerHTML =
      `<div class="news-empty">Analysis failed: ${err.message}.<br>Make sure ANTHROPIC_API_KEY is set as an environment variable.</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '🤖 Analyze';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadNews();
  // Refresh news every 5 minutes
  setInterval(loadNews, 300000);
  // Repaint the marquee (with fresh price ticker) every 30s — matches the
  // price poll cadence so the inline price chip always shows the latest.
  setInterval(() => { if (cachedNews.length) paintMarquee(cachedNews); }, 30000);

  document.getElementById('aiAnalyzeBtn')?.addEventListener('click', runAISummary);
  document.getElementById('newsPopupAiBtn')?.addEventListener('click', runAISummary);
  document.getElementById('closeAiSummary')?.addEventListener('click', () => {
    document.getElementById('aiSummaryPanel').style.display = 'none';
  });

  // Floating news popup toggle
  const fab = document.getElementById('newsFabBtn');
  const popup = document.getElementById('newsPopup');
  const closeBtn = document.getElementById('newsPopupClose');
  const openPopup = () => {
    if (!popup) return;
    popup.style.display = '';
    popup.setAttribute('aria-hidden', 'false');
    const dot = document.getElementById('newsFabDot');
    if (dot) dot.style.display = 'none';
  };
  const closePopup = () => {
    if (!popup) return;
    popup.style.display = 'none';
    popup.setAttribute('aria-hidden', 'true');
  };
  fab?.addEventListener('click', () => {
    if (popup?.style.display === 'none') openPopup();
    else closePopup();
  });
  closeBtn?.addEventListener('click', closePopup);
});
