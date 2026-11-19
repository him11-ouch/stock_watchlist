require('dotenv').config({ quiet: true });
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const db = require('./db.cjs');
const market = require('./services/market.cjs');
const { portfolio, money } = require('./services/portfolio.cjs');
const { assess, techIdeas, listings } = require('./services/research.cjs');
const account = require('./services/account.cjs');
const { editProfile } = require('./services/profile-editor.cjs');
const { ticker, quantity } = account;
const { buildDashboard, renderDashboard } = require('./services/dashboard.cjs');
const { equityChart } = require('./services/equity-chart.cjs');
const { liveLayout, inspectedLines, pollLive } = require('./services/live.cjs');
const { pointAt } = require('./services/terminal-plot.cjs');
const { TerminalInput, mouseOn, mouseOff } = require('./services/terminal-input.cjs');
const { recordTransaction } = require('./services/transactions.cjs');
const { reviewStock, planBudget, askLocal } = require('./services/advisor.cjs');

const help = [
  'setup                Create a profile and review it before saving',
  'profile / edit       View your profile / open its numbered edit menu',
  'edit TICKER          Edit one holding, for example edit T.TO',
  'edit FIELD           Open holdings, cash, broker, currency, limit, horizon or baseline',
  'dashboard            View holdings, gains, review levels and portfolio history',
  'live                 Open the auto-updating equity graph and prices (every minute)',
  'graph                Show total equity and its change over time',
  'deposit / withdraw AMOUNT    Record cash added to or taken from the account',
  'buy / sell TICKER SHARES PRICE [BROKER_CASH_TOTAL]    Record a trade and update cash',
  'ask TICKER QUESTION  Ask the local AI about a stock using sourced evidence',
  'ask budget AMOUNT QUESTION   Discuss a cash allocation scenario with the local AI',
  'budget AMOUNT        Explore a Canadian tech allocation using your recorded cash',
  'compare TICKER ...   Compare dated closes, trends and research assessments',
  'alert TICKER below|above PRICE   Set a closing-price review level (off to clear)',
  'monitor              Check levels every 15 minutes while the terminal stays open',
  'list [CAD|USD|…]      Show closes, daily moves and total stock equity (default CAD)',
  'watch TICKER         Add a listing without changing any shares held',
  'hold TICKER SHARES [AVG_COST]   Correct a share balance. Use buy or sell for trades.',
  'remove TICKER        Delete the watchlist entry and its recorded share count',
  'ideas                Screen five Toronto-listed tech stocks for further research',
  'NAME or TICKER       Look up a company, for example TELUS or T.TO',
  'help / quit          Show commands / exit',
].join('\n');

function activeProfile() {
  const profile = account.profile();
  if (!profile) throw new Error('Run setup to enter your holdings, cash and preferences.');
  return profile;
}

async function snapshot(profile = activeProfile()) {
  return buildDashboard(account.holdings(), profile, listings);
}

async function recordValuation(activity, checkedView) {
  const view = checkedView ?? await snapshot();
  account.recordSnapshot(view, activity);
  return view;
}

async function showDashboard(activity, checkedView) {
  const view = await recordValuation(activity, checkedView);
  console.log(renderDashboard(view, account.equityHistory(view)).join('\n'));
  return view;
}

async function showGraph(activity) {
  const view = await recordValuation(activity);
  console.log(equityChart(view, account.equityHistory(view)));
  for (const position of view.positions) {
    if (position.issue) console.log(position.symbol + ' — ' + position.issue);
  }
}

