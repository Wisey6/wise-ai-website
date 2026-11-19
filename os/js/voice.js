// Voice input (dictation) for the assistant's composer: the browser's own speech
// recognition (SpeechRecognition / webkitSpeechRecognition), en-AU, words shown as they
// are heard. No dependency, no server, no cost; nothing is recorded by the hub. Speech is
// turned into text by the browser's speech service (Chrome and Edge send the audio to
// Google or Microsoft; Safari uses Apple's). Where the browser has none (Firefox), there is
// no microphone button and nothing else changes.
//
// While it listens: the words it is still unsure of show in a muted tone at the cursor and
// firm up as they are settled; dictated text goes in at the cursor and never replaces what
// was typed. It stops after SILENCE_MS without speech and leaves the text in the bar to
// check, or sends it when "Send when I stop talking" is on (per device, off by default).
// Ending with "send it" (or saying just "send") sends the message without those words.
// Errors give one calm line and never restart in a loop.

export const SILENCE_MS = 2500;
const AUTOSEND_KEY = 'wiseos.voice.autosend';
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
/** Hold to talk (a quick press toggles it on instead). Ctrl+Shift+J is Chrome's console. */
export const VOICE_SHORTCUT = IS_MAC ? '⌘⇧Space' : 'Ctrl Shift Space';
export const VOICE_PRIVACY = 'Speech is turned into text by your browser’s speech service.';

const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;
export const voiceSupported = () => Boolean(Recognition());

const MESSAGES = {
  'not-allowed': 'Microphone is blocked for this site. Allow it in the browser’s address bar.',
  'service-not-allowed': 'Microphone is blocked for this site. Allow it in the browser’s address bar.',
  'audio-capture': 'No microphone was found. Check it is plugged in and not used by another app.',
  network: 'The speech service could not be reached. Check your connection and try again.',
  'language-not-supported': 'This browser cannot take dictation in Australian English.'
};

const readAutosend = () => { try { return localStorage.getItem(AUTOSEND_KEY) === '1'; } catch { return false; } };
const writeAutosend = (v) => { try { localStorage.setItem(AUTOSEND_KEY, v ? '1' : '0'); } catch { /* private window: it just will not stick */ } };

/** Spoken punctuation, only for engines that leave it as words. Kept deliberately small. */
const SPOKEN = [[/\s*\b(?:full stop|period)\b/gi, '.'], [/\s*\bcomma\b/gi, ','], [/\s*\bquestion mark\b/gi, '?'], [/\s*\bnew (?:line|paragraph)\b\s*/gi, '\n']];
function tidy(t) {
  let s = String(t || '');
  for (const [re, p] of SPOKEN) s = s.replace(re, p);
  return s.replace(/[ \t]+/g, ' ').replace(/ ([.,?])/g, '$1');
}
const SEND_RE = /(?:^|[\s,.])(send it|send)[.!]?\s*$/i;

function micIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'icon' })) svg.setAttribute(k, v);
  const body = document.createElementNS(ns, 'rect');
  for (const [k, v] of Object.entries({ x: '9', y: '3', width: '6', height: '11', rx: '3', class: 'cx-mic-body' })) body.setAttribute(k, v);
  svg.append(body);
  for (const d of ['M5 11a7 7 0 0 0 14 0', 'M12 18v3']) { const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p); }
  return svg;
}

/**
 * Dictation for one composer.
 * box: the textarea · form: the composer form (it gets is-dictating and a 'cx-voice' event)
 * onInput(): after the text changed (draft saved, box grown) · submit(): send what is there
 * announce(text): the polite live region · active(): may this surface listen now
 * → { supported, button, menu, note, listening, start(), stop(), toggle() }
 */
