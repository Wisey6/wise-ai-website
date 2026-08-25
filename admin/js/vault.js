// Encrypted vault: PBKDF2-SHA256 -> AES-GCM-256, via WebCrypto.
// The passcode is never stored. Correctness is proven by the GCM auth tag:
// a wrong passcode derives a wrong key and decryption throws.

const ITERATIONS = 310000;
const KEY_LEN = 256;
const STORAGE_KEY = 'wiseai.hq.vault.v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Derive a non-extractable AES-GCM key from a passcode + salt. */
async function deriveKey(passcode, salt, iterations = ITERATIONS) {
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: KEY_LEN },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt a JSON-serialisable value into a self-describing envelope. */
async function seal(key, salt, iterations, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value))
  );
  return {
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct)
  };
}

/** Decrypt an envelope. Throws if the key is wrong or the payload was tampered with. */
async function open(key, envelope) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(envelope.iv) }, key, fromB64(envelope.ct)
  );
  return JSON.parse(dec.decode(plain));
}

export const Vault = {
  /** True once a vault exists in this browser. */
  exists() {
    return localStorage.getItem(STORAGE_KEY) !== null;
  },

  readEnvelope() {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },

  /** Create a brand-new vault around `data`. Returns the live session key. */
  async create(passcode, data) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passcode, salt);
    const envelope = await seal(key, salt, ITERATIONS, data);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    return { key, salt, iterations: ITERATIONS, data };
  },

  /**
   * Unlock the stored vault.
   * Resolves with the session on success; rejects with 'BAD_PASSCODE' otherwise.
   */
  async unlock(passcode) {
    const envelope = this.readEnvelope();
    if (!envelope) throw new Error('NO_VAULT');
    const salt = fromB64(envelope.salt);
    const iterations = envelope.iterations || ITERATIONS;
    const key = await deriveKey(passcode, salt, iterations);
    let data;
    try {
      data = await open(key, envelope);
    } catch {
      throw new Error('BAD_PASSCODE');
    }
    return { key, salt, iterations, data };
  },

  /** Re-seal `data` under an existing session key. */
  async save(session, data) {
    const envelope = await seal(session.key, session.salt, session.iterations, data);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  },

  /** Re-key the vault under a new passcode, keeping the data. */
  async rekey(passcode, data) {
    return this.create(passcode, data);
  },

  /** Destroy the local copy. The encrypted backup file, if any, is unaffected. */
  destroy() {
    localStorage.removeItem(STORAGE_KEY);
  },

  /** Encrypt `data` under a one-off passcode, for an offline backup file. */
  async exportEncrypted(passcode, data) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(passcode, salt);
    return seal(key, salt, ITERATIONS, data);
  },

  /** Decrypt a backup file produced by `exportEncrypted`. */
  async importEncrypted(passcode, envelope) {
    const salt = fromB64(envelope.salt);
    const key = await deriveKey(passcode, salt, envelope.iterations || ITERATIONS);
    try {
      return await open(key, envelope);
    } catch {
      throw new Error('BAD_PASSCODE');
    }
  }
};