async function research(stock, detailed = false) {
  const history = await market.dailyHistory(stock.symbol);
  let fundamentals, issue;
  try {
    fundamentals = await market.overview(stock.symbol);
  } catch (error) {
    issue = error.message;
  }
  const result = assess(history, fundamentals);
  const latest = history.at(-1);
  const { close, date } = latest;
  const currency = latest.currency || stock.currency;
  const unitPrice = close * (latest.priceScale ?? stock.priceScale ?? 1);
  const lines = [
    `${stock.name} (${stock.symbol}) | ${currency ? money(unitPrice, currency) : close + ' (currency unknown)'} on ${date} | ${latest.source || 'Alpha Vantage'}`,
    result.label, ...result.lines,
  ];
  if (issue) lines.push(issue);
  if (fundamentals?.Source) lines.push('Fundamentals from ' + fundamentals.Source);
  if (stock.question && !detailed) lines.push('Investigate: ' + stock.question);
  if (detailed) {
    const closes = history.slice(-30).map(bar => bar.close);
    const low = Math.min(...closes);
    const high = Math.max(...closes);
    const graph = closes.map(value => '▁▂▃▄▅▆▇█'[high === low ? 3 : Math.round(7 * (value - low) / (high - low))]).join('');
    lines.push(`Last ${closes.length} closes  ${graph}  ${history.at(-closes.length).date} to ${date}`);
    const profile = account.profile();
    const held = account.holdings().find(row => row.symbol === stock.symbol);
    const view = held && profile ? await snapshot(profile) : null;
    const holding = view?.positions.find(row => row.symbol === stock.symbol);
    let headlines = [];
    try { headlines = await market.news(stock.symbol); }
    catch (error) { lines.push('Related headlines unavailable. ' + error.message); }
    lines.push(...reviewStock({
      symbol: stock.symbol, screen: result, question: stock.question, shares: held?.shares,
      close: unitPrice, currency, quoteDate: date, priceFloor: held?.review_below,
      priceTarget: held?.review_above, weightPct: holding?.weight, maxWeightPct: profile?.max_weight,
      horizon: profile?.horizon, headlines,
    }));
  }
  return { rank: result.rank, label: result.label, symbol: stock.symbol, lines };
}

async function screenIdeas() {
  const results = [];
  for (const stock of techIdeas) {
    try { results.push(await research(stock)); }
    catch (error) {
      results.push({ symbol: stock.symbol, rank: -1, label: 'Unavailable',
        lines: [`${stock.name} (${stock.symbol}) | Unassessed. ${error.message}`, stock.question] });
    }
  }
  return results.sort((a, b) => b.rank - a.rank);
}

async function budgetEvidence(raw) {
  const amount = quantity(raw);
  if (amount <= 0) throw new Error('Enter an amount above zero.');
  const profile = activeProfile();
  const view = await snapshot(profile);
  const candidates = await screenIdeas();
  const lines = planBudget({ amount, cash: profile.cash, equity: view.equity,
    currency: view.currency, positions: view.positions, maxWeightPct: profile.max_weight,
    horizon: profile.horizon, candidates });
  for (const candidate of candidates) lines.push(candidate.lines[0], candidate.label, ...candidate.lines.slice(2, 4));
  return lines;
}

