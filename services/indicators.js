'use strict';

// Pure technical-indicator math used by /api/market-vitals and anywhere else
// we want the latest reading off a price series.

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function sma(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    return s / period;
  });
}

function stdev(values, period, mean) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sq = 0;
    const m = mean[i];
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - m) ** 2;
    out[i] = Math.sqrt(sq / period);
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  const macdLine = values.map((_, i) => (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
  // Signal is an EMA of the MACD line, only where defined.
  const filled = macdLine.map(v => v == null ? 0 : v);
  const signal = ema(filled, signalPeriod);
  const histogram = macdLine.map((v, i) => (v != null && signal[i] != null) ? v - signal[i] : null);
  return { macd: macdLine, signal, histogram };
}

function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const std = stdev(values, period, mid);
  const upper = mid.map((m, i) => (m == null || std[i] == null) ? null : m + mult * std[i]);
  const lower = mid.map((m, i) => (m == null || std[i] == null) ? null : m - mult * std[i]);
  // Bandwidth, percent-style.
  const width = mid.map((m, i) => (m == null || std[i] == null) ? null : ((upper[i] - lower[i]) / m) * 100);
  return { upper, middle: mid, lower, width };
}

function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// Just the most recent (non-null) value in a series.
function latest(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

module.exports = { ema, sma, rsi, macd, bollinger, latest };
