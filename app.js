'use strict';

/* =========================================================================
   Tank-App – Maschinen, Nutzer und Tankvorgänge als CSV-Dateien in einem
   (privaten) GitHub-Repository. Anmeldung per Benutzername + Passwort;
   der Team-Token liegt verschlüsselt in accounts.json (siehe auth.js).
   ========================================================================= */

const FILES = {
  entries: 'tankvorgaenge.csv',
  machines: 'maschinen.csv',
  users: 'nutzer.csv',
};
const COLUMNS = {
  entries: ['id', 'zeitstempel', 'maschine_id', 'maschine', 'person_id', 'person', 'diesel_liter', 'adblue_liter', 'notiz'],
  machines: ['id', 'name', 'typ', 'kennzeichen', 'notiz', 'erstellt'],
  users: ['id', 'name', 'erstellt'],
};
const NUMERIC = new Set(['diesel_liter', 'adblue_liter']);
const DELIM = ';'; // Semikolon: öffnet sich in deutschem Excel direkt korrekt
const SESSION_KEY = 'tankapp:session';
const LAST_PERSON_KEY = 'tankapp:lastPerson';
const ACCOUNTS_PATH = 'accounts.json';
const MIN_PW = 10;
const DEMO = new URLSearchParams(location.search).has('demo');
const APP_REPO = detectAppRepo();

function detectAppRepo() {
  // Auf GitHub Pages: https://<owner>.github.io/<repo>/
  if (location.hostname.endsWith('.github.io')) {
    const owner = location.hostname.split('.')[0];
    const repo = location.pathname.split('/').filter(Boolean)[0] || location.hostname;
    return { owner, repo, branch: 'main' };
  }
  return { owner: 'bennihager46-lab', repo: 'tank-app', branch: 'main' };
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const store = {
  get(key, fallback = null, area = localStorage) {
    try { const v = area.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
  },
  set(key, value, area = localStorage) { try { area.setItem(key, value); } catch { /* ignore */ } },
  del(key) { try { localStorage.removeItem(key); sessionStorage.removeItem(key); } catch { /* ignore */ } },
};

/* ---------------------------- Hilfsfunktionen ---------------------------- */

const pad = (n) => String(n).padStart(2, '0');
function nowStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || '');
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}
function uid() {
  if (crypto.randomUUID) return crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}
function parseNum(v) {
  if (v === null || v === undefined) return 0;
  const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
  if (s === '') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const fmtL = (n) => `${nf.format(n)} L`;
function fmtCompact(n) {
  if (Math.abs(n) >= 10000) return `${nf.format(Math.round(n / 100) / 10)} Tsd. L`;
  return `${nf0.format(n)} L`;
}
function fmtDate(s) {
  const d = parseStamp(s);
  if (!d) return s || '';
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const collator = new Intl.Collator('de', { sensitivity: 'base' });
const normUser = (s) => String(s || '').trim().toLowerCase();
const validUser = (s) => /^[a-z0-9._-]{3,30}$/.test(s);

/* ---------------------------------- CSV --------------------------------- */

function parseCSV(text) {
  text = (text || '').replace(/^﻿/, '');
  if (!text.trim()) return [];
  const nl = text.indexOf('\n');
  const firstLine = nl === -1 ? text : text.slice(0, nl);
  const delim = (firstLine.split(';').length >= firstLine.split(',').length) ? ';' : ',';
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((f) => f !== ''));
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => {
    const o = {};
    keys.forEach((k, i) => { o[k] = r[i] ?? ''; });
    return o;
  });
}

