# Stock Watchlist API

A Node.js backend for tracking stocks. Add symbols to your watchlist, fetch daily market data from Alpha Vantage, and get desktop notifications at market close.

## Features

- **Watchlist CRUD** – Add, view, and remove stock symbols (persisted in SQLite)
- **Market Data** – Fetch daily OHLCV data with analytics (change %, volatility, volume category, trend signals)
- **EOD Notifications** – Scheduled desktop alerts at 5:30 PM (Toronto time) every weekday with closing prices

## Tech Stack

- Node.js / Express
- SQLite (via better-sqlite3)
- Alpha Vantage API
- node-cron (scheduling)
- node-notifier (desktop alerts)

## Setup

```bash
# Clone and install
git clone <your-repo-url>
cd stock_watchlist
npm install

# Add your API key
cp .env.example .env
# Edit .env and add your Alpha Vantage key (free at https://www.alphavantage.co/support/#api-key)

# Start the server
npm run dev
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3000` |
| `ALPHA_VANTAGE_KEY` | API key from Alpha Vantage | — (required) |
| `ALERT_BASE_URL` | Base URL for notification fetches | `http://localhost:4321` |

## API Endpoints

### Watchlist

**GET /watchlist** – View all tracked symbols

```
curl http://localhost:4321/watchlist
```

```json
{
  "success": true,
  "count": 1,
  "watchlist": [
    { "id": 1, "symbol": "AC.TO", "added_at": "2025-08-10 12:00:00" }
  ]
}
```

**POST /watchlist** – Add a symbol

```
curl -X POST http://localhost:4321/watchlist \
  -H "Content-Type: application/json" \
  -d '{"symbol": "AAPL"}'
```

```json
{
  "success": true,
  "message": "Stock added successfully",
  "watchlist": [
    { "id": 1, "symbol": "AC.TO", "added_at": "2025-08-10 12:00:00" },
    { "id": 2, "symbol": "AAPL", "added_at": "2025-08-10 14:30:00" }
  ]
}
```

**DELETE /watchlist/:symbol** – Remove a symbol

```
curl -X DELETE http://localhost:4321/watchlist/AAPL
```

### Market Data

**GET /prices/:symbol** – Fetch daily data + analytics for any symbol

```
curl http://localhost:4321/prices/AC.TO
```

```json
{
  "success": true,
  "symbol": "AC.TO",
  "date": "2025-08-08",
  "price": 22.35,
  "volume": 3842100,
  "open": 22.10,
  "high": 22.50,
  "low": 21.95,
  "analytics": {
    "dailyChange": 0.25,
    "dailyChangePercent": 1.13,
    "dailyRange": 0.55,
    "volatilityPercent": 2.46,
    "volumeCategory": "High"
  },
  "signals": {
    "trend": "Bullish",
    "gapStatus": "Normal Open",
    "liquidityStatus": "Good"
  },
  "timestamp": "2025-08-10T18:30:00.000Z"
}
```

### Utility

| Endpoint | Description |
|---|---|
| `GET /` | Health check |
| `GET /test-env` | Verify API key configuration |
| `GET /test-notification` | Trigger a test desktop notification |

## Project Structure

```
stock_watchlist/
├── server.cjs                # Express app entry point
├── db.cjs                    # SQLite database setup
├── routes/
│   ├── stocks.cjs            # Watchlist CRUD routes
│   └── movers.cjs            # Market data routes
├── services/
│   └── notifications.cjs     # EOD notification scheduler
├── .env                      # Environment variables (not committed)
└── package.json
```
