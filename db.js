'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS daily_sentiment (
    date TEXT PRIMARY KEY,
    eth_price REAL,
    eth_open REAL,
    eth_move_pct REAL,
    btc_price REAL,
    btc_open REAL,
    btc_move_pct REAL,
    verdict TEXT,
    verdict_score REAL,
    summary TEXT,
    claude_ts INTEGER,
    updated_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS daily_headlines (
    date TEXT NOT NULL,
    source TEXT,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    published_at TEXT,
    rank INTEGER,
    PRIMARY KEY (date, url)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_headlines_date ON daily_headlines(date);

  CREATE TABLE IF NOT EXISTS user_prefs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS news_fetch_log (
    date TEXT PRIMARY KEY,
    fetched_ts INTEGER,
    article_count INTEGER,
    error TEXT
  );

  CREATE TABLE IF NOT EXISTS marker_sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    prediction TEXT,
    currency TEXT DEFAULT 'usd',
    created_ts INTEGER,
    updated_ts INTEGER,
    oracle_result TEXT,
    oracle_ts INTEGER
  );

  CREATE TABLE IF NOT EXISTS marker_points (
    set_id INTEGER NOT NULL,
    candle_time INTEGER NOT NULL,
    date TEXT,
    eth_price REAL,
    eth_open REAL,
    eth_high REAL,
    eth_low REAL,
    eth_close REAL,
    PRIMARY KEY (set_id, candle_time),
    FOREIGN KEY (set_id) REFERENCES marker_sets(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_marker_points_set ON marker_points(set_id);
`);
db.pragma('foreign_keys = ON');

// ── Migrations for categorized news + hope/macro scoring ──────────────────
function hasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
function addColumn(table, col, spec) {
  if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${spec}`);
}

// Add `category` to daily_headlines and change PK to (date, category, url).
if (!hasColumn('daily_headlines', 'category')) {
  db.exec(`
    CREATE TABLE daily_headlines_new (
      date TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'crypto',
      source TEXT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      published_at TEXT,
      rank INTEGER,
      PRIMARY KEY (date, category, url)
    );
    INSERT INTO daily_headlines_new (date, category, source, title, url, description, published_at, rank)
      SELECT date, 'crypto', source, title, url, description, published_at, rank FROM daily_headlines;
    DROP TABLE daily_headlines;
    ALTER TABLE daily_headlines_new RENAME TO daily_headlines;
    CREATE INDEX IF NOT EXISTS idx_daily_headlines_date ON daily_headlines(date);
    CREATE INDEX IF NOT EXISTS idx_daily_headlines_cat  ON daily_headlines(category, date);
  `);
}

// news_fetch_log needs per-category tracking too.
if (!hasColumn('news_fetch_log', 'category')) {
  db.exec(`
    CREATE TABLE news_fetch_log_new (
      date TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'crypto',
      fetched_ts INTEGER,
      article_count INTEGER,
      error TEXT,
      PRIMARY KEY (date, category)
    );
    INSERT INTO news_fetch_log_new (date, category, fetched_ts, article_count, error)
      SELECT date, 'crypto', fetched_ts, article_count, error FROM news_fetch_log;
    DROP TABLE news_fetch_log;
    ALTER TABLE news_fetch_log_new RENAME TO news_fetch_log;
  `);
}

// Per-day hope + macro scoring columns on daily_sentiment.
addColumn('daily_sentiment', 'hope_score',    'REAL');    // 0–100
addColumn('daily_sentiment', 'hope_summary',  'TEXT');
addColumn('daily_sentiment', 'macro_score',   'REAL');    // -100 … +100
addColumn('daily_sentiment', 'macro_summary', 'TEXT');

// Market vitals — one JSON snapshot per refresh cycle. Cheap to query and
// keeps a history of funding / OI / dominance / fear-greed / etc.
db.exec(`
  CREATE TABLE IF NOT EXISTS market_vitals (
    ts INTEGER PRIMARY KEY,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS buy_recommendations (
    ts INTEGER PRIMARY KEY,
    verdict TEXT,
    confidence REAL,
    data TEXT NOT NULL
  );
`);

// Binance aggregated trades — persisted forever so we always have a 5m
// trend available to new browser sessions without waiting 5 min of live data.
db.exec(`
  CREATE TABLE IF NOT EXISTS order_flow_trades (
    agg_id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    price REAL NOT NULL,
    qty REAL NOT NULL,
    is_sell INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_oft_ts ON order_flow_trades(ts);
`);

