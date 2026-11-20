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
| `ALPHA_VANTAGE_KEY` | Used by HTTP market-data routes and as a terminal fallback | Optional for terminal use |
| `ALERT_BASE_URL` | Base URL for notification fetches | `http://localhost:4321` |

## Terminal watchlist

Run `npm run watchlist` in the project directory, or use `stocks` if you have the shell shortcut. Click the dropdown beside **Equity Trend** or type `range` at the `live>` prompt. Choose the last hour, past day, week, month (30 days), year (365 days), or since inception. Click an option or use ↑ and ↓ followed by Enter. Since inception starts with the first saved valuation in the account currency. When readings span at least two days, the live chart shows the opening reading and each day's last recorded balance.

**Today's P&L** compares current equity with the previous Eastern calendar day's last recorded balance. If that day has no reading, the comparison starts at today's first reading. The amount excludes recorded deposits and withdrawals. The percentage uses the opening balance. A manual balance change with no known funding or trade amount makes P&L unavailable for that comparison.

While `live>` is open, prices and FX refresh in place about once a minute. Type **details** to see each holding's price, quote time and FX, then **summary** to return to the selected range. Pressing **Enter** on an empty line with the dropdown closed pauses live updates and returns to `watchlist>`. Type **live** to resume or **graph** for the full recorded period.

Move the pointer across the live graph to see total equity and its change at the selected Eastern time. You can hover above or below the line in the same time column. Between readings, the marker follows the line and the time is labeled **Interpolated**. Moving outside the plot or into a time interval with no line restores the latest balance. At an empty `live>` prompt, use the left and right arrow keys to step through readings or Esc to return to the latest balance.

The live graph's horizontal axis covers the selected period. If you have two days of saved history, those readings fill only the last two days of the month or year view. Time before the first reading and after the last reading stays blank. Each complete live check in a new minute records a point. For gaps today between readings with matching shares and cash, the chart can also show estimated values using available Yahoo share prices and FX from the same completed minute. The caption counts these estimates. They assume those balances held throughout the gap and are used only for display. The last-hour view leaves gaps in minute coverage blank. Longer live ranges draw a line between available points. A broker's earlier equity curve requires that period's account history.

The watchlist values foreign holdings with the displayed FX rate. Questrade documents that its combined equity uses the previous business day's closing USD/CAD rate. Compare quotes from the same time and the same set of accounts when checking a difference. [Questrade account balances](https://www.questrade.com/learning/using-questrade/understanding-your-account-balances)

On the first interactive launch, type `y` to start setup. Portfolio totals default to Canadian dollars.

1. Enter the first stock's ticker, for example `T.TO` for TELUS on the TSX. The first ticker is required to record a holding. Type `none` for a cash-only account. Enter a foreign listing explicitly when you own one.
2. Enter the number of shares you currently own, including fractional shares.
3. If you know your average purchase price, enter what you paid **per share** in its trading currency. Press Enter to skip an unknown cost. At the ticker prompt, a blank line asks again. Enter another ticker or type **done** to continue to cash.
4. Enter the uninvested cash balance in the account. Use zero if all of the money is invested.
5. To check the account, enter the total equity your broker shows, including cash. Use the total from the same account and currency. Setup compares it with the value of your holdings plus cash before you save.
6. Optionally enter your own maximum percentage in one company (`20` means 20% of total equity) and how long until you expect to use the money (such as `5 years`).

Type **holdings** at any account question to return to your stocks. Type **done** when finished to resume the interrupted question. **back** returns to the preceding step. Backspace edits the text on the current line.

At **Review your profile**, enter the number for the field you want to change.

1. Add a holding or pick an existing holding by number.
2. Change uninvested cash.
3. Change your broker's total equity.
4. Change the reporting currency.
5. Change the maximum percentage in one company.
6. Change the time horizon.
7. Correct the starting equity used for the chart's dollar and percentage change (`edit baseline`).

You can also type a holding's ticker directly at review. Its own menu has **1** for the ticker, **2** for shares, **3** for average purchase price, **4** for the current broker price per share, and **5** for removal. For option 4, enter the price and currency shown by the broker, such as `18.50 USD`. A number alone uses the reporting currency. A newer market quote takes over automatically. Enter keeps a displayed value and `-` clears an optional value.

When you enter a broker total, the review shows each quantity × price, any currency conversion, cash, and the amount above or below that total. A missing price or exchange rate identifies the affected holding. Compare the quantities, prices, FX and cash with the same broker screen, correct the relevant field, then review the new calculation. Type **yes** to save once the totals match at the reporting currency's precision. You can clear the optional broker total in option 3 if you have no comparable figure. Type **cancel** to discard the draft.

