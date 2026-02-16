const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'watchlist.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS watchlist (
    id  INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT    NOT NULL UNIQUE,
    added_at TEXT  NOT NULL DEFAULT (datetime('now'))
  )
`);

// Seed default symbols if the table is empty
const count = db.prepare('SELECT COUNT(*) AS cnt FROM watchlist').get();
if (count.cnt === 0) {
  const insert = db.prepare('INSERT INTO watchlist (symbol) VALUES (?)');
  const seedMany = db.transaction((symbols) => {
    for (const symbol of symbols) insert.run(symbol);
  });
  seedMany(['AC.TO', 'NVDA', 'CLS.TO']);
}

module.exports = db;