// Market-history tables — SQL record of every price / OHLC we ever pull.
// Kept forever so we build up a persistent time-series archive.
db.exec(`
  CREATE TABLE IF NOT EXISTS price_snapshots (
    ts INTEGER NOT NULL,
    coin TEXT NOT NULL,
    currency TEXT NOT NULL,
    price REAL,
    market_cap REAL,
    volume_24h REAL,
    change_24h_pct REAL,
    PRIMARY KEY (ts, coin, currency)
  );
  CREATE INDEX IF NOT EXISTS idx_price_snap_coin_ts ON price_snapshots(coin, ts);

  CREATE TABLE IF NOT EXISTS hourly_price (
    ts INTEGER NOT NULL,
    coin TEXT NOT NULL,
    currency TEXT NOT NULL,
    price REAL,
    PRIMARY KEY (ts, coin, currency)
  );
  CREATE INDEX IF NOT EXISTS idx_hourly_coin_ts ON hourly_price(coin, ts);

  CREATE TABLE IF NOT EXISTS daily_ohlc (
    date TEXT NOT NULL,
    coin TEXT NOT NULL,
    currency TEXT NOT NULL,
    open REAL,
    high REAL,
    low REAL,
    close REAL,
    volume REAL,
    fetched_ts INTEGER,
    PRIMARY KEY (date, coin, currency)
  );
  CREATE INDEX IF NOT EXISTS idx_daily_ohlc_coin_date ON daily_ohlc(coin, date);
`);

// ── Sentiment rows ─────────────────────────────────────────────────────────
const upsertSentimentStmt = db.prepare(`
  INSERT INTO daily_sentiment (
    date, eth_price, eth_open, eth_move_pct,
    btc_price, btc_open, btc_move_pct,
    verdict, verdict_score, summary, claude_ts, updated_ts,
    hope_score, hope_summary, macro_score, macro_summary
  ) VALUES (
    @date, @eth_price, @eth_open, @eth_move_pct,
    @btc_price, @btc_open, @btc_move_pct,
    @verdict, @verdict_score, @summary, @claude_ts, @updated_ts,
    @hope_score, @hope_summary, @macro_score, @macro_summary
  )
  ON CONFLICT(date) DO UPDATE SET
    eth_price      = COALESCE(excluded.eth_price, daily_sentiment.eth_price),
    eth_open       = COALESCE(excluded.eth_open,  daily_sentiment.eth_open),
    eth_move_pct   = COALESCE(excluded.eth_move_pct, daily_sentiment.eth_move_pct),
    btc_price      = COALESCE(excluded.btc_price, daily_sentiment.btc_price),
    btc_open       = COALESCE(excluded.btc_open,  daily_sentiment.btc_open),
    btc_move_pct   = COALESCE(excluded.btc_move_pct, daily_sentiment.btc_move_pct),
    verdict        = COALESCE(excluded.verdict, daily_sentiment.verdict),
    verdict_score  = COALESCE(excluded.verdict_score, daily_sentiment.verdict_score),
    summary        = COALESCE(excluded.summary, daily_sentiment.summary),
    claude_ts      = COALESCE(excluded.claude_ts, daily_sentiment.claude_ts),
    hope_score     = COALESCE(excluded.hope_score, daily_sentiment.hope_score),
    hope_summary   = COALESCE(excluded.hope_summary, daily_sentiment.hope_summary),
    macro_score    = COALESCE(excluded.macro_score, daily_sentiment.macro_score),
    macro_summary  = COALESCE(excluded.macro_summary, daily_sentiment.macro_summary),
    updated_ts     = excluded.updated_ts
`);

function upsertSentiment(row) {
  upsertSentimentStmt.run({
    date: row.date,
    eth_price: row.eth_price ?? null,
    eth_open: row.eth_open ?? null,
    eth_move_pct: row.eth_move_pct ?? null,
    btc_price: row.btc_price ?? null,
    btc_open: row.btc_open ?? null,
    btc_move_pct: row.btc_move_pct ?? null,
    verdict: row.verdict ?? null,
    verdict_score: row.verdict_score ?? null,
    summary: row.summary ?? null,
    claude_ts: row.claude_ts ?? null,
    updated_ts: Date.now(),
    hope_score:    row.hope_score    ?? null,
    hope_summary:  row.hope_summary  ?? null,
    macro_score:   row.macro_score   ?? null,
    macro_summary: row.macro_summary ?? null,
  });
}