function csvField(v) {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(kind, rows) {
  const cols = COLUMNS[kind];
  const lines = [cols.join(DELIM)];
  for (const r of rows) {
    lines.push(cols.map((c) => {
      let v = r[c];
      if (NUMERIC.has(c)) v = Number(v || 0) ? String(Math.round(Number(v) * 100) / 100).replace('.', ',') : '0';
      return csvField(v);
    }).join(DELIM));
  }
  return '﻿' + lines.join('\r\n') + '\r\n';
}
function normalize(kind, rows) {
  return rows.map((r) => {
    const o = {};
    for (const c of COLUMNS[kind]) o[c] = NUMERIC.has(c) ? (parseNum(r[c]) || 0) : (r[c] ?? '').trim();
    if (!o.id) o.id = uid();
    return o;
  });
}

/* ------------------------------ GitHub-Zugriff --------------------------- */

class ConflictError extends Error {}

function b64EncodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64DecodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function GitHubClient({ owner, repo, branch, token }) {
  const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  branch = branch || 'main';
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function ghFetch(url, opts = {}) {
    try {
      return await fetch(url, { cache: 'no-store', ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    } catch {
      throw new Error('Keine Verbindung zu GitHub (offline?).');
    }
  }
  async function errorFrom(res) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
    if (res.status === 401) return new Error(`Token für ${owner}/${repo} ungültig oder abgelaufen – bitte Admin informieren.`);
    if (res.status === 403) return new Error(`Kein Zugriff auf ${owner}/${repo}. ${msg}`);
    if (res.status === 404) return new Error(`${owner}/${repo} (Branch „${branch}“) nicht gefunden oder kein Zugriff.`);
    return new Error(`GitHub-Fehler ${res.status}: ${msg}`);
  }

  return {
    label: `${owner}/${repo}`,
    async getFile(path) {
      const res = await ghFetch(`${api}/contents/${path}?ref=${encodeURIComponent(branch)}&t=${Date.now()}`);
      if (res.status === 404) return { text: '', sha: null };
      if (!res.ok) throw await errorFrom(res);
      const json = await res.json();
      let text = '';
      if (json.content) text = b64DecodeUtf8(json.content);
      else if (json.sha) {
        // Dateien > 1 MB: Inhalt über die Blob-API laden
        const blob = await ghFetch(`${api}/git/blobs/${json.sha}`);
        if (!blob.ok) throw await errorFrom(blob);
        text = b64DecodeUtf8((await blob.json()).content || '');
      }
      return { text, sha: json.sha };
    },
    async putFile(path, text, sha, message) {
      const body = { message, content: b64EncodeUtf8(text), branch };
      if (sha) body.sha = sha;
      const res = await ghFetch(`${api}/contents/${path}`, {
        method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
      });
      if (res.status === 409 || res.status === 422) throw new ConflictError('Datei wurde zwischenzeitlich geändert');
      if (!res.ok) throw await errorFrom(res);
      return (await res.json()).content.sha;
    },
    /**
     * Prüft, ob der TOKEN (nicht das Konto) in dieses Repo schreiben darf.
     * Die Repo-Abfrage liefert bei Fine-grained-Tokens die Rechte des Kontos,
     * deshalb ein Schreibversuch mit absichtlich falscher Versionsnummer (sha):
     * erlaubt → 409 (nichts wird geändert), nicht erlaubt → 403/404.
     * Rückgabe: true / false / null (Repo leer, nicht prüfbar).
     */
    async canPush() {
      const list = await ghFetch(`${api}/contents/?ref=${encodeURIComponent(branch)}&t=${Date.now()}`);
      if (list.status === 404) {
        const repoRes = await ghFetch(api);
        if (!repoRes.ok) throw await errorFrom(repoRes);
        return null; // Repo existiert, ist aber leer
      }
      if (!list.ok) throw await errorFrom(list);
      const items = await list.json();
      const file = Array.isArray(items) && items.find((x) => x.type === 'file');
      if (!file) return null;
      const res = await ghFetch(`${api}/contents/${file.path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Tank-App: Berechtigungstest', content: '', sha: '0'.repeat(40), branch }),
      });
      if (res.status === 409 || res.status === 422) return true;
      if (res.status === 403 || res.status === 404) return false;
      if (res.status === 401) throw await errorFrom(res);
      return res.ok;
    },
  };
}

function DataBackend(team) {
  const gh = GitHubClient(team);
  const folder = (team.folder || '').replace(/^\/+|\/+$/g, '');
  const pathOf = (kind) => (folder ? `${folder}/` : '') + FILES[kind];
  return {
    label: gh.label,
    load: (kind) => gh.getFile(pathOf(kind)),
    save: (kind, text, sha) => gh.putFile(pathOf(kind), text, sha, `Tank-App: ${FILES[kind]} (${state.user?.username || '?'}, ${nowStamp()})`),
  };
}

const LocalBackend = {
  label: 'Demo (dieser Browser)',
  async load(kind) { return { text: store.get('tankapp:demo:csv:' + kind, ''), sha: null }; },
  async save(kind, text) { store.set('tankapp:demo:csv:' + kind, text); return null; },
};

/* --------------------------------- Konten ------------------------------- */

const emptyAccounts = () => ({ version: 1, accounts: [] });

async function fetchAccountsPublic() {
  if (DEMO) {
    try { return JSON.parse(store.get('tankapp:demo:accounts', 'null')); } catch { return null; }
  }
  const { owner, repo, branch } = APP_REPO;
  const urls = [
    `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${ACCOUNTS_PATH}?t=${Date.now()}`,
    `./${ACCOUNTS_PATH}?t=${Date.now()}`,
  ];
  let failed = false;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (res.status === 404) continue;
      if (!res.ok) { failed = true; continue; }
      return JSON.parse(await res.text());
    } catch { failed = true; }
  }
  if (failed) throw new Error('Benutzerliste konnte nicht geladen werden (offline?).');
  return null;
}

/** Lesen → ändern → schreiben von accounts.json (nur mit Admin-Token). */
async function mutateAccounts(fn, appToken = state.admin?.appToken) {
  if (DEMO) {
    const file = (await fetchAccountsPublic()) || emptyAccounts();
    await fn(file);
    store.set('tankapp:demo:accounts', JSON.stringify(file));
    state.accounts = file;
    return;
  }
  const gh = GitHubClient({ ...APP_REPO, token: appToken });
  for (let attempt = 0; attempt < 4; attempt++) {
    const { text, sha } = await gh.getFile(ACCOUNTS_PATH);
    const file = text ? JSON.parse(text) : emptyAccounts();
    await fn(file);
    try {
      await gh.putFile(ACCOUNTS_PATH, JSON.stringify(file, null, 2) + '\n', sha, `Tank-App: Benutzer aktualisiert (${state.user?.username || 'setup'})`);
      state.accounts = file;
      return;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
    }
  }
  throw new Error('Speichern der Benutzer fehlgeschlagen – bitte erneut versuchen.');
}

function saveSession(username, uk, remember) {
  store.del(SESSION_KEY);
  store.set(SESSION_KEY, JSON.stringify({ username, uk: AUTH.b64(uk) }), remember ? localStorage : sessionStorage);
}
function readSession() {
  const raw = store.get(SESSION_KEY, null, localStorage) || store.get(SESSION_KEY, null, sessionStorage);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/* --------------------------------- Zustand ------------------------------ */

const state = {
  backend: LocalBackend,
  data: { entries: [], machines: [], users: [] },
  accounts: emptyAccounts(),
  user: null,   // { username, name, role, personId }
  uk: null,     // Benutzerschlüssel (Uint8Array)
  team: null,   // Zugang Daten-Repo
  admin: null,  // { adminKey, appToken } – nur Admins
  measure: 'diesel',
  showAll: false,
};
const isAdmin = () => state.user?.role === 'admin';

/* Lesen → Ändern → Schreiben. Bei Konflikt (jemand anderes hat gleichzeitig
   gespeichert) wird die neueste Version erneut geladen und die Änderung neu angewendet. */
async function mutate(kind, fn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { text, sha } = await state.backend.load(kind);
    const rows = normalize(kind, parseCSV(text));
    const result = fn(rows);
    try {
      await state.backend.save(kind, toCSV(kind, rows), sha);
      state.data[kind] = rows;
      return result;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
    }
  }
  throw new Error('Speichern fehlgeschlagen – bitte erneut versuchen.');
}

async function loadAll() {
  const kinds = Object.keys(FILES);
  const results = await Promise.all(kinds.map((k) => state.backend.load(k)));
  kinds.forEach((k, i) => { state.data[k] = normalize(k, parseCSV(results[i].text)); });
}

/* ------------------------------ UI-Grundlagen ---------------------------- */

let busyCount = 0;
let lastError = '';
async function withBusy(fn, okMsg, { quiet = false } = {}) {
  busyCount++;
  const t = setTimeout(() => { if (busyCount) $('#busy').hidden = false; }, 250);
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    setSync(true);
    return r ?? true;
  } catch (e) {
    console.error(e);
    lastError = e.message || String(e);
    if (!quiet) toast(lastError, true);
    setSync(false, e.message);
    return undefined;
  } finally {
    clearTimeout(t);
    if (--busyCount === 0) $('#busy').hidden = true;
  }
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 6000 : 2400);
}
function setSync(ok, msg) {
  const el = $('#syncStatus');
  if (!state.user) return;
  el.textContent = ok ? state.user.name : 'Sync-Fehler';
  el.title = ok ? `Angemeldet als ${state.user.name} · Daten: ${state.backend.label}` : (msg || 'Fehler');
  el.classList.toggle('err', !ok);
}
/** Eigene Bestätigungsabfrage – das native confirm() wird in manchen
    Browsern/Web-Apps nicht angezeigt und liefert dann still „Abbrechen“. */
function confirmDialog(text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    const dlg = $('#confirmDialog');
    $('#confirmText').textContent = text;
    const ok = $('#confirmOk');
    ok.textContent = okLabel;
    ok.classList.toggle('danger-fill', danger);
    dlg.returnValue = '';
    dlg.onclose = () => resolve(dlg.returnValue === 'ok');
    dlg.showModal();
    ok.focus();
  });
}
function formMsg(form, text, ok = false) {
  const el = $('.form-msg', form);
  el.textContent = text;
  el.classList.toggle('ok', ok);
}

function showTab(name) {
  if (!$(`#tab-${name}`) || (name === 'benutzer' && !isAdmin())) name = 'tanken';
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  $$('.tabbar button').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (location.hash !== `#${name}`) history.replaceState(null, '', `${location.pathname}${location.search}#${name}`);
  window.scrollTo(0, 0);
  if (name === 'statistik') renderStats();
}

const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 0 0 0-1.41l-2.33-2.33a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>';
const ICON_DEL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>';
const actions = (kind, id, { edit = true, del = true } = {}) => `
  <div class="item-actions">
    ${edit ? `<button type="button" data-edit-${kind}="${esc(id)}" aria-label="Bearbeiten" title="Bearbeiten">${ICON_EDIT}</button>` : ''}
    ${del ? `<button type="button" class="del" data-del-${kind}="${esc(id)}" aria-label="Löschen" title="Löschen">${ICON_DEL}</button>` : ''}
  </div>`;

function sortedMachines() { return [...state.data.machines].sort((a, b) => collator.compare(a.name, b.name)); }
function sortedUsers() { return [...state.data.users].sort((a, b) => collator.compare(a.name, b.name)); }

function fillSelect(sel, items, placeholder, selected, labelFn = (x) => x.name) {
  sel.innerHTML = `<option value="" disabled ${selected ? '' : 'selected'}>${esc(placeholder)}</option>` +
    items.map((x) => `<option value="${esc(x.id)}" ${x.id === selected ? 'selected' : ''}>${esc(labelFn(x))}</option>`).join('');
}
const machineLabel = (m) => m.name + (m.kennzeichen ? ` (${m.kennzeichen})` : '') + (m.typ && m.typ !== 'Maschine' ? ` · ${m.typ}` : '');

function renderAll() {
  renderTanken();
  renderMachines();
  renderAccounts();
  renderKonto();
  if ($('#tab-statistik').classList.contains('active')) renderStats();
}

/* --------------------------------- Tanken -------------------------------- */

function canEditEntry(e) { return isAdmin() || e.person_id === state.user.personId; }

function renderTanken() {
  const machines = sortedMachines();
  const users = sortedUsers();
  const mSel = $('#tankMachine');
  const keepM = mSel.value;
  fillSelect(mSel, machines, 'Bitte wählen …', machines.some((m) => m.id === keepM) ? keepM : '', machineLabel);
  $('#tankAs').textContent = state.user.name;
  if (isAdmin()) {
    const pSel = $('#tankPerson');
    const keepP = pSel.value || store.get(LAST_PERSON_KEY, '') || state.user.personId;
    fillSelect(pSel, users, 'Bitte wählen …', users.some((u) => u.id === keepP) ? keepP : '');
  }

  const hint = $('#tankHint');
  hint.hidden = machines.length > 0;
  hint.innerHTML = isAdmin()
    ? 'Bevor getankt werden kann: <a href="#maschinen">Maschinen anlegen</a>.'
    : 'Es sind noch keine Maschinen angelegt – bitte einen Admin fragen.';

  const mine = isAdmin() ? state.data.entries : state.data.entries.filter((e) => e.person_id === state.user.personId);
  $('#entryListTitle').textContent = isAdmin() ? 'Letzte Tankvorgänge' : 'Meine letzten Tankvorgänge';
  const entries = [...mine].sort((a, b) => b.zeitstempel.localeCompare(a.zeitstempel));
  const shown = state.showAll ? entries : entries.slice(0, 15);
  $('#showAllEntries').hidden = entries.length <= 15;
  $('#showAllEntries').textContent = state.showAll ? 'Weniger anzeigen' : `Alle anzeigen (${entries.length})`;
  const list = $('#entryList');
  if (!entries.length) {
    list.innerHTML = '<li class="empty">Noch keine Tankvorgänge.</li>';
    return;
  }
  list.innerHTML = shown.map((e) => `
    <li class="item">
      <div class="item-main">
        <div class="item-title">${esc(e.maschine)}</div>
        <div class="item-sub">${esc(fmtDate(e.zeitstempel))}${isAdmin() ? ' · ' + esc(e.person) : ''}${e.notiz ? ' · ' + esc(e.notiz) : ''}</div>
      </div>
      <div class="amounts">
        ${e.diesel_liter ? `<div class="d">${fmtL(e.diesel_liter)}</div>` : ''}
        ${e.adblue_liter ? `<div class="a">${fmtL(e.adblue_liter)}</div>` : ''}
      </div>
      ${canEditEntry(e) ? actions('entry', e.id) : ''}
    </li>`).join('');
}

async function submitTank(ev) {
  ev.preventDefault();
  const m = state.data.machines.find((x) => x.id === $('#tankMachine').value);
  let p;
  if (isAdmin()) p = state.data.users.find((x) => x.id === $('#tankPerson').value);
  else p = { id: state.user.personId, name: state.user.name };
  const diesel = parseNum($('#tankDiesel').value);
  const adblue = parseNum($('#tankAdblue').value);
  if (!m) return toast('Bitte eine Maschine auswählen.', true);
  if (!p) return toast('Bitte die tankende Person auswählen.', true);
  if (Number.isNaN(diesel) || Number.isNaN(adblue) || diesel < 0 || adblue < 0) return toast('Bitte gültige Literangaben eingeben.', true);
  if (!diesel && !adblue) return toast('Bitte Diesel und/oder AdBlue eintragen.', true);

  const entry = {
    id: uid(), zeitstempel: nowStamp(),
    maschine_id: m.id, maschine: m.name, person_id: p.id, person: p.name,
    diesel_liter: diesel, adblue_liter: adblue, notiz: $('#tankNote').value.trim(),
  };
  const ok = await withBusy(() => mutate('entries', (rows) => { rows.push(entry); }), 'Tankvorgang gespeichert ✓');
  if (ok) {
    if (isAdmin()) store.set(LAST_PERSON_KEY, p.id);
    $('#tankDiesel').value = '';
    $('#tankAdblue').value = '';
    $('#tankNote').value = '';
    $('#tankMachine').value = '';
    renderAll();
  }
}

function toLocalInput(s) {
  const d = parseStamp(s) || new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function editEntry(id) {
  const e = state.data.entries.find((x) => x.id === id);
  if (!e || !canEditEntry(e)) return;
  const dlg = $('#entryDialog');
  const f = $('#entryForm');
  const machines = sortedMachines();
  const users = isAdmin() ? sortedUsers() : [{ id: state.user.personId, name: state.user.name }];
  // Gelöschte Maschine/Person trotzdem auswählbar halten
  if (!machines.some((m) => m.id === e.maschine_id)) machines.unshift({ id: e.maschine_id, name: e.maschine + ' (gelöscht)' });
  if (!users.some((u) => u.id === e.person_id)) users.unshift({ id: e.person_id, name: e.person + ' (gelöscht)' });
  fillSelect(f.maschine_id, machines, 'Bitte wählen …', e.maschine_id, (m) => m.typ ? machineLabel(m) : m.name);
  fillSelect(f.person_id, users, 'Bitte wählen …', e.person_id);
  f.person_id.disabled = !isAdmin();
  f.zeitstempel.value = toLocalInput(e.zeitstempel);
  f.diesel.value = e.diesel_liter ? String(e.diesel_liter).replace('.', ',') : '';
  f.adblue.value = e.adblue_liter ? String(e.adblue_liter).replace('.', ',') : '';
  f.notiz.value = e.notiz;
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const diesel = parseNum(f.diesel.value);
    const adblue = parseNum(f.adblue.value);
    if (Number.isNaN(diesel) || Number.isNaN(adblue) || diesel < 0 || adblue < 0) return toast('Ungültige Literangabe – nicht gespeichert.', true);
    const mId = f.maschine_id.value;
    const pId = isAdmin() ? f.person_id.value : e.person_id;
    const mName = state.data.machines.find((m) => m.id === mId)?.name ?? e.maschine;
    const pName = state.data.users.find((u) => u.id === pId)?.name ?? e.person;
    const stamp = f.zeitstempel.value.replace('T', ' ') + (f.zeitstempel.value.length === 16 ? ':00' : '');
    await withBusy(() => mutate('entries', (rows) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error('Eintrag wurde inzwischen gelöscht.');
      if (!canEditEntry(r)) throw new Error('Keine Berechtigung für diesen Eintrag.');
      Object.assign(r, { zeitstempel: stamp, maschine_id: mId, maschine: mName, person_id: pId, person: pName, diesel_liter: diesel, adblue_liter: adblue, notiz: f.notiz.value.trim() });
    }), 'Tankvorgang aktualisiert');
    renderAll();
  };
  dlg.returnValue = '';
  dlg.showModal();
}

async function deleteEntry(id) {
  const e = state.data.entries.find((x) => x.id === id);
  if (!e || !canEditEntry(e) || !(await confirmDialog(`Tankvorgang „${e.maschine}“ vom ${fmtDate(e.zeitstempel)} löschen?`, 'Löschen', true))) return;
  await withBusy(() => mutate('entries', (rows) => {
    const i = rows.findIndex((x) => x.id === id && canEditEntry(x));
    if (i >= 0) rows.splice(i, 1);
  }), 'Tankvorgang gelöscht');
  renderAll();
}

/* -------------------------------- Maschinen ------------------------------ */

function renderMachines() {
  const list = $('#machineList');
  const ms = sortedMachines();
  if (!ms.length) { list.innerHTML = '<li class="empty">Noch keine Maschinen oder Autos angelegt.</li>'; return; }
  const totals = {};
  for (const e of state.data.entries) {
    const t = (totals[e.maschine_id] ||= { d: 0, a: 0, n: 0 });
    t.d += e.diesel_liter; t.a += e.adblue_liter; t.n++;
  }
  list.innerHTML = ms.map((m) => {
    const t = totals[m.id] || { d: 0, a: 0, n: 0 };
    const sub = [m.kennzeichen, m.notiz, `${t.n} Tankvorgänge`].filter(Boolean).map(esc).join(' · ');
    return `
    <li class="item">
      <div class="item-main">
        <div class="item-title">${esc(m.name)}<span class="tag">${esc(m.typ || 'Maschine')}</span></div>
        <div class="item-sub">${sub}</div>
      </div>
      <div class="amounts">
        ${t.d ? `<div class="d">${fmtL(t.d)}</div>` : ''}
        ${t.a ? `<div class="a">${fmtL(t.a)}</div>` : ''}
      </div>
      ${isAdmin() ? actions('machine', m.id) : ''}
    </li>`;
  }).join('');
}

function openMachineDialog(id) {
  if (!isAdmin()) return;
  const m = id ? state.data.machines.find((x) => x.id === id) : null;
  const dlg = $('#machineDialog');
  const f = $('#machineForm');
  $('#machineDialogTitle').textContent = m ? 'Maschine bearbeiten' : 'Maschine / Auto anlegen';
  f.elements.name.value = m?.name || '';
  f.typ.value = m?.typ || 'Maschine';
  f.kennzeichen.value = m?.kennzeichen || '';
  f.notiz.value = m?.notiz || '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const vals = { name: f.elements.name.value.trim(), typ: f.typ.value, kennzeichen: f.kennzeichen.value.trim(), notiz: f.notiz.value.trim() };
    if (!vals.name) return;
    const dupe = state.data.machines.some((x) => x.id !== id && collator.compare(x.name, vals.name) === 0 && x.kennzeichen === vals.kennzeichen);
    if (dupe && !(await confirmDialog(`„${vals.name}“ gibt es schon. Trotzdem speichern?`, 'Speichern'))) return;
    if (!m) {
      await withBusy(() => mutate('machines', (rows) => { rows.push({ id: uid(), ...vals, erstellt: nowStamp() }); }), 'Maschine angelegt');
    } else {
      const renamed = m.name !== vals.name;
      await withBusy(async () => {
        await mutate('machines', (rows) => {
          const r = rows.find((x) => x.id === id);
          if (!r) throw new Error('Maschine wurde inzwischen gelöscht.');
          Object.assign(r, vals);
        });
        // Namen auch in den Tankvorgängen nachziehen, damit die CSV lesbar bleibt
        if (renamed) await mutate('entries', (rows) => { rows.forEach((e) => { if (e.maschine_id === id) e.maschine = vals.name; }); });
      }, 'Maschine gespeichert');
    }
    renderAll();
  };
  dlg.returnValue = '';
  dlg.showModal();
  f.elements.name.focus();
}

async function deleteMachine(id) {
  const m = state.data.machines.find((x) => x.id === id);
  if (!m || !isAdmin()) return;
  const n = state.data.entries.filter((e) => e.maschine_id === id).length;
  const msg = `„${m.name}“ löschen?` + (n ? `\n\nDie ${n} Tankvorgänge dieser Maschine bleiben erhalten.` : '');
  if (!(await confirmDialog(msg, 'Löschen', true))) return;
  await withBusy(() => mutate('machines', (rows) => {
    const i = rows.findIndex((x) => x.id === id);
    if (i >= 0) rows.splice(i, 1);
  }), 'Maschine gelöscht');
  renderAll();
}

/* ------------------------------ Benutzer (Admin) ------------------------- */

function renderAccounts() {
  if (!isAdmin()) return;
  const list = $('#accountList');
  const accs = [...state.accounts.accounts].sort((a, b) => collator.compare(a.name, b.name));
  const totals = {};
  for (const e of state.data.entries) {
    const t = (totals[e.person_id] ||= { d: 0, a: 0, n: 0 });
    t.d += e.diesel_liter; t.a += e.adblue_liter; t.n++;
  }
  list.innerHTML = accs.map((a) => {
    const t = totals[a.personId] || { d: 0, a: 0, n: 0 };
    const self = a.username === state.user.username;
    return `
    <li class="item">
      <div class="item-main">
        <div class="item-title">${esc(a.name)}<span class="tag ${a.role === 'admin' ? 'admin' : ''}">${a.role === 'admin' ? 'Admin' : 'Nutzer'}</span></div>
        <div class="item-sub">@${esc(a.username)}${self ? ' · du' : ''} · ${t.n} Tankvorgänge</div>
      </div>
      <div class="amounts">
        ${t.d ? `<div class="d">${fmtL(t.d)}</div>` : ''}
        ${t.a ? `<div class="a">${fmtL(t.a)}</div>` : ''}
      </div>
      ${actions('account', a.username, { del: !self })}
    </li>`;
  }).join('');
}

async function createAccount(ev) {
  ev.preventDefault();
  const f = ev.target;
  const name = f.elements.name.value.trim();
  const username = normUser(f.username.value);
  const password = f.password.value;
  const role = f.role.value;
  if (!validUser(username)) return toast('Benutzername: 3–30 Zeichen, nur a–z, 0–9, Punkt, Minus, Unterstrich.', true);
  if (password.length < MIN_PW) return toast(`Das Passwort muss mindestens ${MIN_PW} Zeichen haben.`, true);
  if (state.accounts.accounts.some((a) => a.username === username)) return toast(`Den Benutzernamen „${username}“ gibt es schon.`, true);
  const personId = uid();
  const ok = await withBusy(async () => {
    const rec = await AUTH.createAccount({ username, name, role, personId, password }, state.admin.adminKey, state.team, AUTH.adminPayload(state.admin));
    await mutateAccounts((file) => {
      if (file.accounts.some((a) => a.username === username)) throw new Error(`Den Benutzernamen „${username}“ gibt es schon.`);
      file.accounts.push(rec);
    });
    await mutate('users', (rows) => { rows.push({ id: personId, name, erstellt: nowStamp() }); });
  }, `${name} angelegt – Benutzername und Passwort weitergeben.`);
  if (ok) {
    f.reset();
    renderAll();
  }
}

function editAccount(username) {
  const a = state.accounts.accounts.find((x) => x.username === username);
  if (!a) return;
  const dlg = $('#accountDialog');
  const f = $('#accountEditForm');
  const self = a.username === state.user.username;
  $('#accountEditUser').textContent = `@${a.username}`;
  f.elements.name.value = a.name;
  f.role.value = a.role;
  f.role.disabled = self; // eigene Admin-Rechte nicht versehentlich entziehen
  f.password.value = '';
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const name = f.elements.name.value.trim() || a.name;
    const role = self ? a.role : f.role.value;
    const password = f.password.value;
    if (password && password.length < MIN_PW) return toast(`Das Passwort muss mindestens ${MIN_PW} Zeichen haben.`, true);
    const renamed = name !== a.name;
    await withBusy(async () => {
      await mutateAccounts(async (file) => {
        const rec = file.accounts.find((x) => x.username === username);
        if (!rec) throw new Error('Benutzer wurde inzwischen gelöscht.');
        const uk = await AUTH.ukFromAdmin(rec, state.admin.adminKey);
        rec.name = name;
        if (password) await AUTH.setPassword(rec, uk, password);
        if (role !== rec.role) {
          rec.role = role;
          await AUTH.setAdmin(rec, uk, role === 'admin' ? AUTH.adminPayload(state.admin) : null);
        }
      });
      if (renamed) {
        await mutate('users', (rows) => {
          const r = rows.find((u) => u.id === a.personId);
          if (r) r.name = name; else rows.push({ id: a.personId, name, erstellt: nowStamp() });
        });
        await mutate('entries', (rows) => { rows.forEach((e) => { if (e.person_id === a.personId) e.person = name; }); });
        if (self) state.user.name = name;
      }
    }, password ? 'Gespeichert – neues Passwort weitergeben.' : 'Benutzer gespeichert');
    renderAll();
  };
  dlg.returnValue = '';
  dlg.showModal();
}

async function deleteAccount(username) {
  const a = state.accounts.accounts.find((x) => x.username === username);
  if (!a || a.username === state.user.username) return;
  if (!(await confirmDialog(`Benutzer „${a.name}“ (@${a.username}) löschen?\n\nSeine Tankvorgänge bleiben in der Statistik erhalten.`, 'Löschen', true))) return;
  const ok = await withBusy(async () => {
    await mutateAccounts((file) => { file.accounts = file.accounts.filter((x) => x.username !== username); });
    await mutate('users', (rows) => {
      const i = rows.findIndex((u) => u.id === a.personId);
      if (i >= 0) rows.splice(i, 1);
    });
  }, 'Benutzer gelöscht');
  if (ok && !DEMO) {
    toast('Gelöscht. Für vollständige Sperre: unter „Konto“ einen neuen Team-Token hinterlegen.');
  }
  renderAll();
}

/* -------------------------------- Statistik ------------------------------ */

function rangeBounds(range) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  switch (range) {
    case 'month': return [new Date(y, m, 1), new Date(y, m + 1, 1)];
    case 'lastmonth': return [new Date(y, m - 1, 1), new Date(y, m, 1)];
    case 'year': return [new Date(y, 0, 1), new Date(y + 1, 0, 1)];
    case '12m': return [new Date(y, m - 11, 1), new Date(y, m + 1, 1)];
    default: return [null, null];
  }
}

function groupBy(entries, keyFn, nameFn) {
  const map = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    const g = map.get(k) || { name: nameFn(e), d: 0, a: 0, n: 0 };
    g.d += e.diesel_liter; g.a += e.adblue_liter; g.n++;
    map.set(k, g);
  }
  return [...map.values()];
}

