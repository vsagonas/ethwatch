# ETHWATCH v1.3 — Live Ethereum Tracker + Intelligence Platform

Real-time ETH price tracker with candlestick charts, pattern recognition, live order flow, news sentiment with per-day AI verdicts, saved **Oracle** marker sets with Claude prophecy, 7-day AI forecast engine, **Master Predict daily report (Opus streaming)**, **Reddit RSS pull + user post scoring**, ETHWEATHER climate dashboard, admin intelligence panel, four themes, and persistent user preferences.

## Quick Start

```bash
npm install
# Fill in .env (see Environment Variables)
npm start
# Open http://localhost:3000
# Admin: http://localhost:3000/admin
# Weather: http://localhost:3000/weather
```

## Architecture

**Backend:** Node.js / Express in `server.js`. Serves the frontend, proxies all external APIs, persists cache to disk + SQLite.
- `db.js` — SQLite schema + prepared statements (`better-sqlite3`). Creates `data.db` next to the server.
- `services/newsapi.js` — NewsAPI.org fetcher with per-date caching and delta inserts.
- `services/monthly.js` — orchestrates per-day sentiment: ETH/BTC daily bars + headlines + Claude batched verdicts (Haiku 4.5, tool-use for strict JSON).
- `services/oracle.js` — Claude Sonnet 4.6 pattern prophecy engine over saved marker sets.
- `services/forecast.js` — Claude Sonnet 4.6 7-day AI forecast engine. Pattern-completion over 7–90 days of history. 28-point (every 6h) trajectory. Served from in-memory cache (30min TTL) with SQLite DB fallback on cold start.
- `services/marketvitals.js` — funding rate, OI, BTC dominance, Fear & Greed, gas, hash rate, MACD, Bollinger.
- `services/buyadvisor.js` — buy/sell/hold advisor using vitals + sentiment.
- `services/orderflow.js` — Binance WebSocket trade aggregation.

**Frontend:** Vanilla JS, no build step. Modules in `public/js/`:
- `app.js` — core state, line chart (Chart.js), RSI, alerts, themes, prefs sync. Custom `#lineTooltip` for all hover (history + forecast). Native Chart.js tooltip disabled.
- `candlestick.js` — TradingView Lightweight Charts + synced news strip + marker persistence + forecast overlay with crosshair tooltip.
- `orderflow.js` — Binance WebSocket live trades (last buy / last sell only; `MAX_ROWS = 1`)
- `news.js` — RSS news + AI 24h summary
- `monthly.js` — 30-day sentiment strip + day-detail modal
- `oracle.js` — save-set dialog, list, Claude prophecy rendering
- `forecast.js` — AI 7-day forecast modal, day cards in strip, chart overlay wiring
- `chips.js` — chip popup explanations + drag-and-drop chip layout (persisted to localStorage)

**Pages:**
- `/` — ETHWATCH main tracker (clients only — no admin/weather links shown)
- `/weather` — ETHWEATHER climate dashboard (shares same DB; clients navigate back to ETHWATCH)
- `/admin` — Admin intelligence panel (not linked from client pages; direct URL access only)

## External APIs

| API | Auth | Purpose |
|-----|------|---------|
| CoinGecko (free) | None | Price, OHLC, history, market data |
| Binance WebSocket | None | Live ETHUSDT trade stream |
| Anthropic Claude | `ANTHROPIC_API_KEY` | News sentiment, pattern interpretation, per-day monthly verdicts, Oracle prophecy, 7-day forecast |
| NewsAPI.org (free) | `NEWSAPI_KEY` | Historical per-day crypto headlines (30-day archive, ~24h article delay on free tier) |
| RSS feeds | None | CoinDesk, Cointelegraph, CryptoSlate, Decrypt, CryptoPotato — current news feed |

