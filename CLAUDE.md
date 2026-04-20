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
- `services/forecast.js` — Claude Sonnet/Opus 7-day AI forecast. Single-window + combined multi-window (7/15/30/60/90d Opus synthesis). 28-point (every 6h) trajectory. Cache→DB→throw (no auto-Claude). Every forecast stamps `{kind, system, prompt_hash, tool_schema}` for audit.
- `services/marketvitals.js` — funding rate, OI, BTC dominance, Fear & Greed, gas, hash rate, MACD, Bollinger.
- `services/buyadvisor.js` — Sonnet + Advanced Opus buy/hodl/sell. Opus path hard-gates on a same-day Opus 7d forecast, consumes `sentiment_aggregates`, user_posts, break-speed discipline, ETH/BTC tripwire, friction-vs-fuel funding language.
- `services/masterpredict.js` — **NEW in v1.3**. Opus 4.7 streaming daily master report: 90d sentiment + 14d headlines + vitals + order flow + 30d user posts + latest Opus forecast + latest Opus buy advice → today_verdict/feeling/executive_summary, key_data_points, critical_contradictions, invalidation_levels (w/ break-speed note), action_plan, 500-900 word markdown narrative. Served over SSE with 10s keep-alive pings, 3 transient-retry loop.
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
   - `prediction_history` — all AI forecasts + Oracle + buy-advice + **master_report** rows; each row persists `raw_result.prompt = {kind, system, prompt_hash, tool_schema}` + `context_digest` + `response_meta` for full accuracy attribution
   - `user_posts` — freeform-imported / Reddit-RSS-pulled community posts with Sonnet-scored `hope_score`, `war_score`, `people_sentiment`, summary
   - `buy_recommendations` — Sonnet + Opus Buy/HODL/SELL history, indexed by ts

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
| `/api/admin/master-predict-stream` | GET (SSE) | **NEW v1.3**. Streams Opus master report with 10s keep-alive pings. Final `{done, data}` or `{error}` event. |
| `/api/admin/master-predict/latest` | GET | Last 5 master_report rows. |
| `/api/admin/posts-stats` | GET | Today + 7d aggregates: user-post counts, hope/war avgs, sentiment breakdown, top sources, daily sentiment, headline counts, order-flow digest. |
| `/api/user-posts/import` | POST | Freeform text/JSON → Sonnet-scored user_posts (JSON fast-path + prose slow-path). |
| `/api/user-posts/fetch-reddit` | POST | **NEW v1.3**. Pulls subreddit RSS feeds (browser UA + old.reddit + `.json` fallbacks) → Sonnet-scored, saved to `user_posts`. |
| `/api/user-posts/counts` | GET | Per-date counts for imported user posts. |
| `/api/buy-time-advanced` | GET | Advanced Opus Buy/HODL. Returns 412 `NEED_OPUS_FORECAST` if today's Opus 7d forecast hasn't been generated. |

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

## Prediction Layers (v1.3)

Four stacked AI layers, each consumes the outputs of the layers below it. Every output stamps `{kind, system, prompt_hash, tool_schema}` into `prediction_history.raw_result.prompt` for full attribution.

**Layer 1 — Scoring (persistent cache)**
- `Haiku 4.5` batched per-day sentiment → `daily_sentiment` (verdict, hope_score 0-100, macro_score −100..+100, summary). Hourly timer re-runs today; all other days are one-shot cached. No auto-Claude.
- `Sonnet 4.6` user-post scoring (10 posts/batch) → `user_posts` (hope_score, war_score, people_sentiment, summary).

**Layer 2 — 7-day Forecast** (`services/forecast.js`)
- Single-window: Sonnet 4.6 over chosen 7/15/30/90 day history.
- Combined Multi-Window Sonnet: 3 parallel sub-forecasts + synthesis = 4 Sonnet calls.
- **Advanced Opus Max Layers**: 5 sub-forecasts (7, 15, 30, 60, 90 days) + synthesis = **6 Opus calls**. Returns direction, confidence, 28-point 6-hourly trajectory, daily_breakdown, pattern_match, key_drivers, risks.
- Prompts weave ETH/BTC tripwire, friction-vs-fuel funding calibration, break-speed discipline, 2-3 week lead time, second-higher-low confirmation.