const getSentimentStmt = db.prepare('SELECT * FROM daily_sentiment WHERE date = ?');
function getSentiment(date) { return getSentimentStmt.get(date); }

const getSentimentRangeStmt = db.prepare(
  'SELECT * FROM daily_sentiment WHERE date BETWEEN ? AND ? ORDER BY date ASC'
);
function getSentimentRange(from, to) { return getSentimentRangeStmt.all(from, to); }

// ── Headlines ──────────────────────────────────────────────────────────────
const insertHeadlineStmt = db.prepare(`
  INSERT OR REPLACE INTO daily_headlines
  (date, category, source, title, url, description, published_at, rank)
  VALUES (@date, @category, @source, @title, @url, @description, @published_at, @rank)
`);

const insertHeadlinesTxn = db.transaction((date, category, items) => {
  for (let i = 0; i < items.length; i++) {
    const h = items[i];
    if (!h.title || !h.url) continue;
    insertHeadlineStmt.run({
      date, category,
      source: h.source ?? null,
      title: h.title,
      url: h.url,
      description: h.description ?? null,
      published_at: h.published_at ?? null,
      rank: i + 1,
    });
  }
});
function insertHeadlines(date, items, category = 'crypto') { insertHeadlinesTxn(date, category, items); }

// Delta insert — only adds URLs we've never seen for this (date, category).
const insertHeadlineIgnoreStmt = db.prepare(`
  INSERT OR IGNORE INTO daily_headlines
  (date, category, source, title, url, description, published_at, rank)
  VALUES (@date, @category, @source, @title, @url, @description, @published_at, @rank)
`);
const countHeadlinesStmt = db.prepare('SELECT COUNT(*) as n FROM daily_headlines WHERE date = ? AND category = ?');
const insertHeadlinesDeltaTxn = db.transaction((date, category, items) => {
  const base = countHeadlinesStmt.get(date, category).n;
  let inserted = 0;
  for (let i = 0; i < items.length; i++) {
    const h = items[i];
    if (!h.title || !h.url) continue;
    const r = insertHeadlineIgnoreStmt.run({
      date, category,
      source: h.source ?? null,
      title: h.title,
      url: h.url,
      description: h.description ?? null,
      published_at: h.published_at ?? null,
      rank: base + i + 1,
    });
    if (r.changes > 0) inserted++;
  }
  return inserted;
});
function insertHeadlinesDelta(date, items, category = 'crypto') { return insertHeadlinesDeltaTxn(date, category, items); }

const getHeadlinesStmt = db.prepare(
  'SELECT * FROM daily_headlines WHERE date = ? AND category = ? ORDER BY rank ASC LIMIT ?'
);
function getHeadlines(date, limit = 30, category = 'crypto') {
  return getHeadlinesStmt.all(date, category, limit);
}
function countHeadlines(date, category = 'crypto') { return countHeadlinesStmt.get(date, category).n; }

// ── Fetch log (so we know not to retry empty-result dates immediately) ────
const recordFetchStmt = db.prepare(`
  INSERT OR REPLACE INTO news_fetch_log (date, category, fetched_ts, article_count, error)
  VALUES (?, ?, ?, ?, ?)
`);
function recordFetch(date, count, error = null, category = 'crypto') {
  recordFetchStmt.run(date, category, Date.now(), count, error);
}

const getFetchLogStmt = db.prepare('SELECT * FROM news_fetch_log WHERE date = ? AND category = ?');
function getFetchLog(date, category = 'crypto') { return getFetchLogStmt.get(date, category); }

// ── User preferences ───────────────────────────────────────────────────────
const getPrefStmt = db.prepare('SELECT value FROM user_prefs WHERE key = ?');
function getPref(key) {
  const row = getPrefStmt.get(key);
  return row ? row.value : null;
}

const setPrefStmt = db.prepare(`
  INSERT INTO user_prefs (key, value, updated_ts) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_ts = excluded.updated_ts
`);
function setPref(key, value) { setPrefStmt.run(key, String(value), Date.now()); }

const allPrefsStmt = db.prepare('SELECT key, value FROM user_prefs');
function getAllPrefs() {
  const out = {};
  for (const { key, value } of allPrefsStmt.all()) out[key] = value;
  return out;
}