CoinGecko free tier rate limit ≈ 10–30 req/min. We back off 60s on any 429 and serve stale data from disk cache during the cooldown.

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
   - `daily_sentiment` — per-day ETH/BTC moves + Claude verdict/score/summary + hope_score/macro_score
   - `daily_headlines` — per-day NewsAPI headlines, PK `(date, category, url)` → natural dedupe
   - `news_fetch_log` — soft throttle for empty / errored days, keyed `(date, category)`
   - `user_prefs` — currency, range, theme, indicators (server-synced on each click)
   - `marker_sets` + `marker_points` — saved Oracle pattern sets with embedded ETH OHLC per marker
   - `prediction_history` — all AI forecasts + Oracle + pattern predictions with accuracy tracking

## API Endpoints

| Endpoint | Method | Params / Notes |
|----------|--------|----------------|
| `/api/eth-price` | GET | Current price USD+EUR, 24h change, market cap, volume |
| `/api/eth-history` | GET | `days` (`1,7,30,90,365,max`), `currency`. Prices + SMA20, EMA50, RSI14 |
| `/api/eth-ohlc` | GET | `days`, `currency`. OHLC candles. Synthesizes from cache on CoinGecko 429. |
| `/api/eth-info` | GET | ATH, ATL, rank, supply, multi-period changes |
| `/api/patterns` | GET | Top 5 cosine-similar 24h patterns from 90-day history |
| `/api/news` | GET | ETH-filtered news from RSS + CoinGecko |
| `/api/news/ai-summary` | POST | Claude analysis of last 24h headlines (30min cache) |
| `/api/predict-pattern` | POST | Similarity search + optional Claude interpretation |
| `/api/monthly-sentiment` | GET | `days` (default 30), `currency`. Per-day ETH/BTC moves + verdict + top headlines |
| `/api/monthly-sentiment/rescore` | POST | Clear + rebuild last N days of Claude verdicts |
| `/api/day-detail` | GET | `date=YYYY-MM-DD`. All stored headlines + sentiment for one day |
| `/api/prefs` | GET/POST | User-pref key/value map, server-side persistent |
| `/api/marker-sets` | GET | List saved Oracle sets (+ last prophecy) |
| `/api/marker-sets/:id` | GET | One set: metadata + marker points |
| `/api/marker-sets` | POST | Create Oracle set with marker points |
| `/api/marker-sets/:id` | DELETE | Cascades to points |
| `/api/marker-sets/:id/oracle` | POST | Runs Claude Sonnet prophecy; persists + returns result |
| `/api/forecast-7d` | GET | Current 7-day AI forecast (30min cache, DB fallback on cold start) |
| `/api/forecast-7d/history` | GET | `limit` (default 10). Past ai_forecast rows from DB. |
| `/api/market-vitals` | GET | Funding rate, OI, BTC dom, Fear&Greed, gas, hash, RSI, EMA, MACD, Bollinger |
| `/api/predictions/history` | GET | `limit`, `type`. Full prediction history with accuracy scores. |
| `/api/admin/stats` | GET | `days`. Sentiment stats: verdict %, avg hope/macro, war days, forecast accuracy. |
| `/api/admin/run-forecast` | POST | `{history_days}`. Force new Claude forecast (7/15/30/90 day window). Saves to DB + updates live cache. |
| `/api/admin/rescore-sentiment` | POST | `{days}`. Re-run Claude verdicts on last N days. |
| `/api/admin/prediction` | POST | Save manual prediction as ai_forecast type. Becomes live immediately. |
| `/api/admin/set-live-forecast/:id` | POST | Promote a stored forecast to live in-memory cache. All clients get it on next refresh. |

## Cache TTLs

| Layer | TTL |
|-------|-----|
| Price | 25s |
| History (short-range) | 60s |
| History (90+ days) | 5 min |
| OHLC | 60s |
| RSS news | 5 min |
| AI 24h summary | 30 min |
| 7-day forecast | 30 min in-memory; DB row permanent |
| `daily_sentiment` verdict/summary | Permanent — Claude only re-runs for dates missing a verdict |
| NewsAPI headlines (historical) | Permanent — written once per date |
| NewsAPI headlines (today + yesterday) | 1h refresh cadence, delta-insert only |
| Oracle prophecy | Persisted on the set; re-run only on explicit Invoke |

