const notifier = require('node-notifier');
const cron = require('node-cron');
const axios = require('axios');

const WATCHLIST = ['AC.TO'];
const BASE_URL = process.env.ALERT_BASE_URL || 'http://localhost:4321';
const SCHEDULE = '30 17 * * 1-5'; // 17:30 Toronto

async function fetchSymbol(symbol) {
  const url = symbol === 'AC.TO'
    ? `${BASE_URL}/prices/test-ac`
    : `${BASE_URL}/prices/${encodeURIComponent(symbol)}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data;
}
function notifyClose(data) {
  const price = Number(data.price);
  const message = `Close: $${Number.isFinite(price) ? price.toFixed(2) : data.price} • Date: ${data.date || 'n/a'}`;

  notifier.notify({
    title: `EOD Close: ${data.symbol || 'Unknown'}`,
    message,
    sound: true,
    wait: true,
    timeout: 15,
  }, (err, response, metadata) => {
    if (err) console.error('notify error', err);
  });
}

async function checkAndNotifyOnce() {
  for (const symbol of WATCHLIST) {
    try {
      const data = await fetchSymbol(symbol);
      if (data?.success) notifyClose(data);
    } catch (err) {
      console.error(`[alerts] ${symbol} fetch failed:`, err.message);
    }
  }
}

function startScheduler() {
  cron.schedule(SCHEDULE, async () => {
    await checkAndNotifyOnce();
  }, { timezone: 'America/Toronto' });

  console.log('[alerts] EOD scheduler started (Mon–Fri, 17:30 America/Toronto)');
}

module.exports = { startScheduler, checkAndNotifyOnce };
