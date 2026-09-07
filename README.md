# Wise AI — Website

Single self-contained static site (`index.html`). No build step.

## Deploy
Static host (Vercel/Netlify). Root = repo root, output = repo root, no build command.
Custom domain: wise-ai.au

## Look

"Real, restrained, proven": one near-black ground with a slow monochrome swirl
under film grain, typography carrying the weight, real photography in colour, no
glass tiles. The system lives in `styles.css`; every page shares it. The grain
is `mix-blend-mode: screen` on purpose — overlay cancels on a near-black ground.

## Two switches in `index.html`

- **Reviews.** Paste Google reviews into the `<script id="reviews-data">` JSON
  block, word for word, and the "Don't just take my word for it" section
  appears with its schema.org markup. Empty, it stays hidden.
- **Client naming.** `CONSENT = { bundy: false }` keeps the case study
  anonymised. Flip it to `true` once the client has agreed to be named, and
  every `data-client` span swaps to its `data-named` text.

## Tests

```bash
python3 -m http.server 8099 --bind 127.0.0.1 &
npm install playwright
node tests/site.test.mjs          # public site: layout, layers, switches, audit, contrast
```
The HQ console has its own suites under `admin/tests/`.
