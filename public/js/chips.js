/* ═══════════════════════════════════════════════════════════
   ETHWATCH — Chip Info Popups + Drag-and-Drop Layout
   Click any [data-chip-key] chip → floating explanation popup.
   Drag chips within or between zones → layout saved to localStorage.
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ── Explanation dictionary ───────────────────────────────────────
const CHIP_INFO = {
  'mkt-cap': {
    title: 'Market Capitalization',
    body: 'Total value of all ETH in circulation: supply × current price. A larger market cap means more stability but slower percentage gains. ETH is typically #2 by market cap globally.',
  },
  '24h-vol': {
    title: '24-Hour Trading Volume',
    body: 'Total ETH traded across all exchanges in the last 24 hours. High volume confirms a price move is real. A big pump on low volume is usually a weak signal.',
  },
  '7d-change': {
    title: '7-Day Price Change',
    body: 'ETH price change over the past 7 days. Filters out daily noise and shows the weekly trend direction. Useful for spotting momentum shifts early.',
  },
  'last-buy': {
    title: 'Last Buy Trade',
    body: 'Price and size of the most recent buyer-initiated trade on Binance. A large buy at market price signals aggressive buyer demand — someone was willing to lift the ask.',
  },
  'last-sell': {
    title: 'Last Sell Trade',
    body: 'Price and size of the most recent seller-initiated trade on Binance. A large sell hitting the bid signals selling pressure — someone needed out fast.',
  },
  'eth-s-buy': {
    title: 'Buy Rate (ETH/second)',
    body: 'ETH volume being bought per second, averaged over the last 10 seconds. A rising rate means buy flow is accelerating. Watch this vs the sell rate for short-term momentum.',
  },
  'eth-s-sell': {
    title: 'Sell Rate (ETH/second)',
    body: 'ETH volume being sold per second, averaged over the last 10 seconds. When this consistently exceeds the buy rate, short-term downward pressure builds.',
  },
  'flow-buy': {
    title: 'Buy Volume (Window)',
    body: 'Total ETH bought in the selected time window (5M / 1H / 24H). Compare against the sell volume to read order flow direction. Buyers dominating → bullish pressure.',
  },
  'flow-sell': {
    title: 'Sell Volume (Window)',
    body: 'Total ETH sold in the selected time window (5M / 1H / 24H). When sellers dominate the window, short-term price faces downward pressure.',
  },
  '30d-change': {
    title: '30-Day Price Change',
    body: 'ETH price change over the past 30 days. Shows medium-term trend strength. Strong positive 30d while 7d is flat often means consolidation after a rally.',
  },
  'ath': {
    title: 'All-Time High',
    body: "The highest price ETH has ever traded. Current price vs ATH shows how far we are from peak euphoria. Values close to ATH suggest resistance overhead; far below ATH = potential for major upside.",
  },
  'rank': {
    title: 'Market Cap Rank',
    body: "ETH's position among all cryptocurrencies by market cap. Rank #2 = second largest network after Bitcoin. A rising rank means ETH is outgrowing other crypto assets.",
  },
  'mv-vol24h': {
    title: '24h Trading Volume',
    body: 'Global 24-hour crypto trading volume across all assets (USD). Used to gauge market-wide liquidity and participation. High volume + price move = conviction.',
  },
  'mv-oi': {
    title: 'Open Interest (ETH Perp)',
    body: 'Total value of all open ETH perpetual futures contracts on Binance. High OI = heavily leveraged market; a sudden OI drop means mass liquidations. Watch OI + price divergence for trapped traders.',
  },
  'mv-funding': {
    title: 'Funding Rate',
    body: 'Rate paid every 8 hours between long and short futures traders. Positive = longs paying shorts (bullish bias). Negative = shorts paying longs (bearish bias). Extreme values often precede sharp reversals.',
  },
  'mv-rsi': {
    title: 'RSI (14-period)',
    body: 'Relative Strength Index measures momentum 0–100. Above 70 = overbought (potential pullback). Below 30 = oversold (potential bounce). 40–60 = neutral. Works best when confirmed by volume.',
  },
  'mv-ema20': {
    title: 'vs EMA20',
    body: "Price relative to the 20-period Exponential Moving Average. The short-term trend line. Price above = near-term uptrend; below = near-term downtrend. Traders use EMA20 as dynamic support.",
  },
  'mv-ema50': {
    title: 'vs EMA50',
    body: "Price relative to the 50-period EMA. Medium-term trend reference. A golden cross (EMA50 crossing above EMA200) is a major bullish signal. Below EMA50 = trend is softening.",
  },
  'mv-ema200': {
    title: 'vs EMA200',
    body: "Price vs the 200-period EMA — the classic bull/bear dividing line used by institutional traders. Above = macro bullish. Below = macro bearish. Crossing this level draws major market attention.",
  },
  'mv-macd': {
    title: 'MACD',
    body: 'Moving Average Convergence Divergence: difference between 12-period and 26-period EMAs, smoothed by a 9-period signal line. Histogram positive and rising = bullish momentum. Bearish cross = caution.',
  },
  'mv-bb': {
    title: 'Bollinger Band Width',
    body: 'Measures price volatility as the % gap between upper and lower Bollinger Bands (2σ). Low width = squeeze, expect a breakout soon. High width = already volatile, breakout may be exhausting.',
  },
  'mv-gas': {
    title: 'ETH Gas Price',
    body: 'Current Ethereum network transaction fee in Gwei. High gas = congested network with heavy DeFi, NFT, or MEV activity. Low gas = quiet network. Gas spikes often coincide with volatility events.',
  },
  'mv-hash': {
    title: 'BTC Network Hashrate',
    body: "Bitcoin's total computing power in ExaHash/second. High and rising = miners are confident and investing. Sudden drops signal miner capitulation or outages — historically precede BTC price bottoms.",
  },
  'mv-btcdom': {
    title: 'BTC Dominance',
    body: "Bitcoin's share of the total crypto market cap. Rising dominance = capital rotating INTO BTC (risk-off, bad for ETH). Falling dominance = altcoin season, ETH and other assets tend to outperform.",
  },
  'mv-ethbtc': {
    title: 'ETH/BTC Ratio',
    body: 'ETH price expressed in Bitcoin terms. Rising = ETH outperforming BTC (Ether season). Falling = BTC leading the rally or ETH losing ground. A long-term gauge of ETH vs BTC strength.',
  },
  'mv-fg': {
    title: 'Fear & Greed Index',
    body: 'Crypto market sentiment score 0–100. 0–24 = Extreme Fear (historically a buying opportunity). 25–49 = Fear. 50–74 = Greed. 75–100 = Extreme Greed (caution — tops often form here). Based on volatility, volume, social media, and surveys.',
  },
};

// ── Popup ────────────────────────────────────────────────────────
let _popupEl = null;
let _popupOpenKey = null;

function _ensurePopup() {
  if (_popupEl) return _popupEl;
  const el = document.createElement('div');
  el.id = 'chipInfoPopup';
  el.className = 'cip';
  el.innerHTML = `
    <div class="cip-arrow"></div>
    <div class="cip-title"></div>
    <div class="cip-body"></div>
  `;
  document.body.appendChild(el);
  return el;
}

function _hidePopup() {
  if (_popupEl) _popupEl.classList.remove('cip-visible');
  _popupOpenKey = null;
}

function _showPopup(anchor, key) {
  const info = CHIP_INFO[key];
  if (!info) return;

  // Toggle off if same chip clicked again
  if (_popupOpenKey === key) { _hidePopup(); return; }

  _popupEl = _ensurePopup();
  _popupEl.querySelector('.cip-title').textContent = info.title;
  _popupEl.querySelector('.cip-body').textContent = info.body;

  // Position
  _popupEl.classList.remove('cip-visible', 'cip-above', 'cip-below');
  _popupEl.style.cssText = '';

  const rect = anchor.getBoundingClientRect();
  const POP_W = 300;

  let left = rect.left + rect.width / 2 - POP_W / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - POP_W - 8));

  const spaceBelow = window.innerHeight - rect.bottom;
  const above = spaceBelow < 160 && rect.top > 160;

  _popupEl.style.width = POP_W + 'px';
  _popupEl.style.left = left + 'px';

  if (above) {
    _popupEl.style.top = '';
    _popupEl.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
    _popupEl.classList.add('cip-above');
  } else {
    _popupEl.style.bottom = '';
    _popupEl.style.top = (rect.bottom + 6) + 'px';
    _popupEl.classList.add('cip-below');
  }

  // Arrow centering
  const arrowLeft = rect.left + rect.width / 2 - left;
  _popupEl.style.setProperty('--cip-arrow-left', arrowLeft + 'px');

  _popupEl.classList.add('cip-visible');
  _popupOpenKey = key;
}

// ── Drag & Drop ───────────────────────────────────────────────────
const LAYOUT_KEY = 'chipLayout_v1';
let _dragging = null;
let _placeholder = null;

function _getLayout() {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null') || {}; } catch { return {}; }
}

function _saveLayout() {
  const layout = {};
  document.querySelectorAll('[data-drop-zone]').forEach(zone => {
    const zoneId = zone.dataset.dropZone;
    layout[zoneId] = [...zone.querySelectorAll('[data-chip-key]')]
      .map(c => c.dataset.chipKey);
  });
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
}

function _restoreLayout() {
  const layout = _getLayout();
  if (!Object.keys(layout).length) return;
  Object.entries(layout).forEach(([zoneId, keys]) => {
    const zone = document.querySelector(`[data-drop-zone="${zoneId}"]`);
    if (!zone) return;
    keys.forEach(key => {
      const chip = document.querySelector(`[data-chip-key="${key}"]`);
      if (chip && chip.parentElement !== zone) {
        // Find insertion point: after last chip or before group title
        const title = zone.querySelector('.mv-group-title');
        if (title) zone.insertBefore(chip, null); // append
        else zone.appendChild(chip);
      }
    });
    // Re-order existing chips to match saved order
    keys.forEach(key => {
      const chip = zone.querySelector(`[data-chip-key="${key}"]`);
      if (chip) zone.appendChild(chip);
    });
  });
}

function _makePlaceholder(chip) {
  const ph = document.createElement('div');
  ph.className = 'chip-drag-placeholder';
  ph.style.width = chip.offsetWidth + 'px';
  ph.style.height = chip.offsetHeight + 'px';
  return ph;
}

function _getInsertTarget(zone, x, y) {
  const chips = [...zone.querySelectorAll('[data-chip-key]:not(.chip-dragging)')];
  for (const chip of chips) {
    const r = chip.getBoundingClientRect();
    const midX = r.left + r.width / 2;
    const midY = r.top + r.height / 2;
    const style = getComputedStyle(zone);
    const isRow = style.flexDirection !== 'column';
    if (isRow ? x < midX : y < midY) return chip;
  }
  return null;
}

function _initChipDrag(chip) {
  chip.setAttribute('draggable', 'true');

  chip.addEventListener('dragstart', (e) => {
    _dragging = chip;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', chip.dataset.chipKey);
    chip.classList.add('chip-dragging');
    _placeholder = _makePlaceholder(chip);
    // Insert placeholder immediately
    chip.after(_placeholder);
    // Hide chip ghost after browser captures it
    requestAnimationFrame(() => chip.style.opacity = '0');
  });

  chip.addEventListener('dragend', () => {
    chip.classList.remove('chip-dragging');
    chip.style.opacity = '';
    _placeholder?.remove();
    _placeholder = null;
    _dragging = null;
    document.querySelectorAll('.chip-drop-active').forEach(z => z.classList.remove('chip-drop-active'));
    _saveLayout();
  });
}

function _initZoneDrop(zone) {
  zone.addEventListener('dragover', (e) => {
    if (!_dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('chip-drop-active');

    const after = _getInsertTarget(zone, e.clientX, e.clientY);
    if (after) {
      zone.insertBefore(_placeholder, after);
    } else {
      // Append at end, but keep group title first
      const title = zone.querySelector('.mv-group-title');
      if (title) zone.insertBefore(_placeholder, null);
      zone.appendChild(_placeholder);
    }
  });

  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget)) {
      zone.classList.remove('chip-drop-active');
    }
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('chip-drop-active');
    if (_dragging && _placeholder) {
      zone.insertBefore(_dragging, _placeholder);
      _placeholder.remove();
      _placeholder = null;
    }
  });
}

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Popup: delegate click on any chip with data-chip-key
  document.addEventListener('click', (e) => {
    // Close popup on outside click
    if (_popupEl?.classList.contains('cip-visible') && !e.target.closest('[data-chip-key]') && !e.target.closest('#chipInfoPopup')) {
      _hidePopup();
      return;
    }
    const chip = e.target.closest('[data-chip-key]');
    if (!chip) return;
    if (e.target.closest('a')) return;
    // Let buy chip and forecast chip keep their own click behavior; show info only on secondary click
    if (chip.id === 'buyChip' || chip.id === 'aiVerdictBigBtn') return;
    e.stopPropagation();
    _showPopup(chip, chip.dataset.chipKey);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') _hidePopup();
  });

  // Drag & drop
  document.querySelectorAll('[data-chip-key]').forEach(_initChipDrag);
  document.querySelectorAll('[data-drop-zone]').forEach(_initZoneDrop);

  // Restore saved layout
  _restoreLayout();
});