// ── Marker sets (user pattern templates for Oracle) ────────────────────────
const insertMarkerSetStmt = db.prepare(`
  INSERT INTO marker_sets (name, description, prediction, currency, created_ts, updated_ts)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertMarkerPointStmt = db.prepare(`
  INSERT INTO marker_points
  (set_id, candle_time, date, eth_price, eth_open, eth_high, eth_low, eth_close)
  VALUES (@set_id, @candle_time, @date, @eth_price, @eth_open, @eth_high, @eth_low, @eth_close)
`);

const createMarkerSetTxn = db.transaction((meta, points) => {
  const ts = Date.now();
  const info = insertMarkerSetStmt.run(
    meta.name, meta.description ?? null, meta.prediction ?? null,
    meta.currency ?? 'usd', ts, ts
  );
  const id = info.lastInsertRowid;
  for (const p of points) {
    insertMarkerPointStmt.run({
      set_id: id,
      candle_time: p.candle_time,
      date: p.date ?? null,
      eth_price: p.eth_price ?? null,
      eth_open:  p.eth_open  ?? null,
      eth_high:  p.eth_high  ?? null,
      eth_low:   p.eth_low   ?? null,
      eth_close: p.eth_close ?? null,
    });
  }
  return id;
});
function createMarkerSet(meta, points) { return createMarkerSetTxn(meta, points); }

const listMarkerSetsStmt = db.prepare(`
  SELECT s.*, (SELECT COUNT(*) FROM marker_points p WHERE p.set_id = s.id) AS point_count
  FROM marker_sets s
  ORDER BY s.updated_ts DESC
`);
function listMarkerSets() { return listMarkerSetsStmt.all(); }

const getMarkerSetMetaStmt = db.prepare('SELECT * FROM marker_sets WHERE id = ?');
const getMarkerSetPointsStmt = db.prepare('SELECT * FROM marker_points WHERE set_id = ? ORDER BY candle_time ASC');
function getMarkerSet(id) {
  const set = getMarkerSetMetaStmt.get(id);
  if (!set) return null;
  return { set, points: getMarkerSetPointsStmt.all(id) };
}

const deleteMarkerSetStmt = db.prepare('DELETE FROM marker_sets WHERE id = ?');
function deleteMarkerSet(id) { return deleteMarkerSetStmt.run(id).changes > 0; }

const updateOracleStmt = db.prepare(`
  UPDATE marker_sets SET oracle_result = ?, oracle_ts = ?, updated_ts = ? WHERE id = ?
`);
function saveOracleResult(id, resultJson) {
  const ts = Date.now();
  updateOracleStmt.run(typeof resultJson === 'string' ? resultJson : JSON.stringify(resultJson), ts, ts, id);
}

// ── Market history persistence ────────────────────────────────────────────
// Prices from /simple/price and ETH/BTC cache misses → permanent time series.
const insertPriceSnapshotStmt = db.prepare(`
  INSERT OR IGNORE INTO price_snapshots
  (ts, coin, currency, price, market_cap, volume_24h, change_24h_pct)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
function savePriceSnapshot({ ts, coin, currency, price, market_cap = null, volume_24h = null, change_24h_pct = null }) {
  insertPriceSnapshotStmt.run(ts, coin, currency, price ?? null, market_cap, volume_24h, change_24h_pct);
}

// Bulk insert of hourly prices — used when a /market_chart response arrives.
const insertHourlyStmt = db.prepare(`
  INSERT OR IGNORE INTO hourly_price (ts, coin, currency, price) VALUES (?, ?, ?, ?)
`);
const saveHourlyPricesTxn = db.transaction((coin, currency, pairs) => {
  let inserted = 0;
  for (const [ts, price] of pairs) {
    const r = insertHourlyStmt.run(ts, coin, currency, price);
    if (r.changes) inserted++;
  }
  return inserted;
});
function saveHourlyPrices(coin, currency, pairs) {
  if (!pairs?.length) return 0;
  return saveHourlyPricesTxn(coin, currency, pairs);
}

// Daily OHLC bars. Today's row can change as the day progresses, so we
// REPLACE today's row on re-fetch but leave historical rows untouched
// (INSERT OR IGNORE would keep an old day's stale close; we want fresh
// data to win, so use INSERT OR REPLACE keyed by (date, coin, currency)).
const insertDailyOhlcStmt = db.prepare(`
  INSERT OR REPLACE INTO daily_ohlc
  (date, coin, currency, open, high, low, close, volume, fetched_ts)
  VALUES (@date, @coin, @currency, @open, @high, @low, @close, @volume, @fetched_ts)
`);
const saveDailyOhlcTxn = db.transaction((rows) => {
  for (const r of rows) insertDailyOhlcStmt.run(r);
});
const getDailyOhlcRangeStmt = db.prepare(
  'SELECT date, coin, currency, open, high, low, close FROM daily_ohlc WHERE date BETWEEN ? AND ? AND coin = ? AND currency = ? ORDER BY date ASC'
);
function getDailyOhlcRange(from, to, coin = 'ethereum', currency = 'usd') {
  return getDailyOhlcRangeStmt.all(from, to, coin, currency);
}

function saveDailyOhlc(rows) {
  if (!rows?.length) return;
  saveDailyOhlcTxn(rows.map(r => ({
    date: r.date, coin: r.coin, currency: r.currency,
    open: r.open ?? null, high: r.high ?? null, low: r.low ?? null, close: r.close ?? null,
    volume: r.volume ?? null,
    fetched_ts: r.fetched_ts ?? Date.now(),
  })));
}

// ── Prediction History ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS prediction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,          -- 'oracle' | 'pattern' | 'ai_forecast'
    created_ts INTEGER NOT NULL,
    source_ref TEXT,             -- set name for oracle, pattern label for pattern
    predicted_direction TEXT,    -- 'bullish' | 'bearish' | 'neutral'
    predicted_move_pct REAL,     -- expected % move (null if N/A)
    confidence REAL,             -- 0–100
    horizon TEXT,                -- e.g. '24h', '3 days', '1 week'
    target_date TEXT,            -- YYYY-MM-DD of when prediction resolves
    eth_price_at_prediction REAL,
    narrative TEXT,
    raw_result TEXT,             -- full JSON from Claude
    actual_eth_price REAL,       -- filled when target_date passes
    actual_move_pct REAL,        -- actual % change from prediction price
    accuracy_score REAL,         -- 0–100, computed on resolution
    resolved_ts INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ph_type ON prediction_history(type, created_ts);
  CREATE INDEX IF NOT EXISTS idx_ph_target ON prediction_history(target_date);
`);

const insertPredictionStmt = db.prepare(`
  INSERT INTO prediction_history
  (type, created_ts, source_ref, predicted_direction, predicted_move_pct,
   confidence, horizon, target_date, eth_price_at_prediction, narrative, raw_result)
  VALUES
  (@type, @created_ts, @source_ref, @predicted_direction, @predicted_move_pct,
   @confidence, @horizon, @target_date, @eth_price_at_prediction, @narrative, @raw_result)
`);
function savePrediction(p) {
  const r = insertPredictionStmt.run({
    type: p.type,
    created_ts: p.created_ts ?? Date.now(),
    source_ref: p.source_ref ?? null,
    predicted_direction: p.predicted_direction ?? null,
    predicted_move_pct: p.predicted_move_pct ?? null,
    confidence: p.confidence ?? null,
    horizon: p.horizon ?? null,
    target_date: p.target_date ?? null,
    eth_price_at_prediction: p.eth_price_at_prediction ?? null,
    narrative: p.narrative ?? null,
    raw_result: p.raw_result ? JSON.stringify(p.raw_result) : null,
  });
  return r.lastInsertRowid;
}

const getPredictionsStmt = db.prepare(
  `SELECT * FROM prediction_history ORDER BY created_ts DESC LIMIT ?`
);
const getPredictionsByTypeStmt = db.prepare(
  `SELECT * FROM prediction_history WHERE type = ? ORDER BY created_ts DESC LIMIT ?`
);
function getPredictions(limit = 100, type = null) {
  const rows = type
    ? getPredictionsByTypeStmt.all(type, limit)
    : getPredictionsStmt.all(limit);
  return rows.map(r => ({ ...r, raw_result: r.raw_result ? JSON.parse(r.raw_result) : null }));
}

const deletePredictionStmt = db.prepare(`DELETE FROM prediction_history WHERE id = ?`);
function deletePrediction(id) {
  return deletePredictionStmt.run(id).changes;
}

const resolvePredictionStmt = db.prepare(`
  UPDATE prediction_history
  SET actual_eth_price = ?, actual_move_pct = ?, accuracy_score = ?, resolved_ts = ?
  WHERE id = ?
`);
function resolvePrediction(id, { actual_eth_price, actual_move_pct, accuracy_score }) {
  resolvePredictionStmt.run(actual_eth_price, actual_move_pct, accuracy_score, Date.now(), id);
}

const getUnresolvedPredictionsStmt = db.prepare(
  `SELECT * FROM prediction_history WHERE resolved_ts IS NULL AND target_date IS NOT NULL AND target_date < date('now')`
);
function getUnresolvedPredictions() {
  return getUnresolvedPredictionsStmt.all().map(r => ({ ...r, raw_result: r.raw_result ? JSON.parse(r.raw_result) : null }));
}

// ── Order flow ────────────────────────────────────────────────────────────
const insertTradeStmt = db.prepare(`
  INSERT OR IGNORE INTO order_flow_trades (agg_id, ts, price, qty, is_sell)
  VALUES (?, ?, ?, ?, ?)
`);
const insertTradesTxn = db.transaction((rows) => {
  let n = 0;
  for (const t of rows) {
    const r = insertTradeStmt.run(t.agg_id, t.ts, t.price, t.qty, t.is_sell ? 1 : 0);
    if (r.changes) n++;
  }
  return n;
});
function insertTradesBatch(rows) {
  if (!rows?.length) return 0;
  return insertTradesTxn(rows);
}

const tradeSummaryStmt = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN is_sell = 0 THEN qty ELSE 0 END), 0) AS buy_vol,
    COALESCE(SUM(CASE WHEN is_sell = 1 THEN qty ELSE 0 END), 0) AS sell_vol,
    SUM(CASE WHEN is_sell = 0 THEN 1 ELSE 0 END) AS buy_count,
    SUM(CASE WHEN is_sell = 1 THEN 1 ELSE 0 END) AS sell_count
  FROM order_flow_trades WHERE ts >= ?
`);
const lastBuyStmt  = db.prepare(`SELECT * FROM order_flow_trades WHERE is_sell = 0 ORDER BY ts DESC LIMIT 1`);
const lastSellStmt = db.prepare(`SELECT * FROM order_flow_trades WHERE is_sell = 1 ORDER BY ts DESC LIMIT 1`);
function getTradeSummary(fromTs) {
  const s = tradeSummaryStmt.get(fromTs) || {};
  return {
    buy_vol: s.buy_vol || 0,
    sell_vol: s.sell_vol || 0,
    buy_count: s.buy_count || 0,
    sell_count: s.sell_count || 0,
    last_buy:  lastBuyStmt.get()  || null,
    last_sell: lastSellStmt.get() || null,
  };
}