function renderHBars(el, groups, key) {
  const items = groups.filter((g) => g[key] > 0).sort((a, b) => b[key] - a[key]);
  if (!items.length) { el.innerHTML = '<p class="muted small">Keine Daten im gewählten Zeitraum.</p>'; return; }
  const max = items[0][key];
  el.innerHTML = items.map((g) => `
    <div class="hbar" data-tip="${esc(g.name)}|${esc(fmtL(g[key]))}|${g.n} Tankvorgänge">
      <span class="hbar-label">${esc(g.name)}</span>
      <span class="hbar-val">${esc(fmtL(g[key]))}</span>
      <div class="hbar-track"><div class="hbar-fill" style="width:${(g[key] / max) * 100}%"></div></div>
    </div>`).join('');
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function renderMonths(el, entries, range, key) {
  // Monate des Zeitraums bestimmen (bei „Gesamt“: vom ersten Eintrag bis heute, max. 24)
  let [from, to] = rangeBounds(range);
  const now = new Date();
  if (!from) {
    const first = entries.reduce((min, e) => { const d = parseStamp(e.zeitstempel); return d && d < min ? d : min; }, now);
    from = new Date(first.getFullYear(), first.getMonth(), 1);
    to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
  const months = [];
  for (let d = new Date(from); d < to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) months.push(d);
  const shown = months.slice(-24);
  const sums = new Map(shown.map((d) => [`${d.getFullYear()}-${d.getMonth()}`, { d: 0, a: 0, n: 0 }]));
  for (const e of entries) {
    const d = parseStamp(e.zeitstempel);
    if (!d) continue;
    const s = sums.get(`${d.getFullYear()}-${d.getMonth()}`);
    if (s) { s.d += e.diesel_liter; s.a += e.adblue_liter; s.n++; }
  }
  const k = key === 'diesel' ? 'd' : 'a';
  const max = niceMax(Math.max(0, ...[...sums.values()].map((s) => s[k])));
  const label = (d) => d.toLocaleDateString('de-DE', { month: 'short' }).replace('.', '');
  const longLabel = (d) => d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
  const showYear = shown.length > 12 || shown[0]?.getFullYear() !== shown[shown.length - 1]?.getFullYear();
  const every = shown.length > 12 ? 3 : 1;
  el.innerHTML =
    [0.5, 1].map((f) => `<div class="gridline" style="bottom:${f * 100}%"><span>${esc(fmtCompact(max * f))}</span></div>`).join('') +
    shown.map((d) => {
      const s = sums.get(`${d.getFullYear()}-${d.getMonth()}`);
      return `<div class="col" data-tip="${esc(longLabel(d))}|${esc(fmtL(s[k]))}|${s.n} Tankvorgänge">
        <div class="col-fill" style="height:${(s[k] / max) * 100}%"></div></div>`;
    }).join('');
  const labels = shown.map((d, i) => `<span>${i % every === 0 ? esc(label(d) + (showYear ? ` ${String(d.getFullYear()).slice(2)}` : '')) : ''}</span>`).join('');
  let lab = el.nextElementSibling;
  if (!lab || !lab.classList.contains('col-labels')) {
    lab = document.createElement('div');
    lab.className = 'col-labels';
    el.after(lab);
  }
  lab.innerHTML = labels;
}

function renderStats() {
  const range = $('#statRange').value;
  const [from, to] = rangeBounds(range);
  const entries = state.data.entries.filter((e) => {
    if (!from) return true;
    const d = parseStamp(e.zeitstempel);
    return d && d >= from && d < to;
  });
  const sum = (k) => entries.reduce((s, e) => s + e[k], 0);
  $('#kpiDiesel').textContent = `${nf0.format(sum('diesel_liter'))} L`;
  $('#kpiAdblue').textContent = `${nf0.format(sum('adblue_liter'))} L`;
  $('#kpiCount').textContent = nf0.format(entries.length);

  const key = state.measure === 'diesel' ? 'd' : 'a';
  const word = state.measure === 'diesel' ? 'Diesel' : 'AdBlue';
  $('#titlePerson').textContent = `${word} nach Person`;
  $('#titleMachine').textContent = `${word} nach Maschine`;
  $('#titleMonth').textContent = `${word} pro Monat`;
  $$('#tab-statistik .viz').forEach((v) => v.classList.toggle('adblue', state.measure === 'adblue'));

  const byPerson = groupBy(entries, (e) => e.person_id || e.person, (e) => state.data.users.find((u) => u.id === e.person_id)?.name || e.person);
  const byMachine = groupBy(entries, (e) => e.maschine_id || e.maschine, (e) => state.data.machines.find((m) => m.id === e.maschine_id)?.name || e.maschine);
  renderHBars($('#chartPerson'), byPerson, key);
  renderHBars($('#chartMachine'), byMachine, key);
  renderMonths($('#chartMonth'), entries, range, state.measure);

  const rows = byPerson.sort((a, b) => b.d - a.d || b.a - a.a);
  $('#statTable').innerHTML = rows.length
    ? rows.map((g) => `<tr><td>${esc(g.name)}</td><td class="num">${nf.format(g.d)}</td><td class="num">${nf.format(g.a)}</td><td class="num">${g.n}</td></tr>`).join('') +
      `<tr><td><b>Summe</b></td><td class="num"><b>${nf.format(sum('diesel_liter'))}</b></td><td class="num"><b>${nf.format(sum('adblue_liter'))}</b></td><td class="num"><b>${entries.length}</b></td></tr>`
    : '<tr><td colspan="4" class="muted">Keine Daten im gewählten Zeitraum.</td></tr>';
}

/* Tooltip für Balken (Hover am PC, Antippen am Handy) */
function initTooltip() {
  const tip = $('#tooltip');
  let active = null;
  const show = (target, x, y) => {
    const [title, val, extra] = target.dataset.tip.split('|');
    tip.innerHTML = `${esc(title)}<br><b>${esc(val)}</b> · ${esc(extra)}`;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let left = x - r.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
    let top = y - r.height - 12;
    if (top < 8) top = y + 16;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    if (active && active !== target) active.classList.remove('active');
    active = target;
    target.classList.add('active');
  };
  const hide = () => { tip.hidden = true; active?.classList.remove('active'); active = null; };
  const tab = $('#tab-statistik');
  tab.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const t = e.target.closest('[data-tip]');
    if (t) show(t, e.clientX, e.clientY); else hide();
  });
  tab.addEventListener('pointerleave', hide);
  tab.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tip]');
    if (t) show(t, e.clientX, e.clientY); else hide();
  });
  window.addEventListener('scroll', hide, { passive: true });
}

