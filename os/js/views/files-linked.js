// "Files" on a client, project or deal page: the Google Drive (or OneDrive) files linked to that record from the
// Files page. Self-contained: reads the hub's file_links rows (never Microsoft), keeps itself
// current through realtime, and quietly hides itself if the links cannot be read.
import { el, icon, fill, timeAgo } from '../ui.js?v=20261119a';
import { linksForRecord, watchFiles } from '../files-api.js?v=20261119a';

const KIND_OF = (name, isFolder, mime) => {
  if (isFolder) return 'folder';
  const ext = (String(name).match(/\.([a-z0-9]{1,8})$/i)?.[1] || '').toLowerCase();
  if (/google-apps\.document$/.test(mime || '')) return 'gdoc';
  if (/google-apps\.spreadsheet$/.test(mime || '')) return 'gsheet';
  if (/google-apps\.presentation$/.test(mime || '')) return 'gslide';
  return ({ doc: 'word', docx: 'word', xls: 'excel', xlsx: 'excel', csv: 'excel', ppt: 'powerpoint', pptx: 'powerpoint', pdf: 'pdf', jpg: 'image', jpeg: 'image', png: 'image', heic: 'image', webp: 'image' })[ext] || 'file';
};

/**
 * linkedFiles('client' | 'project' | 'deal' | 'lead', recordId, { drawer }) → <section>.
 * `drawer: true` uses the drawer's section classes (the deal drawer); otherwise the page's.
 */
export function linkedFiles(kind, recordId, { drawer = false } = {}) {
  const list = el('div', { class: 'fl-rec-files' });
  const head = drawer
    ? el('div', { class: 'ld-section-head' }, el('h2', { class: 'h2' }, 'Files'))
    : el('div', { class: 'section-head' }, el('div', { class: 'stack' }, el('p', { class: 'eyebrow' }, 'Documents'), el('h2', { class: 'h2' }, 'Files')),
      el('a', { class: 'card-link', href: '#files' }, 'Open Files', icon('arrow', 13)));
  const node = el('section', { class: `${drawer ? 'ld-section' : 'section'} fl-linked`, 'aria-label': 'Linked files', dataset: { linkedFiles: kind } }, head, list);

  let rows = null;
  const paint = () => {
    if (rows === null) { fill(list, el('div', { class: 'skeleton', style: 'height:44px' })); return; }
    fill(list, rows.length
      ? el('ul', { class: 'fl-rec-file-list' }, rows.map((l) => el('li', { dataset: { item: l.item_id } },
        el('span', { class: 'fl-rec-file-mark', dataset: { kind: KIND_OF(l.name, l.is_folder, l.mime) }, 'aria-hidden': 'true' }),
        el('a', { class: 'fl-rec-file-name', href: `#files/${encodeURIComponent(l.item_id)}` }, l.name || 'Untitled'),
        el('span', { class: 'fl-rec-file-when small faint' }, `linked ${timeAgo(l.created_at)}`),
        l.web_url && /^https:\/\//.test(l.web_url) ? el('a', { class: 'icon-btn sm', href: l.web_url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `Open ${l.name} in ${l.provider === 'onedrive' ? 'OneDrive' : 'Google Drive'}`, title: l.provider === 'onedrive' ? 'Open in OneDrive' : 'Open in Google Drive' }, icon('external', 14)) : null)))
      : el('p', { class: drawer ? 'small muted' : 'dl-none' }, 'No files linked yet. In ', el('a', { href: '#files', class: 'link-btn' }, 'Files'), ', choose a file and use Link to…'));
  };
  const load = async () => {
    try { rows = await linksForRecord(kind, recordId); paint(); } catch { node.hidden = true; }
  };
  paint();
  load();
  const stop = watchFiles(({ table, row }) => {
    if (!node.isConnected) { if (rows !== null) stop(); return; }
    if (table === 'file_links' && (!row || (row.kind === kind && row.record_id === recordId) || rows?.some((r) => r.id === row.id))) load();
  });
  return node;
}
