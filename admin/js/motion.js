// Motion layer. GSAP loaded lazily from a CDN; the console works fully without it.
//
// Rules this follows, from the gsap-core skill:
//   - gsap.matchMedia() gates everything on prefers-reduced-motion
//   - transform aliases (y, scale) and autoAlpha only — never width/height/top/left
//   - timelines rather than chained delays
//   - gsap.defaults() so the whole console shares one feel
//
// Nothing here is decorative. Entrances orient you in a view you just switched
// to; the count-up puts your eye on a number. If the CDN is blocked the page
// renders exactly as it does now, just without the movement.

const GSAP_URL = 'https://cdn.jsdelivr.net/npm/gsap@3.13.0/+esm';

let gsap = null;
let loading = null;
let reduced = false;

/** Resolve to the gsap instance, or null if it cannot be loaded. */
function loadGsap() {
  if (gsap) return Promise.resolve(gsap);
  if (loading) return loading;

  loading = import(/* @vite-ignore */ GSAP_URL)
    .then((mod) => {
      gsap = mod.gsap || mod.default;
      if (!gsap) throw new Error('no gsap export');

      gsap.defaults({ duration: 0.42, ease: 'power2.out' });
      document.documentElement.classList.add('js-motion');

      // One matchMedia decides whether anything moves at all.
      gsap.matchMedia().add('(prefers-reduced-motion: reduce)', () => {
        reduced = true;
        return () => { reduced = false; };
      });
      return gsap;
    })
    .catch(() => {
      gsap = null;          // stay null so callers no-op
      return null;
    });

  return loading;
}

/** Kick the load early without blocking first paint. */
export function primeMotion() {
  if ('requestIdleCallback' in window) requestIdleCallback(() => loadGsap(), { timeout: 2000 });
  else setTimeout(loadGsap, 300);
}

/* ------------------------------------------------------------------ count-up */

// "$1,030" -> { value: 1030, render(n) }
//
// Split on the numeric run INCLUDING its group separators. Measuring the run by
// the length of a digits-only copy instead leaves the separators unaccounted
// for, and the suffix then swallows a real digit — "$1,234" yielding a suffix
// of "4", so every frame rendered "$1,1534" and the tile appeared to count past
// its target.
function parseDisplay(text) {
  const raw = String(text).trim();
  const match = raw.match(/-?\d[\d,]*(?:\.\d+)?/);
  if (!match) return null;

  const magnitude = Number(match[0].replace(/,/g, ''));
  if (!Number.isFinite(magnitude) || Math.abs(magnitude) < 1) return null;

  // A currency figure signs itself before the symbol — "-$126" — so the minus
  // sits in the prefix, not in the matched number. Net/month is routinely
  // negative here, and dropping that sign would animate toward a wrong figure.
  const head = raw.slice(0, match.index);
  const negative = head.includes('-') || match[0].startsWith('-');
  const value = negative ? -Math.abs(magnitude) : magnitude;

  const prefix = head.replace('-', '');
  const suffix = raw.slice(match.index + match[0].length);
  const grouped = match[0].includes(',');
  // "$1.5m" must not round to "$2m" mid-count — keep the original precision.
  const decimals = (match[0].split('.')[1] || '').length;

  return {
    value,
    render(n) {
      const abs = Math.abs(n);
      const body = decimals
        ? abs.toFixed(decimals)
        : grouped ? Math.round(abs).toLocaleString('en-AU') : String(Math.round(abs));
      return `${negative ? '-' : ''}${prefix}${body}${suffix}`;
    }
  };
}

/**
 * Count the KPI figures up to the value the view already rendered, then restore
 * that exact string — so the animation can never leave a differently-formatted
 * number on screen than the one the view computed.
 */
function countUp(root) {
  const nodes = [...root.querySelectorAll('.stat-value .num')];
  for (const node of nodes) {
    const final = node.textContent;
    const parsed = parseDisplay(final);
    if (!parsed) continue;

    const counter = { n: 0 };
    gsap.to(counter, {
      n: parsed.value,
      duration: 0.75,
      ease: 'power2.out',
      onUpdate: () => { node.textContent = parsed.render(counter.n); },
      onComplete: () => { node.textContent = final; },
      onInterrupt: () => { node.textContent = final; }
    });
  }
}

/* ------------------------------------------------------------------ entrances */

/**
 * Animate a freshly rendered view in.
 * `full` runs the whole entrance (route change); otherwise only new list rows
 * settle, so editing a record does not replay the entire screen.
 */
export function animateView(root, { full = false } = {}) {
  if (!gsap || reduced || !root) return;

  // from() with autoAlpha sets visibility:hidden as its START state. If a tween
  // is ever interrupted — a re-render mid-flight, a backgrounded tab, a starved
  // main thread — that hidden state is what stays on screen. clearProps strips
  // the inline styles on completion, and the interrupt handler does the same if
  // it never gets there, so content can never be left invisible.
  const settle = (targets) => gsap.set(targets, { clearProps: 'opacity,visibility,transform' });

  const reveal = (targets, vars, position) => {
    const list = [...targets];
    if (!list.length) return;
    tl.from(list, {
      ...vars,
      clearProps: 'opacity,visibility,transform',
      onInterrupt: () => settle(list)
    }, position);
  };

  const tl = gsap.timeline();

  if (full) {
    const stats = root.querySelectorAll('.stat');
    reveal(stats, { y: 14, autoAlpha: 0, stagger: { each: 0.045, from: 'start' } }, 0);
    reveal(root.querySelectorAll('.card, .col, .lib-card'),
      { y: 12, autoAlpha: 0, stagger: { each: 0.035 } }, stats.length ? 0.08 : 0);
    countUp(root);
  } else {
    reveal(root.querySelectorAll('.stagger-in > *'),
      { y: 6, autoAlpha: 0, duration: 0.3, stagger: { each: 0.018, from: 'start' } }, 0);
  }

  return tl;
}

/** Called once per render by the shell. Loads GSAP on first use. */
export function onRendered(root, opts) {
  if (gsap) return animateView(root, opts);
  loadGsap().then((g) => { if (g) animateView(root, opts); });
}
