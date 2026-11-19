const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.WATCHLIST_DB || path.join(__dirname, 'watchlist.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

const initializeWatchlist = db.transaction(() => {
  const existingTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'watchlist'"
  ).get();
  if (existingTable) {
    if (!db.pragma('table_info(watchlist)').some(column => column.name === 'shares')) {
      db.exec('ALTER TABLE watchlist ADD COLUMN shares REAL NOT NULL DEFAULT 0 CHECK (shares >= 0)');
    }
    return;
  }

  db.exec(`
    CREATE TABLE watchlist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL UNIQUE,
      shares REAL NOT NULL DEFAULT 0 CHECK (shares >= 0),
      added_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO watchlist (symbol) VALUES ('AC.TO'), ('T.TO'), ('CLS.TO');
  `);
});

initializeWatchlist.immediate();

db.transaction(() => {
  const columns = new Set(db.pragma('table_info(watchlist)').map(row => row.name));
  for (const column of ['avg_cost', 'review_below', 'review_above']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE watchlist ADD COLUMN ${column} REAL CHECK (${column} >= 0)`);
  }
  if (!columns.has('broker_price')) {
    db.exec(`ALTER TABLE watchlist ADD COLUMN broker_price REAL CHECK (broker_price > 0);
      ALTER TABLE watchlist ADD COLUMN broker_price_currency TEXT;
      ALTER TABLE watchlist ADD COLUMN broker_price_at TEXT;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      currency TEXT NOT NULL, cash REAL NOT NULL CHECK (cash >= 0),
      broker_equity REAL, broker_date TEXT, max_weight REAL, horizon TEXT
    );
    CREATE TABLE IF NOT EXISTS portfolio_starting_equity (
      currency TEXT PRIMARY KEY, equity REAL NOT NULL CHECK (equity >= 0)
    );
  `);
  if (!db.pragma('table_info(portfolio_profile)').some(row => row.name === 'broker_date')) {
    db.exec('ALTER TABLE portfolio_profile ADD COLUMN broker_date TEXT');
  }

  // The original primary key allowed only one valuation per currency per day.
  const snapshotColumns = db.pragma('table_info(portfolio_snapshots)');
  const dailyHistory = snapshotColumns.length > 0 && !snapshotColumns.some(column => column.name === 'id');
  if (dailyHistory) db.exec('ALTER TABLE portfolio_snapshots RENAME TO daily_portfolio_snapshots');
  db.exec(`
    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id INTEGER PRIMARY KEY, date TEXT NOT NULL, recorded_at TEXT,
      currency TEXT NOT NULL, equity REAL NOT NULL, cash REAL,
      composition_key TEXT NOT NULL, activity TEXT
    );
    CREATE INDEX IF NOT EXISTS portfolio_snapshot_time ON portfolio_snapshots(currency, date, recorded_at, id);
  `);
  if (dailyHistory) {
    db.exec(`
      INSERT INTO portfolio_snapshots (date, currency, equity, composition_key, cash)
        SELECT date, currency, equity, composition_key,
          CASE WHEN json_valid(composition_key) THEN json_extract(composition_key, '$[1]') END
        FROM daily_portfolio_snapshots ORDER BY date;
      DROP TABLE daily_portfolio_snapshots;
    `);
  }
}).immediate();

module.exports = db;
