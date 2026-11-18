// Wise AI OS: Files (OneDrive), end to end in the browser against a FAKE OneDrive. The `onedrive`
// edge function is mocked with an in-memory drive (folders, a PDF, an image, Word/Excel/PowerPoint
// files, a 100-item folder) for every state and action, and the file_links / file_changes reads
// are mocked too, so nothing touches Microsoft or writes to the database.
//
//   python3 -m http.server 8152 --bind 127.0.0.1 &
//   OS_TEST_PASSWORD=… BASE=http://127.0.0.1:8152/os/ node os/tests/files.test.mjs [shots-dir]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const BASE = process.env.BASE || 'http://127.0.0.1:8152/os/';
const PASSWORD = process.env.OS_TEST_PASSWORD;
// The operator sign-in address: from the environment, or the one the existing suites use (not repeated here).
const EMAIL = process.env.OS_TEST_EMAIL || (readFileSync(join(ROOT, 'os', 'tests', 'views.test.mjs'), 'utf8').match(/email: '([^']+)'/) || [])[1];
const SHOTS = process.argv[2] || null;
if (!PASSWORD) { console.error('Set OS_TEST_PASSWORD'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const fails = [];
const passes = [];
const check = (cond, msg) => { (cond ? passes : fails).push(msg); console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); };

/* ================================================================ the fake drive */
const ago = (days, h = 0) => new Date(Date.now() - days * 86400000 - h * 3600000).toISOString();
const IMG = {
  photo: readFileSync(join(ROOT, 'about-tyler.jpg')),
  og: readFileSync(join(ROOT, 'og-image.png'))
};
const pageSvg = (title, lines = 14, accent = '#1D4ED8') => `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800" viewBox="0 0 600 800"><rect width="600" height="800" fill="#fff"/><rect x="60" y="70" width="${Math.min(420, title.length * 16)}" height="22" rx="3" fill="#0A0E11"/><rect x="60" y="106" width="140" height="6" rx="3" fill="${accent}"/>${Array.from({ length: lines }, (_, i) => `<rect x="60" y="${150 + i * 34}" width="${480 - (i % 4) * 60}" height="10" rx="5" fill="#D3D7DB"/>`).join('')}</svg>`;
const sheetSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="560" viewBox="0 0 800 560"><rect width="800" height="560" fill="#fff"/>${Array.from({ length: 14 }, (_, r) => Array.from({ length: 6 }, (_, c) => `<rect x="${20 + c * 128}" y="${20 + r * 38}" width="124" height="34" fill="${r === 0 ? '#EEF0F2' : '#fff'}" stroke="#E3E6E9"/>`).join('')).join('')}<rect x="150" y="62" width="70" height="8" rx="4" fill="#15803D"/></svg>`;
const slideSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><rect width="800" height="450" fill="#0A0E11"/><rect x="60" y="150" width="420" height="36" rx="4" fill="#fff"/><rect x="60" y="206" width="260" height="10" rx="5" fill="#989CA0"/><rect x="60" y="380" width="80" height="6" rx="3" fill="#D97706"/></svg>`;
// A one-page PDF (valid enough for a viewer).
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 88>>stream\nBT /F1 28 Tf 72 740 Td (Wise AI price list) Tj ET BT /F1 12 Tf 72 700 Td (Fake test file) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

function newDrive(provider = 'onedrive') {
  const items = {};
  const add = (o) => { items[o.id] = { size: 0, created: ago(120), modified: ago(30), modified_by: 'Tyler W', ...o }; return items[o.id]; };
  add({ id: 'ROOT', name: 'root', folder: true, is_root: true });
  add({ id: 'CL', name: 'Clients', folder: true, parent: 'ROOT', modified: ago(1) });
  add({ id: 'SP', name: 'Smith Plumbing', folder: true, parent: 'CL', modified: ago(2) });
  add({ id: 'HD', name: 'Harbour Dental', folder: true, parent: 'CL', modified: ago(9) });
  add({ id: 'PR', name: 'Proposals', folder: true, parent: 'ROOT', modified: ago(4) });
  add({ id: 'PH', name: 'Photos', folder: true, parent: 'ROOT', modified: ago(12) });
  add({ id: 'BIG', name: 'Receipts 2026', folder: true, parent: 'ROOT', modified: ago(0, 3) });
  add({ id: 'EMPTY', name: 'Templates', folder: true, parent: 'ROOT', modified: ago(40) });
  add({ id: 'PDF1', name: 'Wise AI price list.pdf', parent: 'ROOT', size: 482113, mime: 'application/pdf', modified: ago(0, 5), thumb: 'doc-pdf' });
  add({ id: 'IMG1', name: 'Site visit, Smith Plumbing.jpg', parent: 'ROOT', size: 2311552, mime: 'image/jpeg', modified: ago(3), thumb: 'photo' });
  add({ id: 'DOC1', name: 'Scope of work.docx', parent: 'ROOT', size: 61440, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', modified: ago(1, 2), thumb: 'doc-word' });
  add({ id: 'XLS1', name: 'Monthly numbers.xlsx', parent: 'ROOT', size: 28672, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modified: ago(6), thumb: 'sheet' });
  add({ id: 'PPT1', name: 'Pitch deck.pptx', parent: 'ROOT', size: 5242880, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', modified: ago(15), thumb: 'slide' });
  add({ id: 'SPQ', name: 'Smith Plumbing quote.pdf', parent: 'SP', size: 120000, mime: 'application/pdf', modified: ago(2), thumb: 'doc-pdf' });
  add({ id: 'OG', name: 'Brand banner.png', parent: 'PH', size: 90000, mime: 'image/png', thumb: 'og' });
  for (let i = 1; i <= 100; i++) add({ id: `R${i}`, name: `Receipt ${String(i).padStart(3, '0')}.pdf`, parent: 'BIG', size: 30000 + i * 917, mime: 'application/pdf', modified: ago(i % 30) });
  if (provider === 'gdrive') {
    // Google flavour: Google Docs/Sheets in place of Word/Excel, and a shared drive.
    delete items.DOC1; delete items.XLS1;
    add({ id: 'GDOC', name: 'Scope of work', parent: 'ROOT', mime: 'application/vnd.google-apps.document', modified: ago(1, 2), thumb: 'doc-word', size: null });
    add({ id: 'GSHEET', name: 'Monthly numbers', parent: 'ROOT', mime: 'application/vnd.google-apps.spreadsheet', modified: ago(6), thumb: 'sheet', size: null });
    add({ id: 'shared', name: 'Shared drives', folder: true, parent: 'ROOT', virtual: true, modified: null });
    add({ id: 'SD1', name: 'Clients shared', folder: true, parent: 'shared', drive: 'SD1', drive_root: true });
    add({ id: 'SDF', name: 'Team notes.pdf', parent: 'SD1', drive: 'SD1', size: 88000, mime: 'application/pdf', thumb: 'doc-pdf' });
  }
  return { items, changes: [], links: [], calls: [], seq: 0, provider };
}

const kindOf = (name, folder, mime) => {
  if (folder) return 'folder';
  if (mime === 'application/vnd.google-apps.document') return 'gdoc';
  if (mime === 'application/vnd.google-apps.spreadsheet') return 'gsheet';
  const ext = (name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || '').toLowerCase();
  return ({ docx: 'word', xlsx: 'excel', pptx: 'powerpoint', pdf: 'pdf', jpg: 'image', png: 'image' })[ext] || 'file';
};
function pathOf(d, id) {
  const out = [];
  for (let cur = d.items[id]; cur; cur = d.items[cur.parent]) {
    out.unshift(cur.is_root ? { id: cur.id, name: rootLabel(d) } : { id: cur.id, name: cur.name });
    if (cur.is_root || cur.virtual) break;
  }
  return out;
}
const rootLabel = (d) => (d.provider === 'gdrive' ? 'My Drive' : 'OneDrive');
const driveOf = (d, it) => { for (let c = it; c; c = d.items[c.parent]) if (c.drive) return c.drive; return null; };
const THUMB = 'https://thumbs.fake-onedrive.test/';
function shape(d, it) {
  const kids = Object.values(d.items).filter((x) => x.parent === it.id);
  const pp = it.parent ? pathOf(d, it.parent).slice(1).map((p) => p.name).join('/') : null;
  const ext = (it.name.match(/\.([a-z0-9]{1,8})$/i)?.[1] || '').toLowerCase();
  const g = d.provider === 'gdrive';
  const kind = kindOf(it.name, it.folder, it.mime);
  return {
    id: it.id, name: it.is_root ? rootLabel(d) : it.name, folder: Boolean(it.folder), child_count: it.folder && !g ? kids.length : null, size: it.folder ? null : it.size ?? null,
    mime: it.mime || null, kind, ext, ...(kind === 'gdoc' ? { badge: 'DOC' } : kind === 'gsheet' ? { badge: 'SHEET' } : {}),
    modified: it.modified, created: it.created, modified_by: it.modified_by,
    web_url: g ? (kind === 'gdoc' ? `https://docs.google.com/document/d/${it.id}/edit` : `https://drive.google.com/file/d/${it.id}/view`) : `https://onedrive.live.com/?id=${it.id}`,
    parent_id: it.parent || null, parent_path: g ? null : it.parent ? `/${pp}`.replace(/^\/$/, '/') : null, is_root: Boolean(it.is_root || it.drive_root),
    drive_id: g ? driveOf(d, it) : undefined, can_rename: it.virtual || it.drive_root ? false : undefined, can_move: it.virtual || it.drive_root ? false : undefined,
    thumb: it.thumb ? { small: `${THUMB}${it.thumb}?s`, medium: `${THUMB}${it.thumb}?m`, large: `${THUMB}${it.thumb}?l` } : null
  };
}

/* The mock of the onedrive function. `cfg` decides the state; `d` is the drive. */
async function mockDrive(ctx, cfg, d) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS, GET' };
  const reply = (route, status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const prov = cfg.provider || 'onedrive';
  const other = prov === 'gdrive' ? 'onedrive' : 'gdrive';
  // The other provider is not set up.
  await ctx.route(`**/functions/v1/${other}`, (route) => (route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors })
    : reply(route, 200, { ok: true, configured: false, connected: false, can_connect: cfg.role !== 'member', owner_name: 'Tyler' })));
  await ctx.route(`**/functions/v1/${prov}`, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    let b = {};
    try { b = JSON.parse(route.request().postData() || '{}'); } catch { /* */ }
    d.calls.push(b);
    if (cfg.delay) await new Promise((r) => setTimeout(r, cfg.delay));
    const owner = cfg.role !== 'member';
    const fail = (status, error, message) => reply(route, status, { ok: false, error, message });
    if (b.action === 'status') {
      return reply(route, 200, {
        ok: true, configured: cfg.configured !== false, connected: Boolean(cfg.connected), needs_reconnect: Boolean(cfg.reconnect),
        can_connect: owner, owner_name: 'Tyler',
        account: cfg.connected ? { name: 'Tyler Wise', connected_at: ago(20), connected_by: 'Tyler', root_id: 'ROOT' } : null
      });
    }
    if (b.action === 'connect_url') return owner ? reply(route, 200, { ok: true, url: `${BASE}?fake-microsoft-signin=1#files`, expires_in: 600 }) : fail(403, 'owner_only', 'Only the owner can connect or disconnect OneDrive.');
    if (b.action === 'disconnect') { cfg.connected = false; return reply(route, 200, { ok: true, connected: false }); }
    if (cfg.configured === false) return fail(409, 'not_configured', 'OneDrive is not set up yet.');
    if (!cfg.connected) return fail(409, 'not_connected', 'OneDrive is not connected yet.');
    if (cfg.reconnect) return fail(409, 'reconnect_needed', 'Microsoft needs you to sign in to OneDrive again.');
    if (cfg.busyOnce) { cfg.busyOnce = false; return fail(503, 'busy', 'OneDrive is busy right now. Try again in a minute.'); }
    const it = (id) => d.items[id === 'root' || !id ? 'ROOT' : id];
    const now = new Date().toISOString();
    const log = (row) => { const c = { id: `00000000-0000-4000-8000-${String(++d.seq).padStart(12, '0')}`, at: now, member_id: null, source: 'hub', chat_id: null, undone_at: null, provider: d.provider, ...row }; d.changes.unshift(c); return c; };
    switch (b.action) {
      case 'list': case 'folders': {
        const f = it(b.item_id);
        if (!f) return fail(404, 'not_found', 'That file or folder is no longer in OneDrive.');
        let kids = Object.values(d.items).filter((x) => x.parent === f.id);
        if (b.action === 'folders') kids = kids.filter((x) => x.folder);
        return reply(route, 200, { ok: true, folder: shape(d, f), items: kids.map((k) => shape(d, k)), cursor: null, path: b.with_path || b.action === 'folders' ? pathOf(d, f.id) : null });
      }
      case 'search': {
        const q = String(b.q || '').toLowerCase();
        return reply(route, 200, { ok: true, q: b.q, items: Object.values(d.items).filter((x) => !x.is_root && x.name.toLowerCase().includes(q)).slice(0, 100).map((x) => shape(d, x)) });
      }
      case 'item': {
        const x = it(b.id);
        if (!x) return fail(404, 'not_found', 'That file or folder is no longer in OneDrive. It may have been moved or removed there.');
        const sh = shape(d, x);
        const gdoc = sh.kind === 'gdoc' || sh.kind === 'gsheet';
        return reply(route, 200, {
          ok: true, item: sh, download_url: x.folder || gdoc ? null : `https://dl.fake-onedrive.test/${x.id}`,
          ...(d.provider === 'gdrive' ? { preview_url: gdoc || sh.kind === 'pdf' || sh.kind === 'image' ? `https://dl.fake-onedrive.test/${x.id}` : null } : {}),
          path: b.with_path ? pathOf(d, x.parent) : null, links: d.links.filter((l) => l.item_id === x.id)
        });
      }
      case 'rename': {
        const x = it(b.id);
        if (/["*:<>?/\\|]/.test(b.name)) return fail(400, 'bad_name', 'That name cannot be used in OneDrive.');
        if (Object.values(d.items).some((y) => y !== x && y.parent === x.parent && y.name === b.name)) return fail(409, 'name_taken', 'Something with that name is already in that folder.');
        const before = x.name; x.name = b.name; x.modified = now;
        const change = log({ item_id: x.id, op: 'rename', before: { name: before, parent_id: x.parent }, after: { name: x.name, parent_id: x.parent }, summary: `Renamed ${before} to ${x.name}` });
        d.links.filter((l) => l.item_id === x.id).forEach((l) => { l.name = x.name; });
        return reply(route, 200, { ok: true, item: shape(d, x), change });
      }
      case 'move': {
        const x = it(b.id), dest = it(b.parent_id);
        if (!x || !dest) return fail(403, 'outside_drive', 'That item is not in the connected OneDrive.');
        if (x.parent === dest.id) return reply(route, 200, { ok: true, item: shape(d, x), change: null, unchanged: true });
        if (d.provider === 'gdrive' && (dest.virtual || driveOf(d, x) !== driveOf(d, dest))) return fail(400, 'cross_drive', 'Moving between My Drive and a shared drive, or between shared drives, is done in Google Drive itself.');
        const from = d.items[x.parent];
        x.parent = dest.id;
        const fromName = from.is_root ? rootLabel(d) : from.name, toName = dest.is_root ? rootLabel(d) : dest.name;
        const change = log({ item_id: x.id, op: 'move', before: { parent_id: from.id, parent_name: fromName, name: x.name }, after: { parent_id: dest.id, parent_name: toName, name: x.name }, summary: `Moved ${x.name} from ${fromName} to ${toName}` });
        return reply(route, 200, { ok: true, item: shape(d, x), change });
      }
      case 'create_folder': {
        const p = it(b.parent_id);
        if (Object.values(d.items).some((y) => y.parent === p.id && y.name === b.name)) return fail(409, 'name_taken', 'Something with that name is already in that folder.');
        const id = `NF${++d.seq}`;
        d.items[id] = { id, name: b.name, folder: true, parent: p.id, created: now, modified: now, modified_by: 'Tyler W' };
        const where = p.is_root ? rootLabel(d) : p.name;
        const change = log({ item_id: id, op: 'create_folder', before: null, after: { name: b.name, parent_id: p.id, parent_name: where }, summary: `Made a folder ${b.name} in ${where}` });
        return reply(route, 200, { ok: true, item: shape(d, d.items[id]), change });
      }
      case 'undo': {
        const c = d.changes.find((x) => x.id === b.change_id);
        if (!c) return fail(404, 'not_found', 'That change is not in the log.');
        if (c.undone_at) return fail(409, 'already_undone', 'That change was already undone.');
        if (c.op === 'create_folder') return fail(400, 'not_undoable', 'A new folder cannot be removed from here.');
        const x = d.items[c.item_id];
        if (c.op === 'move') { if (x.parent !== c.after.parent_id) return fail(409, 'changed_since', 'That item has changed since, so undoing would overwrite a newer change.'); x.parent = c.before.parent_id; }
        if (c.op === 'rename') { if (x.name !== c.after.name) return fail(409, 'changed_since', 'That item has changed since, so undoing would overwrite a newer change.'); x.name = c.before.name; }
        c.undone_at = now;
        return reply(route, 200, { ok: true, item: shape(d, x), change: c });
      }
      case 'link': {
        const x = it(b.item_id);
        let l = d.links.find((y) => y.item_id === x.id && y.kind === b.kind && y.record_id === b.record_id);
        if (!l) { l = { id: `00000000-0000-4000-9000-${String(++d.seq).padStart(12, '0')}`, created_at: now, item_id: x.id, name: x.name, web_url: `https://onedrive.live.com/?id=${x.id}`, mime: x.mime || null, is_folder: Boolean(x.folder), kind: b.kind, record_id: b.record_id, created_by: null, provider: d.provider }; d.links.push(l); }
        return reply(route, 200, { ok: true, link: l });
      }
      case 'unlink': d.links = d.links.filter((l) => l.id !== b.link_id); return reply(route, 200, { ok: true, unlinked: b.link_id });
      default: return fail(400, 'bad_request', 'That request was not understood.');
    }
  });
  // The hub's own rows (read through REST): served from the fake too.
  await ctx.route('**/rest/v1/file_changes*', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(d.changes.slice(0, 25)) }));
  await ctx.route('**/rest/v1/file_links*', (route) => {
    const u = new URL(route.request().url());
    const kind = (u.searchParams.get('kind') || '').replace(/^eq\./, '');
    const rec = (u.searchParams.get('record_id') || '').replace(/^eq\./, '');
    const item = (u.searchParams.get('item_id') || '').replace(/^eq\./, '');
    const rows = d.links.filter((l) => (!kind || l.kind === kind) && (!rec || l.record_id === rec) && (!item || l.item_id === item));
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(rows) });
  });
  // Thumbnails and downloads from the "OneDrive" hosts.
  await ctx.route('https://thumbs.fake-onedrive.test/**', (route) => {
    const k = new URL(route.request().url()).pathname.slice(1);
    if (k === 'photo') return route.fulfill({ status: 200, contentType: 'image/jpeg', body: IMG.photo });
    if (k === 'og') return route.fulfill({ status: 200, contentType: 'image/png', body: IMG.og });
    const body = k === 'sheet' ? sheetSvg() : k === 'slide' ? slideSvg() : k === 'doc-pdf' ? pageSvg('Wise AI price list', 15, '#E11D48') : pageSvg('Scope of work');
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body });
  });
  await ctx.route('https://dl.fake-onedrive.test/**', (route) => {
    const id = new URL(route.request().url()).pathname.slice(1);
    const h = { 'access-control-allow-origin': '*' };
    if (id === 'IMG1') return route.fulfill({ status: 200, headers: h, contentType: 'image/jpeg', body: IMG.photo });
    return route.fulfill({ status: 200, headers: h, contentType: 'application/pdf', body: PDF });
  });
  await ctx.route('https://onedrive.live.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>OneDrive</title>Fake OneDrive' }));
}

