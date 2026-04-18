'use strict';

const axios = require('axios');
const dbm = require('../db');

const BASE = 'https://newsapi.org/v2/everything';
const PAGE_SIZE = 30;

// Per-category popularity-sorted queries. All English, all NewsAPI free tier.
// Queries are deliberately wide (no AND-chains) so each day returns enough
// articles for Claude to score meaningfully. NewsAPI's relevance ranking
// still floats the most on-topic items to the top.
const QUERIES = {
  crypto: 'ethereum OR bitcoin OR "crypto market" OR blockchain OR "digital asset" OR ETF OR SEC crypto OR stablecoin',
  macro:  'war OR ceasefire OR invasion OR sanctions OR recession OR inflation OR "central bank" OR "interest rates" OR geopolitics OR tariffs OR "trade war" OR summit OR "global economy"',
  hope:   'breakthrough OR "peace deal" OR humanitarian OR "renewable energy" OR "climate progress" OR "medical breakthrough" OR "scientific discovery" OR rescue OR "rare success" OR "historic agreement" OR "vaccine approved" OR reforestation OR "wildlife recovery"',
};
const CATEGORIES = Object.keys(QUERIES);

// Caching policy:
// - Historical days (older than yesterday): fetched exactly once, then frozen forever.
// - Today + yesterday: "live" days — only hit NewsAPI if the last fetch is >LIVE_REFRESH_MS old.
//                      When refetched, insert delta only (INSERT OR IGNORE), preserving earlier rows.
// - Previously-empty or errored days: retried at most every STALE_RETRY_MS.
const LIVE_REFRESH_MS = 60 * 60 * 1000;        // 1h
const STALE_RETRY_MS  = 6 * 3600 * 1000;       // 6h

function todayISO() { return new Date().toISOString().slice(0, 10); }
function yesterdayISO() { return new Date(Date.now() - 86400000).toISOString().slice(0, 10); }
function isLiveDay(dateISO) { return dateISO === todayISO() || dateISO === yesterdayISO(); }

function getKey() { return process.env.NEWSAPI_KEY; }

// Returns: { articles, cached, skipped?, inserted? }
async function fetchDay(dateISO, { force = false, category = 'crypto' } = {}) {
  if (!QUERIES[category]) throw new Error(`Unknown news category: ${category}`);

  const existing = dbm.countHeadlines(dateISO, category);
  const lastFetch = dbm.getFetchLog(dateISO, category);
  const live = isLiveDay(dateISO);

  if (!force) {
    if (!live && existing > 0) {
      return { articles: dbm.getHeadlines(dateISO, PAGE_SIZE, category), cached: true, skipped: 'historical-cached' };
    }
    if (live && lastFetch && Date.now() - lastFetch.fetched_ts < LIVE_REFRESH_MS) {
      return { articles: dbm.getHeadlines(dateISO, PAGE_SIZE, category), cached: true, skipped: 'live-fresh' };
    }
    if (!live && !existing && lastFetch && Date.now() - lastFetch.fetched_ts < STALE_RETRY_MS) {
      return { articles: [], cached: true, skipped: 'recent-empty' };
    }
  }

  const apiKey = getKey();
  if (!apiKey) {
    return { articles: dbm.getHeadlines(dateISO, PAGE_SIZE, category), cached: false, skipped: 'no-key' };
  }

  try {
    const res = await axios.get(BASE, {
      params: {
        q: QUERIES[category],
        from: dateISO,
        to: dateISO,
        language: 'en',
        sortBy: 'popularity',
        pageSize: PAGE_SIZE,
      },
      headers: { 'X-Api-Key': apiKey, 'Accept': 'application/json' },
      timeout: 12000,
    });

    const raw = res.data?.articles ?? [];
    const normalized = raw.map(a => ({
      source: a.source?.name || null,
      title: a.title || '',
      url: a.url || '',
      description: a.description || null,
      published_at: a.publishedAt || null,
    })).filter(a => a.title && a.url);

    let inserted = 0;
    if (normalized.length) inserted = dbm.insertHeadlinesDelta(dateISO, normalized, category);
    dbm.recordFetch(dateISO, normalized.length, null, category);

    return {
      articles: dbm.getHeadlines(dateISO, PAGE_SIZE, category),
      cached: false,
      inserted,
      returned: normalized.length,
    };
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    dbm.recordFetch(dateISO, 0, `${status || ''} ${msg}`.trim(), category);
    return {
      articles: dbm.getHeadlines(dateISO, PAGE_SIZE, category),
      cached: false,
      skipped: `error-${status || 'net'}`,
      error: msg,
    };
  }
}

module.exports = { fetchDay, isLiveDay, CATEGORIES };