At `watchlist>`, type **edit** for the menu, **edit T.TO** to change just that holding, or **edit cash** to jump straight to cash. Other field shortcuts are `edit holdings`, `edit broker`, `edit currency`, `edit limit` and `edit horizon`. Use `profile` to see your saved details.

The dashboard calculates total equity as cash plus the converted value of your shares. A new profile uses the confirmed opening broker total as its starting equity when supplied. Existing history and profiles without an entered opening use the first complete recorded balance in that currency. Later edits to the broker comparison leave the starting amount in place. Use `edit baseline` to correct the starting amount itself. Changes use the two balances at the displayed currency precision. Deposits and withdrawals count toward the change in equity. The dashboard reports unrealized investment gains separately.

```text
dashboard
ask T.TO What evidence would make me reconsider holding it?
budget 500
ask budget 500 How much of my cash could go to the strongest candidates?
alert T.TO below 15
monitor
compare SHOP.TO CLS.TO
ideas
quit
```

To record a purchase using account cash, enter `buy MSFT 2.5 150` with the number of shares purchased and your actual price per share in listing currency. `sell MSFT 1 160` credits the sale proceeds to cash. For a foreign trade the preview shows the estimated currency conversion. You can supply the actual cash debit or credit from your broker as the final argument, including any fees. For example, `buy MSFT 2.5 150 520` records a debit of 520 in your reporting currency. Review the cash and share changes and confirm with `y`. These commands record trades you have made at your broker.

Use `deposit 500` or `withdraw 100` for external cash movements. Recording a trade, a cash movement or a balance correction refreshes the graph. `dashboard` and `graph` value stocks and ETFs with the latest available dated Yahoo quote or one-minute price, a completed close, or a newer price you entered from your broker. They convert foreign prices using dated FX. A price or FX rate older than seven calendar days is excluded. When a valuation is incomplete the chart retains its last complete point. Reopening an unchanged one-shot dashboard on the same day reuses its last point.

Use `hold MSFT 2.5 150` to correct an existing share balance and average purchase price without moving cash. Changing the quantity this way without entering a new average clears the old cost basis. Use `remove MSFT` to delete an entry. One-shot commands also work, for example `npm run watchlist -- profile edit`.

`alert` accepts an upper or lower closing-price level for a holding. `monitor` checks every 15 minutes and rings the terminal bell on entry into the alert range. Keep that terminal running and use Ctrl+C to stop. `budget` models spending existing cash on the five screened companies, subject to your position limit and existing exposure. A scenario can leave cash unallocated.

`list` shows the dated daily close, the change from the previous close, and each position's market value. It converts holdings to CAD by default using dated FX rates. Set `WATCHLIST_CURRENCY` or pass a currency to `list` to change the reporting currency. Equity covers the shares you enter and excludes cash, debts, and fees. If a held position lacks a usable price or FX rate, or either is over seven days old, the output identifies the gap and shows a subtotal. Quotes and FX rates can have different timestamps.

Enter a company name or ticker to see its price trend, available financial metrics and research assessment. Canadian listings take priority for matching company names, and an explicit ticker selects its own listing. For ambiguous searches, pick a ticker from the results. `ideas` and `budget` screen the Toronto listings of Shopify, Constellation Software, Celestica, OpenText and Descartes Systems Group. The criteria include positive revenue growth, positive net margin and a trailing P/E of up to 30. The cutoff is a screening choice. Check the company's earnings and comparable valuations before using a result to make an investment decision.

Terminal commands use Yahoo Finance for completed daily prices, currency rates, financial metrics and related headlines. They work without an API key. Prices can be delayed, and Yahoo's public interfaces can throttle or change. If Yahoo FX is unavailable for USD/CAD, the monitor tries the Bank of Canada's dated daily average. A configured Alpha Vantage key provides a further fallback for prices, FX, searches and fundamentals. Set `WATCHLIST_MARKET_SOURCE=alpha` to use Alpha Vantage for those operations. The existing HTTP market-data endpoints and scheduled end-of-day desktop notifications still use Alpha Vantage. [Yahoo Finance exchange coverage](https://help.yahoo.com/kb/yahoo-finance-plus/partnerships-sln2310.html)

### Local AI

`ask` sends the question and displayed research to Ollama on this computer. Quotes and portfolio calculations come from the data services and SQLite. The model explains that evidence and can flag conditions to review a position. Read the dated evidence above its answer and check any claim that affects a trade.

On a Mac with Homebrew, a first-time local installation uses `brew install ollama`, `brew services start ollama`, then `ollama pull qwen3:4b` (about 2.5 GB for the model). Set `OLLAMA_MODEL` to select a different downloaded local model. The monitor's calculations, screens, alerts and scenarios work independently of Ollama. [Ollama model](https://ollama.com/library/qwen3:4b)

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
