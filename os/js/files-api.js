// Files client helpers: one call shape for the drive functions (`gdrive` for Google Drive,
// `onedrive` for OneDrive; both answer the same actions with the same shapes), the hub's own
// link and change rows, and record labels for linking. Imports api.js with the same ?v= stamp
// as every other module so there is only one copy of `state`.
import { fn, sb, state, leadName } from './api.js?v=20261119a';

/** The two providers. Google Drive is the business's drive; OneDrive stays available, dormant. */
export const PROVIDERS = {
  gdrive: { id: 'gdrive', fn: 'gdrive', name: 'Google Drive', root: 'My Drive', open: 'Open in Google Drive', search: 'Search Drive', flag: 'drive', company: 'Google' },
  onedrive: { id: 'onedrive', fn: 'onedrive', name: 'OneDrive', root: 'OneDrive', open: 'Open in OneDrive', search: 'Search OneDrive', flag: 'onedrive', company: 'Microsoft' }
};
let current = PROVIDERS.gdrive;
/** The provider the Files page is showing. */
export const provider = () => current;

async function call(name, action, body = {}) {
  const { status, data } = await fn(name, { action, ...body });
  if (data && typeof data === 'object' && 'ok' in data) return data;
  if (status === 0) return { ok: false, error: 'network', message: 'Cannot reach the hub. Check your connection.' };
  return { ok: false, error: 'server_error', message: 'Something went wrong. Try again in a minute.' };
}

/** Call the Google Drive function whatever the Files page is showing (Settings, Connections). */
export async function gdriveCall(action, body = {}) { return call('gdrive', action, body); }

/** Call the current provider's function. Never throws: resolves to the body with `ok`. */
export async function od(action, body = {}) { return call(current.fn, action, body); }

/**
 * Pick the provider and return its status: Google Drive when it is set up or connected, else
 * OneDrive when it is set up, else Google Drive (whose not-set-up state explains the Google steps).
 */
export async function detectProvider() {
  const g = await call('gdrive', 'status');
  if (g.ok && (g.configured || g.connected)) { current = PROVIDERS.gdrive; return g; }
  const o = await call('onedrive', 'status');
  if (o.ok && o.configured) { current = PROVIDERS.onedrive; return { ...o, provider: 'onedrive' }; }
  current = PROVIDERS.gdrive;
  return g.ok ? g : o.ok ? { ...g, ...o, configured: false, connected: false } : g;
}

/** Links for one record (client, project, deal or lead), newest first. */
export async function linksForRecord(kind, recordId) {
  const { data, error } = await sb.from('file_links').select('*').eq('kind', kind).eq('record_id', recordId).order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

/** Links for one drive item. */
export async function linksForItem(itemId) {
  const { data, error } = await sb.from('file_links').select('*').eq('item_id', itemId).order('created_at');
  if (error) throw new Error(error.message);
  return data || [];
}

/** The latest moves, renames and new folders. */
export async function recentChanges(limit = 25) {
  const { data, error } = await sb.from('file_changes').select('*').eq('provider', current.id).order('at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}

let channel = null;
const watchers = new Set();
/** Call `cb({table, type, row})` when a link or change row arrives. Returns an unsubscribe. */
export function watchFiles(cb) {
  watchers.add(cb);
  if (!channel) {
    channel = sb.channel('wiseos-files');
    for (const table of ['file_links', 'file_changes']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, (p) => {
        for (const w of [...watchers]) { try { w({ table, type: p.eventType, row: p.new || p.old }); } catch (e) { setTimeout(() => { throw e; }, 0); } }
      });
    }
    channel.subscribe();
  }
  return () => watchers.delete(cb);
}

/* --------------------------------------------------------- linkable records */

export const LINK_KINDS = [
  { id: 'client', label: 'Client', table: 'clients', route: 'clients' },
  { id: 'project', label: 'Project', table: 'projects', route: 'projects' },
  { id: 'deal', label: 'Deal', table: 'deals', route: 'pipeline' },
  { id: 'lead', label: 'Lead', table: 'leads', route: 'leads' }
];
export const KIND = Object.fromEntries(LINK_KINDS.map((k) => [k.id, k]));

/** A readable name for a hub record. */
export function recordLabel(kind, row) {
  if (!row) return 'Removed record';
  if (kind === 'client') return row.name || 'Unnamed client';
  if (kind === 'project') return row.name || 'Unnamed project';
  if (kind === 'deal') return row.title || 'Untitled deal';
  if (kind === 'lead') return leadName(row);
  return 'Record';
}

/** The record behind a link, from live state (null if it has gone). */
export function recordFor(kind, id) {
  const k = KIND[kind];
  return k ? (state[k.table] || []).find((r) => r.id === id) || null : null;
}

/** Hash route for a record. */
export const recordHash = (kind, id) => `#${KIND[kind]?.route || 'home'}/${id}`;

/** Records of one kind for the picker, filtered by text, best first. */
export function pickRecords(kind, q = '', limit = 40) {
  const k = KIND[kind];
  if (!k) return [];
  const needle = q.trim().toLowerCase();
  const rows = (state[k.table] || []).filter((r) => !r.archived);
  const scored = rows.map((r) => {
    const label = recordLabel(kind, r);
    const hay = `${label} ${r.contact_name || ''} ${r.suburb || ''}`.toLowerCase();
    const at = needle ? hay.indexOf(needle) : 0;
    return { r, label, at };
  }).filter((x) => x.at >= 0);
  scored.sort((a, b) => a.at - b.at || a.label.localeCompare(b.label, 'en-AU'));
  return scored.slice(0, limit).map((x) => ({ id: x.r.id, label: x.label, sub: kind === 'project' || kind === 'deal' ? recordLabel('client', recordFor('client', x.r.client_id)) : (x.r.suburb || x.r.contact_name || '') }));
}

/* --------------------------------------------------------- formatting */

/** 1536 → "1.5 KB" (en-AU, base 1024, one decimal under 10). */
export function fileSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)} ${units[i]}`;
}

/** Name without the extension, for pre-selecting in a rename field. */
export function baseName(name) {
  const m = /^(.*?)(\.[A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m && m[1] ? m[1] : String(name || '');
}

/** The same rules the function applies. Returns an error sentence or ''. */
export function nameProblem(raw) {
  const name = String(raw || '').trim();
  if (!name) return 'Give it a name.';
  if (name.length > 250) return 'That name is too long.';
  if (current.id === 'gdrive') return name.includes('/') ? 'Names cannot contain a slash (/).' : '';
  if (/["*:<>?/\\|]/.test(name)) return 'Names cannot contain " * : < > ? / \\ or |.';
  if (name.endsWith('.')) return 'Names cannot end with a full stop.';
  if (/^(con|prn|aux|nul|com\d|lpt\d|desktop\.ini|\.lock)$/i.test(name) || /^_vti_/i.test(name) || name.startsWith('~$')) return 'OneDrive reserves that name.';
  return '';
}

/** Human type label for an item kind. */
export function kindLabel(item) {
  if (!item) return '';
  if (item.folder) return 'Folder';
  return ({ word: 'Word document', excel: 'Excel workbook', powerpoint: 'PowerPoint deck', pdf: 'PDF', image: 'Image', video: 'Video', audio: 'Audio', text: 'Text file', archive: 'Archive',
    gdoc: 'Google Doc', gsheet: 'Google Sheet', gslide: 'Google Slides', gform: 'Google Form', gdraw: 'Google Drawing', shortcut: 'Shortcut' })[item.kind]
    || (item.ext ? `${item.ext.toUpperCase()} file` : 'File');
}
