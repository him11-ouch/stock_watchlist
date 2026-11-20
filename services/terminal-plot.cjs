const { money } = require('./portfolio.cjs');

// Each terminal cell has two columns and four rows of Braille dots.
const dots = [[1, 8], [2, 16], [4, 32], [64, 128]];
const maxGapMs = 3 * 60_000;

function plotEquity(points, currency, columns, rows = 6, { inspectable = false, liveRange, labelWidth = 0, gapLimit = maxGapMs, axis } = {}) {
  let low = points[0].equity, high = low;
  for (const point of points) {
    low = Math.min(low, point.equity);
    high = Math.max(high, point.equity);
  }
  const first = points[0], last = points.at(-1);
  axis ??= { from: first.time, to: last.time, left: first.tick, right: last.tick };
  const flat = low === high;
  const topLabel = points.length === 1 ? money(high, currency) : flat ? 'Steady' : 'High ' + money(high, currency);
  const bottomLabel = flat ? '' : 'Low ' + money(low, currency);
  const labelSize = Math.max(labelWidth, topLabel.length, bottomLabel.length);
  const available = columns - labelSize - 4;
  const width = Math.max(2, liveRange ? available : Math.min(110, available));
  const height = flat && !liveRange ? 1 : Math.max(2, rows);
  const middleY = Math.floor((height * 4 - 1) / 2);
  const connectGaps = liveRange && liveRange !== 'hour';
  const cells = Array.from({ length: height }, () => new Uint8Array(width));
  // Keep reading indices stable for keyboard navigation. Line segments add further hover targets.
  const targets = inspectable ? new Array(points.length) : null;
  const hits = inspectable ? Array.from({ length: width }, () => new Map()) : null;
  const msPerDot = (axis.to - axis.from) / (2 * width - 1);
  const marked = new Set();
  function put(x, y) {
    cells[y >> 2][x >> 1] |= dots[y % 4][x % 2];
  }
  function drawSegment(start, end, rightIndex) {
    const dx = end.x - start.x, dy = end.y - start.y;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    const duration = end.point.time - start.point.time;
    for (let i = 1; i < steps; i++) {
      const along = i / steps;
      const x = Math.round(start.x + dx * along), y = Math.round(start.y + dy * along);
      put(x, y);
      const column = x >> 1, row = y >> 2;
      if (!hits || hits[column].has(row)) continue;

      // Use the column's time if the line crosses this row there. A steep line can
      // pass through several rows in one column, each at a different time.
      const centerTime = axis.from + (2 * column + 0.5) * msPerDot;
      const atCenter = duration > 0 ? (centerTime - start.point.time) / duration : -1;
      const centerOnRow = atCenter > 0 && atCenter < 1 && (Math.round(start.y + dy * atCenter) >> 2) === row;
      const fraction = centerOnRow ? atCenter : along;
      const point = {
        interpolated: true,
        time: Math.round(start.point.time + duration * fraction),
        equity: start.point.equity + (end.point.equity - start.point.equity) * fraction,
      };
      hits[column].set(row, targets.length);
      targets.push({ column, row, point, leftIndex: rightIndex - 1, rightIndex });
    }
  }
  let previous, gaps = false;
  for (const [index, point] of points.entries()) {
    const fraction = axis.to > axis.from ? (point.time - axis.from) / (axis.to - axis.from) : Number(Boolean(liveRange));
    const x = Math.round((width * 2 - 1) * fraction);
    const y = flat ? middleY : Math.round((height * 4 - 1) * (high - point.equity) / (high - low));
    put(x, y);
    const current = { x, y, point };
    if (targets) {
      const column = x >> 1, row = y >> 2;
      targets[index] = { column, row, point, leftIndex: index - 1, rightIndex: index + 1 };
      const existing = targets[hits[column].get(row)]?.point;
      if (!existing || existing.interpolated || (existing.estimated && !point.estimated)) hits[column].set(row, index);
    }
    if (previous) {
      const gap = point.time - previous.point.time > gapLimit;
      if (gap) {
        gaps = true;
        marked.add((previous.y >> 2) * width + (previous.x >> 1));
        marked.add((y >> 2) * width + (x >> 1));
      }
      if (!gap || connectGaps) drawSegment(previous, current, index);
    }
    if (point === first || point === last) marked.add((y >> 2) * width + (x >> 1));
    previous = current;
  }
  const lines = cells.map((row, i) => {
    const label = i === (flat ? middleY >> 2 : 0) ? topLabel : i === height - 1 ? bottomLabel : '';
    const line = Array.from(row, (bits, j) => marked.has(i * width + j) ? '●' : bits ? String.fromCharCode(0x2800 + bits) : ' ').join('').trimEnd();
    return label.padStart(labelSize) + ' │ ' + line;
  });
  if (liveRange) {
    const left = axis.from !== axis.to && width >= axis.left.length + axis.right.length + 3 ? axis.left + ' ' : '';
    const right = width > axis.right.length ? ' ' + axis.right : '';
    lines.push(' '.repeat(labelSize) + ' └─' + left.padEnd(width - right.length, '─') + right);
  } else if (width >= axis.left.length + axis.right.length + 1 && axis.from !== axis.to) {
    lines.push(' '.repeat(labelSize + 3) + axis.left.padEnd(width - axis.right.length) + axis.right);
  }
  const geometry = targets && { left: labelSize + 3, height, samples: targets.slice(0, points.length), targets, cells, hits };
  return { lines, gaps, geometry };
}

// Follow the line in the pointer's time column, including from above or below it.
function pointAt(plot, column, row) {
  if (!plot || row < plot.top || row >= plot.top + plot.height) return -1;
  const hits = plot.hits[column - plot.left];
  if (!hits?.size) return -1;
  const y = row - plot.top;
  if (hits.has(y)) return hits.get(y);
  let closest = -1, distance = Infinity;
  for (const [lineRow, index] of hits) {
    const dy = Math.abs(lineRow - y);
    if (dy < distance) { closest = index; distance = dy; }
  }
  return closest;
}

module.exports = { plotEquity, pointAt, maxGapMs };
