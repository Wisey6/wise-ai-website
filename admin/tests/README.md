# HQ console tests

Browser tests driven by Playwright against a locally served copy of the site.
They exercise the real UI — no mocks, no test-only hooks.

## Running them

```bash
# from the repository root
python3 -m http.server 8099 --bind 127.0.0.1 &
npm install playwright          # browsers are preinstalled in CI images
node admin/tests/console.test.mjs        # 15 functional checks
node admin/tests/features.test.mjs       # outputs, library, archive
node admin/tests/responsive.test.mjs     # 5 breakpoints x 8 routes
node admin/tests/a11y.test.mjs           # names, focus, contrast, Escape
```

`motion.test.mjs` needs GSAP served locally, because it has to exercise the
animation path rather than the graceful-degradation path:

```bash
curl -sL -o /tmp/m/gsap.js https://cdn.jsdelivr.net/npm/gsap@3.13.0/+esm
cp -r admin /tmp/m/ && sed -i 's|https://cdn.jsdelivr.net/npm/gsap@3.13.0/+esm|/gsap.js|' /tmp/m/admin/js/motion.js
(cd /tmp/m && python3 -m http.server 8177 --bind 127.0.0.1 &)
node admin/tests/motion.test.mjs
```

`BASE` overrides the server URL and `CHROME` the browser binary.

Add `shots` to the console run (`node admin/tests/console.test.mjs shots`) to
write a screenshot per route.

`CHROME` overrides the browser binary if the default path does not exist.

## What is covered

**console.test.mjs** — first-run vault creation, short/mismatched passcode
rejection, that `localStorage` holds ciphertext at 310k PBKDF2 iterations and no
plaintext, adding a client / income / recurring cost / deal / project / task
through the real modals, that the derived metrics (collected, burn, weighted
pipeline) recompute correctly, drag-to-stage, the task filter, lock-and-unlock
round trip, and that a wrong passcode is refused while the right one restores
every collection.

**responsive.test.mjs** — every route at 375, 390, 768, 1024 and 1440 wide,
asserting no horizontal page scroll and that the content column is not being
squeezed by the rail.

**features.test.mjs** — the Outputs and Library sections end to end: adding
through the real modals, the draft-outputs callout, archive and restore round
trips, library search across title/notes/tags, that archiving a client drops it
out of MRR, and that an archived task leaves the board but survives in the
Archived filter.

**motion.test.mjs** — the animation layer under stress. Runs 24 deliberately
interrupted view entrances (switching route every 35ms against a 420ms
entrance) and asserts nothing is left invisible, then interrupts a KPI count-up
and asserts the figure still settles on its true value. `from()` with
`autoAlpha` sets `visibility: hidden` as its *start* state, so an interrupted
tween is exactly how a dashboard ends up blank — this is the test that keeps
that from shipping.

**a11y.test.mjs** — keyboard-only vault creation, an accessible name on every
interactive control, a visible focus ring, WCAG AA contrast (4.5:1) for each
text tier against the canvas, and Escape closing a modal.

## Note on the sandbox

Google Fonts is blocked in some CI sandboxes, so screenshots taken there render
in fallback faces. That affects appearance only, not the assertions.

The GSAP CDN is usually blocked too. That is not a failure — the console is
built to work without it, and every suite except `motion.test.mjs` passes on
the no-GSAP path. Run `motion.test.mjs` against a local copy of GSAP (above) to
cover the other one.
