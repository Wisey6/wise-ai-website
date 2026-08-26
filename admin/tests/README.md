# HQ console tests

Browser tests driven by Playwright against a locally served copy of the site.
They exercise the real UI — no mocks, no test-only hooks.

## Running them

```bash
# from the repository root
python3 -m http.server 8099 --bind 127.0.0.1 &
npm install playwright          # browsers are preinstalled in CI images
node admin/tests/console.test.mjs        # 15 functional checks
node admin/tests/responsive.test.mjs     # 5 breakpoints x 6 routes
node admin/tests/a11y.test.mjs           # names, focus, contrast, Escape
```

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

**a11y.test.mjs** — keyboard-only vault creation, an accessible name on every
interactive control, a visible focus ring, WCAG AA contrast (4.5:1) for each
text tier against the canvas, and Escape closing a modal.

## Note on the sandbox

Google Fonts is blocked in some CI sandboxes, so screenshots taken there render
in fallback faces. That affects appearance only, not the assertions.
