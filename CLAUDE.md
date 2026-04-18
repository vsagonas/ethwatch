# ETHWATCH — Live Ethereum Tracker

Real-time ETH price tracker with candlestick charts, pattern recognition, live order flow, news sentiment with per-day AI verdicts, saved **Oracle** marker sets with Claude prophecy, four themes, and persistent user preferences.

## Quick Start

```bash
npm install
# Fill in .env (see Environment Variables)
npm start
# Open http://localhost:3000
```

## Architecture

**Backend:** Node.js / Express in `server.js`. Serves the frontend, proxies all external APIs, persists cache to disk + SQLite.
- `db.js` — SQLite schema + prepared statements (`better-sqlite3`). Creates `data.db` next to the server.
- `services/newsapi.js` — NewsAPI.org fetcher with per-date caching and delta inserts.
- `services/monthly.js` — orchestrates per-day sentiment: ETH/BTC daily bars + headlines + Claude batched verdicts (Haiku 4.5, tool-use for strict JSON).
- `services/oracle.js` — Claude Sonnet 4.6 pattern prophecy engine over saved marker sets.

**Frontend:** Vanilla JS, no build step. Modules in `public/js/`:
- `app.js` — core state, line chart (Chart.js), RSI, alerts, themes, prefs sync
- `candlestick.js` — TradingView Lightweight Charts + synced news strip + marker persistence
- `orderflow.js` — Binance WebSocket live trades (last buy / last sell only; `MAX_ROWS = 1`)
- `news.js` — RSS news + AI 24h summary
- `monthly.js` — 30-day sentiment strip + day-detail modal
- `oracle.js` — save-set dialog, list, Claude prophecy rendering

## External APIs

| API | Auth | Purpose |
|-----|------|---------|
| CoinGecko (free) | None | Price, OHLC, history, market data |
| Binance WebSocket | None | Live ETHUSDT trade stream |
| Anthropic Claude | `ANTHROPIC_API_KEY` | News sentiment, pattern interpretation, per-day monthly verdicts, Oracle prophecy |
| NewsAPI.org (free) | `NEWSAPI_KEY` | Historical per-day crypto headlines (30-day archive, ~24h article delay on free tier) |
| RSS feeds | None | CoinDesk, Cointelegraph, CryptoSlate, Decrypt, CryptoPotato — current news feed |

CoinGecko free tier rate limit ≈ 10–30 req/min. We back off 60s on any 429 and serve stale data from disk cache during the cooldown. `days=max` is 401 on free tier — `/api/eth-history?days=max` will attempt and fail; not part of startup warming.

NewsAPI free tier: 1000 req/day, 100 results per query max, articles delayed ~24h, 30-day historical window.

## Environment Variables (`.env`)

```
ANTHROPIC_API_KEY=sk-ant-...     # required for all Claude features
NEWSAPI_KEY=<your NewsAPI key>   # required for 30-day headline archive + Oracle news context
PORT=3000
```

App runs without either key — AI features and historical news just degrade gracefully.

## Persistence (two layers)

1. **Disk file cache** (`cache/`) — JSON files of API payloads keyed by range/currency. Price, history, OHLC. Loaded at startup via `hydrateDiskCache()`, written after every successful CoinGecko call. `warmCaches()` only fetches missing ranges, so second boots onward are effectively free.
2. **SQLite** (`data.db`, WAL mode, foreign keys on):
   - `daily_sentiment` — per-day ETH/BTC moves + Claude verdict/score/summary
   - `daily_headlines` — per-day NewsAPI headlines, PK `(date, url)` → natural dedupe
   - `news_fetch_log` — soft throttle for empty / errored days
   - `user_prefs` — currency, range, theme, indicators (server-synced on each click)
   - `marker_sets` + `marker_points` — saved Oracle pattern sets with embedded ETH OHLC per marker

## API Endpoints

