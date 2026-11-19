// Motion helpers shared by the hub (tokens and keyframes live in os.css, rule 8).
// - reducedMotion(): the person asked for less motion (fades only, nothing moves).
// - viewTransition(update): run a navigation's DOM update inside a View Transition where
//   the browser has one, so the old view fades out as the new one fades in. Only for
//   navigations to another page, never for live re-renders. Progressive: without the API
//   (or with the tab hidden) it simply runs update().
// - navigate(hash): go to a hub hash with that transition (used by the assistant's tiles).
// - Toasts close up smoothly when one leaves (a FLIP on the stack, transform only).
// No dependencies; safe to import more than once.

export const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

const routeOf = (h) => String(h || '').replace(/^#\/?/, '').split('/')[0] || 'home';
let lastRoute = routeOf(location.hash);
let running = null;

/**
 * Wrap a navigation's update. `update` may return a promise (the hub's render is async).
 * Skipped (update runs plainly) when the route did not change, the API is missing, the
 * tab is hidden, or another transition is still running.
 */
export function viewTransition(update) {
  const to = routeOf(location.hash);
  const changed = to !== lastRoute;
  lastRoute = to;
  if (!changed || !document.startViewTransition || document.hidden || running) return update();
  const root = document.documentElement;
  root.classList.add('mo-vt');
  try {
    running = document.startViewTransition(() => Promise.resolve(update()).catch(() => {}));
  } catch { root.classList.remove('mo-vt'); return update(); }
  const done = () => { running = null; root.classList.remove('mo-vt'); };
  running.finished.then(done, done);
  return running.updateCallbackDone;
}

/** Go to a hub hash; the change of page cross-fades where the browser can. */
export function navigate(hash) {
  const h = String(hash || '');
  if (!h.startsWith('#') || location.hash === h) { if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange')); return; }
  if (!document.startViewTransition || document.hidden || running || routeOf(h) === routeOf(location.hash)) { location.hash = h; return; }
  // The hub renders on hashchange; the new view is ready a frame after it (capped at 400 ms).
  const root = document.documentElement;
  root.classList.add('mo-vt');
  lastRoute = routeOf(h);
  try {
    running = document.startViewTransition(() => new Promise((res) => {
      const t = setTimeout(res, 400);
      window.addEventListener('hashchange', () => requestAnimationFrame(() => { clearTimeout(t); res(); }), { once: true });
      location.hash = h;
    }));
  } catch { root.classList.remove('mo-vt'); location.hash = h; return; }
  const done = () => { running = null; root.classList.remove('mo-vt'); };
  running.finished.then(done, done);
}
window.addEventListener('hashchange', () => { if (!running) lastRoute = routeOf(location.hash); });

/* ------------------------------------------------------------ toast stack */
// When a toast leaves, the ones below it slide up instead of jumping (FLIP).
let toastObs = null;
const tops = new WeakMap();
function measure(wrap) { for (const t of wrap.children) tops.set(t, t.getBoundingClientRect().top); }
function watchToasts(wrap) {
  if (wrap.dataset.moWatched) return;
  wrap.dataset.moWatched = '1';
  measure(wrap);
  new MutationObserver(() => {
    if (reducedMotion()) { measure(wrap); return; }
    for (const t of wrap.children) {
      const before = tops.get(t);
      const now = t.getBoundingClientRect().top;
      if (before !== undefined && Math.abs(before - now) > 0.5 && !t.classList.contains('is-leaving')) {
        t.animate([{ transform: `translateY(${before - now}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' });
      }
    }
    measure(wrap);
  }).observe(wrap, { childList: true });
}
function bootToasts() {
  if (toastObs || !document.body) return;
  const w = document.querySelector('.toast-wrap');
  if (w) watchToasts(w);
  toastObs = new MutationObserver((list) => {
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1 && n.classList.contains('toast-wrap')) watchToasts(n);
  });
  toastObs.observe(document.body, { childList: true });
}
if (document.body) bootToasts(); else document.addEventListener('DOMContentLoaded', bootToasts, { once: true });
