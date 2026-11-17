// Runway: the "bleed" view. Am I OK, and for how long? Inputs saved to settings,
// then this month, average in, burn, draw, net position, runway, break-even,
// retainers vs need, tax and GST to set aside, a 6-month projection and a what-if.
import { el, fill, icon, toast, money, num, plural } from '../ui.js?v=20261118c';
import { saveSettings } from '../api.js?v=20261118c';
import {
  n0, r2, todayIso, monthKey, addDays, monthLabel, monthlyBurn, monthSoFar, averageIn, recurringRevenue,
  runway, projection, quarterToDate, isActiveClient, daysBetween
} from './money-math.js?v=20261118c';
import { money2, dateFmt, how, pageHead, sectionHead } from './money-ui.js?v=20261118c';

const signed = (n) => `${n < 0 ? '−' : '+'}${money(Math.abs(n))}`;
const monthsText = (m) => (m >= 24 ? `${num(Math.floor(m / 12))} years` : `${m.toFixed(1)} months`);

/** "Runs out around" month for a runway of m months from today. */
export function runsOutMonth(today, m) {
  return monthKey(addDays(today, Math.floor(m * 30.44)));
}

/** Every number on the page from settings (with any unsaved typed values) and the data. */
export function workings(st, s, today) {
  const cash = n0(s.cash_on_hand);
  const draw = n0(s.owner_draw);
  const burn = monthlyBurn(st.costs, today);
  const avg = averageIn(st.income, s, today, 3);
  const rw = runway({ cash, avgIn: avg.average, burn, draw });
  const recurring = recurringRevenue(st.clients);
  return {
    cash, draw, burn, avg, rw, recurring,
    month: monthSoFar(st.income, st.costs, s, today),
    quarter: quarterToDate(st.income, st.costs, s, today),
    proj: projection({ cash, clients: st.clients, income: st.income, costs: st.costs, settings: s, draw, today, months: 6 })
  };
}