## Technical Indicators

Server-side:
- **SMA(n)** — rolling mean of last n closes
- **EMA(n)** — Wilder's exponential average, k = 2/(n+1)
- **RSI(14)** — Wilder's smoothing; >70 overbought, <30 oversold

## Chart Tooltips (v1.1)

**Single unified tooltip** (`#lineTooltip` / `#lwTooltip`) — native Chart.js tooltip is disabled.

**Line chart (`#lineTooltip`):**
- History region: date + time, close price, ▲/▼ % move vs previous point (green/red)
- Forecast region: date + time, interpolated forecast price, direction (▲/▼/→), confidence %, low/high band
- Hides cleanly when cursor enters forecast region where no history exists

**Candle chart (`#lwTooltip`):**
- History bars: date + time, close price, ▲/▼ %, OHLC row; plus AI forecast badge (direction + confidence) if a forecast is active
- Forecast region (beyond last candle): date + time, interpolated forecast price, direction, confidence %, low/high band

## 7-Day AI Forecast Engine (`services/forecast.js`)

Claude Sonnet 4.6 pattern-completion engine:
1. Admin chooses history window: **7 / 15 / 30 / 90 days** of daily bars + news
2. Claude scans for the strongest historical analog (shape, momentum, macro/hope regime)
3. Returns 28-point (every 6h × 7 days) trajectory + daily_breakdown + pattern_match + key_drivers + risks
4. Result saved to `prediction_history` DB and promoted to in-memory cache
5. **Clients (Watch + Weather) always receive the most recent stored forecast** — no generation wait

Admin controls (no forecast controls on client pages):
- Run new AI forecast with chosen data window
- Set any past forecast as live (instantly promotes to cache)
- Save manual prediction (direction + move% + confidence + narrative) — also becomes live

## ETHWEATHER (`/weather`)

Separate weather-themed landing page sharing the same SQLite DB:
- **Animated sky** — changes based on ETH 24h move: 🌈→☀️→⛅→🌥️→🌧️→⛈️→🌪️ with rain + lightning effects
- **7-day forecast strip** — weather cards (click → modal with 6h trajectory, key events, drivers). TODAY card always first.
- **Forecast meta banner** — direction badge, confidence %, narrative, analog pattern, generated timestamp
- **Past Forecasts section** — DB history; VIEW any past forecast in the strip
- **8 Weather Vitals** — RSI=Temperature, Volume=Humidity, Funding=Wind, BTC Dom=Pressure, F&G=Lightning, OI=Tide, BB Width=Visibility, Gas=Traffic
- **Storm Alerts** — today's headlines as Crypto Advisory / Macro Storm Warning / Hope Signal
- **30-day Climate History** — scrollable strip of weather icons + hope bar, click → full day modal
- Back-link to ETHWATCH only; no admin link shown to clients

## Admin Panel (`/admin`)

Direct URL only — not linked from client pages.
- **Sentiment Overview** — stat cards + bar charts for Bullish/Bearish/Neutral %, Avg Hope (0–100), Avg Macro (−100..+100), War/Crisis days, Forecast Accuracy. Period picker: 7D / 14D / 30D / 60D
- **Run AI Forecast** — data window picker (Last 7 Days / Last 15 Days / Last Month / Last 3 Months), then triggers Claude, saves result, makes it live
- **Rescore Sentiment** — re-run Claude on last N days
- **Make New Prediction** — manual direction + move% + confidence + headline → saves as ai_forecast, instantly live
- **Prediction History table** — all past forecasts with Set Live button; current live row highlighted

## Pattern Recognition (cosine similarity)

