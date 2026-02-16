const express = require('express');
const router = express.Router();
const db = require('../db.cjs');

// Prepared statements (created once, reused on every request)
const selectAll = db.prepare('SELECT id, symbol, added_at FROM watchlist ORDER BY added_at');
const selectOne = db.prepare('SELECT id FROM watchlist WHERE symbol = ?');
const insertOne = db.prepare('INSERT INTO watchlist (symbol) VALUES (?)');
const deleteOne = db.prepare('DELETE FROM watchlist WHERE symbol = ?');

router.get('/', (req, res) => {
  const rows = selectAll.all();
  res.json({
    success: true,
    count: rows.length,
    watchlist: rows,
  });
});

router.post('/', (req, res) => {
  const { symbol } = req.body;

  if (!symbol) {
    return res.status(400).json({
      success: false,
      message: 'Stock symbol is required',
    });
  }

  const upper = symbol.toUpperCase();

  if (selectOne.get(upper)) {
    return res.status(409).json({
      success: false,
      message: 'Stock already in watchlist',
    });
  }

  insertOne.run(upper);

  res.json({
    success: true,
    message: 'Stock added successfully',
    watchlist: selectAll.all(),
  });
});

router.delete('/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  const result = deleteOne.run(symbol);

  if (result.changes === 0) {
    return res.status(404).json({
      success: false,
      message: 'Stock not found in watchlist',
    });
  }

  res.json({
    success: true,
    message: 'Stock removed',
    watchlist: selectAll.all(),
  });
});

module.exports = router;