/* ---------------------------------- Konto -------------------------------- */

function renderKonto() {
  $('#meName').textContent = state.user.name;
  $('#meUser').textContent = `@${state.user.username}`;
  const role = $('#meRole');
  role.textContent = isAdmin() ? 'Admin' : 'Nutzer';
  role.classList.toggle('admin', isAdmin());
  if (isAdmin() && state.team && !DEMO) {
    const f = $('#teamForm');
    if (!f.contains(document.activeElement)) {
      for (const k of ['owner', 'repo', 'branch', 'folder']) f[k].value = state.team[k] || '';
    }
  }
}

async function saveTeam(ev) {
  ev.preventDefault();
  const f = ev.target;
  const team = {
    owner: f.owner.value.trim(), repo: f.repo.value.trim(),
    branch: f.branch.value.trim() || 'main', folder: f.folder.value.trim(),
    token: f.teamToken.value.trim() || state.team.token,
  };
  const newAdminToken = f.adminToken.value.trim();
  const admin = { adminKey: state.admin.adminKey, appToken: newAdminToken || state.admin.appToken };
  formMsg(f, 'Prüfe Zugang …', true);
  const ok = await withBusy(async () => {
    await checkTokens(team, admin.appToken);
    await mutateAccounts(async (file) => {
      for (const rec of file.accounts) {
        const uk = await AUTH.ukFromAdmin(rec, admin.adminKey);
        await AUTH.setVault(rec, uk, team);
        if (rec.role === 'admin') await AUTH.setAdmin(rec, uk, AUTH.adminPayload(admin));
      }
    }, admin.appToken);
    state.team = team;
    state.admin = admin;
    state.backend = DataBackend(team);
    await loadAll();
  }, 'Team-Zugang für alle Benutzer aktualisiert', { quiet: true });
  if (ok) {
    f.teamToken.value = '';
    f.adminToken.value = '';
    formMsg(f, `Gespeichert – alle Benutzer nutzen jetzt ${team.owner}/${team.repo}.`, true);
    renderAll();
  } else {
    formMsg(f, lastError || 'Fehler beim Speichern.');
  }
}