90 days of hourly closes. Each 24-hour window's log-return sequence is cosine-compared against the current 24-hour window. Threshold >0.65. Returns top 5 matches with outcome stats.

## Candlestick — Middle Candle Detection

A candle is a "middle candle" (doji/spinning top) when `body / range < 0.25`. Marked with yellow **M** below the bar. Users click candles to mark setups for Oracle or pattern prediction.

## Synced News Strip (candle view, 1M range)

Below the candlestick chart in 1M mode: one tile per candle absolutely-positioned via `timeScale().timeToCoordinate()`. Each tile shows date, ETH move%, top headline, verdict color. Click → day-detail modal.

## 30-Day Sentiment Strip (line view, 1M range)

Each day: verdict tile (bullish/bearish/neutral) + hope bar. 7 forecast day tiles injected after the historical tiles, re-injected after any `renderStrip()` call. Click → day-detail modal.

### News categories

| Category | Query focus |
|----------|-------------|
| `crypto` | Ethereum, bitcoin, ETF, SEC, regulation, hack |
| `macro`  | World economy, recession, inflation, war, sanctions, geopolitics |
| `hope`   | Breakthrough, peace, humanitarian, renewable, rescue, innovation |

### Claude scoring (batched, Haiku 4.5)

For each day missing verdict/hope_score/macro_score: one batched call returns verdict + score + summary + hope_score + hope_summary + macro_score + macro_summary. Stored in `daily_sentiment`.

## ORACLE (Neural Pattern Prophecy)

1. User marks candles → **Save as Oracle Set** with name + description + prediction.
2. **Invoke Oracle** runs `services/oracle.js` — enriches each marker with sentiment + headlines, sends to Claude Sonnet 4.6 `submit_prophecy` tool.
3. Returns `{direction, confidence, horizon, expected_move_pct, user_hypothesis_verdict, narrative, key_signals, risk_factors}`.
4. Persisted on the set; re-run only on explicit click.

## Chip Popups + Drag-and-Drop (`chips.js`)

All 26 header/hero/footer data chips have `data-chip-key`. Click → floating popup with title + explanation. Chips are draggable between 8 labeled drop zones. Layout persisted to `localStorage` key `chipLayout_v1`.

## Order Flow (Binance WebSocket)

Browser → `wss://stream.binance.com:9443/ws/ethusdt@aggTrade`. `m=true` → sell pressure; `m=false` → buy pressure. 5-minute rolling window. Feed shows only last buy + last sell (`MAX_ROWS = 1`).

## Themes (4)

| Theme | Vibe |
|-------|------|
| `dark` (default) | GitHub dim — navy bg, soft text, blue accent |
| `light` | GitHub light |
| `dystopian` | Blade Runner — deep indigo-black, neon magenta + amber + cyan |
| `matrix` | Phosphor green on pure black, monospace, scanline overlay |

All colors are CSS custom properties. Chart.js and Lightweight Charts destroy/re-create on theme change.

## User Preferences (persistent)

Debounced `POST /api/prefs` on: currency, range, theme, indicator toggles.
Keys: `currency`, `days`, `theme`, `indicators` (`{sma20, ema50, volume}`), `darkMode` (legacy).
Boot: `localStorage` first (zero flash), then `GET /api/prefs` applied.

## Dev Notes

- No auth layer. All API routes are public. Admin at `/admin` is security-by-obscurity only.
- If CoinGecko 429s on a cold server, wait ~60s (automatic cooldown) — disk cache absorbs it.
- `npm run dev` uses nodemon for file-watch restart.
- `data.db` + `cache/` directory are user-scoped state; delete to reset.
- Pattern window size (24h) and middle-candle threshold (0.25) are hardcoded constants.
- Forecast `services/forecast.js` uses a `const cache = {}` object mutated in-place so `getCache()` always returns the live reference — enables admin set-live to work across module boundaries.