| Endpoint | Method | Params / Notes |
|----------|--------|----------------|
| `/api/eth-price` | GET | Current price USD+EUR, 24h change, market cap, volume |
| `/api/eth-history` | GET | `days` (`1,7,30,90,365,max`), `currency`. Prices + SMA20, EMA50, RSI14 |
| `/api/eth-ohlc` | GET | `days`, `currency`. OHLC candles. On CoinGecko 429 with no cache, synthesizes candles by bucketing cached history prices (`synthetic: true` in response) |
| `/api/eth-info` | GET | ATH, ATL, rank, supply, multi-period changes |
| `/api/patterns` | GET | Top 5 cosine-similar 24h patterns from 90-day history |
| `/api/news` | GET | ETH-filtered news from RSS + CoinGecko |
| `/api/news/ai-summary` | POST | Claude analysis of last 24h headlines (30min cache) |
| `/api/predict-pattern` | POST | Similarity search + optional Claude interpretation |
| `/api/monthly-sentiment` | GET | `days` (default 30), `currency`. Per-day ETH/BTC moves + verdict + top headlines |
| `/api/day-detail` | GET | `date=YYYY-MM-DD`. All stored headlines + sentiment for one day |
| `/api/prefs` | GET/POST | User-pref key/value map, server-side persistent |
| `/api/marker-sets` | GET | List saved Oracle sets (+ last prophecy) |
| `/api/marker-sets/:id` | GET | One set: metadata + marker points |
| `/api/marker-sets` | POST | Body: `{name, description, prediction, currency, points:[{candle_time, date, eth_price, eth_open, eth_high, eth_low, eth_close}]}` |
| `/api/marker-sets/:id` | DELETE | Cascades to points |
| `/api/marker-sets/:id/oracle` | POST | Runs Claude Sonnet prophecy over the set; persists + returns result |

## Cache TTLs

| Layer | TTL |
|-------|-----|
| Price | 25s (just under 30s client refresh) |
| History (short-range) | 60s |
| History (90+ days, `max`) | 5 min |
| OHLC | 60s |
| RSS news | 5 min |
| AI 24h summary | 30 min |
| `daily_sentiment` verdict/summary | **Permanent** — Claude only re-runs for dates missing a verdict |
| NewsAPI headlines (historical days) | **Permanent** — written once per date, never re-fetched |
| NewsAPI headlines (today + yesterday) | 1h refresh cadence, delta-insert only (existing URLs never re-inserted) |
| Empty / errored news date retry | 6h |
| Oracle prophecy | Persisted on the set; re-run only if user clicks **Invoke Oracle** again |

## Technical Indicators

Server-side:
- **SMA(n)** — rolling mean of last n closes
- **EMA(n)** — Wilder's exponential average, k = 2/(n+1)
- **RSI(14)** — Wilder's smoothing; >70 overbought, <30 oversold

## Pattern Recognition (cosine similarity)

90 days of hourly closes. Each 24-hour window's log-return sequence is cosine-compared against the current 24-hour window. Threshold >0.65. Returns top 5 matches with outcome stats. Pattern window size (24h) hardcoded.

## Candlestick — Middle Candle Detection

A candle is a "middle candle" (doji/spinning top) when `body / range < 0.25`. Marked with yellow **M** below the bar.

Users click candles to mark setups. Marks persist in `localStorage`. From there:
- **Predict Pattern** runs the cosine similarity search on an 8-candle window around each mark + optional Claude naming.
- **Save as Oracle Set** persists the marks as a named pattern template (see Oracle).

## Synced News Strip (candle view, 1M range)

Below the candlestick chart in 1M mode: one tile per candle absolutely-positioned via `timeScale().timeToCoordinate()`. Subscribed to `subscribeVisibleTimeRangeChange` so pan/zoom keeps tiles aligned with their candles. Each tile shows date, ETH move%, top headline, verdict color. Click → day-detail modal.

## 30-Day Sentiment Strip (line view, 1M range)

Each day is a column with two stacked elements:
1. **Day tile** — crypto-market verdict (bullish / bearish / neutral / pending), ETH move %, headline count.
2. **Hope bar** — signed ±% bar from the neutral midline. Green up when hopeful, red down when bleak. Scale is `(hope_score − 50) × 2`, so a hope_score of 75 renders as `+50%`.

Click any tile OR hope cell → modal showing:
- ETH/BTC close + move, Claude crypto verdict
- Hope score (0–100) + Claude hope summary
- Macro score (−100 to +100) + Claude macro summary
- Three headline lists: **Crypto**, **Macro / War**, **World Hope**

### News categories

Each date stores headlines across 3 NewsAPI categories:
| Category | Query focus |
|----------|-------------|
| `crypto` | Ethereum, bitcoin, ETF, SEC, regulation, hack |
| `macro`  | World economy, recession, inflation, war, sanctions, geopolitics |
| `hope`   | Breakthrough, peace, humanitarian, renewable, rescue, innovation |

