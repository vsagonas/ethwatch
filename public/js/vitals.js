/* Market Vitals — 24h stats frame in the hero. Polls /api/market-vitals
   every 5 min and paints chips with colors based on direction. */

'use strict';

function fmtUsdLarge(v) {
  if (v == null) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(2)}M`;
  return `$${v.toLocaleString()}`;
}
function fmtPct(v, digits = 2) {
  if (v == null || !isFinite(v)) return '—';
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}%`;
}
function fmtNum(v, digits = 2) {
  if (v == null || !isFinite(v)) return '—';
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: digits });
}

function setChip(id, value, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  const chip = el.closest('.mv-chip');
  if (!chip) return;
  chip.classList.remove('up', 'down', 'warn', 'info', 'neutral');
  if (cls) chip.classList.add(cls);
}

function paint(d) {
  if (!d) return;

  // ── Price & Structure ──
  setChip('mvVolume', fmtUsdLarge(d.global_volume_24h), 'info');
  setChip('mvOI', d.open_interest_eth != null ? `${(d.open_interest_eth / 1000).toFixed(1)}K ETH` : '—', 'info');
  const fr = d.funding_rate;
  setChip('mvFunding', fr != null ? `${(fr * 100).toFixed(4)}%` : '—',
    fr == null ? null : fr > 0.0001 ? 'up' : fr < -0.0001 ? 'down' : 'neutral');

  // ── Technicals ──
  const t = d.technicals || {};
  // RSI comes from the existing app state (already on the line chart); re-read from price history via monthly api — easier: compute from local priceChart data if available.
  const rsi = window.state?.historyData?.indicators?.rsi;
  if (Array.isArray(rsi)) {
    for (let i = rsi.length - 1; i >= 0; i--) {
      if (rsi[i] != null) {
        setChip('mvRsi', rsi[i].toFixed(1),
          rsi[i] > 70 ? 'down' : rsi[i] < 30 ? 'up' : 'neutral');
        break;
      }
    }
  }
  setChip('mvEma20',  fmtPct(t.ema20_vs_price_pct),  t.ema20_vs_price_pct  != null ? (t.ema20_vs_price_pct  >= 0 ? 'up' : 'down') : null);
  setChip('mvEma50',  fmtPct(t.ema50_vs_price_pct),  t.ema50_vs_price_pct  != null ? (t.ema50_vs_price_pct  >= 0 ? 'up' : 'down') : null);
  setChip('mvEma200', fmtPct(t.ema200_vs_price_pct), t.ema200_vs_price_pct != null ? (t.ema200_vs_price_pct >= 0 ? 'up' : 'down') : null);

  let macdTxt = '—', macdCls = null;
  switch (t.macd_cross) {
    case 'bullish_cross': macdTxt = '▲ Cross';   macdCls = 'up'; break;
    case 'bearish_cross': macdTxt = '▼ Cross';   macdCls = 'down'; break;
    case 'bull':          macdTxt = '▲ Above';   macdCls = 'up'; break;
    case 'bear':          macdTxt = '▼ Below';   macdCls = 'down'; break;
  }
  setChip('mvMacd', macdTxt, macdCls);

  if (t.bb_width_pct != null) {
    setChip('mvBB', `${t.bb_width_pct.toFixed(2)}%${t.bb_squeeze ? ' ⚡' : ''}`,
      t.bb_squeeze ? 'warn' : 'neutral');
  }

  // ── On-Chain ──
  setChip('mvGas', d.gas_gwei != null ? `${d.gas_gwei} gwei` : '—',
    d.gas_gwei == null ? null : d.gas_gwei > 80 ? 'down' : d.gas_gwei < 20 ? 'up' : 'neutral');
  setChip('mvHash', d.btc_hash_rate != null ? `${(d.btc_hash_rate / 1e18).toFixed(1)} EH/s` : '—', 'info');

  // ── Macro ──
  setChip('mvBtcDom', d.btc_dominance != null ? `${d.btc_dominance.toFixed(2)}%` : '—', 'info');
  setChip('mvEthBtc', d.eth_btc_ratio != null ? fmtNum(d.eth_btc_ratio, 5) : '—', 'info');

  const fg = d.fg_value;
  let fgCls = 'neutral';
  if (fg != null) {
    if (fg >= 75) fgCls = 'down';       // extreme greed — contrarian bearish
    else if (fg >= 55) fgCls = 'up';
    else if (fg <= 25) fgCls = 'up';    // extreme fear — contrarian bullish
    else if (fg <= 45) fgCls = 'down';
  }
  setChip('mvFG', fg != null ? `${fg} · ${d.fg_label || ''}` : '—', fgCls);
}

async function refreshVitals() {
  try {
    const res = await fetch('/api/market-vitals');
    const json = await res.json();
    if (!json.success) return;
    paint(json.data);
  } catch { /* silent — keeps the existing chip values */ }
}

document.addEventListener('DOMContentLoaded', () => {
  refreshVitals();
  setInterval(refreshVitals, 5 * 60 * 1000);
});