/** Team-Token muss ins Daten-Repo schreiben dürfen, aber NICHT ins App-Repo. */
async function checkTokens(team, appToken) {
  if ((await GitHubClient(team).canPush()) === false) {
    throw new Error(`Der Team-Token hat keine Schreibrechte auf ${team.owner}/${team.repo} (Contents: Read and write?).`);
  }
  let teamOnApp = false;
  try { teamOnApp = await GitHubClient({ ...APP_REPO, token: team.token }).canPush(); } catch { teamOnApp = false; }
  if (teamOnApp === true) {
    throw new Error(`Der Team-Token darf auch ins App-Repo ${APP_REPO.owner}/${APP_REPO.repo} schreiben. Bitte beim Token unter „Repository access“ nur ${team.repo} auswählen.`);
  }
  if ((await GitHubClient({ ...APP_REPO, token: appToken }).canPush()) === false) {
    throw new Error(`Der Admin-Token hat keine Schreibrechte auf ${APP_REPO.owner}/${APP_REPO.repo} (Contents: Read and write?).`);
  }
}

/* --------------------------------- Export -------------------------------- */

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function visibleEntries() {
  return isAdmin() ? state.data.entries : state.data.entries.filter((e) => e.person_id === state.user.personId);
}
function exportCSV(kind) {
  const rows = kind === 'entries' ? visibleEntries() : state.data[kind];
  download(FILES[kind], new Blob([toCSV(kind, rows)], { type: 'text/csv;charset=utf-8' }));
}

