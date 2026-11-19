require('dotenv').config();
const express = require('express');

const watchlistRoutes = require('./routes/stocks.cjs');
const marketDataRoutes = require('./routes/movers.cjs');
const { startScheduler, checkAndNotifyOnce } = require('./services/notifications.cjs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// --- Health / debug routes ---------------------------------------------------

app.get('/', (req, res) => {
  res.send('Stock Watchlist API Server - Ready for Trading');
});

app.get('/test-env', (req, res) => {
  res.json({
    port: PORT,
    hasApiKey: !!process.env.ALPHA_VANTAGE_KEY,
    apiKeyConfigured: process.env.ALPHA_VANTAGE_KEY ? 'Yes' : 'No - Add to .env file',
    serverStatus: 'Operational',
    timestamp: new Date().toISOString(),
  });
});

// --- Feature routes ----------------------------------------------------------

app.use('/watchlist', watchlistRoutes);
app.use('/prices', marketDataRoutes);

app.get('/test-notification', async (req, res) => {
  try {
    await checkAndNotifyOnce();
    res.json({ success: true, message: 'Test notification triggered' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Global error handler ----------------------------------------------------

app.use((err, req, res, _next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
  });
});

// --- Start -------------------------------------------------------------------

startScheduler();

const server = app.listen(PORT, process.env.WATCHLIST_HOST, () => {
  console.log(`Server is running on http://localhost:${server.address().port}`);
});
