# Wise AI — HQ console (`/admin`)

A single-user, browser-only console for running Wise AI: pipeline, clients,
projects and tasks, and the money behind them.

## How it is built

Static ES modules, no build step, no dependencies, no server. It is deployed by
the same GitHub Pages pipeline as the rest of the site.

```
admin/
  index.html        shell
  admin.css         dark-glass HQ design system
  js/
    vault.js        PBKDF2 -> AES-GCM encrypted storage
    store.js        data model, persistence, derived metrics
    charts.js       inline SVG charts (bar, area, donut, meter)
    ui.js           DOM helpers, icons, formatting, modals, toasts
    app.js          gate, hash router, shell, idle auto-lock
    views/          overview, pipeline, clients, work, money, settings
```

## Security model — read this before putting real numbers in

**What it does.** Everything entered is encrypted with AES-GCM-256 under a key
derived from the passcode via PBKDF2-SHA256 (310,000 iterations) and stored in
this browser's `localStorage`. The passcode is never stored; a wrong passcode
simply fails to decrypt. The session key is held in memory only and dropped on
lock, on tab close, and after 20 minutes idle.

**What it does not do.** `wise-ai-website` is a **public** repository served as
static files. There is no server, so the gate is enforced by the browser, not by
an access-control layer — the page source is readable by anyone. That is fine,
because the page ships with **no business data in it**: the repository contains
the application only. The data lives encrypted in the operator's browser.

**The rule that follows from that:** never commit a plain-JSON export to this
repository. Seed and backup files belong in the private `Ecosystem` repo, and
the encrypted export (Settings → Encrypted backup) is the format to use.

**If this ever needs real server-side auth** — multi-device sync, more than one
user, or data that must not live only in a browser — the pattern already exists
at `Ecosystem/hq/`: Vercel middleware with an HMAC session cookie and the
passcode in an environment variable. Move the same views behind that gate.

## Backups

There is no cloud copy. Clearing site data or switching device starts from an
empty vault. Take an encrypted backup from Settings after any significant
update and keep it in the private repo.

## Brand

Type and colour follow `Ecosystem/Brand/Typography.md` (Archivo display, Inter
UI) and the dark-glass system in `Ecosystem/Brand/Visual Style.md`, which that
document explicitly keeps live for internal HQ surfaces while the public site
uses the "real, restrained, proven" direction instead.