let xlsxPromise;
function loadXLSX() {
  xlsxPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxPromise = null; reject(new Error('Excel-Bibliothek konnte nicht geladen werden.')); };
    document.head.appendChild(s);
  });
  return xlsxPromise;
}
async function exportXLSX() {
  await withBusy(async () => {
    const XLSX = await loadXLSX();
    const wb = XLSX.utils.book_new();
    const entries = [...visibleEntries()].sort((a, b) => a.zeitstempel.localeCompare(b.zeitstempel));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entries.map((e) => ({
      Zeitstempel: e.zeitstempel, Maschine: e.maschine, Person: e.person,
      'Diesel (L)': e.diesel_liter, 'AdBlue (L)': e.adblue_liter, Notiz: e.notiz,
    }))), 'Tankvorgänge');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.data.machines.map((m) => ({
      Name: m.name, Typ: m.typ, Kennzeichen: m.kennzeichen, Notiz: m.notiz, Erstellt: m.erstellt,
    }))), 'Maschinen');
    if (isAdmin()) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(state.data.users.map((u) => ({ Name: u.name, Erstellt: u.erstellt }))), 'Nutzer');
    }
    const per = groupBy(entries, (e) => e.person_id || e.person, (e) => e.person).sort((a, b) => b.d - a.d);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(per.map((g) => ({
      Person: g.name, 'Diesel (L)': Math.round(g.d * 100) / 100, 'AdBlue (L)': Math.round(g.a * 100) / 100, Tankvorgänge: g.n,
    }))), 'Statistik');
    XLSX.writeFile(wb, `Tank-App_${nowStamp().slice(0, 10)}.xlsx`);
  });
}