export default function runwayView(ctx) {
  const { state: st } = ctx;
  const root = el('div', { class: 'page money-page runway-page' });
  root.append(pageHead('Money', 'Runway', 'Am I OK, and for how long?'));

  /* ------------------------------------------------------------ inputs */
  const saved = el('span', { class: 'money-saved muted small', role: 'status', 'aria-live': 'polite' });
  const s0 = st.settings || {};
  const mkInput = (name, label, opts, hint) => {
    const id = `rw-${name}`;
    const inp = el('input', { class: 'input', id, name, ...opts });
    return { inp, node: el('div', { class: 'field' }, el('label', { class: 'field-label', for: id }, label), inp, hint ? el('span', { class: 'field-hint' }, hint) : null) };
  };
  const num2 = { type: 'number', min: '0', step: '0.01', inputmode: 'decimal' };
  const f = {
    cash_on_hand: mkInput('cash_on_hand', 'Cash on hand', num2, 'Business bank balance.'),
    cash_as_of: mkInput('cash_as_of', 'As of', { type: 'date' }),
    owner_draw: mkInput('owner_draw', 'You need to take home', num2, 'Each month.'),
    tax_rate: mkInput('tax_rate', 'Tax rate %', { type: 'number', min: '0', max: '99', step: '0.5', inputmode: 'decimal' }, 'For a rough set-aside.'),
    monthly_target: mkInput('monthly_target', 'Monthly revenue target', num2)
  };
  const gst = el('input', { type: 'checkbox', class: 'check', id: 'rw-gst', name: 'gst_registered' });
  const gstField = el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'GST'),
    el('label', { class: 'check-row money-gst-row', for: 'rw-gst' }, gst, 'Registered for GST'),
    el('span', { class: 'field-hint' }, 'Revenue then excludes GST.'));

  const toField = {
    cash_on_hand: (v) => r2(v), cash_as_of: (v) => v || null, owner_draw: (v) => r2(v),
    tax_rate: (v) => r2(n0(v) / 100 * 10000) / 10000, monthly_target: (v) => r2(v)
  };
  const fromField = {
    cash_on_hand: (v) => (v === null || v === undefined ? '' : String(r2(v))), cash_as_of: (v) => v || '', owner_draw: (v) => String(r2(v)),
    tax_rate: (v) => String(r2(n0(v) * 100)), monthly_target: (v) => String(r2(v))
  };
  const syncInputs = (force = false) => {
    const s = st.settings || {};
    for (const [k, { inp }] of Object.entries(f)) if (force || document.activeElement !== inp) inp.value = fromField[k](s[k]);
    gst.checked = Boolean(s.gst_registered);
  };
  /** Settings with typed (possibly unsaved) values on top, for live figures. */
  const live = () => {
    const s = { ...(st.settings || {}) };
    for (const [k, { inp }] of Object.entries(f)) if (inp.value !== '' || k === 'cash_as_of') s[k] = toField[k](inp.value);
    s.gst_registered = gst.checked;
    return s;
  };
  const save = async (k, value) => {
    if (k === 'tax_rate' && !(value >= 0 && value < 1)) { toast('Tax rate must be between 0 and 99%', 'bad'); syncInputs(true); return; }
    if (value !== null && typeof value === 'number' && value < 0) { toast('Use a positive number', 'bad'); syncInputs(true); return; }
    const patch = { [k]: value };
    if (k === 'cash_on_hand' && !f.cash_as_of.inp.value) { patch.cash_as_of = todayIso(); f.cash_as_of.inp.value = patch.cash_as_of; }
    saved.textContent = 'Saving…';
    try { await saveSettings(patch); saved.textContent = 'Saved'; setTimeout(() => { if (saved.textContent === 'Saved') saved.textContent = ''; }, 2400); } catch (e) { saved.textContent = ''; toast(e.message, 'bad'); }
  };
  for (const [k, { inp }] of Object.entries(f)) {
    inp.addEventListener('input', () => paint());
    inp.addEventListener('change', () => {
      if (inp.value === '' && k !== 'cash_as_of') { syncInputs(true); return; }
      save(k, toField[k](inp.value));
    });
  }
  gst.addEventListener('change', () => { paint(); save('gst_registered', gst.checked); });
  syncInputs(true);

  root.append(el('section', { class: 'section money-section money-inputs', 'aria-label': 'Your numbers' },
    el('div', { class: 'section-head' }, el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Your numbers'), el('h2', { class: 'h2' }, 'Start here')), saved),
    el('div', { class: 'money-input-grid' }, f.cash_on_hand.node, f.cash_as_of.node, f.owner_draw.node, f.tax_rate.node, gstField, f.monthly_target.node),
    how('Saved as you change them. Everything below updates as you type.')));

  const body = el('div', { class: 'money-body' });
  root.append(body);

  /* ------------------------------------------------------------ what-if */
  const wiAdd = el('input', { class: 'input', type: 'number', min: '0', step: '50', inputmode: 'decimal', id: 'rw-wi-add', placeholder: '0', 'aria-describedby': 'rw-wi-note' });
  const wiCut = el('input', { class: 'input', type: 'number', min: '0', step: '10', inputmode: 'decimal', id: 'rw-wi-cut', placeholder: '0', 'aria-describedby': 'rw-wi-note' });
  const wiOut = el('div', { class: 'money-whatif-out', 'aria-live': 'polite' });
  wiAdd.addEventListener('input', () => paintWhatIf());
  wiCut.addEventListener('input', () => paintWhatIf());
  let lastW = null;
  const whatIf = el('section', { class: 'section money-section', 'aria-label': 'What if' },
    sectionHead('What if', 'Try a change'),
    el('div', { class: 'money-whatif' },
      el('div', { class: 'field' }, el('label', { class: 'field-label', for: 'rw-wi-add' }, 'Add a client at, per month'), wiAdd),
      el('div', { class: 'field' }, el('label', { class: 'field-label', for: 'rw-wi-cut' }, 'Cut costs by, per month'), wiCut),
      wiOut),
    el('p', { class: 'money-how', id: 'rw-wi-note' }, 'Adds to your average money in and takes off your monthly burn. Nothing here is saved.'));

  function paintWhatIf() {
    const w = lastW;
    if (!w) return;
    const add = Math.max(0, n0(wiAdd.value));
    const cut = Math.min(w.burn, Math.max(0, n0(wiCut.value)));
    const next = runway({ cash: w.cash, avgIn: w.avg.average + add, burn: w.burn - cut, draw: w.draw });
    fill(wiOut,
      el('div', { class: 'money-wi-cell' }, el('p', { class: 'eyebrow' }, 'Runway'),
        el('p', { class: 'money-wi-value', dataset: { wi: 'runway' } }, next.burning ? monthsText(next.months) : 'Not burning'),
        el('p', { class: 'money-kpi-sub' }, next.burning ? `was ${w.rw.burning ? monthsText(w.rw.months) : 'not burning'}` : `${money(next.spare)} to spare a month`)),
      el('div', { class: 'money-wi-cell' }, el('p', { class: 'eyebrow' }, 'Break-even'),
        el('p', { class: 'money-wi-value', dataset: { wi: 'need' } }, `${money(next.need)}/mo`),
        el('p', { class: 'money-kpi-sub' }, `was ${money(w.rw.need)}`)),
      el('div', { class: 'money-wi-cell' }, el('p', { class: 'eyebrow' }, 'Each month'),
        el('p', { class: `money-wi-value${next.net < 0 ? ' is-bad' : ''}`, dataset: { wi: 'net' } }, signed(next.net)),
        el('p', { class: 'money-kpi-sub' }, `was ${signed(w.rw.net)}`)));
  }

  /* -------------------------------------------------------------- paint */
  function paint() {
    const today = todayIso();
    const s = live();
    const w = workings(st, s, today);
    lastW = w;
    const noData = !st.income.length && !st.costs.length && !w.cash && !st.clients.some((c) => isActiveClient(c) && n0(c.monthly_value) > 0);
    if (noData) {
      fill(body, el('section', { class: 'section money-section money-start' },
        sectionHead('Nothing to work out yet', 'Three things to enter first'),
        el('ol', { class: 'money-steps' },
          el('li', {}, el('b', {}, 'Your cash on hand'), ' and what you need to take home each month, in the boxes above.'),
          el('li', {}, el('b', {}, 'Your recurring costs'), ': software, phone, AI services and insurance. ', el('a', { href: '#costs/new', class: 'money-link' }, 'Add a cost')),
          el('li', {}, el('b', {}, 'Your invoices'), ', marked paid when the money lands, so average income can be worked out. ', el('a', { href: '#income/new', class: 'money-link' }, 'Add an invoice')))));
      return;
    }
    fill(body, answer(w, s, today), figures(w, s, today), cover(w), taxBlock(w, s), projBlock(w, s, today), whatIf);
    paintWhatIf();
  }

  function answer(w, s, today) {
    const { rw } = w;
    const stale = s.cash_as_of ? daysBetween(s.cash_as_of, today) : null;
    let big; let line; let tone = '';
    if (!rw.burning) {
      big = 'Not burning';
      line = `Covering costs and your pay with ${money(rw.spare)} to spare each month.`;
      tone = 'ok';
    } else if (w.cash <= 0) {
      big = 'No cash buffer';
      line = `You are ${money(rw.shortfall)} a month short and there is no cash on hand to cover it.`;
      tone = 'bad';
    } else {
      big = monthsText(rw.months);
      line = `of runway. You are ${money(rw.shortfall)} a month short, so ${money(w.cash)} lasts until about ${monthLabel(runsOutMonth(today, rw.months), true)}.`;
      tone = rw.months < 3 ? 'bad' : rw.months < 6 ? 'warn' : '';
    }
    return el('section', { class: `money-answer${tone ? ` is-${tone}` : ''}`, 'aria-label': 'Runway' },
      el('p', { class: 'eyebrow' }, 'Runway'),
      el('p', { class: 'money-answer-big', dataset: { answer: rw.burning ? 'burning' : 'ok' } }, big),
      el('p', { class: 'money-answer-line' }, line),
      how(rw.burning
        ? `Cash on hand ÷ (monthly burn ${money(w.burn)} + your pay ${money(w.draw)} − average money in ${money(w.avg.average)}).`
        : `Average money in ${money(w.avg.average)} less monthly burn ${money(w.burn)} and your pay ${money(w.draw)}.`),
      stale !== null && stale > 31 ? el('p', { class: 'money-stale' }, icon('alert', 14), `Cash on hand was last updated ${dateFmt(s.cash_as_of)}. Update it for a truer answer.`) : null,
      !s.cash_as_of && w.cash === 0 ? el('p', { class: 'money-stale' }, icon('alert', 14), 'Enter your cash on hand above to see how long it lasts.') : null);
  }

  function fig(id, label, value, sub, howText, tone = '') {
    return el('div', { class: 'money-fig', dataset: { fig: id } },
      el('p', { class: 'eyebrow' }, label),
      el('p', { class: `money-fig-value${tone ? ` is-${tone}` : ''}` }, value),
      sub ? el('p', { class: 'money-kpi-sub' }, sub) : null,
      how(howText));
  }

  function figures(w, s, today) {
    const mk = monthKey(today);
    const months = w.avg.months.map((m) => `${monthLabel(m.key)} ${money(m.net)}`).join(', ');
    const gap = r2(w.avg.average - w.rw.need);
    return el('section', { class: 'section money-section' },
      sectionHead('The month', 'Where it stands'),
      el('div', { class: 'money-figs' },
        fig('month', `${monthLabel(mk, true)} so far`, signed(w.month.net), `${money(w.month.in)} in · ${money(w.month.out)} out`,
          'In: paid invoices this month less GST. Out: this month\'s recurring costs plus one-offs bought so far.', w.month.net < 0 ? 'bad' : ''),
        fig('avg', 'Average money in', `${money(w.avg.average)}/mo`, months, 'Paid invoices less GST over the last 3 full months, divided by 3.'),
        fig('burn', 'Monthly burn', `${money(w.burn)}/mo`, null, 'Running recurring costs; yearly ones count as a twelfth.'),
        fig('draw', 'Your pay', `${money(w.draw)}/mo`, null, 'What you need to take home, from the box above.'),
        fig('net', 'Net each month', signed(w.rw.net), w.rw.net < 0 ? 'Burning cash' : 'Building cash', 'Average money in − monthly burn − your pay.', w.rw.net < 0 ? 'bad' : 'ok'),
        fig('need', 'Break-even', `${money(w.rw.need)}/mo`,
          gap >= 0 ? `Average income is ${money(gap)} above it` : `Average income is ${money(-gap)} short of it`,
          `You need ${money(w.rw.need)} a month to cover costs and your pay: burn + your pay.`, gap < 0 ? 'warn' : '')));
  }

  function cover(w) {
    const need = w.rw.need;
    const max = Math.max(1, need, w.recurring);
    const pct = need > 0 ? w.recurring / need : null;
    const bar = (label, value, cls, id) => el('div', { class: 'money-hbar', dataset: { bar: id } },
      el('div', { class: 'money-hbar-label' }, el('span', {}, label), el('b', { class: 'tnum' }, `${money(value)}/mo`)),
      el('div', { class: 'money-hbar-track' }, el('i', { class: cls, style: { width: `${(value / max) * 100}%` } })));
    return el('section', { class: 'section money-section' },
      sectionHead('Retainers', pct === null ? 'Nothing to cover yet' : pct >= 1 ? 'Your month is paid for by retainers' : `${Math.round(pct * 100)}% of the month is already paid for`),
      el('div', { class: 'money-hbars' },
        bar('Recurring revenue', w.recurring, 'is-accent', 'recurring'),
        bar('Burn + your pay', need, 'is-ink', 'need')),
      how('Recurring revenue is the monthly value of your active clients. The share is that divided by burn plus your pay.'));
  }

  function taxBlock(w, s) {
    const q = w.quarter;
    const rate = n0(s.tax_rate);
    const total = r2(q.tax + (s.gst_registered ? q.gst : 0));
    return el('section', { class: 'section money-section' },
      sectionHead(`This quarter, ${q.label}`, `Set aside ${money(total)}`),
      el('div', { class: 'money-figs is-3' },
        fig('tax', 'Tax set-aside', money(q.tax), `${money(q.revenue)} revenue − ${money(q.costs)} costs`,
          `${Math.round(rate * 1000) / 10}% of revenue less costs so far this quarter, never below zero. A rough set-aside, not tax advice.`),
        fig('gst', 'GST to set aside', s.gst_registered ? money(q.gst) : 'Not registered', s.gst_registered ? 'Collected on paid invoices' : null,
          s.gst_registered ? 'The GST inside invoices paid this quarter. GST credits on your costs are not taken off here.' : 'Tick GST registered above if you are.'),
        fig('profit', 'Profit so far', signed(q.profit), null, 'Revenue less GST, minus this quarter\'s recurring costs (whole months) and one-offs.', q.profit < 0 ? 'bad' : '')));
  }

  function projBlock(w, s, today) {
    const { rows, zeroKey } = w.proj;
    return el('section', { class: 'section money-section' },
      sectionHead('Next six months', zeroKey ? `Cash runs out in ${monthLabel(zeroKey, true)}` : `${money(rows[rows.length - 1].close)} by ${monthLabel(rows[rows.length - 1].key, true)}`),
      zeroKey ? el('div', { class: 'callout is-bad' }, icon('alert', 16), el('span', {}, `On these numbers your cash goes below zero in ${monthLabel(zeroKey, true)}. Win work, chase invoices or cut costs before then.`)) : null,
      el('div', { class: 'table-wrap' }, el('table', { class: 'table money-table money-proj' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Month'), el('th', { class: 'num' }, 'Starting cash'), el('th', { class: 'num' }, 'Expected in'),
          el('th', { class: 'num' }, 'Out'), el('th', { class: 'num' }, 'Closing cash'))),
        el('tbody', {}, rows.map((r) => el('tr', { class: r.key === zeroKey ? 'is-zero' : '', dataset: { month: r.key } },
          el('td', {}, monthLabel(r.key, true), r.key === zeroKey ? el('span', { class: 'money-sub money-neg' }, 'hits zero') : null),
          el('td', { class: 'num muted' }, money(r.start)),
          el('td', { class: 'num' }, money(r.in), el('span', { class: 'money-sub' }, `${money(r.retainers)} retainers${r.receivables ? ` · ${money(r.receivables)} invoices` : ''}`)),
          el('td', { class: 'num' }, money(r.out), el('span', { class: 'money-sub' }, `${money(r.recurring + r.oneOff)} costs · ${money(r.draw)} pay`)),
          el('td', { class: 'num' }, el('b', { class: r.close < 0 ? 'money-neg' : '' }, r.close < 0 ? `−${money(-r.close)}` : money(r.close)))))))),
      how('Starts next month from your cash on hand. In: active retainers plus unpaid invoices due that month (the first month also picks up anything overdue). Out: recurring costs, your pay and one-offs dated that month. All before GST.'));
  }

  paint();
  root.onState = () => { syncInputs(); paint(); };
  return root;
}
