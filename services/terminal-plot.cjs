const { money } = require('./portfolio.cjs');

// Each terminal cell has two columns and four rows of Braille dots.
const dots = [[1, 8], [2, 16], [4, 32], [64, 128]];
const maxGapMs = 3 * 60_000;

function plotEquity(points, currency, columns, rows = 6, inspectable = false) {
  let low = points[0].equity, high = low;
  for (const point of points) {
    low = Math.min(low, point.equity);
    high = Math.max(high, point.equity);
  }
  const first = points[0], last = points.at(-1);
  const flat = low === high;
  const topLabel = flat ? 'Steady' : 'High ' + money(high, currency);
  const bottomLabel = flat ? '' : 'Low ' + money(low, currency);
  const labelSize = Math.max(topLabel.length, bottomLabel.length);
  const available = columns - labelSize - 4;
  const width = Math.max(2, Math.min(110, available));
  const height = flat ? 1 : Math.max(2, rows);
  const cells = Array.from({ length: height }, () => new Uint8Array(width));
  const samples = inspectable ? [] : null;
  const marked = new Set();
  function put(x, y) {
    cells[y >> 2][x >> 1] |= dots[y % 4][x % 2];
  }
  let previous, gaps = false;
  for (const point of points) {
    const x = last.time > first.time ? Math.round((width * 2 - 1) * (point.time - first.time) / (last.time - first.time)) : 0;
    const y = flat ? 1 : Math.round((height * 4 - 1) * (high - point.equity) / (high - low));
    put(x, y);
    samples?.push({ column: x >> 1, row: y >> 2, point });
    if (previous) {
      if (point.time - previous.time <= maxGapMs) {
        const steps = Math.max(Math.abs(x - previous.x), Math.abs(y - previous.y));
        for (let i = 1; i < steps; i++) {
          put(Math.round(previous.x + (x - previous.x) * i / steps), Math.round(previous.y + (y - previous.y) * i / steps));
        }
      } else {
        gaps = true;
        marked.add((previous.y >> 2) * width + (previous.x >> 1));
        marked.add((y >> 2) * width + (x >> 1));
      }
    }
    if (point === first || point === last) marked.add((y >> 2) * width + (x >> 1));
    previous = { x, y, time: point.time };
  }
  const lines = cells.map((row, i) => {
    const label = i === 0 ? topLabel : i === height - 1 ? bottomLabel : '';
    const line = Array.from(row, (bits, j) => marked.has(i * width + j) ? '●' : bits ? String.fromCharCode(0x2800 + bits) : ' ').join('').trimEnd();
    return label.padStart(labelSize) + ' │ ' + line;
  });
  if (width >= first.tick.length + last.tick.length + 1 && first.time !== last.time) {
    lines.push(' '.repeat(labelSize + 3) + first.tick.padEnd(width - last.tick.length) + last.tick);
  }
  const geometry = samples && { left: labelSize + 3, height, samples, cells };
  return { lines, gaps, geometry };
}

// Pick by time column. If readings share a column, their heights break the tie.
function pointAt(plot, column, row) {
  if (!plot) return -1;
  const x = column - plot.left, y = row - plot.top;
  if (!plot.cells[y]?.[x]) return -1;
  let index = -1, closestColumn = Infinity, closestRow = Infinity;
  for (const [i, sample] of plot.samples.entries()) {
    const dx = Math.abs(sample.column - x), dy = Math.abs(sample.row - y);
    if (dx < closestColumn || (dx === closestColumn && dy < closestRow)) {
      index = i;
      closestColumn = dx;
      closestRow = dy;
    }
  }
  return index;
}

module.exports = { plotEquity, pointAt, maxGapMs };
