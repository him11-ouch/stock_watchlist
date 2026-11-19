const account = require('./account.cjs');
const { money } = require('./portfolio.cjs');
const { buildDashboard, equityCheck } = require('./dashboard.cjs');
const { listings } = require('./research.cjs');
const { isDeepStrictEqual } = require('node:util');

const back = Symbol('back');
const holdings = Symbol('holdings');
const cancel = Symbol('cancel');
const currencies = new Set(Intl.supportedValuesOf('currency'));
const emptyPrice = { broker_price: null, broker_price_currency: null, broker_price_at: null };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());

function number(raw) {
  const grouped = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw);
  return account.quantity(grouped ? raw.replaceAll(',', '') : raw);
}

function currencyCode(raw) {
  const code = raw.toUpperCase();
  if (!currencies.has(code)) throw new Error('Enter a currency code such as CAD or USD');
  return code;
}

async function editProfile(read, shortcut = '') {
  const old = account.profile();
  if (!await account.confirm(read, old ? 'Edit your saved profile?' : 'Create a portfolio profile?')) {
    console.log(old ? 'Editor closed' : 'Profile creation skipped');
    return false;
  }
  const original = account.profileHoldings();
  const positions = new Map(original.map(row => [row.symbol, row]));
  const preferred = process.env.WATCHLIST_CURRENCY?.trim().toUpperCase();
  const draft = old ? { ...old } : {
    currency: currencies.has(preferred) ? preferred : 'CAD', cash: 0,
    broker_equity: null, broker_date: null, max_weight: null, horizon: null, starting_equity: null,
  };

  async function answer(prompt) {
    const input = (await read(prompt))?.trim();
    if (input == null || input.toLowerCase() === 'cancel') throw cancel;
    return input;
  }

  async function field(label, previous, validate, optional = false) {
    for (;;) {
      const hint = previous != null ? ` [${previous}]` : optional ? ' [Enter to skip]' : '';
      const input = await answer(label + hint + ' > ');
      if (input.toLowerCase() === 'back') throw back;
      if (input.toLowerCase() === 'holdings') throw holdings;
      const value = input || String(previous ?? '');
      if (optional && (!value || value === '-')) return null;
      try { return validate(value, input.length > 0); }
      catch (error) { console.log(error.message); }
    }
  }

  async function shares(symbol, previous, isNew = false) {
    return field(`Shares of ${symbol}${isNew ? ' (fractions are OK)' : ' (0 removes this holding)'}`, previous, raw => {
      const n = number(raw);
      if (!n && isNew) throw new Error('Enter how many shares you own, for example 2 or 1.5');
      return n;
    });
  }
  const averageCost = (symbol, previous) => field(`Average purchase price per share of ${symbol} in its trading currency`,
    previous, number, true);

  async function addHolding(symbol) {
    let count = null;
    for (;;) {
      count = await shares(symbol, count, true);
      try {
        const cost = await averageCost(symbol, null);
        positions.set(symbol, { symbol, shares: count, avg_cost: cost, ...emptyPrice });
        console.log(`Added ${symbol} to your draft with ${count} shares`);
        return;
      } catch (error) {
        if (error !== back) throw error;
      }
    }
  }

  async function removeHolding(row) {
    const confirm = await field(`Remove all ${row.shares} shares of ${row.symbol} from this draft? Type y or n`, 'n', raw => {
      if (/^(y|yes)$/i.test(raw)) return true;
      if (/^(n|no)$/i.test(raw)) return false;
      throw new Error('Type y to remove it or n to keep it');
    });
    if (confirm) positions.delete(row.symbol);
  }

  async function editHolding(symbol) {
    const row = positions.get(symbol);
    const previousPrice = row.broker_price == null ? null : `${row.broker_price} ${row.broker_price_currency}`;
    for (;;) {
      console.log(`\nEdit ${symbol}\n  1  Change ticker                 ${symbol}\n  2  Change number of shares       ${row.shares}` +
        `\n  3  Change average purchase price  ${row.avg_cost ?? 'unspecified'} (per share in trading currency)` +
        `\n  4  Change current broker price    ${previousPrice || 'automatic market quote'}\n  5  Remove this holding\n  back  Return without changing this holding`);
      const choice = (await answer('Choose a holding option > ')).toLowerCase();
      try {
        switch (choice) {
          case '1': {
            const replacement = await field('Correct ticker, including the exchange suffix for a Canadian listing', symbol, raw => {
              const next = account.ticker(raw);
              if (next !== symbol && positions.has(next)) throw new Error(`You already hold ${next}. Type back to choose that holding.`);
              return next;
            });
            if (replacement !== symbol) {
              positions.delete(symbol);
              positions.set(replacement, { ...row, symbol: replacement, ...emptyPrice });
              console.log(`Changed ${symbol} to ${replacement}. Check that its average cost is in the new listing's currency.`);
            }
            return;
          }
          case '2': {
            const count = await shares(symbol, row.shares);
            if (!count) await removeHolding(row);
            else positions.set(symbol, { ...row, shares: count });
            return;
          }
          case '3': positions.set(symbol, { ...row, avg_cost: await averageCost(symbol, row.avg_cost) }); return;
          case '4': {
            console.log(`Enter today's price for ONE share with its currency, for example 18.50 USD. A number alone means ${draft.currency}.\nType - to use automatic prices. A newer market quote replaces a broker price.`);
            const price = await field('Current price per share from your broker', previousPrice, (raw, typed) => {
              if (!typed) return row;
              const [value, unit = draft.currency, ...extra] = raw.split(/\s+/);
              const amount = number(value);
              if (extra.length || amount <= 0) throw new Error('Enter a positive price per share and its currency, for example 20.50 CAD');
              return { broker_price: amount, broker_price_currency: currencyCode(unit), broker_price_at: new Date().toISOString() };
            }, true);
            positions.set(symbol, { ...row, ...(price || emptyPrice) });
            return;
          }
          case '5': await removeHolding(row); return;
          case 'back': case 'done': return;
          case 'holdings': throw holdings;
          default: console.log('Choose 1 through 5 or type back');
        }
      } catch (error) { if (error !== back) throw error; }
    }
  }

  async function editHoldings() {
    console.log('\nEnter a ticker to add a holding, for example T.TO for TELUS on the TSX. Prices are looked up automatically.');
    for (;;) {
      const rows = [...positions.values()];
      if (rows.length) {
        console.log(rows.map((row, i) => `  ${i + 1}  ${row.symbol}  ${row.shares} shares`).join('\n'));
      }
      const prompt = rows.length ? 'Type a ticker to add, a holding number to edit, or done to continue'
        : 'First stock ticker (required), or type none for a cash-only account';
      const raw = await answer(prompt + ' > ');
      const token = raw.toLowerCase();
      if (token === 'back') throw back;
      if ((rows.length && token === 'done') || (!rows.length && token === 'none')) return;
      if (!raw || ['done', 'none', 'holdings'].includes(token)) {
        console.log(rows.length ? 'Enter another ticker, choose a holding number, or type done when finished.'
          : 'Enter your first ticker, such as T.TO, or type none if you own no stocks.');
        continue;
      }
      let symbol;
      if (rows.length && /^\d+$/.test(raw)) {
        symbol = rows[Number(raw) - 1]?.symbol;
        if (!symbol) { console.log('Choose one of the listed holding numbers or enter a ticker'); continue; }
      } else {
        try { symbol = account.ticker(raw); }
        catch (error) { console.log(error.message); continue; }
      }
      try {
        if (positions.has(symbol)) await editHolding(symbol);
        else await addHolding(symbol);
      } catch (error) {
        if (error !== back && error !== holdings) throw error;
      }
    }
  }

  const cashAmount = (unit, previous) => field(`Uninvested cash in this account (${unit})`, previous, number);
  const brokerAmount = (unit, previous) => field(`Total account equity shown by your broker, including cash (${unit})`,
    previous, number, true);
  async function editCash() { draft.cash = await cashAmount(draft.currency, draft.cash); }
  async function editBroker() {
    draft.broker_equity = await brokerAmount(draft.currency, draft.broker_equity);
    draft.broker_date = draft.broker_equity == null ? null : today();
  }
  async function editCurrency() {
    const unit = await field('Currency for portfolio totals, for example CAD', draft.currency, currencyCode);
    if (unit === draft.currency) return;
    console.log(`Enter the cash and broker total shown in ${unit} for this account.`);
    const cash = await cashAmount(unit, 0);
    const total = await brokerAmount(unit, null);
    Object.assign(draft, { currency: unit, cash, broker_equity: total, broker_date: total == null ? null : today(),
      starting_equity: account.startingEquity(unit) });
  }
  async function editLimit() {
    draft.max_weight = await field('Maximum percentage of the portfolio in one company (enter 20 for 20%)', draft.max_weight, raw => {
      const n = number(raw);
      if (n <= 0 || n > 100) throw new Error('Enter a percentage above 0 and up to 100');
      return n;
    }, true);
  }
  async function editHorizon() {
    draft.horizon = await field('How long until you plan to use this money? For example, 5 years', draft.horizon, raw => raw, true);
  }
  function openingAmount() {
    return draft.starting_equity ?? account.firstValuation(draft.currency)?.equity ?? (!old ? draft.broker_equity : null);
  }
  async function editBaseline() {
    const first = account.firstValuation(draft.currency);
    if (first) console.log(`First recorded balance on ${first.date}  ${money(first.equity, draft.currency)}`);
    console.log('The chart measures change from this opening amount. Type - to use your first recorded balance.');
    draft.starting_equity = await field(`Starting equity in ${draft.currency}`, openingAmount(),
      (raw, typed) => typed ? number(raw) : draft.starting_equity, true);
  }

  const options = [
    ['holdings', 'Add or edit a holding', () => String(positions.size) + ' held', editHoldings],
    ['cash', 'Uninvested cash', () => money(draft.cash, draft.currency), editCash],
    ['broker', 'Broker total equity', () => draft.broker_equity == null ? 'unspecified' : money(draft.broker_equity, draft.currency), editBroker],
    ['currency', 'Reporting currency', () => draft.currency, editCurrency],
    ['limit', 'Maximum in one company', () => draft.max_weight == null ? 'unspecified' : draft.max_weight + '%', editLimit],
    ['horizon', 'Time horizon', () => draft.horizon || 'unspecified', editHorizon],
    ['baseline', 'Chart starting equity', () => {
      const opening = openingAmount();
      return opening == null ? 'first recorded balance' : money(opening, draft.currency);
    }, editBaseline],
  ];
  async function choose(choice) {
    const option = options.find(([key], i) => choice === key || choice === String(i + 1));
    const symbol = choice.toUpperCase();
    let open = option?.[3];
    if (!open && positions.has(symbol)) open = () => editHolding(symbol);
    if (!open) {
      console.log('Choose a number from 1 to 7 or type a ticker you already hold. Use 1 to add a new ticker.');
      return false;
    }
    for (;;) {
      try { await open(); return true; }
      catch (error) {
        if (error === back) return true;
        if (error !== holdings) throw error;
        open = editHoldings;
      }
    }
  }

  console.log('Enter keeps the value in brackets or skips an optional question. Type - to clear an optional value.\nType back to go back, or holdings at any account question to return to your stocks.\nOnly yes at the review screen saves your draft. Type cancel to discard it.');
  try {
    if (!old) {
      const unit = draft.currency === 'CAD' ? 'Canadian dollars (CAD)' : draft.currency;
      console.log(`Portfolio totals use ${unit}. Choose 4 at review to change currency.`);
      const steps = [editHoldings, editCash, editBroker, editLimit, editHorizon];
      for (let i = 0; i < steps.length;) {
        try { await steps[i](); i++; }
        catch (error) {
          if (error === back) i = Math.max(0, i - 1);
          else if (error === holdings) await choose('holdings');
          else throw error;
        }
      }
    } else if (shortcut) await choose(shortcut.toLowerCase());

    for (;;) {
      console.log('\nReview your profile');
      options.forEach(([, label, value], i) => console.log(`  ${i + 1}  ${label.padEnd(24)}${value()}`));
      let check, view;
      // A historical reference can be corrected independently of today's market prices.
      const onlyBaselineChanged = old && old.starting_equity !== draft.starting_equity &&
        isDeepStrictEqual({ ...draft, starting_equity: old.starting_equity }, old) && isDeepStrictEqual([...positions.values()], original);
      if (draft.broker_equity != null && !onlyBaselineChanged) {
        console.log('\nLooking up prices for your equity check…');
        const saved = new Map(account.holdings().map(row => [row.symbol, row]));
        const rows = [...positions.values()].map(row => ({ ...saved.get(row.symbol), ...row }));
        view = await buildDashboard(rows, draft, listings);
        check = equityCheck(view);
        console.log(check.lines.join('\n'));
      } else if (positions.size) console.log('\nYour holdings\n' + [...positions.values()].map(account.holdingSummary).join('\n'));
      const example = positions.keys().next().value;
      const hint = `Choose 1 to add a holding${example ? ', or type a ticker (for example ' + example + ') to correct it' : ''}. Choose 2 for cash or 3 for the broker total.`;
      console.log(hint);
      if (check && !check.matches) console.log('To use a price from your broker, type the ticker and choose 4. Type recheck to check quotes again.');
      for (;;) {
        const choice = (await answer('Type an option, a ticker, yes to save, or cancel > ')).toLowerCase();
        if (choice === 'no' || choice === 'n') throw cancel;
        if (choice === 'yes') {
          if (check && !check.matches) {
            console.log('Saving is paused until the broker total matches. ' + hint);
            continue;
          }
          if (view && Date.now() - Date.parse(view.recordedAt) >= 5 * 60_000) {
            console.log('This price check is five minutes old. Review the refreshed total before saving.');
            break;
          }
          account.saveProfile.immediate(old, original, draft, positions);
          console.log('Profile saved');
          return { view };
        }
        if (choice === 'recheck' || await choose(choice)) break;
      }
    }
  } catch (error) {
    if (error !== cancel) throw error;
    console.log('Edits discarded');
    return false;
  }
}

module.exports = { editProfile };