**Layer 3 — Buy/HODL Advice** (`services/buyadvisor.js`)
- Sonnet path: 30d sentiment + week headlines + vitals + order flow → BUY/HODL/SELL.
- **Advanced Opus path** (1 Opus call): HARD-GATED on a same-day Opus 7d forecast (returns HTTP 412 + `NEED_OPUS_FORECAST` if missing). Consumes 90d sentiment, 2w headlines, vitals, order flow, 30d user_posts, sentiment_aggregates (hope/macro 7d+30d avgs + momentums, war_days_14d), plus the Layer-2 forecast as default direction. Must cite ≥1 hope number and ≥1 macro/war signal.

**Layer 4 — Master Predict Report** (`services/masterpredict.js`, v1.3)
- 1 Opus 4.7 call, streamed via SSE. Synthesizes **everything** above (Layer-1 aggregates + Layer-2 forecast + Layer-3 advice) plus 14d headlines, vitals, order flow, and user_posts directly. Produces today_verdict + bias + confidence + timeframe + headline + today_feeling + executive_summary + sentiment_analysis + technical_analysis + forecast_alignment + buy_advice_alignment + key_data_points + critical_contradictions + what_could_flip_this + invalidation_levels (ETH + ETH/BTC + break-speed note) + action_plan + **500-900 word markdown narrative**.
- Full end-to-end Master Report cost: ~1 Haiku + ~8 Opus calls.