async function run(args, read, signal) {
  const [verb, ...rest] = args;
  const command = verb?.toLowerCase();
  switch (command) {
    case 'profile': case 'edit': case 'setup': {
      const saved = account.profile();
      if (command === 'profile' && !rest.length) {
        console.log(saved ? 'Saved profile\n' + account.profileSummary(saved, account.holdings()) +
          '\nType edit for numbered options or edit T.TO to change one holding.' : 'No profile saved. Type setup to create one.');
        break;
      }
      if (rest.length > 1 || (rest.length && command === 'setup') ||
          (command === 'profile' && rest[0]?.toLowerCase() !== 'edit')) {
        throw new Error('Use edit for the menu, edit T.TO for one holding, or edit cash for one field.');
      }
      const shortcut = command === 'edit' && rest[0]?.toLowerCase() !== 'profile' ? rest[0] : '';
      const edited = await editProfile(read, shortcut);
      if (edited) return showDashboard(saved ? 'Profile edited' : 'Opening balance', edited.view);
      break;
    }
    case 'dashboard':
      return showDashboard();
    case 'graph':
      return showGraph();
    case 'deposit': case 'withdraw': case 'buy': case 'sell': {
      const activity = await recordTransaction(command, rest, read, listings, recordValuation);
      if (activity) return showGraph(activity);
      break;
    }
    case 'monitor': {
      activeProfile();
      console.log('Watching your closing-price levels every 15 minutes. Ctrl+C stops the monitor.');
      let previous = new Set();
      for (;;) {
        const view = await showDashboard();
        const active = new Set();
        for (const position of view.positions) {
          for (const note of position.alerts) {
            const alert = position.symbol + ' — ' + note;
            active.add(alert);
            if (!previous.has(alert)) console.log('\x07Review ' + alert);
          }
        }
        previous = active;
        try { await delay(15 * 60000, undefined, { signal }); }
        catch (error) { if (error.name === 'AbortError') return; throw error; }
      }
    }
    case 'alert': {
      const [input, side, price] = rest;
      if (rest.length !== 3 || !['below', 'above'].includes(side)) throw new Error('Use alert TICKER below|above PRICE (or off).');
      const symbol = ticker(input);
      const value = price === 'off' ? null : quantity(price);
      if (value === 0) throw new Error('Enter a positive price, or off.');
      const holding = db.prepare('SELECT * FROM watchlist WHERE symbol = ? AND shares > 0').get(symbol);
      if (!holding) throw new Error('Record a holding with hold before setting its level.');
      if (value != null && (side === 'below' ? holding.review_above != null && value >= holding.review_above :
          holding.review_below != null && value <= holding.review_below)) throw new Error('The lower level must be below the upper level.');
      db.prepare(`UPDATE watchlist SET review_${side} = ? WHERE symbol = ?`).run(value, symbol);
      console.log(`${symbol} ${side} level ${value == null ? 'cleared' : 'set to ' + value + ' in listing currency'}.`);
      break;
    }
    case 'budget': {
      if (rest.length !== 1) throw new Error('Use budget AMOUNT in your reporting currency.');
      console.log((await budgetEvidence(rest[0])).join('\n'));
      break;
    }
    case 'ask': {
      if (rest.length < 2) throw new Error('Use ask TICKER QUESTION, for example ask T.TO What would make me reconsider holding this?');
      let lines, question;
      if (rest[0].toLowerCase() === 'budget') {
        if (rest.length < 3) throw new Error('Use ask budget AMOUNT QUESTION.');
        lines = await budgetEvidence(rest[1]);
        question = rest.slice(2).join(' ');
      } else {
        const stock = await market.resolveListing(rest[0], listings);
        ({ lines } = await research(stock, true));
        question = rest.slice(1).join(' ');
      }
      console.log(lines.join('\n'));
      console.log(await askLocal(question, lines));
      break;
    }
    case 'compare': {
      if (rest.length < 2) throw new Error('Use compare TICKER TICKER.');
      for (const input of rest) {
        try {
          const stock = await market.resolveListing(input, listings);
          console.log((await research(stock)).lines.join('\n') + '\n');
        } catch (error) { console.log(input + ' — ' + error.message); }
      }
      break;
    }
    case 'help': case '--help': case '-h':
      console.log(help);
      break;
    case 'list': {
      const base = (rest[0] || account.profile()?.currency || process.env.WATCHLIST_CURRENCY || 'CAD').toUpperCase();
      if (rest.length > 1 || !Intl.supportedValuesOf('currency').includes(base)) throw new Error('Enter one reporting currency, e.g. list CAD.');
      const rows = db.prepare('SELECT symbol, shares FROM watchlist ORDER BY (shares > 0) DESC, id').all();
      console.log((await portfolio(rows, base, listings)).join('\n'));
      break;
    }
    case 'watch': {
      if (rest.length !== 1) throw new Error('Use watch TICKER.');
      const symbol = ticker(rest[0]);
      const result = db.prepare('INSERT INTO watchlist (symbol) VALUES (?) ON CONFLICT(symbol) DO NOTHING').run(symbol);
      console.log(result.changes ? `Watching ${symbol}.` : `${symbol} is already on your watchlist.`);
      break;
    }
    case 'hold': {
      const symbol = ticker(rest[0]);
      if (rest.length < 2 || rest.length > 3) throw new Error('Use hold TICKER SHARES [AVG_COST].');
      const shares = quantity(rest[1]);
      const old = db.prepare('SELECT shares, avg_cost FROM watchlist WHERE symbol = ?').get(symbol);
      const cost = rest[2] == null ? (old?.shares === shares ? old.avg_cost : null) : quantity(rest[2]);
      account.saveHolding.run(symbol, shares, shares ? cost : null);
      console.log(`${symbol} now has ${shares} shares recorded.`);
      if ((old?.shares ?? 0) !== shares && account.profile()) return showGraph(`Set ${symbol} balance to ${shares} shares`);
      break;
    }
    case 'remove': {
      if (rest.length !== 1) throw new Error('Use remove TICKER.');
      const symbol = ticker(rest[0]);
      const removed = db.prepare('DELETE FROM watchlist WHERE symbol = ? RETURNING shares').get(symbol);
      console.log(removed ? `Removed ${symbol}.` : `${symbol} was not on your watchlist.`);
      if (removed?.shares > 0 && account.profile()) return showGraph(`Removed ${symbol} holding`);
      break;
    }
    case 'ideas': {
      console.log('Canadian tech research screen | highest research priority first');
      for (const result of await screenIdeas()) console.log('\n' + result.lines.join('\n'));
      break;
    }
    default: {
      const query = (verb?.toLowerCase() === 'research' ? rest : args).join(' ').trim();
      if (!query) throw new Error('Enter a company name or ticker.');
      const stock = await market.resolveListing(query, listings);
      console.log((await research(stock, true)).lines.join('\n'));
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  let terminal, input;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const redraw = interactive && process.env.TERM !== 'dumb';
  const keys = redraw ? new TerminalInput(process.stdin) : process.stdin;
  const session = new AbortController();
  async function read(prompt) {
    if (!terminal) {
      terminal = createInterface({ input: keys, output: process.stdout, terminal: redraw });
      if (redraw) process.stdin.pipe(keys);
      terminal.on('close', () => session.abort());
      input = terminal[Symbol.asyncIterator]();
    }
    if (process.stdin.isTTY) {
      terminal.setPrompt(prompt);
      terminal.prompt(true);
    }
    const { value, done } = await input.next();
    return done ? null : value;
  }
  async function live() {
    const profile = activeProfile();
    if (!interactive) { await showDashboard(); return ''; }
    const control = new AbortController();
    let details = false, tracking = false, frame, selected = -1, visibleRows = 0;
    let pointer, refresh;
    function track(enable) {
      if (redraw && tracking !== enable) process.stdout.write(enable ? mouseOn : mouseOff);
      tracking = enable;
    }
    function fit(line) {
      const width = process.stdout.columns || 80;
      const plain = line.replace(/\x1b\[[\d;]*m/g, '');
      return plain.length < width ? line : plain.slice(0, Math.max(0, width - 2)) + '…';
    }
    function select(index) {
      if (index === selected || !frame?.plot) return;
      const before = inspectedLines(frame, selected);
      selected = index;
      const after = inspectedLines(frame, selected);
      let update = '';
      for (let row = 0; row < Math.min(visibleRows, frame.plot.top + frame.plot.height); row++) {
        if (before[row] !== after[row]) update += `\x1b[${row + 1};1H\x1b[2K` + fit(after[row]);
      }
      if (update) process.stdout.write('\x1b7' + update + '\x1b8');
    }
    function move(column, row) {
      if (!tracking) return;
      pointer = { column, row };
      select(row < visibleRows ? pointAt(frame.plot, column, row) : -1);
    }
    function navigate(_, key) {
      if (!tracking || terminal?.line || !key || key.ctrl || key.shift) return;
      if (key.name === 'escape') { pointer = null; select(-1); return; }
      if (key.meta || !['left', 'right'].includes(key.name)) return;
      pointer = null;
      const end = frame.plot.samples.length - 1;
      select(Math.max(0, Math.min(end, (selected < 0 ? end : selected) + (key.name === 'left' ? -1 : 1))));
    }
    const resize = () => { refresh?.(); terminal?.prompt(true); };
    const close = () => terminal?.close();
    function paint(lines) {
      const height = Math.max(3, (process.stdout.rows || 30) - 3);
      const visible = lines.slice(0, height);
      visibleRows = visible.length < lines.length ? height - 1 : visible.length;
      if (visible.length < lines.length) visible[height - 1] = '  Type dashboard for the full breakdown.';
      if (redraw) process.stdout.write('\x1b[H\x1b[2J');
      const hint = details ? 'summary  Equity graph' : 'details  Holdings and FX';
      process.stdout.write([...visible, '', `  ${hint}     Enter  Pause and return to commands`].map(fit).join('\n') + '\n');
    }
    if (redraw) process.stdout.write('\x1b[?1049h');
    try {
      const now = new Date();
      const pending = { currency: profile.currency, date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(now),
        recordedAt: now.toISOString(), equity: null };
      let history = account.equityHistory(pending);
      let current = { ...pending, cash: profile.cash, ...history.at(-1), positions: [], startingEquity: profile.starting_equity };
      let loading = true;
      function display(message) {
        const previous = frame?.plot?.samples[selected]?.point;
        frame = liveLayout(current, history, process.stdout.columns, { rows: process.stdout.rows || 24,
          styled: redraw, details, loading, inspectable: redraw });
        if (message) frame.lines.push(message);
        selected = pointer ? pointAt(frame.plot, pointer.column, pointer.row) :
          (previous && frame.plot ? frame.plot.samples.findIndex(({ point }) => point.time === previous.time && point.equity === previous.equity) : -1);
        paint(inspectedLines(frame, selected));
        track(Boolean(frame.plot && frame.plot.top < visibleRows));
      }
      refresh = display;
      if (redraw) {
        keys.on('pointer', move);
        keys.on('keypress', navigate);
        process.stdout.on('resize', resize);
        for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.once(signal, close);
      }
      display();
      async function nextCommand() {
        for (;;) {
          const line = await read('live> ');
          const command = line?.trim().toLowerCase();
          if (command !== 'details' && command !== 'summary') return line;
          details = command === 'details';
          pointer = null;
          display();
        }
      }
      const next = nextCommand();
      const updating = pollLive({
        load: signal => buildDashboard(account.holdings(), activeProfile(), listings, market, undefined, signal),
        display: view => {
          account.recordSnapshot(view, null, true);
          current = view;
          history = account.equityHistory(view);
          loading = false;
          display();
          terminal.prompt(true);
        },
        reportError: message => {
          display('Price check failed. Retrying in 60s. ' + message);
          terminal.prompt(true);
        },
      }, control.signal);
      return (await Promise.race([next, updating])) ?? 'quit';
    } finally {
      control.abort();
      if (redraw) {
        track(false);
        keys.off('pointer', move);
        keys.off('keypress', navigate);
        process.stdout.off('resize', resize);
        for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.off(signal, close);
        process.stdout.write('\x1b[?1049l');
      }
    }
  }
  try {
    if (args.length && args[0].toLowerCase() !== 'live') return await run(args, read, session.signal);
    if (args.length > 1) throw new Error('Use live with no arguments.');
    let line;
    if (args.length) line = 'live';
    else {
      console.log('Stock watchlist\nType live for the equity graph, edit for your profile, or help for all commands.');
      if (interactive) {
        if (!account.profile()) {
          try { await run(['setup'], read, session.signal); }
          catch (error) { console.error(error.message); }
        }
        if (account.profile()) line = 'live';
      }
    }
    for (;;) {
      if (!line) line = await read('watchlist> ');
      if (line == null || /^(quit|exit)$/i.test(line.trim())) break;
      const command = line.trim();
      line = undefined;
      try {
        if (/^live$/i.test(command)) {
          line = await live();
          if (args.length && !line && !interactive) break;
        } else if (command) await run(command.split(/\s+/), read, session.signal);
      } catch (error) { if (args.length) throw error; console.error(error.message); }
    }
  } finally {
    terminal?.close();
    if (redraw && terminal) {
      process.stdin.unpipe(keys);
      process.stdin.pause();
      keys.destroy();
    }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.close());
