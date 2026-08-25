// Settings — backup, restore, passcode and the numbers that drive the targets.

import { el, icon, money, modal, field, input, toast, confirmDialog, dateLabel } from '../ui.js';
import { Vault } from '../vault.js';

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function pickFile() {
  return new Promise((resolve) => {
    const picker = el('input', { type: 'file', accept: 'application/json,.json' });
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
    picker.click();
  });
}

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

function row(title, description, control) {
  return el('div', {
    style: 'display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;padding:16px 0;border-bottom:1px solid rgba(184,189,194,.08)'
  },
    el('div', { style: 'flex:1;min-width:230px' },
      el('div', { style: 'font-weight:600;color:var(--platinum);margin-bottom:3px' }, title),
      el('div', { class: 'muted', style: 'font-size:12.5px;line-height:1.55' }, description)
    ),
    control
  );
}

export function settingsView(store, { onLock } = {}) {
  const d = store.data;
  const counts = {
    clients: d.clients.length, deals: d.deals.length, projects: d.projects.length,
    tasks: d.tasks.length, income: d.income.length,
    expenses: d.expenses.length, subscriptions: d.subscriptions.length
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  /* -------- handlers -------- */

  const exportPlain = () => {
    download(`wiseai-hq-${stamp()}.json`, JSON.stringify(d, null, 2));
    toast('Exported. This file is unencrypted — store it somewhere private.');
  };

  const exportEncrypted = async () => {
    const values = await modal({
      title: 'Encrypted backup',
      body: [
        el('p', { class: 'muted', style: 'font-size:13px;line-height:1.6' },
          'Wraps the whole vault in AES-GCM under a passcode of your choosing. Safe to store in a private repo or cloud drive.'),
        field('Backup passcode', input('passcode', { type: 'password', required: true, placeholder: 'At least 12 characters' }))
      ],
      confirmLabel: 'Download'
    });
    if (!values?.passcode) return;
    if (values.passcode.length < 8) return toast('Use at least 8 characters.', 'bad');
    const envelope = await Vault.exportEncrypted(values.passcode, d);
    download(`wiseai-hq-${stamp()}.enc.json`, JSON.stringify(envelope, null, 2));
    toast('Encrypted backup downloaded.');
  };

  const importFile = async () => {
    const text = await pickFile();
    if (!text) return;

    let payload;
    try { payload = JSON.parse(text); }
    catch { return toast('That file is not valid JSON.', 'bad'); }

    // Encrypted envelope? Ask for its passcode first.
    if (payload && payload.ct && payload.iv && payload.salt) {
      const values = await modal({
        title: 'Encrypted backup',
        body: [
          el('p', { class: 'muted', style: 'font-size:13px' }, 'This file is encrypted. Enter the passcode it was sealed with.'),
          field('Backup passcode', input('passcode', { type: 'password', required: true }))
        ],
        confirmLabel: 'Unlock & import'
      });
      if (!values?.passcode) return;
      try { payload = await Vault.importEncrypted(values.passcode, payload); }
      catch { return toast('Wrong passcode for that backup.', 'bad'); }
    }

    const ok = await confirmDialog('Replace everything?',
      'Importing overwrites the whole vault in this browser. Export a backup first if you are not sure.');
    if (!ok) return;

    await store.replaceAll(payload);
    toast('Vault imported.');
  };

  const changePasscode = async () => {
    const values = await modal({
      title: 'Change passcode',
      body: [
        el('p', { class: 'muted', style: 'font-size:13px;line-height:1.6' },
          'The vault is re-encrypted under the new passcode. There is no recovery — if you forget it, the data is gone.'),
        field('Current passcode', input('current', { type: 'password', required: true })),
        field('New passcode', input('next', { type: 'password', required: true, placeholder: 'At least 10 characters' })),
        field('Confirm new passcode', input('confirm', { type: 'password', required: true }))
      ],
      confirmLabel: 'Re-encrypt'
    });
    if (!values) return;
    if (values.next !== values.confirm) return toast('New passcodes do not match.', 'bad');
    if (values.next.length < 10) return toast('Use at least 10 characters.', 'bad');

    try { await Vault.unlock(values.current); }
    catch { return toast('Current passcode is wrong.', 'bad'); }

    const session = await Vault.rekey(values.next, store.data);
    store.session = session;
    toast('Passcode changed. The vault is re-encrypted.');
  };

  const wipe = async () => {
    const ok = await confirmDialog('Wipe this browser',
      'Deletes the encrypted vault from this browser only. Any exported backup file still works. This cannot be undone.');
    if (!ok) return;
    Vault.destroy();
    location.reload();
  };

  const setQuitLine = async () => {
    const values = await modal({
      title: 'Targets',
      body: [
        field('Quit line (AUD / month)',
          input('quitLine', { type: 'number', value: d.settings.quitLine, step: '50', required: true })),
        el('p', { class: 'muted', style: 'font-size:12.5px;line-height:1.55' },
          'The monthly net the business needs to clear before Wise AI replaces the day job.')
      ],
      confirmLabel: 'Save'
    });
    if (!values) return;
    await store.update((data) => ({
      ...data,
      settings: { ...data.settings, quitLine: Number(values.quitLine) || 0 }
    }));
    toast('Target updated.');
  };

  /* -------- render -------- */

  return el('div', {},
    el('section', { class: 'card section' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Vault')),
      el('div', { class: 'card-body' },
        el('div', {
          style: 'display:flex;gap:26px;flex-wrap:wrap;padding-bottom:16px;border-bottom:1px solid rgba(184,189,194,.08);margin-bottom:4px'
        },
          Object.entries(counts).map(([key, value]) => el('div', {},
            el('div', { class: 'num', style: 'font-size:19px' }, value),
            el('div', { class: 'eyebrow', style: 'margin-top:2px' }, key)
          ))
        ),

        row('Encrypted backup',
          'AES-GCM, sealed under a passcode you choose. This is the one that is safe to keep in a private repo.',
          el('button', { class: 'btn btn-primary btn-sm', onClick: exportEncrypted }, icon('download', 13), 'Download')),

        row('Plain JSON export',
          'Readable by anything. Convenient, but it is your full financials in the clear — keep it off shared drives.',
          el('button', { class: 'btn btn-ghost btn-sm', onClick: exportPlain }, icon('download', 13), 'Export')),

        row('Import',
          'Takes either format and replaces everything in this browser. Encrypted files will ask for their passcode.',
          el('button', { class: 'btn btn-ghost btn-sm', onClick: importFile }, icon('upload', 13), 'Choose file')),

        row('Quit line',
          `Currently ${money(d.settings.quitLine)} per month. Drives the progress meter on the Overview.`,
          el('button', { class: 'btn btn-ghost btn-sm', onClick: setQuitLine }, icon('target', 13), 'Change')),

        row('Passcode',
          'Re-encrypts the vault under a new passcode. No recovery path — write it down somewhere real.',
          el('button', { class: 'btn btn-ghost btn-sm', onClick: changePasscode }, icon('lock', 13), 'Change')),

        row('Lock now',
          'Drops the key from memory. The vault stays encrypted in this browser until you unlock it again.',
          el('button', { class: 'btn btn-ghost btn-sm', onClick: onLock }, icon('lock', 13), 'Lock')),

        el('div', { style: 'border-bottom:none' },
          row('Wipe this browser',
            'Deletes the local encrypted vault. Exported backups are unaffected.',
            el('button', { class: 'btn btn-danger btn-sm', onClick: wipe }, icon('trash', 13), 'Wipe')))
      )
    ),

    el('section', { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'How this is secured')),
      el('div', { class: 'card-body' },
        el('div', { class: 'muted', style: 'font-size:13px;line-height:1.75;display:flex;flex-direction:column;gap:12px' },
          el('p', {}, el('strong', { style: 'color:var(--platinum)' }, 'Your data never leaves this browser. '),
            'There is no server and no database. Everything you enter is encrypted with AES-GCM-256 under a key derived from your passcode (PBKDF2-SHA256, 310,000 iterations) and written to this browser\'s local storage. The passcode itself is never stored anywhere.'),
          el('p', {}, el('strong', { style: 'color:var(--platinum)' }, 'What that does and does not protect. '),
            'Someone with access to this machine cannot read the vault without the passcode. But this is a static page on a public site — the code is readable by anyone, and the gate is enforced by your browser, not by a server. Treat it as a private notebook with a good lock, not as a system with server-side access control.'),
          el('p', {}, el('strong', { style: 'color:var(--platinum)' }, 'Back it up. '),
            'Clearing site data, a browser reset, or a new device all start you from an empty vault. The encrypted export is the backup — take one after any significant update.'),
          el('p', { class: 'dim', style: 'font-size:12px' },
            `Vault last updated ${dateLabel(d.meta.updated)} · ${total} records`)
        )
      )
    )
  );
}