/* ------------------------- Anmeldung & Einrichtung ----------------------- */

function showAuth(which, msg = '') {
  document.body.classList.remove('authed');
  $('#authLoading').hidden = true;
  $('#loginForm').hidden = which !== 'login';
  $('#setupForm').hidden = which !== 'setup';
  const form = which === 'login' ? $('#loginForm') : $('#setupForm');
  formMsg(form, msg);
  if (which === 'setup' && !form.owner.value) form.owner.value = APP_REPO.owner;
  setTimeout(() => form.querySelector('input')?.focus(), 50);
}

async function enterApp(rec, uk) {
  const { team, admin } = await AUTH.openAccount(rec, uk);
  state.user = { username: rec.username, name: rec.name, role: rec.role, personId: rec.personId };
  state.uk = uk;
  state.team = team;
  state.admin = admin;
  state.backend = DEMO ? LocalBackend : DataBackend(team);
  document.body.dataset.role = rec.role;
  document.body.classList.add('authed');
  const start = location.hash.slice(1);
  showTab(start || 'tanken');
  setSync(true);
  const ok = await withBusy(loadAll);
  // Person zum Konto in nutzer.csv sicherstellen
  if (ok && !state.data.users.some((u) => u.id === rec.personId)) {
    await withBusy(() => mutate('users', (rows) => {
      if (!rows.some((u) => u.id === rec.personId)) rows.push({ id: rec.personId, name: rec.name, erstellt: nowStamp() });
    }));
  }
  renderAll();
}

