const notifier = require('node-notifier');
const cron = require('node-cron');
const axios = require('axios');
const db = require('../db.cjs');

const BASE_URL = process.env.ALERT_BASE_URL || 'http://localhost:4321';
const SCHEDULE = '30 17 * * 1-5'; // 17:30 Toronto time, weekdays only

const selectSymbols = db.prepare('SELECT symbol FROM watchlist');

function getWatchlist() {
  return selectSymbols.all().map((row) => row.symbol);
}

async function fetchSymbol(symbol) {
  const url = `${BASE_URL}/prices/${encodeURIComponent(symbol)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data;
}

function notifyClose(data) {
  const price = Number(data.price);
  const priceStr = Number.isFinite(price) ? price.toFixed(2) : data.price;
  const message = `Close: $${priceStr} on ${data.date || 'n/a'}`;

  notifier.notify(
    {
      title: `EOD Close: ${data.symbol || 'Unknown'}`,
      message,
      sound: true,
      wait: true,
      timeout: 15,
    },
    (err) => {
      if (err) console.error('[alerts] notify error:', err);
    }
  );
}

async function checkAndNotifyOnce() {
  const symbols = getWatchlist();

  for (const symbol of symbols) {
    try {
      const data = await fetchSymbol(symbol);
      if (data?.success) notifyClose(data);
    } catch (err) {
      console.error(`[alerts] ${symbol} fetch failed:`, err.message);
    }
  }
}

function startScheduler() {
  cron.schedule(
    SCHEDULE,
    async () => {
      await checkAndNotifyOnce();
    },
    { timezone: 'America/Toronto' }
  );

  console.log('[alerts] EOD scheduler started (Mon-Fri, 17:30 America/Toronto)');
}

module.exports = { startScheduler, checkAndNotifyOnce };