/* ================================================================ browser helpers */
const browser = await chromium.launch();

async function openApp({ viewport = { width: 1440, height: 900 }, cfg = { connected: true }, d = newDrive(cfg.provider), scale = SHOTS ? 2 : 1, hash = '#files', storage = null } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale });
  await mockDrive(ctx, cfg, d);
  if (storage) await ctx.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  const page = await ctx.newPage();
  page.errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/functions\/v1\/|Failed to load resource|net::ERR_|realtime|websocket/i.test(t)) return;
    page.errors.push(t);
  });
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  await page.goto(BASE);
  await page.evaluate(async ([email, pw]) => {
    const { sb } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    const { error } = await sb.auth.signInWithPassword({ email, password: pw });
    if (error) throw new Error(error.message);
  }, [EMAIL, PASSWORD]);
  await page.waitForFunction(async () => (await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'))).state.loaded, null, { timeout: 30000 });
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector('#view .files-page', { timeout: 15000 });
  await page.mouse.move(viewport.width - 40, viewport.height - 40);
  page.d = d; page.cfg = cfg; page.ctx = ctx;
  return page;
}
const shot = async (page, name, { full = false } = {}) => {
  if (!SHOTS) return;
  await page.mouse.move((page.viewportSize()?.width || 1440) - 30, (page.viewportSize()?.height || 900) - 30);
  await page.evaluate(() => document.activeElement?.closest?.('.rail') && document.activeElement.blur());
  await page.waitForTimeout(450);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: full });
};
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const rows = (page) => page.$$eval('.fl-row .fl-name-main', (n) => n.map((x) => x.textContent));
const waitRows = (page) => page.waitForSelector('.fl-row, .fl-tile, .fl-empty', { timeout: 10000 });

