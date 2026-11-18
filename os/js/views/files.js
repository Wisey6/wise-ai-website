// Files: a live window onto the business drive (Google Drive; OneDrive is supported but dormant),
// in the hub's own design. Nothing is copied: every folder is read through the `gdrive` (or
// `onedrive`) function when it is opened. Both functions answer the same actions and shapes.
// Folders, breadcrumbs, search, thumbnails, previews (images, PDFs, video in place; Office files
// open in the drive's own editor), rename, move, new folder, links to clients / projects / deals / leads, and a
// log of every change with Undo. There is no delete, anywhere.
//
// Layout: one column on phones (preview opens as a sheet), list + preview from 1100px, and on
// very wide screens (1760px+) a folder tree, the list and the preview side by side.
// Deep links: #files/<itemId> opens a folder, or a file's folder with the file in preview.
import {
  el, icon, toast, modal, fill, clear, busy, timeAgo, dateTime, plural, trapFocus
} from '../ui.js?v=20261118d';
import { state, memberName, saveSettings } from '../api.js?v=20261118d';
import {
  od, detectProvider, provider, recentChanges, watchFiles, LINK_KINDS, KIND, recordLabel, recordFor, recordHash, pickRecords,
  fileSize, baseName, nameProblem, kindLabel
} from '../files-api.js?v=20261118d';
const P = () => provider();
/** A folder's display name: the drive root reads as the provider's root (OneDrive / My Drive). */
const rootName = (f) => (f?.is_root && !f.parent_id ? P().root : f?.name || P().root);

/* ================================================================ memory
   Kept across re-renders (each hash change builds a fresh view) so moving around is instant. */
