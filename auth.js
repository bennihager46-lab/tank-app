'use strict';

/* =========================================================================
   Verschlüsselte Benutzerkonten
   -------------------------------------------------------------------------
   accounts.json liegt öffentlich im App-Repo. Es enthält KEINE Klartext-
   Tokens, sondern pro Benutzer:

     kw     = Benutzerschlüssel (UK), verschlüsselt mit dem Passwort
              (PBKDF2-SHA256 → AES-256-GCM)
     ka     = derselbe UK, verschlüsselt mit dem Admin-Schlüssel
              (damit Admins Passwörter zurücksetzen / Tokens erneuern können)
     vault  = Team-Zugang zum Daten-Repo {owner, repo, branch, folder, token},
              verschlüsselt mit UK
     admin  = nur bei Admins: {adminKey, appToken}, verschlüsselt mit UK

   Jeder Wert ist mit dem Benutzernamen als „additional data“ gebunden,
   sodass Blöcke nicht zwischen Konten vertauscht werden können.
   ========================================================================= */

const AUTH = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const PBKDF2_ITER = 600000;

  const b64 = (bytes) => {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

  async function deriveKey(password, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  }
  const importAes = (raw) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

  async function seal(key, bytes, aad) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, bytes);
    return `${b64(iv)}.${b64(ct)}`;
  }
  async function unseal(key, str, aad) {
    const [iv, ct] = String(str).split('.');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(aad) }, key, unb64(ct));
    return new Uint8Array(pt);
  }
  const sealJSON = (key, obj, aad) => seal(key, enc.encode(JSON.stringify(obj)), aad);
  const unsealJSON = async (key, str, aad) => JSON.parse(dec.decode(await unseal(key, str, aad)));

  async function setPassword(rec, uk, password) {
    const salt = rand(16);
    rec.salt = b64(salt);
    rec.iter = PBKDF2_ITER;
    rec.kw = await seal(await deriveKey(password, salt, PBKDF2_ITER), uk, `kw:${rec.username}`);
  }
  async function setVault(rec, uk, team) {
    rec.vault = await sealJSON(await importAes(uk), team, `vault:${rec.username}`);
  }
  async function setAdmin(rec, uk, adminPayload) {
    if (adminPayload) rec.admin = await sealJSON(await importAes(uk), adminPayload, `admin:${rec.username}`);
    else delete rec.admin;
  }

  /** Neues Konto. adminKey = Roh-Schlüssel (Uint8Array), team = Daten-Zugang, adminPayload nur für Admins. */
  async function createAccount({ username, name, role, personId, password }, adminKey, team, adminPayload) {
    const uk = rand(32);
    const rec = { username, name, role, personId, created: nowStampAuth() };
    await setPassword(rec, uk, password);
    rec.ka = await seal(await importAes(adminKey), uk, `ka:${username}`);
    await setVault(rec, uk, team);
    await setAdmin(rec, uk, role === 'admin' ? adminPayload : null);
    return rec;
  }

  /** Wirft einen Fehler, wenn das Passwort falsch ist. */
  async function ukFromPassword(rec, password) {
    const key = await deriveKey(password, unb64(rec.salt), rec.iter || PBKDF2_ITER);
    return unseal(key, rec.kw, `kw:${rec.username}`);
  }
  async function ukFromAdmin(rec, adminKey) {
    return unseal(await importAes(adminKey), rec.ka, `ka:${rec.username}`);
  }
  async function openAccount(rec, uk) {
    const key = await importAes(uk);
    const team = await unsealJSON(key, rec.vault, `vault:${rec.username}`);
    let admin = null;
    if (rec.role === 'admin' && rec.admin) {
      const a = await unsealJSON(key, rec.admin, `admin:${rec.username}`);
      admin = { adminKey: unb64(a.adminKey), appToken: a.appToken };
    }
    return { team, admin };
  }
  const adminPayload = (admin) => ({ adminKey: b64(admin.adminKey), appToken: admin.appToken });

  function nowStampAuth() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function generatePassword(len = 12) {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const r = rand(len);
    let s = '';
    for (let i = 0; i < len; i++) s += chars[r[i] % chars.length];
    return s;
  }

  return {
    b64, unb64, rand, createAccount, ukFromPassword, ukFromAdmin, openAccount,
    setPassword, setVault, setAdmin, adminPayload, generatePassword, PBKDF2_ITER,
  };
})();