**Client delivery:** Watch and Weather pages always serve the most recent stored forecast — no generation wait. Admin buttons are the only auto-Claude triggers except for the hourly today-sentiment timer.

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
- **📊 Posts & Feeds Stats** (v1.3) — two-column card (TODAY / LAST 7D) showing user-post counts, hope/war averages, bull/bear sentiment ratio, top post sources, daily sentiment aggregates, headline counts per category, and order-flow buy/sell volume digest
- **🎯 Master Prediction Report** (v1.3) — gradient RUN button streams Opus synthesis of every data source. Opens modal with verdict/bias/confidence strip, today's feeling, key data points grid, sentiment/technical analysis, Opus-forecast + buy-advice alignment blocks, contradictions, invalidation levels, action plan, full markdown narrative, **📋 Copy JSON / 💾 Download / { } View** buttons for pasting into another Claude, and a "Data Used for This Prediction" footer (digest of what fed the prompt)
- **Run AI Forecast** — data window picker (Last 7/15/30/90 Days) + bias picker (Today's Data / Force Upward / Force Downward) → single-window Sonnet, Combined Multi-Window Sonnet, or Advanced Opus Max-Layers (5 windows + synthesis)
- **Rescore Sentiment** — re-run Claude on last N days
- **Refresh Buy/HODL Advice** — Sonnet path + Advanced Opus path. Opus is hard-gated on a same-day Opus 7d forecast (actionable error in UI if missing)
- **📥 Import User Posts** — paste freeform JSON/prose/markdown; Sonnet extracts + scores `hope_score`, `war_score`, `people_sentiment`
- **🟠 Pull Reddit RSS** (v1.3) — configured subreddit list; browser-UA + old.reddit + `.json` fallbacks bypass Reddit's 403 blocks
- **Prediction History table** — all past forecasts + buy advice + master reports with Set Live button, 📝 Prompt viewer (shows exact system prompt + hash used for that prediction), current live row highlighted

## Pattern Recognition (cosine similarity)

90 days of hourly closes. Each 24-hour window's log-return sequence is cosine-compared against the current 24-hour window. Threshold >0.65. Returns top 5 matches with outcome stats.

## Candlestick — Middle Candle Detection

A candle is a "middle candle" (doji/spinning top) when `body / range < 0.25`. Marked with yellow **M** below the bar. Users click candles to mark setups for Oracle or pattern prediction.

## Synced News Strip (candle view, 1M range)

Below the candlestick chart in 1M mode: one tile per candle absolutely-positioned via `timeScale().timeToCoordinate()`. Each tile shows date, ETH move%, top headline, verdict color. Click → day-detail modal.

## Unified Day Strip (v1.3)

One `#monthStrip` element, shared between line and candle modes. Both hook tiles to the **active chart's native time→pixel function** in a single `_layoutStrip()` (monthly.js):
- Line mode: Chart.js `scale.getPixelForValue(tms)` — tiles center on their date's chart x.
- Candle mode: Lightweight Charts `timeScale().timeToCoordinate(tms_sec)` + linear extrapolation from known bar pxPerMs for forecast dates beyond the last candle.
- UTC-day `Math.floor` bucket dedup so TODAY (noon UTC) and D1 (anchor+24h) never collide in the same slot.
- Tiles outside the chart's visible range are `display:none`; `.chart-wrapper { overflow: hidden }` clips stragglers.
- Fires on Chart.js `afterRender` (line) and Lightweight Charts `subscribeVisibleTimeRangeChange` (candle) → tiles drag with the chart during pan/zoom.
- Hover: no Y-translate, just `box-shadow` + `z-index: 30` so tiles stay anchored and just pop forward.

Forecast cards are re-injected by `renderForecastDayCards` after any `renderStrip()` rebuild.

## Forecast Overlay Rendering (v1.3)

- **Line chart** (Chart.js): raw 28-point 6-hourly trajectory drawn as-is with Bezier tension; time-based x-axis handles density automatically.
- **Candle chart** (Lightweight Charts): forecast line is **resampled to match the OHLC bar interval** (4h for 1W, daily for 1M). Pipeline: `_fillForecastTrajectory(prophecy)` (fills 28-point grid + weaves in `daily_breakdown` end-of-day anchors via linear interpolation between known neighbors) → detect interval from OHLC bar spacing → resample at that interval → dedup by time → `setData()` → `fitContent()`. This keeps the history+forecast chart split proportional to their wall-clock time spans instead of being dominated by bar-count ratio (Lightweight Charts uses strict bar-based spacing).
- Overlay active on both **1W and 1M** ranges (v1.3). 1D locks the view (single-day); 3M/1Y too far out to read.
- 1M pan limit extends 8 days past history so the forecast is scrollable into view.

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

**Staleness safeguards (v1.3):**
- Each chip update tracks `lastShownBuyTs` / `lastShownSellTs`. Older updates are ignored.
- Server's independent Binance→SQLite pipeline is polled every 5s; if its `last_buy.ts` is newer than the client's locally-shown chip, the server value wins — prevents chip freezing when the browser WS silently lags.
- WS staleness watchdog: if no aggTrade received in 30s, force-reconnect.

## User Posts Import (v1.3)

Freeform input pipeline (`services/-none-`, in server.js). Paste JSON, CSV, markdown, prose, chat-log — Sonnet 4.6 figures out the structure:
- **Fast path (JSON detected):** local wrapper-key scan (`posts`, `items`, `entries`, `data`, `results`, `messages`, …) extracts entries → batches of 10 sent to `score_posts` Sonnet tool → parallel hope/war/people_sentiment scoring.
- **Slow path (prose):** single Sonnet `extract_and_score_posts` call — infers dates/sources from context, falls back to import date.
- 90s per-call `withTimeout`, 3 min client AbortController. Live elapsed-seconds counter so users see progress.
- **Reddit RSS** (`/api/user-posts/fetch-reddit`): Chrome browser UA + `Accept: text/html,application/xhtml+xml,...` + `Sec-Fetch-*` headers + fallback chain `www.reddit.com/.rss → old.reddit.com/.rss → /r/<sub>/.json → old.reddit/.json`. Parses Atom feeds via `xml2js` directly (rss-parser's internal fetch was getting Reddit-403'd). Each subreddit feed reported per-feed OK/fail with HTTP status.

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