async function submitLogin(ev) {
  ev.preventDefault();
  const f = ev.target;
  const username = normUser(f.username.value);
  formMsg(f, '');
  await withBusy(async () => {
    try {
      state.accounts = (await fetchAccountsPublic()) || emptyAccounts();
    } catch (e) { formMsg(f, e.message); return; }
    const rec = state.accounts.accounts.find((a) => a.username === username);
    let uk = null;
    if (rec) { try { uk = await AUTH.ukFromPassword(rec, f.password.value); } catch { uk = null; } }
    if (!uk) { formMsg(f, 'Benutzername oder Passwort falsch.'); return; }
    saveSession(username, uk, f.remember.checked);
    f.password.value = '';
    await enterApp(rec, uk);
  }, null, { quiet: true });
}

async function submitSetup(ev) {
  ev.preventDefault();
  const f = ev.target;
  const name = f.elements.name.value.trim();
  const username = normUser(f.username.value);
  const password = f.password.value;
  if (!validUser(username)) return formMsg(f, 'Benutzername: 3–30 Zeichen, nur a–z, 0–9, Punkt, Minus, Unterstrich.');
  if (password.length < MIN_PW) return formMsg(f, `Das Passwort muss mindestens ${MIN_PW} Zeichen haben.`);
  if (password !== f.password2.value) return formMsg(f, 'Die Passwörter stimmen nicht überein.');
  const team = DEMO
    ? { demo: true }
    : { owner: f.owner.value.trim(), repo: f.repo.value.trim(), branch: f.branch.value.trim() || 'main', folder: f.folder.value.trim(), token: f.teamToken.value.trim() };
  const appToken = DEMO ? 'demo' : f.adminToken.value.trim();
  if (!DEMO && (!team.owner || !team.repo || !team.token || !appToken)) return formMsg(f, 'Bitte Daten-Repo, Team-Token und Admin-Token ausfüllen.');
  if (!DEMO && team.token === appToken) return formMsg(f, 'Team-Token und Admin-Token müssen zwei verschiedene Tokens sein.');

  formMsg(f, DEMO ? 'Richte ein …' : 'Prüfe Tokens …', true);
  const ok = await withBusy(async () => {
    if (!DEMO) await checkTokens(team, appToken);
    const admin = { adminKey: AUTH.rand(32), appToken };
    const personId = uid();
    const rec = await AUTH.createAccount({ username, name, role: 'admin', personId, password }, admin.adminKey, team, AUTH.adminPayload(admin));
    await mutateAccounts((file) => {
      if (file.accounts.length) throw new Error('Es gibt bereits Benutzer – bitte neu laden und anmelden.');
      file.accounts.push(rec);
    }, appToken);
    const uk = await AUTH.ukFromPassword(rec, password);
    saveSession(username, uk, true);
    f.reset();
    await enterApp(rec, uk);
    toast('Eingerichtet! Lege jetzt Maschinen und Benutzer an.');
  }, null, { quiet: true });
  if (!ok) formMsg(f, lastError || 'Einrichtung fehlgeschlagen.');
}

async function logout() {
  if (!(await confirmDialog('Wirklich abmelden?', 'Abmelden'))) return;
  store.del(SESSION_KEY);
  state.user = state.uk = state.team = state.admin = null;
  state.data = { entries: [], machines: [], users: [] };
  delete document.body.dataset.role;
  location.hash = '';
  showAuth('login');
}

/* ---------------------------------- Start -------------------------------- */

function bindEvents() {
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  window.addEventListener('hashchange', () => {
    if (!state.user) return;
    const t = location.hash.slice(1);
    if ($(`#tab-${t}`)) showTab(t);
  });
  $('#reloadBtn').addEventListener('click', async () => {
    await withBusy(async () => {
      await loadAll();
      if (isAdmin()) state.accounts = (await fetchAccountsPublic()) || state.accounts;
    }, 'Daten aktualisiert');
    renderAll();
  });

  $('#loginForm').addEventListener('submit', submitLogin);
  $('#setupForm').addEventListener('submit', submitSetup);
  $('#logoutBtn').addEventListener('click', logout);

  $('#tankForm').addEventListener('submit', submitTank);
  $('#showAllEntries').addEventListener('click', () => { state.showAll = !state.showAll; renderTanken(); });
  $('#entryList').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit-entry]');
    const del = e.target.closest('[data-del-entry]');
    if (ed) editEntry(ed.dataset.editEntry);
    if (del) deleteEntry(del.dataset.delEntry);
  });

  $('#addMachine').addEventListener('click', () => openMachineDialog(null));
  $('#machineList').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit-machine]');
    const del = e.target.closest('[data-del-machine]');
    if (ed) openMachineDialog(ed.dataset.editMachine);
    if (del) deleteMachine(del.dataset.delMachine);
  });

  $('#accountForm').addEventListener('submit', createAccount);
  $('#accountList').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit-account]');
    const del = e.target.closest('[data-del-account]');
    if (ed) editAccount(ed.dataset.editAccount);
    if (del) deleteAccount(del.dataset.delAccount);
  });
  $$('[data-genpw]').forEach((b) => b.addEventListener('click', () => {
    const input = b.parentElement.querySelector('input');
    input.value = AUTH.generatePassword();
    input.select();
  }));

  $('#statRange').addEventListener('change', renderStats);
  $$('.seg [data-measure]').forEach((b) => b.addEventListener('click', () => {
    state.measure = b.dataset.measure;
    $$('.seg [data-measure]').forEach((x) => x.classList.toggle('on', x === b));
    renderStats();
  }));

  $('#teamForm').addEventListener('submit', saveTeam);
  $$('[data-export]').forEach((b) => b.addEventListener('click', () => exportCSV(b.dataset.export)));
  $('#exportXlsx').addEventListener('click', exportXLSX);

  // Beim Zurückkehren zur App (z. B. Handy entsperrt) frische Daten holen
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.user && !DEMO && busyCount === 0) {
      await withBusy(loadAll, null, { quiet: true });
      renderAll();
    }
  });
}

async function init() {
  if (DEMO) {
    document.body.classList.add('demo');
    $('#demoBanner').hidden = false;
  }
  bindEvents();
  initTooltip();
  let file;
  try {
    file = await fetchAccountsPublic();
  } catch (e) {
    showAuth('login', e.message);
    return;
  }
  state.accounts = file || emptyAccounts();
  if (!state.accounts.accounts.length) { showAuth('setup'); return; }

  const session = readSession();
  const rec = session && state.accounts.accounts.find((a) => a.username === session.username);
  if (rec) {
    try {
      await enterApp(rec, AUTH.unb64(session.uk));
      return;
    } catch (e) {
      console.warn('Sitzung ungültig', e);
    }
  }
  if (session) store.del(SESSION_KEY);
  showAuth('login', session ? 'Bitte erneut anmelden.' : '');
}

init();
