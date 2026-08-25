// Overview — the "is the business OK today" screen.

import { el, icon, money, shortMoney, dueLabel, badge, chip, daysUntil } from '../ui.js';
import { barChart, areaChart, donutChart, donutLegend, meter } from '../charts.js';
import { metrics, incomeByMonth, cumulativeIncome, revenueByClient, upcomingBills, clientName } from '../store.js';

function stat(label, iconName, value, { sub, delta, deltaDir } = {}) {
  return el('div', { class: 'stat' },
    el('div', { class: 'stat-label' }, icon(iconName, 13), label),
    el('div', { class: 'stat-value' },
      el('span', { class: 'num' }, value),
      delta ? chip(delta, deltaDir) : null
    ),
    sub ? el('div', { class: 'stat-sub' }, sub) : null
  );
}

function card(title, actions, ...body) {
  return el('section', { class: 'card' },
    el('div', { class: 'card-head' },
      el('div', { class: 'card-head-left' }, el('h2', {}, title)),
      actions ? el('div', { class: 'topbar-actions' }, actions) : null
    ),
    el('div', { class: 'card-body' }, ...body)
  );
}

export function overviewView(store) {
  const d = store.data;
  const m = metrics(d);

  const months = incomeByMonth(d, 12);
  const thisMonth = months.at(-1)?.value || 0;
  const lastMonth = months.at(-2)?.value || 0;
  const monthDelta = lastMonth > 0
    ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100)
    : null;

  const bills = upcomingBills(d, 30);
  const overdueBills = bills.filter((b) => daysUntil(b.nextDue) < 0);

  const dueTasks = d.tasks
    .filter((t) => t.status !== 'done' && t.due)
    .sort((a, b) => a.due.localeCompare(b.due))
    .slice(0, 6);

  const byClient = revenueByClient(d).slice(0, 6);

  return el('div', {},
    /* ---- KPI row ---- */
    el('div', { class: 'stat-row' },
      stat('Collected', 'wallet', money(m.collected), { sub: 'All time, cleared' }),
      stat('MRR', 'clock', money(m.mrr), {
        sub: `${m.activeClients} active client${m.activeClients === 1 ? '' : 's'}`
      }),
      stat('Outstanding', 'invoice', money(m.outstanding), {
        sub: m.unbilled > 0 ? `+ ${money(m.unbilled)} unbilled` : 'Invoiced, awaiting payment'
      }),
      stat('Monthly burn', 'down', money(m.burn), { sub: 'Active recurring costs' }),
      stat('Net / month', 'up', money(m.net), {
        delta: monthDelta !== null ? `${monthDelta > 0 ? '+' : ''}${monthDelta}%` : null,
        deltaDir: monthDelta === null ? 'flat' : monthDelta > 0 ? 'up' : monthDelta < 0 ? 'down' : 'flat',
        sub: 'MRR less recurring out'
      }),
      stat('Pipeline', 'pipeline', money(m.pipelineValue), {
        sub: `${m.openDeals} open · ${money(m.weightedPipeline)} weighted`
      })
    ),

    /* ---- quit line ---- */
    el('section', { class: 'card section' },
      el('div', { class: 'card-body' },
        el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:12px' },
          el('div', {},
            el('span', { class: 'eyebrow' }, 'Quit line'),
            el('div', { style: 'display:flex;align-items:baseline;gap:8px;margin-top:6px' },
              el('span', { class: 'num', style: 'font-size:23px' }, money(m.net)),
              el('span', { class: 'muted', style: 'font-size:13px' }, `of ${money(m.quitLine)} / month`)
            )
          ),
          el('div', { style: 'text-align:right' },
            el('span', { class: 'num', style: 'font-size:23px' }, `${Math.round(m.quitProgress * 100)}%`),
            el('div', { class: 'stat-sub' },
              m.gapToQuitLine > 0 ? `${money(m.gapToQuitLine)} to go` : 'Target cleared')
          )
        ),
        meter(m.quitProgress)
      )
    ),

    /* ---- charts ---- */
    el('div', { class: 'grid-main section' },
      card('Income received', el('span', { class: 'eyebrow' }, 'Last 12 months'),
        barChart(months)),
      card('Revenue by client', el('span', { class: 'eyebrow' }, 'Cleared'),
        el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:18px' },
          donutChart(byClient, { centreLabel: 'Collected' }),
          byClient.length ? donutLegend(byClient) : null
        ))
    ),

    el('section', { class: 'card section' },
      el('div', { class: 'card-head' },
        el('div', { class: 'card-head-left' }, el('h2', {}, 'Cumulative revenue')),
        el('span', { class: 'eyebrow' }, `Against ${shortMoney(m.quitLine)}/mo target`)
      ),
      el('div', { class: 'card-body' },
        areaChart(cumulativeIncome(d, 12), { target: m.quitLine }))
    ),

    /* ---- bills + tasks ---- */
    el('div', { class: 'grid-2' },
      card('Bills due',
        overdueBills.length
          ? badge(`${overdueBills.length} overdue`, 'bad')
          : el('span', { class: 'eyebrow' }, 'Next 30 days'),
        bills.length
          ? el('div', { class: 'table-scroll' }, el('table', {},
              el('thead', {}, el('tr', {},
                el('th', {}, 'Item'), el('th', {}, 'Due'), el('th', { class: 't-right' }, 'Amount'))),
              el('tbody', {}, bills.slice(0, 8).map((b) => {
                const days = daysUntil(b.nextDue);
                return el('tr', {},
                  el('td', {},
                    el('div', { style: 'font-weight:500' }, b.item),
                    el('div', { class: 'dim', style: 'font-size:11.5px' }, b.vendor || '')),
                  el('td', {}, badge(dueLabel(b.nextDue), days < 0 ? 'bad' : days <= 7 ? 'warn' : '')),
                  el('td', { class: 't-right t-num' }, money(b.amount, true))
                );
              }))
            ))
          : el('p', { class: 'muted', style: 'font-size:13px' }, 'Nothing due in the next 30 days.')
      ),

      card('Next up',
        m.overdueTasks ? badge(`${m.overdueTasks} overdue`, 'bad') : el('span', { class: 'eyebrow' }, `${m.openTasks} open`),
        dueTasks.length
          ? el('div', {}, dueTasks.map((t) => {
              const days = daysUntil(t.due);
              return el('div', { class: 'task', style: 'padding-left:0;padding-right:0' },
                el('div', { class: 'task-main' },
                  el('div', { class: 'task-title' }, t.title),
                  el('div', { class: 'task-meta' },
                    el('span', { class: `pri-${t.priority || 'low'}` }, `● ${t.priority || 'low'}`),
                    t.clientId ? el('span', {}, clientName(d, t.clientId)) : null,
                    el('span', { class: days < 0 ? 'pri-high' : '' }, dueLabel(t.due))
                  )
                )
              );
            }))
          : el('p', { class: 'muted', style: 'font-size:13px' }, 'No dated tasks. Add one from Work.')
      )
    )
  );
}