All three share the same caching policy: permanent for historical days, 1h refresh for today/yesterday, delta insert via `(date, category, url)` PK so existing URLs never re-insert. Schema on `daily_headlines` includes `category`; `news_fetch_log` is keyed `(date, category)` for independent per-category throttling.

### Claude scoring (batched)

For each day missing any of `verdict / hope_score / macro_score`, one batched Claude call (`submit_verdicts` tool) returns:
- `verdict` + `score` + `summary` (crypto market)
- `hope_score` (0–100) + `hope_summary`
- `macro_score` (−100 to +100) + `macro_summary`

All four dimensions get stored in the same `daily_sentiment` row (new columns: `hope_score`, `hope_summary`, `macro_score`, `macro_summary`). Claude uses Haiku 4.5 for this batched call.

Assembly order in `services/monthly.js`:
1. Load existing `daily_sentiment` rows from DB.
2. Fetch CoinGecko ETH+BTC daily bars only if a date is missing prices, or for today/yesterday (live).
3. For each date, across **all 3 categories**, call `fetchDay({category})` — decides internally whether to hit NewsAPI.
4. Send days missing a verdict in one batched Claude call with the `submit_verdicts` tool (schema-enforced → guaranteed valid JSON).

## ORACLE (Neural Pattern Prophecy)

1. User marks candles, clicks **Save as Oracle Set**, provides a name, shared-trait description, and their own prediction.
2. The set + each marker's candle_time, UTC date, and full OHLC are persisted in SQLite.
3. Clicking **Invoke Oracle** on a saved set runs `services/oracle.js`:
   - For each marker, enrich with the day's sentiment row (ETH/BTC moves, stored verdict, Claude summary) + top 5 NewsAPI headlines.
   - Send to Claude Sonnet 4.6 with the `submit_prophecy` tool.
   - Tool returns `{direction, confidence, horizon, expected_move_pct, user_hypothesis_verdict, narrative, key_signals, risk_factors}` — schema enforced.
4. Result persisted as JSON on the set (`oracle_result`, `oracle_ts`) and rendered inline.

Model choice: Sonnet 4.6 for the prophecy (quality across many days matters); Haiku 4.5 for the cheaper per-day batched verdicts.

## Order Flow (Binance WebSocket)

Browser → `wss://stream.binance.com:9443/ws/ethusdt@aggTrade`. `m=true` → buyer is maker (sell pressure); `m=false` → buy pressure. 5-minute rolling window drives the buy/sell volume bars and trend arrow (↑/↓/→ at 55%/45% ratio crosses). Feed columns show **only the last** buy and last sell (`MAX_ROWS = 1`).

## Themes (4)

Header toggle cycles through them. Persisted server-side on `user_prefs.theme` and mirrored to `localStorage.eth_theme` for flash-free boot.

| Theme | Vibe |
|-------|------|
| `dark` (default) | GitHub dim — navy bg, soft text, blue accent |
| `light` | GitHub light |
| `dystopian` | Blade Runner — deep indigo-black, neon magenta + amber + cyan, drop-shadow glow, radial gradients |
| `matrix` | Phosphor green on pure black, monospace everywhere, scanline overlay |

All colors are CSS custom properties on `[data-theme=...]`. Chart.js and Lightweight Charts both destroy/re-create on theme change (`applyTheme` → `updatePriceChart`, `buildRSIChart`, `window.reloadCandles`) because they bake colors at init.

## User Preferences (persistent)

Debounced `POST /api/prefs` fires on any click of: currency, range, theme toggle, or indicator button. Keys tracked:
- `currency` — `usd` / `eur`
- `days` — `1` / `7` / `30` / `90` / `365`
- `theme` — one of the 4 theme ids
- `indicators` — JSON `{sma20, ema50, volume}`
- `darkMode` — legacy back-compat

Boot order: `localStorage` applied first (zero flash), then `GET /api/prefs` fetched and applied if server has values.

## Dev Notes

- No auth layer. All API routes are public.
- If CoinGecko 429s on a cold server, wait ~60s (automatic cooldown) or restart — disk cache absorbs it.
- `npm run dev` uses nodemon for file-watch restart.
- `data.db` + `cache/` directory are user-scoped state; delete to reset.
- Pattern window size (24h) and middle-candle threshold (0.25) are hardcoded constants.
