// Spot: after a result tile in the chat takes you to a record, find that record on the
// page and flash a soft ring around it once, so it is easy to see where it landed.
// Works on what the views already expose (no view knows about this): the row, card or
// list item carrying the record's id, and a drawer that opened for it. If nothing
// matches, it does nothing. The ring's look lives in os-agents.css (.is-spotted).
const RING_MS = 1600;
const WAIT_MS = 3200;

/** How each kind of record is marked on its page. Most views use data-id. */
const SELECTORS = {
  agent_memory: (id) => [`[data-mem="${id}"]`],
  memory: (id) => [`[data-mem="${id}"]`]
};
const byId = (id) => [`#view [data-id="${id}"]`];

const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'));
const reduced = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const inChat = (n) => Boolean(n.closest('.cx, .agd-dock'));

let job = 0;

function candidates(table, ids) {
  const sels = [];
  for (const id of ids) {
    const e = esc(id);
    sels.push(...(SELECTORS[table] ? SELECTORS[table](e) : []), ...byId(e));
  }
  return sels;
}

function find(sels) {
  for (const s of sels) {
    let list = [];
    try { list = [...document.querySelectorAll(s)]; } catch { continue; }
    const hit = list.find((n) => !inChat(n) && n.getClientRects().length);
    if (hit) return hit;
  }
  return null;
}

function mark(node, started) {
  if (!node || node.classList.contains('is-spotted')) return;
  node.style.setProperty('--spot-delay', `-${Math.max(0, Date.now() - started)}ms`);
  node.classList.add('is-spotted');
  setTimeout(() => { node.classList.remove('is-spotted'); node.style.removeProperty('--spot-delay'); }, Math.max(0, RING_MS - (Date.now() - started)));
}

function inView(n) {
  const r = n.getBoundingClientRect();
  return r.top >= 56 && r.bottom <= window.innerHeight - 72;
}

/**
 * Ring the record once it is on the page.
 * table: the record's table (or a kind), id: its id, hash: where the tile went.
 * Ids are tried in order: the record's own, then the last part of the hash.
 */
export function spotRecord({ table = '', id = '', hash = '' } = {}) {
  const ids = [...new Set([id, String(hash || '').split('/').slice(1).pop()].filter((x) => x && /^[\w-]{6,}$/.test(String(x))))];
  const sels = candidates(table, ids);
  const drawersBefore = new Set(document.querySelectorAll('.drawer'));
  const me = ++job;
  const t0 = Date.now();
  let started = 0;
  let row = null; let drawer = null;
  const tick = () => {
    if (me !== job) return;
    const now = Date.now();
    if (hash && location.hash !== hash && now - t0 < 600) { setTimeout(tick, 60); return; }
    const d = [...document.querySelectorAll('.drawer:not(.is-leaving)')].find((n) => !drawersBefore.has(n) || (row && n.contains(row)));
    const r = sels.length ? find(sels) : null;
    if ((r || d) && !started) started = now;
    if (r && r !== row) {
      // A re-render replaced the row: ring the new one in step with the old.
      row = r;
      mark(r, started);
      if (!d && !inView(r)) r.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
    }
    if (d && d !== drawer) { drawer = d; mark(d, started); }
    const done = started ? now - started > RING_MS : now - t0 > WAIT_MS;
    if (!done) setTimeout(tick, 90);
  };
  setTimeout(tick, 60);
}