export function voiceInput({ box, form, onInput = () => {}, submit = () => {}, announce = () => {}, active = () => true }) {
  const SR = Recognition();
  if (!SR) return { supported: false, button: null, note: null, listening: false, start() {}, stop() {}, toggle() {} };

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'cx-mic';
  button.dataset.act = 'chat-mic';
  button.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-label', 'Dictate');
  button.setAttribute('aria-haspopup', 'menu');
  button.title = `Dictate (hold ${VOICE_SHORTCUT}). Right-click for options. ${VOICE_PRIVACY}`;
  button.append(micIcon());

  // one calm line under or above the bar for problems
  const note = document.createElement('p');
  note.className = 'cx-voice-note';
  note.setAttribute('role', 'status');
  note.hidden = true;
  let noteTimer = 0;
  const say = (t) => {
    clearTimeout(noteTimer);
    note.textContent = t || '';
    note.hidden = !t;
    if (t) noteTimer = setTimeout(() => { note.hidden = true; }, 9000);
  };

  // the options: one switch, and the privacy line
  const menu = document.createElement('div');
  menu.className = 'cx-mic-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const opt = document.createElement('label');
  opt.className = 'cx-mic-opt';
  opt.setAttribute('role', 'menuitemcheckbox');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.dataset.act = 'voice-autosend';
  check.checked = readAutosend();
  opt.setAttribute('aria-checked', String(check.checked));
  opt.append(check, document.createTextNode('Send when I stop talking'));
  const priv = document.createElement('p');
  priv.className = 'cx-mic-priv';
  priv.textContent = `${VOICE_PRIVACY} Saved on this device only.`;
  menu.append(opt, priv);
  check.addEventListener('change', () => { writeAutosend(check.checked); opt.setAttribute('aria-checked', String(check.checked)); });
  const openMenu = () => { menu.hidden = false; check.focus({ preventScroll: true }); };
  const closeMenu = () => { menu.hidden = true; };
  button.addEventListener('contextmenu', (e) => { e.preventDefault(); if (menu.hidden) openMenu(); else closeMenu(); });
  menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); button.focus(); } });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && e.target !== button) closeMenu(); });
  // long-press (touch) opens the options too
  let pressTimer = 0; let pressed = false;
  button.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; pressed = false; pressTimer = setTimeout(() => { pressed = true; openMenu(); }, 520); });
  const cancelPress = () => clearTimeout(pressTimer);
  button.addEventListener('pointerup', cancelPress);
  button.addEventListener('pointerleave', cancelPress);

  // the muted words still being worked out, drawn over the textarea in step with it
  const ghost = document.createElement('div');
  ghost.className = 'cx-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.hidden = true;

  let rec = null;
  let want = false;        // the person wants it listening
  let errored = false;
  let pre = ''; let post = ''; let said = ''; let interim = '';
  let silence = 0; let lastStart = 0; let restarts = 0; let guard = 0;
  let sendNow = false;

  const setPressed = (on) => {
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', on ? 'Stop dictating' : 'Dictate');
    button.classList.toggle('is-on', on);
    form.classList.toggle('is-dictating', on);
    form.dispatchEvent(new CustomEvent('cx-voice', { bubbles: true, detail: { listening: on } }));
  };

  function syncGhost() {
    if (!interim) { ghost.hidden = true; box.classList.remove('has-interim'); return; }
    const host = ghost.parentElement;
    if (!host) return;
    const cs = getComputedStyle(box);
    for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'textIndent', 'wordSpacing', 'fontFeatureSettings']) ghost.style[k] = cs[k];
    ghost.style.left = `${box.offsetLeft}px`;
    ghost.style.top = `${box.offsetTop}px`;
    ghost.style.width = `${box.offsetWidth}px`;
    ghost.style.height = `${box.offsetHeight}px`;
    const head = pre + joinSaid();
    ghost.replaceChildren(document.createTextNode(head), Object.assign(document.createElement('span'), { className: 'cx-ghost-interim', textContent: interim }), document.createTextNode(post));
    ghost.scrollTop = box.scrollTop;
    ghost.hidden = false;
    box.classList.add('has-interim');
  }

  /** The settled words, spaced and capitalised to sit between what was there. */
  function joinSaid() {
    let t = tidy(said).trim();
    if (!t) return '';
    if (!pre.trim() || /[.?!]\s*$/.test(pre)) t = t[0].toUpperCase() + t.slice(1);
    const lead = pre && !/\s$/.test(pre) ? ' ' : '';
    const tail = post && !/^[\s.,?!]/.test(post) ? ' ' : '';
    return lead + t + tail;
  }
  function render() {
    const mid = joinSaid();
    const live = interim ? `${mid && !/\s$/.test(mid) ? ' ' : (pre && !/\s$/.test(pre) && !mid ? ' ' : '')}${interim}` : '';
    box.value = pre + mid + live + post;
    const caret = (pre + mid + live).length;
    try { box.setSelectionRange(caret, caret); } catch { /* not focused */ }
    onInput();
    syncGhost();
  }
  /** Take what is in the box now as the place to insert (the person may have typed). */
  function anchor() {
    // a textarea keeps its cursor while the microphone button has the focus
    const at = typeof box.selectionStart === 'number' ? box.selectionStart : box.value.length;
    pre = box.value.slice(0, at); post = box.value.slice(at); said = ''; interim = '';
  }
  function commit() {
    // fold the settled words into the text, so the next phrase starts after them
    pre = pre + joinSaid();
    said = '';
  }
  const armSilence = () => {
    clearTimeout(silence);
    silence = setTimeout(() => { if (want) finish(readAutosend() && box.value.trim()); }, SILENCE_MS);
  };

  function makeRec() {
    const r = new SR();
    r.lang = 'en-AU';
    r.interimResults = true;
    r.continuous = true;
    r.maxAlternatives = 1;
    r.onstart = () => { lastStart = Date.now(); armSilence(); };
    r.onresult = (e) => {
      if (r !== rec) return;
      let fin = ''; let mid = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0]?.transcript || '';
        if (res.isFinal) fin += t; else mid += t;
      }
      if (fin) {
        let f = fin.trim();
        const m = f.match(SEND_RE);
        // "… send it" at the end, or "send" on its own: send without those words
        if (m && (m[1].toLowerCase() === 'send it' || f.replace(/[.!]/g, '').trim().toLowerCase() === 'send')) { f = f.slice(0, m.index).trim(); sendNow = true; }
        said = `${said} ${f}`.trim();
        commit();
      }
      interim = mid.trim();
      render();
      armSilence();
      if (sendNow) { sendNow = false; finish(true); }
    };
    r.onerror = (e) => {
      if (r !== rec) return;
      const code = e.error || 'aborted';
      if (code === 'aborted') return;               // we stopped it, or the page did
      errored = true;
      if (code !== 'no-speech') say(MESSAGES[code] || 'Dictation stopped. Try again.');
      finish(false);
    };
    r.onend = () => {
      if (r !== rec) return;
      // Chrome ends a session by itself after a stretch of quiet: carry on if the person
      // still wants it (never after an error, and not in a tight loop).
      if (want && !errored && Date.now() - lastStart > 1200 && restarts < 6) {
        restarts++;
        try { r.start(); return; } catch { /* fall through */ }
      }
      if (want) finish(false);
    };
    return r;
  }

  function start() {
    if (want || !active()) return;
    if (!ghost.parentElement && box.parentElement) box.parentElement.append(ghost);
    say('');
    closeMenu();
    errored = false; restarts = 0;
    anchor();
    rec = makeRec();
    try { rec.start(); } catch { say('Dictation could not start. Try again.'); rec = null; return; }
    want = true;
    setPressed(true);
    announce('Listening');
    clearInterval(guard);
    // the lock screen, a hidden tab or a closed composer ends it
    guard = setInterval(() => { if (document.querySelector('.gate') || !box.isConnected || !box.getClientRects().length) stop(); }, 400);
  }
  /** End listening; `send`: send what is in the box. */
  function finish(send) {
    if (!want) return;
    want = false;
    clearTimeout(silence); clearInterval(guard);
    const r = rec; rec = null;
    try { r?.stop(); } catch { /* already stopped */ }
    if (interim) { said = `${said} ${interim}`.trim(); interim = ''; commit(); render(); } else syncGhost();
    setPressed(false);
    announce('Stopped');
    if (send && box.value.trim()) submit();
  }
  const stop = () => finish(false);
  const toggle = () => (want ? stop() : start());

  button.addEventListener('click', (e) => { if (pressed) { pressed = false; e.preventDefault(); return; } toggle(); box.focus({ preventScroll: true }); });
  box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && want) { e.preventDefault(); e.stopPropagation(); stop(); } });
  // typing while it listens: keep the typed text, carry on from the cursor
  box.addEventListener('input', (e) => { if (want && e.isTrusted) { interim = ''; anchor(); syncGhost(); } });
  box.addEventListener('scroll', () => { if (!ghost.hidden) ghost.scrollTop = box.scrollTop; }, { passive: true });
  form.addEventListener('submit', () => { if (want) { interim = ''; finish(false); } }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });

  /* hold to talk: Ctrl+Shift+Space (⌘⇧Space); a quick press leaves it on */
  let holdAt = 0;
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || !e.shiftKey || !(e.ctrlKey || e.metaKey) || e.altKey || e.repeat) return;
    if (!active()) return;
    e.preventDefault();
    if (want) { stop(); return; }
    holdAt = Date.now();
    form.dispatchEvent(new CustomEvent('cx-voice-shortcut', { bubbles: true }));
    box.focus({ preventScroll: true });
    start();
  });
  document.addEventListener('keyup', (e) => {
    if (!holdAt || !want) return;
    if (e.code === 'Space' || e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta') {
      const held = Date.now() - holdAt;
      holdAt = 0;
      if (held > 450) stop();
    }
  });

  return {
    supported: true, button, menu, note,
    get listening() { return want; },
    start, stop, toggle
  };
}
