// Motion helpers shared by the hub (tokens and keyframes live in os.css, rule 8).
// - reducedMotion(): the person asked for less motion (fades only, nothing moves).
// - viewTransition(update): run a navigation's DOM update inside a View Transition where
//   the browser has one, so the old view fades out as the new one fades in. Only for
//   navigations to another page, never for live re-renders. Progressive: without the API
//   (or with the tab hidden) it simply runs update().
// - navigate(hash): go to a hub hash with that transition (used by the assistant's tiles).
// - Toasts close up smoothly when one leaves (a FLIP on the stack, transform only).
// No dependencies; safe to import more than once.

/**
 * View Transitions are wired but held off: in measured runs (software rendering, 1440 and
 * 3440 wide) the snapshot of the old and new page cost a 60–200 ms frame, where the plain
 * page arrival (.page, os.css) stays at about one frame. Turn this on after a trace on
 * the real machines (GPU) shows the cross-fade holds 60 fps.
 */
export const VIEW_TRANSITIONS = false;
const canTransition = () => VIEW_TRANSITIONS && Boolean(document.startViewTransition) && !document.hidden && !running;

export const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

const routeOf = (h) => String(h || '').replace(/^#\/?/, '').split('/')[0] || 'home';
let lastRoute = routeOf(location.hash);
let running = null;
// The page's own arrival (.page, os.css) would replay when the transition ends: the
// transition is the arrival, so the new page is marked as already in.
const settle = () => { for (const p of document.querySelectorAll('#view .page')) p.style.animation = 'none'; };

/**
 * Wrap a navigation's update. `update` may return a promise (the hub's render is async).
 * Skipped (update runs plainly) when the route did not change, the API is missing, the
 * tab is hidden, or another transition is still running.
 */
export function viewTransition(update) {
  const to = routeOf(location.hash);
  const changed = to !== lastRoute;
  lastRoute = to;
  if (!changed || !canTransition()) return update();
  const root = document.documentElement;
  root.classList.add('mo-vt');
  try {
    running = document.startViewTransition(() => Promise.resolve(update()).catch(() => {}).then(settle));
  } catch { root.classList.remove('mo-vt'); return update(); }
  const done = () => { running = null; root.classList.remove('mo-vt'); };
  running.finished.then(done, done);
  return running.updateCallbackDone;
}

/** Go to a hub hash; the change of page cross-fades where the browser can. */
export function navigate(hash) {
  const h = String(hash || '');
  if (!h.startsWith('#') || location.hash === h) { if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange')); return; }
  if (!canTransition() || routeOf(h) === routeOf(location.hash)) { location.hash = h; return; }
  // The hub renders on hashchange; the new view is in place a task after it (capped at 400 ms).
  const root = document.documentElement;
  root.classList.add('mo-vt');
  lastRoute = routeOf(h);
  try {
    running = document.startViewTransition(() => new Promise((res) => {
      const t = setTimeout(res, 400);
      // (not a requestAnimationFrame: frames are held while a transition's update runs)
      window.addEventListener('hashchange', () => setTimeout(() => { clearTimeout(t); settle(); res(); }, 0), { once: true });
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