const insertVitalsStmt = db.prepare('INSERT OR IGNORE INTO market_vitals (ts, data) VALUES (?, ?)');
function saveMarketVitals(data) {
  const ts = data?.generated_ts || Date.now();
  insertVitalsStmt.run(ts, JSON.stringify(data));
}
const latestVitalsStmt = db.prepare('SELECT data FROM market_vitals ORDER BY ts DESC LIMIT 1');
function getLatestVitals() {
  const row = latestVitalsStmt.get();
  return row ? JSON.parse(row.data) : null;
}

const insertBuyRecStmt = db.prepare('INSERT OR IGNORE INTO buy_recommendations (ts, verdict, confidence, data) VALUES (?, ?, ?, ?)');
function saveBuyRecommendation(rec) {
  const ts = rec?.generated_ts || Date.now();
  insertBuyRecStmt.run(ts, rec?.verdict ?? null, rec?.confidence ?? null, JSON.stringify(rec));
}
const latestBuyRecStmt = db.prepare('SELECT data FROM buy_recommendations ORDER BY ts DESC LIMIT 1');
function getLatestBuyRecommendation() {
  const row = latestBuyRecStmt.get();
  return row ? JSON.parse(row.data) : null;
}

module.exports = {
  db,
  upsertSentiment, getSentiment, getSentimentRange,
  insertHeadlines, insertHeadlinesDelta, getHeadlines, countHeadlines,
  recordFetch, getFetchLog,
  getPref, setPref, getAllPrefs,
  createMarkerSet, listMarkerSets, getMarkerSet, deleteMarkerSet, saveOracleResult,
  savePriceSnapshot, saveHourlyPrices, saveDailyOhlc, getDailyOhlcRange,
  insertTradesBatch, getTradeSummary,
  saveMarketVitals, getLatestVitals,
  saveBuyRecommendation, getLatestBuyRecommendation,
  savePrediction, getPredictions, deletePrediction, resolvePrediction, getUnresolvedPredictions,
};