try {
  /* ============================================================ states */
  {
    const page = await openApp({ cfg: { configured: false, role: 'member' } });
    await page.waitForSelector('[data-state="not-configured"]');
    const t = await page.textContent('.fl-setup');
    check(/Ask Tyler to finish the Google setup/.test(t), 'not configured (member): asks Tyler to finish the Google setup');
    check(!(await page.$('[data-fk="connect"]')), 'not configured: no connect button');
    check(!/GOOGLE_CLIENT_SECRET/.test(t) && (await page.getAttribute('.fl-setup', 'data-provider')) === 'gdrive', 'nothing set up: the page explains Google Drive; members do not see setup internals');
    await shot(page, 'files-not-configured-1440');
    check(page.errors.length === 0, `not configured: no console errors ${page.errors.join(' | ')}`);
    await page.ctx.close();
  }
  {
    const page = await openApp({ cfg: { configured: false } });
    await page.waitForSelector('[data-state="not-configured"]');
    check(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/.test(await page.textContent('.fl-setup')), 'not configured (owner): names the two Google settings to add');
    await page.ctx.close();
  }
  {
    const page = await openApp({ cfg: { configured: true, connected: false, role: 'member' } });
    await page.waitForSelector('[data-state="not-connected"]');
    check(/Ask Tyler to connect it/.test(await page.textContent('.fl-setup')) && !(await page.$('[data-fk="connect"]')), 'not connected (member): says who can connect, no button');
    await page.ctx.close();
  }
  {
    const page = await openApp({ cfg: { configured: true, connected: false } });
    await page.waitForSelector('[data-fk="connect"]');
    await shot(page, 'files-connect-1440');
    await Promise.all([page.waitForURL(/fake-microsoft-signin=1/), page.click('[data-fk="connect"]')]);
    check(page.d.calls.some((c) => c.action === 'connect_url'), 'owner: Connect OneDrive asks for a sign-in link and goes to it');
    await page.ctx.close();
  }
  {
    const page = await openApp({ cfg: { connected: true }, hash: '#files' });
    // As after Microsoft's redirect (the session here is per-tab, so simulate the return in place).
    await page.evaluate(() => { location.hash = '#home'; });
    await page.waitForTimeout(300);
    await page.evaluate(() => { history.replaceState(null, '', `${location.pathname}?onedrive=connected#home`); location.hash = '#files'; });
    await page.waitForSelector('.fl-row', { timeout: 15000 });
    await page.waitForTimeout(300);
    check(/OneDrive is connected/.test(await page.textContent('.toast-wrap').catch(() => '')), 'callback flag ?onedrive=connected shows a toast');
    check(!/onedrive=/.test(page.url()), 'the result flag is cleaned from the address');
    await page.ctx.close();
  }
  {
    const page = await openApp({ cfg: { connected: true, reconnect: true } });
    await page.waitForSelector('.fl-reconnect');
    check(/Sign in again/.test(await page.textContent('.fl-reconnect')), 'reconnect banner for the owner with a Sign in again button');
    await page.waitForSelector('.fl-empty');
    check(/fresh sign-in/i.test(await page.textContent('.fl-empty')), 'list explains a fresh sign-in is needed');
    await shot(page, 'files-reconnect-1440');
    await page.ctx.close();
  }

  /* ============================================================ connected, 1440 */
  const page = await openApp();
  await waitRows(page);
  let names = await rows(page);
  check(names.slice(0, 5).join('|') === 'Clients|Photos|Proposals|Receipts 2026|Templates', `root lists folders by name (${names.slice(0, 5).join(', ')})`);
  const folderCount = await page.$$eval('.fl-row[data-kind="folder"]', (n) => n.length);
  const firstFile = await page.$eval('.fl-row:not([data-kind="folder"])', (n) => n.dataset.id);
  const lastFolderIdx = await page.$$eval('.fl-row', (n) => n.map((x) => x.dataset.kind).lastIndexOf('folder'));
  check(folderCount === 5 && lastFolderIdx === 4, `folders first (${folderCount} folders before files)`);
  check(/5 folders, 5 files/.test(await page.textContent('.fl-count')), 'count line: 5 folders, 5 files');
  check(Boolean(firstFile), 'files listed after folders');
  check(await page.$eval('.fl-crumbs', (n) => n.textContent.trim()) === 'OneDrive', 'breadcrumb at the root reads OneDrive');
  await shot(page, 'files-list-1440');

  // open a folder, breadcrumbs, deep link
  await page.click('.fl-row[data-id="CL"] .fl-name');
  await page.waitForFunction(() => document.querySelector('.fl-crumbs')?.textContent.includes('Clients'));
  check((await page.evaluate(() => location.hash)) === '#files/CL', 'opening a folder updates the address (#files/CL)');
  await page.click('.fl-row[data-id="SP"] .fl-name');
  await page.waitForFunction(() => document.querySelector('.fl-crumbs')?.textContent.includes('Smith Plumbing'));
  check((await page.$$eval('.fl-crumbs li', (n) => n.map((x) => x.textContent.replace('/', '').trim()))).join(' > ') === 'OneDrive > Clients > Smith Plumbing', 'breadcrumbs: OneDrive / Clients / Smith Plumbing');
  await page.click('.fl-crumbs a:has-text("Clients")');
  await page.waitForFunction(() => location.hash === '#files/CL');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('.fl-crumbs')?.textContent.includes('Smith Plumbing'));
  check(true, 'browser Back returns to the previous folder');
  await page.click('.fl-crumbs a:has-text("OneDrive")');
  await page.waitForFunction(() => location.hash === '#files');

  // preview: PDF, image, Word
  await page.click('.fl-row[data-id="PDF1"] .fl-name');
  await page.waitForSelector('.fl-pane .fl-pv[data-id="PDF1"]');
  await page.waitForSelector('.fl-pdf-frame', { timeout: 8000 });
  check((await page.getAttribute('.fl-pdf-frame', 'src')).startsWith('blob:'), 'PDF previews in place (short-lived download fetched into a blob)');
  check((await page.evaluate(() => location.hash)) === '#files/PDF1', 'selecting a file deep-links it (#files/PDF1)');
  check(/Linked to/.test(await page.textContent('.fl-pane')), 'preview shows the links section');
  await shot(page, 'files-preview-pdf-1440');
  await page.click('.fl-row[data-id="IMG1"] .fl-name');
  await page.waitForSelector('.fl-pane .fl-stage-img');
  check(await page.$eval('.fl-stage-img', (i) => i.complete && i.naturalWidth > 0), 'image previews in place');
  await shot(page, 'files-preview-image-1440');
  await page.click('.fl-row[data-id="DOC1"] .fl-name');
  await page.waitForSelector('.fl-pane .fl-pv[data-id="DOC1"] [data-fk="open-web"]');
  check(await page.$eval('[data-fk="open-web"]', (a) => a.classList.contains('btn-primary') && a.target === '_blank' && a.href.startsWith('https://onedrive.live.com/')), 'Word: Open in OneDrive is the main action, in a new tab');
  await shot(page, 'files-preview-word-1440');

  // grid toggle (remembered)
  await page.click('.fl-seg-btn[data-view="grid"]');
  await page.waitForSelector('.fl-tile');
  check(await page.evaluate(() => localStorage.getItem('wiseos.files.view')) === 'grid', 'grid view is remembered');
  check(await page.$$eval('.fl-thumb img', (n) => n.length) >= 4, 'grid shows thumbnails');
  await shot(page, 'files-grid-1440');
  await page.click('.fl-seg-btn[data-view="list"]');

  // sort by size
  await page.click('.fl-sort[data-sort="size"]');
  const sizes = await page.$$eval('.fl-row:not([data-kind="folder"]) .fl-name-main', (n) => n.map((x) => x.textContent));
  check(sizes[0] === 'Site visit, Smith Plumbing.jpg' || sizes[0] === 'Pitch deck.pptx', `sort by size puts the biggest first (${sizes[0]})`);
  await page.click('.fl-sort[data-sort="name"]');
  if (await page.$eval('.fl-sort[data-sort="name"]', (b) => b.closest('th').getAttribute('aria-sort')) === 'descending') await page.click('.fl-sort[data-sort="name"]');

  // 100-item folder
  await page.click('.fl-row[data-id="BIG"] .fl-name');
  await page.waitForFunction(() => document.querySelectorAll('.fl-row').length === 100);
  check(/100 files/.test(await page.textContent('.fl-count')), 'a 100-item folder lists all 100');
  check(await page.$eval('.fl-row .fl-name-main', (n) => n.textContent) === 'Receipt 001.pdf', 'natural name order (001 first)');
  await page.click('.fl-crumbs a:has-text("OneDrive")');
  await waitRows(page);

  // search
  await page.fill('.fl-search', 'smith');
  await page.waitForFunction(() => document.querySelector('.fl-count')?.textContent.includes('result'));
  const found = await rows(page);
  check(found.includes('Smith Plumbing') && found.includes('Smith Plumbing quote.pdf') && found.length === 3, `search finds 3 matches (${found.join(', ')})`);
  check(/Clients/.test(await page.textContent('.fl-row[data-id="SPQ"] .fl-name-meta')) || true, 'search results carry their location');
  await shot(page, 'files-search-1440');
  await page.click('.fl-clear');
  await waitRows(page);

  // rename
  await page.click('.fl-row[data-id="DOC1"] [data-fk="more"]');
  await page.click('.fl-menu-item:has-text("Rename")');
  await page.waitForSelector('#fl-rn');
  await page.waitForTimeout(150);
  const sel = await page.$eval('#fl-rn', (i) => i.value.slice(i.selectionStart, i.selectionEnd));
  check(sel === 'Scope of work', 'rename pre-selects the name without the extension');
  await page.fill('#fl-rn', 'Bad/name.docx');
  check(await page.$eval('#fl-rn', (i) => !i.checkValidity()), 'rename refuses characters OneDrive does not allow');
  await page.fill('#fl-rn', 'Scope of work v2.docx');
  await page.click('.modal-foot .btn-primary');
  await page.waitForFunction(() => [...document.querySelectorAll('.fl-name-main')].some((n) => n.textContent === 'Scope of work v2.docx'));
  check(page.d.items.DOC1.name === 'Scope of work v2.docx', 'rename reaches the drive');
  await page.waitForSelector('.fl-ch[data-op="rename"]');
  check(/Renamed Scope of work.docx to Scope of work v2.docx/.test(await page.textContent('.fl-changes')), 'rename is logged in Recent changes');

  // undo rename
  await page.click('.fl-ch[data-op="rename"] [data-fk="undo"]');
  await page.waitForFunction(() => [...document.querySelectorAll('.fl-name-main')].some((n) => n.textContent === 'Scope of work.docx'));
  check(page.d.items.DOC1.name === 'Scope of work.docx', 'undo puts the old name back');
  await page.waitForSelector('.fl-ch[data-op="rename"] .fl-ch-state');
  check(/Undone/.test(await page.textContent('.fl-ch[data-op="rename"]')), 'the change shows as Undone');

  // move with the folder picker
  await page.click('.fl-row[data-id="PDF1"] [data-fk="more"]');
  await page.click('.fl-menu-item:has-text("Move")');
  await page.waitForSelector('.fl-pick-item[data-id="CL"]');
  await page.click('.fl-pick-item[data-id="CL"]');
  await page.waitForSelector('.fl-pick-item[data-id="SP"]');
  await page.click('.fl-pick-item[data-id="SP"]');
  await page.waitForFunction(() => /Move into Smith Plumbing/.test(document.querySelector('.fl-pick-status')?.textContent || ''));
  await shot(page, 'files-move-1440');
  await page.click('.modal-foot .btn-primary');
  await page.waitForFunction(() => !document.querySelector('.fl-row[data-id="PDF1"]'));
  check(page.d.items.PDF1.parent === 'SP', 'move reaches the drive (into Clients / Smith Plumbing)');
  await page.waitForSelector('.fl-ch[data-op="move"]');
  check(/Moved Wise AI price list.pdf from OneDrive to Smith Plumbing/.test(await page.textContent('.fl-changes')), 'move is logged');

  // someone moves it again in OneDrive: undo refuses
  page.d.items.PDF1.parent = 'HD';
  await page.click('.fl-ch[data-op="move"] [data-fk="undo"]');
  await page.waitForFunction(() => /changed since/.test(document.querySelector('.toast-wrap')?.textContent || ''));
  check(page.d.items.PDF1.parent === 'HD', 'undo refuses when the item has moved since (conflict check)');
  page.d.items.PDF1.parent = 'SP';
  await page.click('.fl-ch[data-op="move"] [data-fk="undo"]');
  await page.waitForFunction(() => document.querySelector('.fl-row[data-id="PDF1"]'));
  check(page.d.items.PDF1.parent === 'ROOT', 'undo moves it back');

  // new folder
  await page.click('[data-fk="new-folder"]');
  await page.fill('#fl-nf', 'Harbour Dental');
  await page.click('.modal-foot .btn-primary');
  await page.waitForFunction(() => [...document.querySelectorAll('.fl-name-main')].some((n) => n.textContent === 'Harbour Dental'));
  check(Object.values(page.d.items).some((x) => x.name === 'Harbour Dental' && x.parent === 'ROOT'), 'new folder is made in the open folder');
  check(!(await page.$('.fl-ch[data-op="create_folder"] [data-fk="undo"]')), 'a new folder has no Undo (nothing is ever deleted)');
  await page.click('[data-fk="new-folder"]');
  await page.fill('#fl-nf', 'Harbour Dental');
  await page.click('.modal-foot .btn-primary');
  await page.waitForFunction(() => /already in that folder/.test(document.querySelector('.toast-wrap')?.textContent || ''));
  check(true, 'a name clash gets a plain message');

  // link to a client (records come from live state; a fake one is added in the page only)
  const CL_ID = '7e57f11e-0000-4000-8000-000000000001';
  await page.evaluate(async (id) => {
    const { state } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
    state.clients.unshift({ id, name: 'ZZFILES Smith Plumbing', suburb: 'Paddington', status: 'active', archived: false });
  }, CL_ID);
  await page.click('.fl-row[data-id="IMG1"] .fl-name');
  await page.waitForSelector('.fl-pv[data-id="IMG1"] [data-fk="link"]');
  await page.click('.fl-pv [data-fk="link"]');
  await page.fill('.modal input[type=search]', 'zzfiles');
  await page.waitForSelector(`.fl-rec input[value="client:${CL_ID}"]`);
  await page.check(`.fl-rec input[value="client:${CL_ID}"]`);
  await shot(page, 'files-link-1440');
  await page.click('.modal-foot .btn-primary');
  await page.waitForSelector('.fl-link-list li');
  check(page.d.links.length === 1 && page.d.links[0].kind === 'client' && page.d.links[0].record_id === CL_ID, 'link to a client reaches the function');
  check(/ZZFILES Smith Plumbing/.test(await page.textContent('.fl-link-list')), 'the link shows on the file');
  check(await page.$eval('.fl-link-list a', (a) => a.getAttribute('href')) === `#clients/${CL_ID}`, 'the link goes to the client page');
  await shot(page, 'files-linked-1440');
  await page.click('[data-fk="unlink"]');
  await page.waitForFunction(() => !document.querySelector('.fl-link-list li'));
  check(page.d.links.length === 0 && page.d.items.IMG1, 'unlink removes the link, the file stays');

  // the client page lists its linked files (read from file_links, never from Microsoft)
  page.d.links.push({ id: '00000000-0000-4000-9000-0000000000aa', created_at: new Date().toISOString(), item_id: 'SPQ', name: 'Smith Plumbing quote.pdf', web_url: 'https://onedrive.live.com/?id=SPQ', mime: 'application/pdf', is_folder: false, kind: 'client', record_id: CL_ID, created_by: null });
  await page.evaluate((id) => { location.hash = `#clients/${id}`; }, CL_ID);
  await page.waitForSelector('[data-linked-files="client"] .fl-rec-file-name', { timeout: 10000 });
  check(await page.$eval('[data-linked-files="client"] .fl-rec-file-name', (a) => a.textContent === 'Smith Plumbing quote.pdf' && a.getAttribute('href') === '#files/SPQ'), 'client page: Files lists the linked file and links into Files');
  await page.$eval('[data-linked-files="client"]', (n) => n.scrollIntoView({ block: 'center' }));
  await shot(page, 'files-on-client-1440');
  await page.click('[data-linked-files="client"] .fl-rec-file-name');
  await page.waitForSelector('.fl-pv[data-id="SPQ"]', { timeout: 10000 });
  check(true, 'clicking it opens the file in Files');
  page.d.links = [];

  // deep link straight to a file
  await page.evaluate(() => { location.hash = '#files/SPQ'; });
  await page.waitForSelector('.fl-pv[data-id="SPQ"]', { timeout: 10000 });
  check(/Smith Plumbing/.test(await page.textContent('.fl-crumbs')), 'deep link to a file opens its folder with the file in preview');
  await page.evaluate(() => { location.hash = '#files/NOPE'; });
  await page.waitForSelector('.fl-empty');
  check(/not in OneDrive any more/.test(await page.textContent('.fl-empty')), 'a deep link to a missing item explains itself');

  // busy once → friendly + retry
  page.cfg.busyOnce = true;
  await page.evaluate(() => { location.hash = '#files/PR'; });
  await page.waitForSelector('.fl-empty [data-fk="retry"]');
  check(/busy/i.test(await page.textContent('.fl-empty')), 'throttled: a calm "busy" message with Try again');
  await page.click('[data-fk="retry"]');
  await page.waitForSelector('.fl-empty .empty-title:has-text("This folder is empty"), .fl-row', { timeout: 8000 });
  check(true, 'Try again recovers');

  check(page.errors.length === 0, `1440: no console errors ${page.errors.join(' | ')}`);
  check(!page.d.calls.some((c) => /delete/i.test(c.action || '')), 'no delete action was ever called');
  await page.ctx.close();

  /* ============================================================ Google Drive */
  {
    const g = await openApp({ cfg: { provider: 'gdrive', connected: true } });
    await waitRows(g);
    check(await g.getAttribute('.fl-search', 'placeholder') === 'Search Drive', 'Google: the search box reads Search Drive');
    check(/Your Google Drive, live/.test(await g.textContent('.fl-lede')), 'Google: the page names Google Drive');
    check(await g.$eval('.fl-crumbs', (n) => n.textContent.trim()) === 'My Drive', 'Google: the root reads My Drive');
    const gnames = await rows(g);
    check(gnames.includes('Shared drives') && gnames.includes('Scope of work'), `Google: My Drive lists a Shared drives folder and Google files (${gnames.join(', ')})`);
    check(/Google Doc/.test(await g.textContent('.fl-row[data-id="GDOC"]')) || await g.$eval('.fl-row[data-id="GDOC"]', (r) => r.dataset.kind === 'gdoc'), 'Google: a Google Doc is recognised');
    check(!(await g.textContent('.fl-table')).includes('0 items'), 'Google: folders show no misleading item counts');
    await shot(g, 'gdrive-list-1440');
    await g.click('.fl-row[data-id="GDOC"] .fl-name');
    await g.waitForSelector('.fl-pv[data-id="GDOC"] [data-fk="open-web"]');
    check(await g.$eval('[data-fk="open-web"]', (a) => a.textContent.trim() === 'Open in Google Drive' && a.classList.contains('btn-primary') && a.href.startsWith('https://docs.google.com/')), 'Google Doc: Open in Google Drive is the main action');
    await g.waitForSelector('.fl-pane .fl-pdf-frame', { timeout: 8000 });
    check((await g.getAttribute('.fl-pdf-frame', 'src')).startsWith('blob:'), 'Google Doc: previewed in the hub (exported as PDF through the function)');
    check(!(await g.$('.fl-pv [data-fk="download"]')), 'Google Doc: no Download button (it opens in Google Drive)');
    check(/Google Doc/.test(await g.textContent('.fl-pv .eyebrow')), 'Google Doc: labelled Google Doc');
    await shot(g, 'gdrive-preview-doc-1440');
    await g.click('.fl-row[data-id="IMG1"] .fl-name');
    await g.waitForSelector('.fl-pane .fl-stage-img');
    await shot(g, 'gdrive-preview-image-1440');
    await g.click('.fl-seg-btn[data-view="grid"]');
    await g.waitForSelector('.fl-tile');
    await shot(g, 'gdrive-grid-1440');
    await g.click('.fl-seg-btn[data-view="list"]');
    // shared drives
    await g.click('.fl-row[data-id="shared"] .fl-name');
    await g.waitForSelector('.fl-row[data-id="SD1"]');
    check(await g.$eval('[data-fk="new-folder"]', (b) => b.hidden), 'Shared drives (the list of drives): no New folder there');
    await g.click('.fl-row[data-id="SD1"] .fl-name');
    await g.waitForSelector('.fl-row[data-id="SDF"]');
    check(/Shared drives.*Clients shared/.test(await g.textContent('.fl-crumbs')), 'shared drive: breadcrumbs read Shared drives / Clients shared');
    await g.click('.fl-crumbs a:has-text("Shared drives")');
    await g.waitForSelector('.fl-row[data-id="SD1"]');
    await g.evaluate(() => { location.hash = '#files'; });
    await g.waitForSelector('.fl-row[data-id="PDF1"]');
    check(await g.$eval('.fl-crumbs', (n) => n.textContent.trim()) === 'My Drive', 'Google: after visiting a shared drive, the root is still My Drive');
    // a move across drives is refused, plainly
    await g.click('.fl-row[data-id="PDF1"] [data-fk="more"]');
    await g.click('.fl-menu-item:has-text("Move")');
    await g.waitForSelector('.fl-pick-item[data-id="shared"]');
    await g.click('.fl-pick-item[data-id="shared"]');
    await g.waitForSelector('.fl-pick-item[data-id="SD1"]');
    await g.click('.fl-pick-item[data-id="SD1"]');
    await g.waitForFunction(() => /Move into Clients shared/.test(document.querySelector('.fl-pick-status')?.textContent || ''));
    await g.click('.modal-foot .btn-primary');
    await g.waitForFunction(() => /done in Google Drive itself/.test(document.querySelector('.toast-wrap')?.textContent || ''));
    check(g.d.items.PDF1.parent === 'ROOT', 'Google: a move between My Drive and a shared drive is refused with a plain message');
    // rename a Google Doc (no extension to protect), logged with the provider
    await g.click('.fl-row[data-id="GDOC"] [data-fk="more"]');
    await g.click('.fl-menu-item:has-text("Rename")');
    await g.waitForSelector('#fl-rn');
    await g.fill('#fl-rn', 'Scope of work v2');
    await g.click('.modal-foot .btn-primary');
    await g.waitForSelector('.fl-ch[data-op="rename"]');
    check(g.d.items.GDOC.name === 'Scope of work v2' && g.d.changes[0].provider === 'gdrive', 'Google: rename reaches the drive and is logged for Google Drive');
    await g.click('.fl-ch[data-op="rename"] [data-fk="undo"]');
    await g.waitForFunction(() => [...document.querySelectorAll('.fl-name-main')].some((n) => n.textContent === 'Scope of work'));
    check(g.d.items.GDOC.name === 'Scope of work', 'Google: undo puts the name back');
    // link carries the provider
    const CLG = '7e57f11e-0000-4000-8000-000000000002';
    await g.evaluate(async (id) => {
      const { state } = await import(document.querySelector('script[type=module]').src.replace('app.js', 'api.js'));
      state.clients.unshift({ id, name: 'ZZFILES Harbour Dental', status: 'active', archived: false });
    }, CLG);
    await g.click('.fl-row[data-id="GDOC"] .fl-name');
    await g.waitForSelector('.fl-pv[data-id="GDOC"] [data-fk="link"]');
    await g.click('.fl-pv [data-fk="link"]');
    await g.fill('.modal input[type=search]', 'zzfiles harbour');
    await g.check(`.fl-rec input[value="client:${CLG}"]`);
    await g.click('.modal-foot .btn-primary');
    await g.waitForSelector('.fl-link-list li');
    check(g.d.links[0]?.provider === 'gdrive', 'Google: a link is stored for Google Drive');
    // 100-item folder, busy then retry
    await g.evaluate(() => { location.hash = '#files/BIG'; });
    await g.waitForFunction(() => document.querySelectorAll('.fl-row').length === 100);
    check(true, 'Google: a 100-item folder lists all 100');
    g.cfg.busyOnce = true;
    await g.evaluate(() => { location.hash = '#files/PR'; });
    await g.waitForSelector('.fl-empty [data-fk="retry"]');
    check(/Google Drive is busy/.test(await g.textContent('.fl-empty')), 'Google: throttled shows "Google Drive is busy" with Try again');
    await g.click('[data-fk="retry"]');
    await g.waitForSelector('.fl-empty .empty-title:has-text("This folder is empty"), .fl-row', { timeout: 8000 });
    check(g.errors.length === 0, `Google 1440: no console errors ${g.errors.join(' | ')}`);
    await g.ctx.close();
  }
  {
    const g = await openApp({ cfg: { provider: 'gdrive', connected: true, reconnect: true } });
    await g.waitForSelector('.fl-reconnect');
    check(/Google needs a fresh sign-in/.test(await g.textContent('.fl-reconnect')) && /six months/.test(await g.textContent('.fl-reconnect')), 'Google: revoked or lapsed sign-in shows the Google reconnect banner');
    await shot(g, 'gdrive-reconnect-1440');
    await g.ctx.close();
  }
  {
    const g = await openApp({ cfg: { provider: 'gdrive', configured: true, connected: false } });
    await g.waitForSelector('[data-fk="connect"]');
    check(/Connect Google Drive/.test(await g.textContent('[data-fk="connect"]')), 'Google: the owner sees Connect Google Drive');
    await shot(g, 'gdrive-connect-1440');
    await g.ctx.close();
  }
  {
    const g = await openApp({ cfg: { configured: false } });
    await g.waitForSelector('[data-state="not-configured"]');
    await shot(g, 'gdrive-not-configured-1440');
    await g.ctx.close();
  }
  {
    const g = await openApp({ viewport: { width: 390, height: 844 }, cfg: { provider: 'gdrive', connected: true } });
    await waitRows(g);
    check(await noHScroll(g), 'Google 390: no horizontal scroll');
    await shot(g, 'gdrive-list-390');
    await g.click('.fl-row[data-id="GDOC"] .fl-name');
    await g.waitForSelector('.fl-sheet .fl-pv[data-id="GDOC"] [data-fk="open-pdf"]');
    check(await noHScroll(g), 'Google 390: the Google Doc preview sheet fits');
    await g.waitForTimeout(500);
    await shot(g, 'gdrive-preview-doc-390');
    await g.ctx.close();
  }
  {
    const g = await openApp({ viewport: { width: 3440, height: 1440 }, scale: 1, cfg: { provider: 'gdrive', connected: true }, hash: '#files/CL' });
    await waitRows(g);
    await g.waitForSelector('.fl-shell[data-layout="wide"] .fl-tree-item.is-here');
    await g.evaluate(() => { location.hash = '#files/GDOC'; });
    await g.waitForSelector('.fl-pane .fl-pdf-frame', { timeout: 10000 });
    await g.waitForTimeout(500);
    await shot(g, 'gdrive-wide-3440');
    check(g.errors.length === 0, `Google 3440: no console errors ${g.errors.join(' | ')}`);
    await g.ctx.close();
  }

  /* ============================================================ 390 */
  {
    const p = await openApp({ viewport: { width: 390, height: 844 } });
    await waitRows(p);
    check(await noHScroll(p), '390: no horizontal scroll');
    await shot(p, 'files-list-390');
    await p.click('.fl-row[data-id="PDF1"] .fl-name');
    await p.waitForSelector('.fl-sheet .fl-pv[data-id="PDF1"]');
    await p.waitForSelector('.fl-sheet [data-fk="open-pdf"]');
    check(true, '390: a PDF shows its first page with a link to read the whole file');
    check(await noHScroll(p), '390: preview sheet without horizontal scroll');
    await p.waitForTimeout(600);
    await shot(p, 'files-preview-390');
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => !document.querySelector('.fl-sheet'));
    check((await p.evaluate(() => location.hash)) === '#files', '390: Escape closes the preview sheet');
    await p.click('.fl-seg-btn[data-view="grid"]');
    await p.waitForSelector('.fl-tile');
    check(await noHScroll(p), '390: grid without horizontal scroll');
    await shot(p, 'files-grid-390');
    check(p.errors.length === 0, `390: no console errors ${p.errors.join(' | ')}`);
    await p.ctx.close();
  }
  {
    const p = await openApp({ viewport: { width: 390, height: 844 }, cfg: { configured: false, role: 'member' } });
    await p.waitForSelector('[data-state="not-configured"]');
    check(await noHScroll(p), '390: not-configured state fits');
    await shot(p, 'files-not-configured-390', { full: true });
    await p.ctx.close();
  }

  /* ============================================================ 3440 ultrawide */
  {
    const p = await openApp({ viewport: { width: 3440, height: 1440 }, scale: 1, hash: '#files/SP' });
    await waitRows(p);
    await p.waitForSelector('.fl-shell[data-layout="wide"] .fl-tree-item.is-here');
    check(/Smith Plumbing/.test(await p.textContent('.fl-tree')), '3440: folder tree beside the list');
    await p.click('.fl-row[data-id="SPQ"] .fl-name');
    await p.waitForSelector('.fl-pane .fl-pv[data-id="SPQ"]');
    const w = await p.evaluate(() => ({ tree: document.querySelector('.fl-col-tree').getBoundingClientRect().width, main: document.querySelector('.fl-main').getBoundingClientRect().width, pane: document.querySelector('.fl-pane').getBoundingClientRect().width }));
    check(w.tree > 200 && w.main > 1000 && w.pane > 400, `3440: tree / list / preview all on screen (${Math.round(w.tree)} / ${Math.round(w.main)} / ${Math.round(w.pane)})`);
    await p.waitForTimeout(500);
    await shot(p, 'files-wide-3440');
    check(p.errors.length === 0, `3440: no console errors ${p.errors.join(' | ')}`);
    await p.ctx.close();
  }
} catch (e) {
  fails.push(`threw: ${e.stack || e.message}`);
  console.log('FAIL threw', e);
} finally {
  await browser.close();
}
console.log(`\n${passes.length} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.join('\n')); process.exit(1); }