const pref = (k, d) => { try { return localStorage.getItem(k) || d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const mem = {
  status: null, statusAt: 0,
  view: pref('wiseos.files.view', 'list'),
  scope: pref('wiseos.files.scope', 'home'), // search inside the business folder, or all of the drive
  sort: pref('wiseos.files.sort', 'name'),
  dir: pref('wiseos.files.dir', 'asc'),
  folders: new Map(),   // folder id → {folder, items, cursor, at}
  paths: new Map(),     // folder id → [{id, name}]
  items: new Map(),     // item id → item (anything seen)
  details: new Map(),   // item id → {item, download_url, links, at}
  changes: null,
  warm: false
};
const FOLDER_TTL = 60_000;
const DETAIL_TTL = 5 * 60_000;
const STATUS_TTL = 60_000;

/* ================================================================ glyphs
   Static path data only. One line weight, ink on paper; a hairline under the type label
   carries the type's colour (meaning, not decoration). */
const SVGNS = 'http://www.w3.org/2000/svg';
function svg(size, paths, { stroke = 1.5, view = 24 } = {}) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', `0 0 ${view} ${view}`);
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', stroke); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
  s.classList.add('icon');
  for (const d of paths) { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
const FOLDER_D = ['M3 6.5A1.5 1.5 0 0 1 4.5 5h4.38a1.5 1.5 0 0 1 1.06.44L11.5 7h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'];
const PAGE_D = ['M6.5 3h7.6L18.5 7.4V19.5A1.5 1.5 0 0 1 17 21H6.5A1.5 1.5 0 0 1 5 19.5v-15A1.5 1.5 0 0 1 6.5 3z', 'M13.5 3v4.5H18'];
export const folderIcon = (size = 16) => svg(size, FOLDER_D);
const GRID_D = ['M4 4h6.5v6.5H4z', 'M13.5 4H20v6.5h-6.5z', 'M4 13.5h6.5V20H4z', 'M13.5 13.5H20V20h-6.5z'];
const LIST_D = ['M4 6h16', 'M4 12h16', 'M4 18h16'];
const NEWFOLDER_D = [...FOLDER_D, 'M12 10.5v5', 'M9.5 13h5'];
const MOVE_D = [...FOLDER_D, 'M9.5 13h5', 'M12.5 10.5 15 13l-2.5 2.5'];

function glyph(item, size = 'md') {
  if (item.folder) return el('span', { class: `fl-glyph is-folder is-${size}` }, svg(size === 'lg' ? 56 : size === 'md' ? 22 : 18, FOLDER_D, { stroke: size === 'lg' ? 1.1 : 1.5 }));
  const ext = (item.badge || item.ext || '').slice(0, 5).toUpperCase();
  return el('span', { class: `fl-glyph is-file is-${size}`, dataset: { kind: item.kind } },
    svg(size === 'lg' ? 56 : size === 'md' ? 22 : 18, PAGE_D, { stroke: size === 'lg' ? 1.1 : 1.5 }),
    size === 'sm' || !ext ? null : el('span', { class: 'fl-ext' }, ext));
}

/* ================================================================ helpers */
const OFFICE = new Set(['word', 'excel', 'powerpoint']);
const GOOGLE = new Set(['gdoc', 'gsheet', 'gslide', 'gdraw']);
const shortDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
};
const whenLabel = (iso) => {
  if (!iso) return '';
  return Date.now() - Date.parse(iso) < 7 * 86400000 ? timeAgo(iso) : shortDate(iso);
};
function sortList(items) {
  const coll = new Intl.Collator('en-AU', { numeric: true, sensitivity: 'base' });
  const dir = mem.dir === 'desc' ? -1 : 1;
  const by = {
    name: (a, b) => coll.compare(a.name, b.name),
    modified: (a, b) => String(a.modified || '').localeCompare(String(b.modified || '')),
    size: (a, b) => (a.size || 0) - (b.size || 0)
  }[mem.sort] || ((a, b) => coll.compare(a.name, b.name));
  return [...items].sort((a, b) => (a.folder !== b.folder ? (a.folder ? -1 : 1) : by(a, b) * dir || coll.compare(a.name, b.name)));
}
const countLabel = (it) => (it.child_count === null || it.child_count === undefined ? 'Folder' : it.child_count === 1 ? '1 item' : `${it.child_count} items`);
const remember = (items) => { for (const it of items || []) if (it?.id) mem.items.set(it.id, it); };
const errText = (r) => r?.message || 'Something went wrong. Try again in a minute.';
const ownerName = () => mem.status?.owner_name || 'the owner';

function cleanQuery() {
  const q = new URLSearchParams(location.search);
  const key = q.has('drive') ? 'drive' : q.has('onedrive') ? 'onedrive' : null;
  if (!key) return null;
  const flag = q.get(key);
  q.delete(key);
  try { history.replaceState(history.state, '', `${location.pathname}${q.toString() ? `?${q}` : ''}${location.hash}`); } catch { /* */ }
  return { flag, google: key === 'drive' };
}
function resultMessage({ flag, google }) {
  const name = google ? 'Google Drive' : 'OneDrive';
  const co = google ? 'Google' : 'Microsoft';
  return ({
    connected: [`${name} is connected.`, 'ok'],
    denied: [`${name} was not connected: the ${co} sign-in was cancelled.`, 'warn'],
    expired: [`That sign-in link expired. Start again from Connect ${name}.`, 'warn'],
    bad_state: [`That sign-in could not be checked. Start again from Connect ${name}.`, 'bad'],
    not_owner: [`Only the owner can connect ${name}.`, 'bad'],
    not_in_org: ['That Google account is not part of the business Google Workspace. Sign in with the business account.', 'bad'],
    no_refresh: ['Google did not grant lasting access. Start again from Connect Google Drive and allow access.', 'bad'],
    scope_missing: ['Google Drive access was not ticked on the Google screen. Start again and allow access to Google Drive.', 'bad'],
    not_configured: [`${name} is not set up yet.`, 'warn'],
    no_drive: ['That Microsoft account has no OneDrive.', 'bad'],
    busy: [`${co} is busy. Try connecting again in a minute.`, 'warn'],
    error: [`${name} could not be connected. Try again.`, 'bad']
  })[flag] || [`${name} could not be connected. Try again.`, 'bad'];
}

/* ================================================================ the view */
export default function filesView(ctx) {
  const root = el('div', { class: `page files-page${mem.warm ? ' is-warm' : ''}` });
  mem.warm = true;
  const flag = cleanQuery();
  if (flag) {
    const [msg, tone] = resultMessage(flag);
    setTimeout(() => toast(msg, tone), 50);
    mem.status = null;
  }

  const acct = el('div', { class: 'fl-acct' });
  const lede = el('p', { class: 'muted fl-lede' });
  const paintLede = () => { lede.textContent = `Your ${P().name}, live. Nothing is copied: what you see here is what is in ${P().name} right now.`; };
  paintLede();
  const head = el('header', { class: 'page-head fl-head' },
    el('div', { class: 'stack' },
      el('p', { class: 'eyebrow' }, 'Know'),
      el('h1', { class: 'h1' }, 'Files'),
      lede),
    acct);
  const banner = el('div', { class: 'fl-banner' });
  const body = el('div', { class: 'fl-body' });
  root.append(head, banner, body);

  let app = null; // the connected browser, once built

  async function loadStatus(force = false) {
    if (!force && mem.status && Date.now() - mem.statusAt < STATUS_TTL) return mem.status;
    const r = await detectProvider();
    if (r.ok) { mem.status = r; mem.statusAt = Date.now(); }
    paintLede();
    return r;
  }

  function paintAcct() {
    const s = mem.status;
    if (!s?.connected) { clear(acct); return; }
    fill(acct,
      el('span', { class: `fl-acct-line${s.needs_reconnect ? ' is-warn' : ''}` },
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', {}, s.needs_reconnect ? 'Needs signing in again' : `${s.account?.name || P().name}`),
        s.account?.connected_at && !s.needs_reconnect ? el('span', { class: 'faint' }, ` · ${P().name} · connected ${shortDate(s.account.connected_at)}`) : null),
      s.can_connect ? el('button', { type: 'button', class: 'link-btn small fl-disconnect', dataset: { fk: 'disconnect' }, onClick: disconnect }, 'Disconnect') : null);
  }

  function paintBanner() {
    const s = mem.status;
    if (!s?.connected || !s.needs_reconnect) { clear(banner); return; }
    const google = P().id === 'gdrive';
    fill(banner, el('div', { class: 'callout is-warn fl-reconnect', role: 'status' },
      icon('alert', 16),
      el('div', { class: 'fl-callout-text' },
        el('b', {}, `${P().company} needs a fresh sign-in`),
        el('span', {}, s.can_connect
          ? (google
            ? 'Google sign-ins lapse after six months without use, or when access is removed in the Google account or by the Workspace admin. Sign in again and everything carries on as before.'
            : 'OneDrive sign-ins lapse after about 90 days without use, or when access is removed in the Microsoft account. Sign in again and everything carries on as before.')
          : `The ${P().name} sign-in has lapsed. Ask ${ownerName()} to sign in again from this page.`)),
      s.can_connect ? el('button', { type: 'button', class: 'btn btn-primary btn-sm', dataset: { fk: 'reconnect' }, onClick: (e) => connect(e.currentTarget) }, 'Sign in again') : null));
  }

  async function connect(btn) {
    await busy(btn, async () => {
      const r = await od('connect_url');
      if (!r.ok || !r.url) { toast(errText(r), 'bad'); return; }
      location.assign(r.url);
    });
  }

  async function disconnect() {
    const google = P().id === 'gdrive';
    const ok = await modal({
      title: `Disconnect ${P().name}?`,
      body: el('p', { class: 'confirm-text' }, `Files will stop showing ${P().name} until someone connects it again. Nothing in ${P().name} changes, and the links to clients and projects stay. ${google
        ? 'The hub’s access is also withdrawn at Google.'
        : 'To remove the hub’s access completely, also remove it under Apps and services in your Microsoft account.'}`),
      confirmLabel: 'Disconnect', danger: true
    });
    if (!ok) return;
    const r = await od('disconnect');
    if (!r.ok) { toast(errText(r), 'bad'); return; }
    mem.status = null; mem.folders.clear(); mem.details.clear(); mem.paths.clear(); mem.changes = null;
    toast(`${P().name} disconnected`);
    start(true);
  }

  /* ------------------------------------------------------------ not set up / not connected */
  const promise = () => el('ul', { class: 'fl-promise' },
    el('li', {}, el('b', {}, 'Every folder, live.'), ` Read straight from ${P().name} each time, so there is nothing to sync and nothing to fall behind.`),
    el('li', {}, el('b', {}, 'Previews in place.'), P().id === 'gdrive'
      ? ' PDFs, photos, Google Docs, Sheets and Slides open right here. Everything opens in Google Drive in one click.'
      : ' PDFs, photos and video open right here. Word, Excel and PowerPoint open in OneDrive.'),
    el('li', {}, el('b', {}, 'Filed against the work.'), ' Link a file to a client, project, deal or lead and it shows on that page.'),
    el('li', {}, el('b', {}, 'Safe to tidy.'), ' Rename, move and make folders. Every change is logged with an Undo, and nothing is ever deleted from here.'));

  function paintSetup(s) {
    const owner = s.owner_name || 'the owner';
    const isOwner = s.can_connect;
    const google = P().id === 'gdrive';
    if (!s.configured) {
      fill(body, el('section', { class: 'fl-setup', dataset: { state: 'not-configured', provider: P().id } },
        el('div', { class: 'fl-setup-mark', 'aria-hidden': 'true' }, folderIcon(40)),
        el('p', { class: 'eyebrow' }, 'Almost ready'),
        el('h2', { class: 'fl-setup-title' }, google ? 'Google Drive is waiting on one Google step' : 'OneDrive is waiting on one Microsoft step'),
        el('p', { class: 'fl-setup-text' }, isOwner
          ? (google
            ? 'The hub needs its Google app details before it can connect: in Google Cloud, an internal app for the wise-ai.au Workspace with a web client. Its client ID and secret go into the hub’s server settings as GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. Once they are in, a Connect Google Drive button appears here.'
            : 'The hub needs its Microsoft app details before it can connect: the application ID and secret go into the hub’s server settings as MS_CLIENT_ID and MS_CLIENT_SECRET. Once they are in, a Connect OneDrive button appears here.')
          : `The ${google ? 'Google' : 'Microsoft'} app details still need to be added before ${P().name} can be connected. ${owner} can finish it.`),
        isOwner
          ? el('p', { class: 'fl-setup-note small muted' }, google
            ? 'The step-by-step clicks, including the exact redirect address to give Google, are in the setup notes (supabase/README.md, Google Drive). It takes about ten minutes.'
            : 'The redirect address to give Microsoft is this hub’s OneDrive function address, exactly as in the setup notes.')
          : el('p', { class: 'fl-setup-ask' }, `Ask ${owner} to finish the ${google ? 'Google' : 'Microsoft'} setup`),
        promise()));
      return;
    }
    fill(body, el('section', { class: 'fl-setup', dataset: { state: 'not-connected', provider: P().id } },
      el('div', { class: 'fl-setup-mark', 'aria-hidden': 'true' }, folderIcon(40)),
      el('p', { class: 'eyebrow' }, 'Not connected'),
      el('h2', { class: 'fl-setup-title' }, isOwner ? `Connect the business ${P().name}` : `${P().name} is not connected yet`),
      el('p', { class: 'fl-setup-text' }, isOwner
        ? (google
          ? 'You will sign in with the business Google account and allow the hub to see and organise your Drive. One connection serves everyone on the team. You can disconnect at any time.'
          : 'You will sign in with Microsoft and allow the hub to read and organise your files. One connection serves everyone on the team. You can disconnect at any time.')
        : `Only the owner can connect ${P().name}. Ask ${owner} to connect it from this page.`),
      isOwner ? el('button', { type: 'button', class: 'btn btn-primary', dataset: { fk: 'connect' }, onClick: (e) => connect(e.currentTarget) }, folderIcon(16), `Connect ${P().name}`) : null,
      promise()));
  }

  /* ------------------------------------------------------------ boot */
  async function start(force = false) {
    if (!mem.status || force) {
      fill(body, el('div', { class: 'fl-skel', 'aria-busy': 'true' },
        el('div', { class: 'skeleton', style: 'height:40px;width:min(520px,100%)' }),
        el('div', { class: 'skeleton', style: 'height:320px' })));
    }
    const s = await loadStatus(force);
    if (!s.ok) {
      fill(body, el('div', { class: 'callout is-bad' }, icon('alert', 16),
        el('div', { class: 'fl-callout-text' }, el('b', {}, 'Files could not load'), el('span', {}, errText(s))),
        el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => start(true) }, icon('refresh', 14), 'Try again')));
      return;
    }
    paintAcct();
    paintBanner();
    if (!s.configured || !s.connected) { app = null; paintSetup(s); return; }
    if (!app) app = browser();
    fill(body, app.node);
    app.open(ctx.param || null);
  }

  /* ================================================================ the browser */
  function browser() {
    let folderId = null;          // the folder on screen
    let selected = null;          // the file in preview
    let searchQ = '';             // active search
    let searchItems = null;
    let menu = null;
    let mode = '';
    let pdfUrl = null;
    let seq = 0;

    const crumbs = el('nav', { class: 'fl-crumbs', 'aria-label': 'Folder path' });
    const search = el('input', { class: 'input fl-search', type: 'search', placeholder: P().search, 'aria-label': P().search, autocomplete: 'off', enterkeyhint: 'search' });
    const searchWrap = el('label', { class: 'fl-search-wrap' }, icon('search', 15), search);
    const viewBtns = {
      list: el('button', { type: 'button', class: 'fl-seg-btn', 'aria-label': 'List view', title: 'List', dataset: { view: 'list' } }, svg(16, LIST_D, { stroke: 1.7 })),
      grid: el('button', { type: 'button', class: 'fl-seg-btn', 'aria-label': 'Grid view', title: 'Grid', dataset: { view: 'grid' } }, svg(16, GRID_D, { stroke: 1.6 }))
    };
    const seg = el('div', { class: 'fl-seg', role: 'group', 'aria-label': 'View' }, viewBtns.list, viewBtns.grid);
    const newBtn = el('button', { type: 'button', class: 'btn btn-ghost btn-sm fl-new', dataset: { fk: 'new-folder' } }, svg(15, NEWFOLDER_D, { stroke: 1.7 }), el('span', { class: 'lbl' }, 'New folder'));
    const scopeBtn = el('button', { type: 'button', class: 'chip fl-scope', dataset: { fk: 'scope' }, hidden: true, onClick: () => {
      mem.scope = mem.scope === 'home' ? 'all' : 'home';
      setPref('wiseos.files.scope', mem.scope);
      paintScope();
      if (searchQ) runSearch(searchQ);
    } });
    const makeHome = el('button', { type: 'button', class: 'link-btn small fl-make-home', dataset: { fk: 'make-home' }, hidden: true, onClick: () => setHome(mem.folders.get(folderId)?.folder) }, 'Make this the business folder');
    const bar = el('div', { class: 'fl-bar' }, el('div', { class: 'fl-bar-left' }, crumbs, makeHome), el('div', { class: 'fl-tools' }, searchWrap, scopeBtn, seg, newBtn));
    const listArea = el('div', { class: 'fl-list-area', 'aria-live': 'polite' });
    const tree = el('nav', { class: 'fl-tree', 'aria-label': 'Folders' });
    const treeCol = el('div', { class: 'fl-col-tree' }, tree);
    const pane = el('aside', { class: 'fl-pane', 'aria-label': 'Preview' });
    const changes = el('section', { class: 'fl-changes', 'aria-labelledby': 'fl-ch-h' });
    const main = el('div', { class: 'fl-main' }, bar, listArea);
    const node = el('div', { class: 'fl-shell' }, treeCol, main, pane);

    for (const [v, b] of Object.entries(viewBtns)) b.addEventListener('click', () => { mem.view = v; setPref('wiseos.files.view', v); paintSeg(); paintList(); });
    newBtn.addEventListener('click', () => newFolder());
    let t = 0;
    search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => runSearch(search.value), 380); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(t); runSearch(search.value); }
      if (e.key === 'Escape' && search.value) { e.preventDefault(); search.value = ''; runSearch(''); }
    });
    function paintSeg() {
      for (const [v, b] of Object.entries(viewBtns)) { b.classList.toggle('is-on', mem.view === v); b.setAttribute('aria-pressed', String(mem.view === v)); }
    }
    paintSeg();

    /* --------------------------------------------- layout: wide / split / stack */
    const mqWide = matchMedia('(min-width: 1760px)');
    const mqSplit = matchMedia('(min-width: 1100px)');
    function layout() {
      const m = mqWide.matches ? 'wide' : mqSplit.matches ? 'split' : 'stack';
      if (m === mode) return;
      mode = m;
      node.dataset.layout = m;
      // Recent changes: under the folder tree when there is room for one, otherwise under the list.
      if (m === 'wide') treeCol.append(changes);
      else main.append(changes);
      closeSheet();
      paintPane();
      if (m === 'wide') paintTree();
    }
    mqWide.addEventListener('change', layout);
    mqSplit.addEventListener('change', layout);

    /* --------------------------------------------- navigation */
    const rootId = () => mem.status?.account?.root_id || 'root';
    /** The business folder (Google Drive only): where Files opens and where search looks first. */
    const home = () => (P().id === 'gdrive' && state.settings?.files_home_id ? { id: String(state.settings.files_home_id), name: state.settings.files_home_name || 'Business files' } : null);
    const homeId = () => home()?.id || rootId();
    const isOwner = () => Boolean(mem.status?.can_connect);
    const hashFor = (id) => `#files${id && id !== homeId() ? `/${encodeURIComponent(id)}` : ''}`;
    function paintScope() {
      const h = home();
      scopeBtn.hidden = !h;
      if (!h) return;
      scopeBtn.textContent = mem.scope === 'home' ? `In ${h.name}` : 'All of Drive';
      scopeBtn.title = mem.scope === 'home' ? `Searching inside ${h.name}. Click to search all of Drive.` : `Searching all of Drive. Click to search inside ${h.name} only.`;
      scopeBtn.setAttribute('aria-label', scopeBtn.title);
      search.placeholder = mem.scope === 'home' ? `Search ${h.name}` : P().search;
    }
    paintScope();
    async function setHome(folder) {
      if (!folder || !isOwner()) return;
      const toRoot = folder.id === rootId();
      const name = toRoot ? null : folder.name;
      const ok = await modal({
        title: 'Make this the business folder?',
        body: el('p', { class: 'confirm-text' }, toRoot
          ? 'Files will open at the top of the drive, and search will look through all of it.'
          : `Files will open in ${folder.name}, and search and the assistant will look there first. Everyone on the team sees the same folder. Nothing in ${P().name} moves.`),
        confirmLabel: 'Make it the business folder'
      });
      if (!ok) return;
      try { await saveSettings({ files_home_id: toRoot ? null : folder.id, files_home_name: name }); } catch (e) { toast(e.message, 'bad'); return; }
      toast(toRoot ? 'Files now opens at the top of the drive' : `${folder.name} is now the business folder`);
      paintScope();
      pushHash(folder.id);
      paintAll();
    }
    function pushHash(id) {
      const h = hashFor(id);
      if (location.hash !== h) { try { history.pushState(null, '', h); } catch { location.hash = h; } }
    }

    /** Open a deep link: a folder, or a file (its folder + preview). */
    async function open(param) {
      layout();
      const id = param ? decodeURIComponent(param) : null;
      if (!id) { await goFolder(null, { push: false }); return; }
      const known = mem.items.get(id);
      if (known?.folder || mem.folders.has(id)) { await goFolder(id, { push: false }); return; }
      if (known && known.parent_id) { await goFolder(known.parent_id, { push: false, keepSelection: true }); select(known, { push: false }); return; }
      // Unknown: ask the drive what it is.
      showLoading();
      const r = await od('item', { id, with_path: true });
      if (!r.ok) { listError(r, r.error === 'not_found' || r.error === 'outside_drive' ? `That file or folder is not in ${P().name} any more` : null); return; }
      remember([r.item]);
      if (r.item.folder) { await goFolder(r.item.id, { push: false }); return; }
      mem.details.set(r.item.id, { ...r, at: Date.now() });
      if (r.path) mem.paths.set(r.item.parent_id, r.path);
      await goFolder(r.item.parent_id, { push: false, keepSelection: true });
      select(r.item, { push: false });
    }

    async function goFolder(id, { push = true, keepSelection = false, force = false } = {}) {
      const my = ++seq;
      closeMenu();
      if (searchQ) { searchQ = ''; searchItems = null; search.value = ''; }
      if (!keepSelection) { selected = null; paintPane(); }
      const key = id || homeId();
      folderId = key;
      if (push) pushHash(key);
      const cached = mem.folders.get(key);
      if (cached && !force) { paintAll(); if (Date.now() - cached.at < FOLDER_TTL) return; }
      else showLoading();
      const r = await od('list', { item_id: id || home()?.id || 'root', with_path: !mem.paths.has(key) });
      if (my !== seq) return;
      if (!r.ok) { listError(r); return; }
      remember(r.items); remember([r.folder]);
      const realKey = r.folder.id;
      if (realKey !== key) { folderId = realKey; }
      mem.folders.set(realKey, { folder: r.folder, items: r.items, cursor: r.cursor, at: Date.now() });
      if (r.path) mem.paths.set(realKey, r.path);
      else if (!mem.paths.has(realKey)) mem.paths.set(realKey, [{ id: realKey, name: rootName(r.folder) }]);
      if (r.folder.is_root && !r.folder.parent_id && mem.status?.account) mem.status.account.root_id = r.folder.id;
      paintAll();
    }

    async function loadMore(btn) {
      const f = mem.folders.get(folderId);
      if (!f?.cursor) return;
      await busy(btn, async () => {
        const r = await od('list', { item_id: folderId, cursor: f.cursor });
        if (!r.ok) { toast(errText(r), 'bad'); return; }
        remember(r.items);
        f.items = [...f.items, ...r.items]; f.cursor = r.cursor;
        paintList();
      });
    }

    async function runSearch(raw) {
      const q = String(raw || '').trim();
      const my = ++seq;
      if (!q) { searchQ = ''; searchItems = null; paintAll(); return; }
      searchQ = q;
      showLoading(`Searching for “${q}”`);
      const h = home();
      const r = await od('search', { q, ...(h && mem.scope === 'home' ? { within: h.id } : {}) });
      if (my !== seq) return;
      if (!r.ok) { listError(r); return; }
      remember(r.items);
      searchItems = r.items;
      paintAll();
    }

    /* --------------------------------------------- painting */
    function paintAll() {
      newBtn.hidden = Boolean(searchQ) || folderId === 'shared';
      const h = home();
      makeHome.hidden = !(P().id === 'gdrive' && isOwner() && !searchQ && folderId !== 'shared' && mem.folders.has(folderId) && folderId !== (h ? h.id : rootId()));
      paintScope(); paintCrumbs(); paintList(); paintTree();
    }

    /** The breadcrumb trail; inside the business folder it starts there. */
    function trailInfo() {
      const h = home();
      const full = mem.paths.get(folderId) || [{ id: homeId(), name: h?.name || P().root }];
      if (!h) return { trail: full, inHome: false, h };
      const i = full.findIndex((c) => c.id === h.id);
      if (i < 0) return { trail: full, inHome: false, h };
      return { trail: [{ id: h.id, name: h.name, home: true }, ...full.slice(i + 1)], inHome: true, h };
    }
    const crumbTrail = () => trailInfo().trail;
    function paintCrumbs() {
      const { trail, inHome, h } = trailInfo();
      const list = el('ol', {});
      if (h && inHome) {
        list.append(el('li', { class: 'fl-crumb-li-up' }, el('a', { class: 'fl-crumb fl-crumb-up', href: hashFor(rootId()), dataset: { fk: 'all-drive' }, title: `Leave ${h.name} and see all of ${P().name}`, onClick: (e) => { e.preventDefault(); goFolder(rootId()); } }, 'All of Drive')));
      }
      const show = trail.length > 4 ? [trail[0], { gap: true }, ...trail.slice(-2)] : trail;
      show.forEach((c, i) => {
        const last = i === show.length - 1 && !searchQ;
        list.append(el('li', {},
          c.gap ? el('span', { class: 'fl-crumb-gap', title: trail.slice(1, -2).map((x) => x.name).join(' / ') }, '…')
            : last ? el('span', { class: 'fl-crumb is-here', 'aria-current': 'page' }, c.name)
              : el('a', { class: 'fl-crumb', href: hashFor(c.id), onClick: (e) => { e.preventDefault(); goFolder(c.id); } }, c.name)));
      });
      if (searchQ) list.append(el('li', {}, el('span', { class: 'fl-crumb is-here' }, h && mem.scope === 'home' ? `Search in ${h.name}: “${searchQ}”` : `Search: “${searchQ}”`)));
      fill(crumbs, list, h && !inHome && !searchQ
        ? el('a', { class: 'fl-crumb-home', href: '#files', dataset: { fk: 'back-home' }, onClick: (e) => { e.preventDefault(); goFolder(h.id); } }, `Back to ${h.name}`)
        : null);
    }

    function showLoading(text = 'Opening') {
      fill(listArea, el('div', { class: 'fl-loading', 'aria-busy': 'true' },
        el('span', { class: 'sr-only' }, text),
        ...Array.from({ length: 6 }, (_, i) => el('div', { class: 'fl-skel-row', style: `--i:${i}` }, el('span', { class: 'skeleton' }), el('span', { class: 'skeleton' })))));
    }

    function listError(r, title = null) {
      if (r.error === 'reconnect_needed') { mem.status.needs_reconnect = true; paintBanner(); paintAcct(); }
      fill(listArea, el('div', { class: 'empty fl-empty' },
        el('div', { class: 'empty-icon' }, icon('alert', 22)),
        el('p', { class: 'empty-title' }, title || (r.error === 'busy' ? `${P().name} is busy` : r.error === 'reconnect_needed' ? `${P().name} needs a fresh sign-in` : 'That did not open')),
        el('p', { class: 'muted' }, errText(r)),
        el('div', { class: 'row' },
          r.error === 'reconnect_needed' ? null : el('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { fk: 'retry' }, onClick: () => (searchQ ? runSearch(searchQ) : goFolder(folderId, { push: false, force: true, keepSelection: true })) }, icon('refresh', 14), 'Try again'),
          el('a', { class: 'btn btn-ghost btn-sm', href: '#files', onClick: (e) => { e.preventDefault(); goFolder(null); } }, `Back to ${P().root}`))));
    }

    function currentItems() {
      if (searchQ) return searchItems || [];
      return mem.folders.get(folderId)?.items || [];
    }

    function itemHref(it) { return hashFor(it.id); }
    function activate(it, e) {
      e?.preventDefault();
      closeMenu();
      if (it.folder) goFolder(it.id);
      else select(it);
    }

    function moreBtn(it) {
      return el('button', {
        type: 'button', class: 'icon-btn sm fl-more', 'aria-label': `More for ${it.name}`, 'aria-haspopup': 'menu', dataset: { fk: 'more' },
        onClick: (e) => { e.stopPropagation(); openMenu(it, e.currentTarget); }
      }, icon('more', 16));
    }

    function sortHead(key, label, cls = '') {
      const on = mem.sort === key;
      return el('th', { class: cls, scope: 'col', 'aria-sort': on ? (mem.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
        el('button', {
          type: 'button', class: `fl-sort${on ? ' is-on' : ''}`, dataset: { sort: key },
          onClick: () => {
            if (mem.sort === key) mem.dir = mem.dir === 'asc' ? 'desc' : 'asc';
            else { mem.sort = key; mem.dir = key === 'name' ? 'asc' : 'desc'; }
            setPref('wiseos.files.sort', mem.sort); setPref('wiseos.files.dir', mem.dir);
            paintList();
          }
        }, label, on ? el('span', { class: `fl-sort-dir is-${mem.dir}`, 'aria-hidden': 'true' }, icon('chevron', 12)) : null));
    }

    function metaLine(it) {
      const bits = [];
      if (searchQ && it.parent_path) bits.push(it.parent_path === '/' ? P().root : it.parent_path.replace(/^\//, '').replace(/\//g, ' / '));
      if (it.folder) bits.push(countLabel(it));
      else if (it.size !== null) bits.push(fileSize(it.size));
      if (it.modified) bits.push(whenLabel(it.modified));
      return bits.join(' · ');
    }

    function paintList() {
      closeMenu();
      const items = sortList(currentItems());
      const f = mem.folders.get(folderId);
      if (!items.length) {
        fill(listArea, searchQ
          ? el('div', { class: 'empty fl-empty' }, el('div', { class: 'empty-icon' }, icon('search', 22)),
            el('p', { class: 'empty-title' }, 'Nothing matches'),
            el('p', { class: 'muted' }, `${P().name} found nothing for “${searchQ}”. Try part of the name, or a word inside the document.`))
          : el('div', { class: 'empty fl-empty' }, el('div', { class: 'empty-icon' }, folderIcon(28)),
            el('p', { class: 'empty-title' }, 'This folder is empty'),
            el('p', { class: 'muted' }, `Add files to it in ${P().name} and they show here straight away.`),
            el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => newFolder() }, svg(14, NEWFOLDER_D, { stroke: 1.7 }), 'New folder'))));
        return;
      }
      const count = el('p', { class: 'fl-count small muted' },
        searchQ ? `${plural(items.length, 'result')} for “${searchQ}”` : [[items.filter((i) => i.folder).length, 'folder'], [items.filter((i) => !i.folder).length, 'file']].filter(([n]) => n).map(([n, w]) => plural(n, w)).join(', '),
        searchQ ? el('button', { type: 'button', class: 'link-btn fl-clear', onClick: () => { search.value = ''; runSearch(''); } }, 'Clear search') : null);
      const more = !searchQ && f?.cursor ? el('div', { class: 'fl-more-row' }, el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: (e) => loadMore(e.currentTarget) }, 'Show more')) : null;

      if (mem.view === 'grid') {
        fill(listArea, count, el('ul', { class: 'fl-grid', role: 'list' }, items.map((it) => el('li', { class: `fl-tile-wrap${selected?.id === it.id ? ' is-selected' : ''}`, dataset: { id: it.id } },
          el('a', { class: 'fl-tile', href: itemHref(it), onClick: (e) => activate(it, e), dataset: { kind: it.kind } },
            el('span', { class: `fl-thumb${it.thumb ? ' has-img' : ''}` },
              it.thumb && !it.folder ? el('img', { src: it.thumb.large || it.thumb.medium, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onError: (e) => { e.currentTarget.replaceWith(glyph(it, 'lg')); } }) : glyph(it, 'lg')),
            el('span', { class: 'fl-tile-name' }, it.name),
            el('span', { class: 'fl-tile-meta' }, metaLine(it))),
          moreBtn(it)))), more);
        return;
      }

      const table = el('table', { class: 'table fl-table' },
        el('thead', {}, el('tr', {}, sortHead('name', 'Name', 'fl-th-name'), sortHead('modified', 'Modified', 'fl-th-mod'), sortHead('size', 'Size', 'fl-th-size num'), el('th', { class: 'fl-th-act' }, el('span', { class: 'sr-only' }, 'Actions')))),
        el('tbody', {}, items.map((it) => el('tr', { class: `fl-row${selected?.id === it.id ? ' is-selected' : ''}`, dataset: { id: it.id, kind: it.kind } },
          el('td', { class: 'fl-td-name' },
            el('a', { class: 'fl-name', href: itemHref(it), onClick: (e) => activate(it, e) },
              it.thumb?.small && it.kind === 'image' ? el('span', { class: 'fl-mini' }, el('img', { src: it.thumb.small, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })) : glyph(it, 'sm'),
              el('span', { class: 'fl-name-text' }, el('span', { class: 'fl-name-main' }, it.name), el('span', { class: 'fl-name-meta' }, metaLine(it))))),
          el('td', { class: 'fl-td-mod tnum' }, it.modified ? el('span', { title: dateTime(it.modified) }, whenLabel(it.modified)) : ''),
          el('td', { class: 'fl-td-size num tnum' }, it.folder ? el('span', { class: 'faint' }, countLabel(it)) : fileSize(it.size)),
          el('td', { class: 'fl-td-act' }, moreBtn(it))))));
      table.addEventListener('click', (e) => {
        const tr = e.target.closest('tr.fl-row');
        if (!tr || e.target.closest('a, button')) return;
        const it = mem.items.get(tr.dataset.id);
        if (it) activate(it, e);
      });
      fill(listArea, count, el('div', { class: 'table-wrap fl-table-wrap' }, table), more);
    }

    function paintTree() {
      if (mode !== 'wide') return;
      const trail = crumbTrail();
      const kids = sortList((mem.folders.get(folderId)?.items || []).filter((i) => i.folder));
      const rows = [];
      trail.forEach((c, i) => rows.push(el('li', {}, el('a', {
        class: `fl-tree-item${c.id === folderId ? ' is-here' : ''}`, href: hashFor(c.id), style: `--d:${i}`,
        'aria-current': c.id === folderId ? 'page' : null, onClick: (e) => { e.preventDefault(); goFolder(c.id); }
      }, folderIcon(15), el('span', { class: 'truncate' }, c.name)))));
      kids.forEach((k) => rows.push(el('li', {}, el('a', {
        class: 'fl-tree-item is-child', href: hashFor(k.id), style: `--d:${trail.length}`, onClick: (e) => { e.preventDefault(); goFolder(k.id); }
      }, folderIcon(15), el('span', { class: 'truncate' }, k.name)))));
      fill(tree, el('p', { class: 'eyebrow fl-col-label' }, 'Folders'), el('ul', { class: 'fl-tree-list' }, rows));
    }

    /* --------------------------------------------- selection + preview */
    function select(it, { push = true } = {}) {
      selected = it;
      if (push) pushHash(it.id);
      for (const r of listArea.querySelectorAll('[data-id]')) r.classList.toggle('is-selected', r.dataset.id === it.id);
      paintPane();
      loadDetail(it.id);
    }
    function deselect() {
      selected = null;
      for (const r of listArea.querySelectorAll('.is-selected')) r.classList.remove('is-selected');
      pushHash(folderId);
      closeSheet();
      paintPane();
    }

    async function loadDetail(id, force = false) {
      const d = mem.details.get(id);
      if (d && !force && Date.now() - d.at < DETAIL_TTL) { paintPane(); return; }
      const r = await od('item', { id });
      if (selected?.id !== id) return;
      if (!r.ok) {
        mem.details.set(id, { error: r, at: Date.now() });
        if (r.error === 'reconnect_needed') { mem.status.needs_reconnect = true; paintBanner(); paintAcct(); }
      } else {
        remember([r.item]);
        selected = r.item;
        mem.details.set(id, { ...r, at: Date.now() });
      }
      paintPane();
    }

    let sheet = null;
    function closeSheet() {
      if (!sheet) return;
      const s = sheet; sheet = null;
      document.removeEventListener('keydown', s._key, true);
      s.classList.add('is-leaving');
      s._scrim.remove();
      setTimeout(() => s.remove(), 180);
    }
    function openSheet(content) {
      if (!sheet) {
        const scrim = el('div', { class: 'drawer-backdrop', onClick: () => deselect() });
        sheet = el('div', { class: 'drawer fl-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'File preview' });
        sheet._scrim = scrim;
        sheet._key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); deselect(); } else if (e.key === 'Tab') trapFocus(e, sheet); };
        document.addEventListener('keydown', sheet._key, true);
        document.body.append(scrim, sheet);
        setTimeout(() => sheet?.querySelector('.fl-pv-close')?.focus(), 40);
      }
      fill(sheet, content);
    }

    function paintPane() {
      if (pdfUrl && !(selected && mem.details.get(selected.id)?.pdf === pdfUrl)) { URL.revokeObjectURL(pdfUrl); pdfUrl = null; }
      if (!selected) {
        closeSheet();
        fill(pane, mode === 'stack' ? null : el('div', { class: 'fl-pane-idle' }, folderIcon(30),
          el('p', { class: 'fl-idle-title' }, 'Choose a file to preview it here'),
          el('p', {}, P().id === 'gdrive' ? 'PDFs, photos, Google Docs, Sheets and Slides open in place. Word, Excel and PowerPoint show their first page, with a button to open them in Google Drive.' : 'PDFs, photos and video open in place. Word, Excel and PowerPoint show their first page, with a button to open them in OneDrive.')));
        pane.classList.toggle('is-idle', true);
        paintChanges();
        return;
      }
      pane.classList.remove('is-idle');
      const content = preview(selected);
      if (mode === 'stack') { clear(pane); openSheet(content); } else fill(pane, content);
    }

    function preview(item) {
      const d = mem.details.get(item.id);
      const it = d?.item || item;
      const loading = !d;
      const isOffice = OFFICE.has(it.kind);
      const isGoogle = GOOGLE.has(it.kind);
      const openBtn = it.web_url ? el('a', { class: `btn btn-sm ${isOffice || isGoogle ? 'btn-primary' : 'btn-ghost'}`, href: it.web_url, target: '_blank', rel: 'noopener noreferrer', dataset: { fk: 'open-web' } }, icon('external', 14), P().open) : null;
      const dl = d?.download_url && !it.folder ? el('a', { class: 'btn btn-ghost btn-sm', href: d.download_url, rel: 'noopener noreferrer', dataset: { fk: 'download' } }, icon('download', 14), 'Download') : null;
      const head = el('div', { class: 'fl-pv-head' },
        el('div', { class: 'fl-pv-top' },
          el('p', { class: 'eyebrow' }, [kindLabel(it), it.size !== null && !it.folder ? fileSize(it.size) : null].filter(Boolean).join(' · ')),
          el('button', { type: 'button', class: 'icon-btn sm fl-pv-close', 'aria-label': 'Close preview', onClick: () => deselect() }, icon('x', 16))),
        el('h2', { class: 'h2 fl-pv-name' }, it.name),
        el('div', { class: 'fl-pv-acts' }, openBtn, dl),
        el('div', { class: 'fl-pv-tools' },
          it.can_rename === false ? null : el('button', { type: 'button', class: 'fl-tool', dataset: { fk: 'rename' }, onClick: () => rename(it) }, icon('edit', 14), 'Rename'),
          it.can_move === false ? null : el('button', { type: 'button', class: 'fl-tool', dataset: { fk: 'move' }, onClick: () => move(it) }, svg(14, MOVE_D, { stroke: 1.7 }), 'Move'),
          el('button', { type: 'button', class: 'fl-tool', dataset: { fk: 'link' }, onClick: () => link(it) }, icon('link', 14), 'Link to…')));

      const stage = el('div', { class: `fl-stage is-${it.kind}` });
      if (d?.error) {
        stage.append(el('div', { class: 'fl-stage-note' }, icon('alert', 18), el('p', {}, errText(d.error)),
          el('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => loadDetail(it.id, true) }, icon('refresh', 14), 'Try again')));
      } else if (loading) {
        stage.append(el('div', { class: 'skeleton fl-stage-skel' }));
      } else if (it.kind === 'image') {
        const src = it.thumb?.large || d.preview_url || d.download_url;
        stage.append(src ? el('img', { class: 'fl-stage-img', src, alt: it.name, referrerpolicy: 'no-referrer', decoding: 'async' }) : glyph(it, 'lg'));
      } else if (it.kind === 'pdf' || (isGoogle && d.preview_url)) {
        stage.append(pdfFrame(it, d));
      } else if (it.kind === 'video' && (d.preview_url || d.download_url) && (it.size || 0) <= 40 * 1024 * 1024) {
        stage.append(el('video', { class: 'fl-stage-media', src: d.preview_url || d.download_url, controls: true, preload: 'metadata', playsinline: true }));
      } else if (it.kind === 'audio' && (d.preview_url || d.download_url)) {
        stage.append(glyph(it, 'lg'), el('audio', { class: 'fl-stage-audio', src: d.preview_url || d.download_url, controls: true, preload: 'none' }));
      } else if (it.thumb?.large) {
        stage.append(el('div', { class: 'fl-sheet-page' }, el('img', { src: it.thumb.large, alt: `First page of ${it.name}`, referrerpolicy: 'no-referrer', decoding: 'async' })),
          isOffice ? el('p', { class: 'fl-stage-cap small muted' }, `A first-page preview. ${P().open} to read or edit the whole thing.`) : null);
      } else {
        stage.append(el('div', { class: 'fl-stage-note' }, glyph(it, 'lg'),
          el('p', {}, isOffice ? `Word, Excel and PowerPoint files open in ${P().name}, where you can read and edit them.` : `There is no preview for this kind of file. ${P().open} or download it.`)));
      }

      const loc = it.parent_path ? (it.parent_path === '/' ? P().root : `${P().root} / ${it.parent_path.replace(/^\//, '').replace(/\//g, ' / ')}`) : null;
      const facts = el('dl', { class: 'fl-facts' },
        fact('Modified', it.modified ? `${dateTime(it.modified)}${it.modified_by ? `, ${it.modified_by}` : ''}` : '—'),
        it.created ? fact('Created', dateTime(it.created)) : null,
        !it.folder && it.size !== null ? fact('Size', fileSize(it.size)) : null,
        loc ? fact('Where', it.parent_id ? el('a', { href: hashFor(it.parent_id), class: 'fl-where', onClick: (e) => { e.preventDefault(); goFolder(it.parent_id); } }, loc) : loc) : null);

      const links = d?.links || [];
      const linksBox = el('section', { class: 'fl-links', 'aria-labelledby': 'fl-links-h' },
        el('div', { class: 'fl-sub-head' }, el('h3', { class: 'eyebrow', id: 'fl-links-h' }, 'Linked to'),
          el('button', { type: 'button', class: 'link-btn small', onClick: () => link(it) }, 'Add a link')),
        loading ? null : links.length
          ? el('ul', { class: 'fl-link-list' }, links.map((l) => {
            const rec = recordFor(l.kind, l.record_id);
            return el('li', { dataset: { link: l.id } },
              el('span', { class: 'fl-link-kind' }, KIND[l.kind]?.label || l.kind),
              rec ? el('a', { href: recordHash(l.kind, l.record_id), class: 'fl-link-name' }, recordLabel(l.kind, rec)) : el('span', { class: 'fl-link-name faint' }, 'A record that has since been removed'),
              el('button', { type: 'button', class: 'icon-btn sm', 'aria-label': `Remove the link to ${rec ? recordLabel(l.kind, rec) : 'this record'}`, title: `Remove link (the file stays in ${P().name})`, dataset: { fk: 'unlink' }, onClick: (e) => unlink(it, l, e.currentTarget) }, icon('x', 14)));
          }))
          : el('p', { class: 'small muted' }, 'Not linked to anything yet. Link it to a client, project, deal or lead and it shows on their page.'));

      return el('div', { class: 'fl-pv', dataset: { id: it.id } }, head, stage, facts, linksBox);
    }
    const fact = (k, v) => el('div', { class: 'fl-fact' }, el('dt', {}, k), el('dd', {}, v));

    function pdfFrame(it, d) {
      const wrap = el('div', { class: 'fl-pdf' });
      const fallback = () => fill(wrap, it.thumb?.large
        ? el('div', { class: 'fl-sheet-page' }, el('img', { src: it.thumb.large, alt: `First page of ${it.name}`, referrerpolicy: 'no-referrer' }))
        : el('div', { class: 'fl-stage-note' }, glyph(it, 'lg'), el('p', {}, `This PDF is too large to show here. ${P().open}.`)));
      const src = d.preview_url || d.download_url;
      if (mode === 'stack') {
        // Phones show only the first page of a framed PDF, so show that page and open the whole file in a tab.
        wrap.classList.add('is-phone');
        wrap.append(it.thumb?.large
          ? el('div', { class: 'fl-sheet-page' }, el('img', { src: it.thumb.large, alt: `First page of ${it.name}`, referrerpolicy: 'no-referrer' }))
          : glyph(it, 'lg'),
        src ? el('a', { class: 'btn btn-ghost btn-sm fl-pdf-open', href: src, target: '_blank', rel: 'noopener noreferrer', dataset: { fk: 'open-pdf' } }, icon('external', 14), 'Read the whole PDF') : null);
        return wrap;
      }
      if (d.pdf) { wrap.append(el('iframe', { class: 'fl-pdf-frame', src: d.pdf, title: `Preview of ${it.name}` })); return wrap; }
      if (!src || (it.size || 0) > 40 * 1024 * 1024) { fallback(); return wrap; }
      wrap.append(el('div', { class: 'skeleton fl-stage-skel' }));
      (async () => {
        try {
          const res = await fetch(src, { referrerPolicy: 'no-referrer', credentials: 'omit' });
          if (!res.ok) throw new Error(String(res.status));
          const blob = new Blob([await res.arrayBuffer()], { type: 'application/pdf' });
          if (selected?.id !== it.id) return;
          if (pdfUrl) URL.revokeObjectURL(pdfUrl);
          pdfUrl = URL.createObjectURL(blob);
          d.pdf = pdfUrl;
          fill(wrap, el('iframe', { class: 'fl-pdf-frame', src: pdfUrl, title: `Preview of ${it.name}` }));
        } catch { fallback(); }
      })();
      return wrap;
    }

    /* --------------------------------------------- recent changes */
    async function loadChanges() {
      try { mem.changes = await recentChanges(25); } catch { mem.changes = mem.changes || []; }
      paintChanges();
    }
    function paintChanges() {
      const rows = mem.changes;
      fill(changes,
        el('div', { class: 'fl-sub-head' }, el('h2', { class: 'eyebrow', id: 'fl-ch-h' }, 'Recent changes')),
        rows === null ? el('div', { class: 'skeleton', style: 'height:84px' })
          : !rows.length ? el('p', { class: 'small muted fl-ch-none' }, 'Moves, renames and new folders made from the hub show here, each with an Undo. Nothing is ever deleted from here.')
            : el('ol', { class: 'fl-ch-list' }, rows.slice(0, 12).map((c) => {
              const who = c.member_id ? memberName(c.member_id, 'Someone') : 'Someone';
              const action = c.undone_at ? el('span', { class: 'fl-ch-state small faint' }, 'Undone')
                : c.op === 'create_folder' ? null
                  : el('button', { type: 'button', class: 'btn btn-ghost btn-sm fl-undo', dataset: { fk: 'undo', change: c.id }, onClick: (e) => undo(c, e.currentTarget) }, 'Undo');
              return el('li', { class: `fl-ch${c.undone_at ? ' is-undone' : ''}`, dataset: { change: c.id, op: c.op } },
                el('div', { class: 'fl-ch-text' },
                  el('a', { class: 'fl-ch-sum', href: hashFor(c.item_id), onClick: (e) => { e.preventDefault(); openChanged(c); } }, c.summary || c.op),
                  el('span', { class: 'fl-ch-meta small muted' }, [who, timeAgo(c.at), c.source === 'assistant' ? 'by the assistant' : null].filter(Boolean).join(' · '))),
                action);
            })));
    }
    function openChanged(c) {
      const it = mem.items.get(c.item_id);
      if (it?.folder || c.op === 'create_folder') goFolder(c.item_id);
      else if (it) { goFolder(it.parent_id, { keepSelection: true }).then(() => select(it)); }
      else open(c.item_id);
    }

    /* --------------------------------------------- actions */
    function afterChange(r, { focusItem = null } = {}) {
      if (r.change) mem.changes = [r.change, ...(mem.changes || []).filter((c) => c.id !== r.change.id)];
      // Folders touched by the change are stale now.
      for (const k of [...mem.folders.keys()]) mem.folders.get(k).at = 0;
      if (r.item) { remember([r.item]); mem.details.delete(r.item.id); }
      paintChanges();
      goFolder(folderId, { push: false, force: true, keepSelection: Boolean(focusItem) }).then(() => {
        if (focusItem && mem.items.get(focusItem.id)?.parent_id === folderId) select(mem.items.get(focusItem.id), { push: false });
        else if (focusItem && selected?.id === focusItem.id) deselect();
      });
    }

    async function rename(it) {
      const inp = el('input', { class: 'input', name: 'name', value: it.name, required: true, maxlength: '250', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'fl-rn-hint' });
      const hint = el('p', { class: 'field-hint', id: 'fl-rn-hint' }, it.folder ? 'The folder keeps everything inside it.' : 'Keep the ending (like .pdf) so it still opens in the right app.');
      inp.addEventListener('input', () => { const p = nameProblem(inp.value); inp.setCustomValidity(p); hint.textContent = p || (it.folder ? 'The folder keeps everything inside it.' : 'Keep the ending (like .pdf) so it still opens in the right app.'); hint.classList.toggle('is-bad', Boolean(p)); });
      const v = await modal({
        title: `Rename ${it.folder ? 'folder' : 'file'}`, confirmLabel: 'Rename',
        body: el('div', { class: 'field' }, el('label', { class: 'field-label', for: 'fl-rn' }, 'New name'), Object.assign(inp, { id: 'fl-rn' }), hint),
        onOpen: () => setTimeout(() => { inp.focus(); inp.setSelectionRange(0, it.folder ? it.name.length : baseName(it.name).length); }, 40)
      });
      if (!v) return;
      const name = String(v.name || '').trim();
      if (name === it.name) return;
      const r = await od('rename', { id: it.id, name });
      if (!r.ok) { toast(errText(r), 'bad'); return; }
      toast(`Renamed to ${r.item?.name || name}`);
      afterChange(r, { focusItem: it.folder ? null : r.item });
    }

    async function move(it) {
      const picked = await pickFolder(it);
      if (!picked) return;
      const r = await od('move', { id: it.id, parent_id: picked.id });
      if (!r.ok) { toast(errText(r), 'bad'); return; }
      if (r.unchanged) { toast('It is already there', 'info'); return; }
      toast(`Moved to ${picked.name}. Undo is in Recent changes.`);
      afterChange(r, { focusItem: null });
      if (selected?.id === it.id) deselect();
    }

    /** The folder picker: browse folders, then "Move here". Resolves {id, name} or null. */
    function pickFolder(it) {
      return new Promise((resolve) => {
        let at = it.parent_id || rootId();
        let atName = P().root;
        let resolved = false;
        const crumbsBox = el('nav', { class: 'fl-pick-crumbs', 'aria-label': 'Folder path' });
        const listBox = el('div', { class: 'fl-pick-list' });
        const status = el('p', { class: 'small muted fl-pick-status', role: 'status' });
        const hidden = el('input', { type: 'hidden', name: 'parent' });
        const body = el('div', { class: 'fl-pick' }, el('p', { class: 'muted small' }, `Choose where ${it.name} should go.`), crumbsBox, listBox, status, hidden);
        let submitBtn = null;
        async function load(id) {
          fill(listBox, el('div', { class: 'skeleton', style: 'height:180px' }));
          const r = await od('folders', { item_id: id });
          if (!r.ok) { fill(listBox, el('p', { class: 'small muted' }, errText(r))); return; }
          remember(r.items); remember([r.folder]);
          at = r.folder.id; atName = rootName(r.folder);
          hidden.value = at;
          const path = r.path || [{ id: at, name: atName }];
          fill(crumbsBox, el('ol', {}, path.map((c, i) => el('li', {}, i === path.length - 1 ? el('span', { class: 'fl-crumb is-here' }, c.name)
            : el('button', { type: 'button', class: 'fl-crumb', onClick: () => load(c.id) }, c.name)))));
          const kids = r.items.filter((f) => f.id !== it.id);
          fill(listBox, kids.length ? el('ul', {}, kids.map((f) => el('li', {}, el('button', { type: 'button', class: 'fl-pick-item', dataset: { id: f.id }, onClick: () => load(f.id) }, folderIcon(16), el('span', { class: 'truncate' }, f.name), icon('chevron', 14)))))
            : el('p', { class: 'small muted fl-pick-none' }, 'No folders inside this one.'));
          const same = at === it.parent_id;
          status.textContent = same ? `${it.name} is already in ${atName}.` : `Move into ${atName}.`;
          if (submitBtn) { submitBtn.disabled = same; submitBtn.textContent = same ? 'Already here' : `Move to ${atName}`; }
        }
        modal({
          title: `Move ${it.folder ? 'folder' : 'file'}`, confirmLabel: 'Move here', body, wide: false,
          onOpen: (form) => { submitBtn = form.parentNode.querySelector('.modal-foot .btn-primary'); load(at); }
        }).then((v) => { if (resolved) return; resolved = true; resolve(v && v.parent ? { id: v.parent, name: atName } : null); });
      });
    }

    async function newFolder() {
      const inp = el('input', { class: 'input', name: 'name', id: 'fl-nf', required: true, maxlength: '250', autocomplete: 'off', placeholder: 'For example, Smith Plumbing' });
      const hint = el('p', { class: 'field-hint' }, '');
      inp.addEventListener('input', () => { const p = nameProblem(inp.value); inp.setCustomValidity(p); hint.textContent = p; });
      const where = (mem.paths.get(folderId) || []).at(-1)?.name || P().root;
      const v = await modal({
        title: 'New folder', confirmLabel: 'Make folder',
        body: [el('p', { class: 'muted small' }, `Inside ${where}.`), el('div', { class: 'field' }, el('label', { class: 'field-label', for: 'fl-nf' }, 'Folder name'), inp, hint)]
      });
      if (!v) return;
      const r = await od('create_folder', { parent_id: folderId, name: String(v.name || '').trim() });
      if (!r.ok) { toast(errText(r), 'bad'); return; }
      toast(`Made ${r.item?.name}`);
      afterChange(r);
    }

    async function link(it) {
      let kind = 'client';
      const q = el('input', { class: 'input', type: 'search', placeholder: 'Search by name', 'aria-label': 'Search records', autocomplete: 'off' });
      const listBox = el('div', { class: 'fl-rec-list', role: 'radiogroup', 'aria-label': 'Record' });
      const kinds = el('div', { class: 'fl-rec-kinds', role: 'group', 'aria-label': 'What to link to' });
      const paintKinds = () => fill(kinds, LINK_KINDS.map((k) => el('button', {
        type: 'button', class: `chip${kind === k.id ? ' is-active' : ''}`, 'aria-pressed': String(kind === k.id), dataset: { kind: k.id },
        onClick: () => { kind = k.id; paintKinds(); paintRecs(); q.focus(); }
      }, k.label)));
      const already = new Set((mem.details.get(it.id)?.links || []).map((l) => `${l.kind}:${l.record_id}`));
      const paintRecs = () => {
        const recs = pickRecords(kind, q.value);
        fill(listBox, recs.length ? recs.map((r, i) => el('label', { class: `fl-rec${already.has(`${kind}:${r.id}`) ? ' is-linked' : ''}` },
          el('input', { type: 'radio', name: 'record', value: `${kind}:${r.id}`, required: true, checked: i === 0 && !already.has(`${kind}:${r.id}`) ? true : null, disabled: already.has(`${kind}:${r.id}`) ? true : null }),
          el('span', { class: 'fl-rec-text' }, el('span', { class: 'fl-rec-name' }, r.label), r.sub ? el('span', { class: 'fl-rec-sub small muted' }, r.sub) : null),
          already.has(`${kind}:${r.id}`) ? el('span', { class: 'small faint' }, 'Linked') : null))
          : el('p', { class: 'small muted fl-rec-none' }, q.value ? 'Nothing matches that.' : `There are no ${KIND[kind].label.toLowerCase()}s in the hub yet.`));
      };
      q.addEventListener('input', paintRecs);
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
      paintKinds(); paintRecs();
      const v = await modal({
        title: 'Link to…', confirmLabel: 'Link',
        body: [el('p', { class: 'muted small' }, `${it.name} will show on that page. The file itself stays where it is in ${P().name}.`), kinds, q, listBox],
        onOpen: () => setTimeout(() => q.focus(), 40)
      });
      if (!v || !v.record) return;
      const [k, id] = String(v.record).split(':');
      const r = await od('link', { item_id: it.id, kind: k, record_id: id });
      if (!r.ok) { toast(errText(r), 'bad'); return; }
      toast(`Linked to ${recordLabel(k, recordFor(k, id))}`);
      const d = mem.details.get(it.id);
      if (d && !d.error) d.links = [...(d.links || []).filter((l) => l.id !== r.link.id), r.link];
      if (selected?.id === it.id) paintPane();
    }

    async function unlink(it, l, btn) {
      await busy(btn, async () => {
        const r = await od('unlink', { link_id: l.id });
        if (!r.ok) { toast(errText(r), 'bad'); return; }
        const d = mem.details.get(it.id);
        if (d) d.links = (d.links || []).filter((x) => x.id !== l.id);
        toast(`Link removed. The file is still in ${P().name}.`);
        if (selected?.id === it.id) paintPane();
      });
    }

    async function undo(c, btn) {
      await busy(btn, async () => {
        const r = await od('undo', { change_id: c.id });
        if (!r.ok) { toast(errText(r), r.error === 'changed_since' ? 'warn' : 'bad'); if (r.error === 'already_undone') loadChanges(); return; }
        mem.changes = (mem.changes || []).map((x) => (x.id === c.id ? { ...x, ...(r.change || {}), undone_at: r.change?.undone_at || new Date().toISOString() } : x));
        toast('Undone');
        afterChange({ item: r.item });
      });
    }

    /* --------------------------------------------- the row menu */
    function closeMenu() { if (menu) { menu.remove(); document.removeEventListener('pointerdown', menu._out, true); document.removeEventListener('keydown', menu._key, true); menu = null; } }
    function openMenu(it, anchor) {
      closeMenu();
      const items = [
        it.folder ? ['Open', () => goFolder(it.id)] : ['Preview', () => select(it)],
        it.web_url ? [P().open, () => window.open(it.web_url, '_blank', 'noopener,noreferrer')] : null,
        it.can_rename === false ? null : ['Rename', () => rename(it)],
        it.can_move === false ? null : ['Move', () => move(it)],
        it.id === 'shared' ? null : ['Link to…', () => link(it)],
        it.folder && it.id !== 'shared' && P().id === 'gdrive' && isOwner() && it.id !== home()?.id ? ['Make this the business folder', () => setHome(it)] : null
      ].filter(Boolean);
      const btns = items.map(([label, run]) => el('button', { type: 'button', role: 'menuitem', class: 'fl-menu-item', onClick: () => { closeMenu(); run(); } }, label));
      menu = el('div', { class: 'fl-menu', role: 'menu', 'aria-label': `Actions for ${it.name}` }, btns);
      document.body.append(menu);
      const r = anchor.getBoundingClientRect();
      const w = menu.offsetWidth, h = menu.offsetHeight;
      menu.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
      menu.style.top = `${r.bottom + 4 + h > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
      menu._out = (e) => { if (!menu.contains(e.target) && e.target !== anchor) closeMenu(); };
      menu._key = (e) => {
        const i = btns.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); anchor.focus(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
        else if (e.key === 'Tab') closeMenu();
      };
      document.addEventListener('pointerdown', menu._out, true);
      document.addEventListener('keydown', menu._key, true);
      btns[0].focus();
    }

    /* --------------------------------------------- live updates from other people */
    const unwatch = watchFiles(({ table, row }) => {
      if (!node.isConnected) { unwatch(); return; }
      if (table === 'file_changes') {
        if (!row?.id) return;
        const list = mem.changes || [];
        const i = list.findIndex((c) => c.id === row.id);
        mem.changes = i >= 0 ? list.map((c) => (c.id === row.id ? row : c)) : [row, ...list];
        paintChanges();
      } else if (selected && row?.item_id === selected.id) {
        loadDetail(selected.id, true);
      }
    });

    loadChanges();
    return {
      node,
      open,
      onState() { paintChanges(); if (selected) paintPane(); },
      destroy() { closeMenu(); closeSheet(); unwatch(); }
    };
  }

  start();
  root.onState = () => { app?.onState?.(); };
  // The app replaces this node on navigation; tidy up anything floating.
  new MutationObserver((_, obs) => { if (!root.isConnected && document.body.contains(document.querySelector('#view'))) { obs.disconnect(); app?.destroy?.(); } })
    .observe(document.querySelector('#view') || document.body, { childList: true });
  return root;
}
