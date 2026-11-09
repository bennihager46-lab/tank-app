'use strict';

/* =========================================================================
   Tank-App – speichert Maschinen, Nutzer und Tankvorgänge als CSV-Dateien,
   wahlweise lokal (nur dieses Gerät) oder in einem GitHub-Repository.
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
const SETTINGS_KEY = 'tankapp:settings';
const LAST_PERSON_KEY = 'tankapp:lastPerson';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const store = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
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

/* ---------------------------------- CSV --------------------------------- */

function parseCSV(text) {
  text = (text || '').replace(/^﻿/, '');
  if (!text.trim()) return [];
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
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

/* ------------------------------ Speicher-Backends ------------------------ */

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

const LocalBackend = {
  label: () => 'Lokal (nur dieses Gerät)',
  async load(kind) { return { text: store.get('tankapp:csv:' + kind, ''), sha: null }; },
  async save(kind, text) { store.set('tankapp:csv:' + kind, text); return null; },
  async test() { return 'Lokaler Speicher funktioniert.'; },
};

function GitHubBackend(cfg) {
  const folder = (cfg.folder || '').replace(/^\/+|\/+$/g, '');
  const api = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
  const branch = cfg.branch || 'main';
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${cfg.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const pathOf = (kind) => (folder ? `${folder}/` : '') + FILES[kind];

  async function ghFetch(url, opts = {}) {
    let res;
    try {
      res = await fetch(url, { cache: 'no-store', ...opts, headers: { ...headers, ...(opts.headers || {}) } });
    } catch (e) {
      throw new Error('Keine Verbindung zu GitHub (offline?).');
    }
    return res;
  }
  async function errorFrom(res) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* ignore */ }
    if (res.status === 401) return new Error('Token ungültig oder abgelaufen.');
    if (res.status === 403) return new Error('Kein Zugriff – hat der Token „Contents: Read and write“ für dieses Repo? ' + msg);
    if (res.status === 404) return new Error('Repository oder Branch nicht gefunden (oder kein Zugriff).');
    return new Error(`GitHub-Fehler ${res.status}: ${msg}`);
  }

  return {
    label: () => `GitHub: ${cfg.owner}/${cfg.repo}`,
    async load(kind) {
      const res = await ghFetch(`${api}/contents/${pathOf(kind)}?ref=${encodeURIComponent(branch)}&t=${Date.now()}`);
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
    async save(kind, text, sha) {
      const body = {
        message: `Tank-App: ${FILES[kind]} aktualisiert (${nowStamp()})`,
        content: b64EncodeUtf8(text),
        branch,
      };
      if (sha) body.sha = sha;
      const res = await ghFetch(`${api}/contents/${pathOf(kind)}`, {
        method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
      });
      if (res.status === 409 || res.status === 422) throw new ConflictError('Datei wurde zwischenzeitlich geändert');
      if (!res.ok) throw await errorFrom(res);
      return (await res.json()).content.sha;
    },
    async test() {
      const res = await ghFetch(`${api}/branches/${encodeURIComponent(branch)}`);
      if (!res.ok) throw await errorFrom(res);
      const repoRes = await ghFetch(api);
      if (!repoRes.ok) throw await errorFrom(repoRes);
      const repo = await repoRes.json();
      if (repo.permissions && !repo.permissions.push) throw new Error('Token hat nur Lesezugriff – Schreibrechte fehlen.');
      return `Verbunden mit ${repo.full_name} (${repo.private ? 'privat' : 'öffentlich'}), Branch „${branch}“.`;
    },
  };
}

/* --------------------------------- Zustand ------------------------------ */

const state = {
  settings: loadSettings(),
  backend: LocalBackend,
  data: { entries: [], machines: [], users: [] },
  measure: 'diesel',
  showAll: false,
};

function loadSettings() {
  let s = {};
  try { s = JSON.parse(store.get(SETTINGS_KEY, '{}')) || {}; } catch { s = {}; }
  // Auf GitHub Pages (benutzer.github.io/repo) Besitzer vorbelegen
  const host = location.hostname;
  const guessOwner = host.endsWith('.github.io') ? host.split('.')[0] : '';
  return { mode: 'local', owner: guessOwner, repo: '', branch: 'main', folder: 'data', token: '', ...s };
}
function makeBackend(s) {
  if (s.mode === 'github' && s.owner && s.repo && s.token) return GitHubBackend(s);
  return LocalBackend;
}

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
async function withBusy(fn, okMsg) {
  busyCount++;
  const t = setTimeout(() => { if (busyCount) $('#busy').hidden = false; }, 250);
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    setSync(true);
    return r;
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), true);
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
  toastTimer = setTimeout(() => { el.hidden = true; }, isErr ? 5000 : 2200);
}
function setSync(ok, msg) {
  const el = $('#syncStatus');
  el.textContent = ok ? state.backend.label() : 'Fehler';
  el.title = ok ? 'Speicherort der CSV-Dateien' : (msg || 'Fehler');
  el.classList.toggle('err', !ok);
}

function showTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
  $$('.tabbar button').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  window.scrollTo(0, 0);
  if (name === 'statistik') renderStats();
}

const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 0 0 0-1.41l-2.33-2.33a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z"/></svg>';
const ICON_DEL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z"/></svg>';

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
  renderUsers();
  if ($('#tab-statistik').classList.contains('active')) renderStats();
}

/* --------------------------------- Tanken -------------------------------- */

function renderTanken() {
  const machines = sortedMachines();
  const users = sortedUsers();
  const mSel = $('#tankMachine');
  const pSel = $('#tankPerson');
  const keepM = mSel.value;
  const keepP = pSel.value || store.get(LAST_PERSON_KEY, '');
  fillSelect(mSel, machines, 'Bitte wählen …', machines.some((m) => m.id === keepM) ? keepM : '', machineLabel);
  fillSelect(pSel, users, 'Bitte wählen …', users.some((u) => u.id === keepP) ? keepP : '');

  const hint = $('#tankHint');
  const missing = [];
  if (!machines.length) missing.push('<a href="#maschinen">Maschinen anlegen</a>');
  if (!users.length) missing.push('<a href="#nutzer">Nutzer anlegen</a>');
  hint.hidden = !missing.length;
  hint.innerHTML = missing.length ? `Bevor getankt werden kann: ${missing.join(' und ')}.` : '';

  const entries = [...state.data.entries].sort((a, b) => b.zeitstempel.localeCompare(a.zeitstempel));
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
        <div class="item-sub">${esc(fmtDate(e.zeitstempel))} · ${esc(e.person)}${e.notiz ? ' · ' + esc(e.notiz) : ''}</div>
      </div>
      <div class="amounts">
        ${e.diesel_liter ? `<div class="d">${fmtL(e.diesel_liter)}</div>` : ''}
        ${e.adblue_liter ? `<div class="a">${fmtL(e.adblue_liter)}</div>` : ''}
      </div>
      <div class="item-actions">
        <button type="button" data-edit-entry="${esc(e.id)}" aria-label="Bearbeiten" title="Bearbeiten">${ICON_EDIT}</button>
        <button type="button" class="del" data-del-entry="${esc(e.id)}" aria-label="Löschen" title="Löschen">${ICON_DEL}</button>
      </div>
    </li>`).join('');
}

async function submitTank(ev) {
  ev.preventDefault();
  const m = state.data.machines.find((x) => x.id === $('#tankMachine').value);
  const p = state.data.users.find((x) => x.id === $('#tankPerson').value);
  const diesel = parseNum($('#tankDiesel').value);
  const adblue = parseNum($('#tankAdblue').value);
  if (!m || !p) return toast('Bitte Maschine und Person auswählen.', true);
  if (Number.isNaN(diesel) || Number.isNaN(adblue) || diesel < 0 || adblue < 0) return toast('Bitte gültige Literangaben eingeben.', true);
  if (!diesel && !adblue) return toast('Bitte Diesel und/oder AdBlue eintragen.', true);

  const entry = {
    id: uid(), zeitstempel: nowStamp(),
    maschine_id: m.id, maschine: m.name, person_id: p.id, person: p.name,
    diesel_liter: diesel, adblue_liter: adblue, notiz: $('#tankNote').value.trim(),
  };
  const ok = await withBusy(() => mutate('entries', (rows) => { rows.push(entry); return true; }), 'Tankvorgang gespeichert ✓');
  if (ok) {
    store.set(LAST_PERSON_KEY, p.id);
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
  if (!e) return;
  const dlg = $('#entryDialog');
  const f = $('#entryForm');
  const machines = sortedMachines();
  const users = sortedUsers();
  // Gelöschte Maschine/Person trotzdem auswählbar halten
  if (!machines.some((m) => m.id === e.maschine_id)) machines.unshift({ id: e.maschine_id, name: e.maschine + ' (gelöscht)' });
  if (!users.some((u) => u.id === e.person_id)) users.unshift({ id: e.person_id, name: e.person + ' (gelöscht)' });
  fillSelect(f.maschine_id, machines, 'Bitte wählen …', e.maschine_id, (m) => m.typ ? machineLabel(m) : m.name);
  fillSelect(f.person_id, users, 'Bitte wählen …', e.person_id);
  f.zeitstempel.value = toLocalInput(e.zeitstempel);
  f.diesel.value = e.diesel_liter ? String(e.diesel_liter).replace('.', ',') : '';
  f.adblue.value = e.adblue_liter ? String(e.adblue_liter).replace('.', ',') : '';
  f.notiz.value = e.notiz;
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    const diesel = parseNum(f.diesel.value);
    const adblue = parseNum(f.adblue.value);
    if (Number.isNaN(diesel) || Number.isNaN(adblue) || diesel < 0 || adblue < 0) return toast('Ungültige Literangabe – nicht gespeichert.', true);
    const mId = f.maschine_id.value, pId = f.person_id.value;
    const mName = state.data.machines.find((m) => m.id === mId)?.name ?? e.maschine;
    const pName = state.data.users.find((u) => u.id === pId)?.name ?? e.person;
    const stamp = f.zeitstempel.value.replace('T', ' ') + (f.zeitstempel.value.length === 16 ? ':00' : '');
    await withBusy(() => mutate('entries', (rows) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error('Eintrag wurde inzwischen gelöscht.');
      Object.assign(r, { zeitstempel: stamp, maschine_id: mId, maschine: mName, person_id: pId, person: pName, diesel_liter: diesel, adblue_liter: adblue, notiz: f.notiz.value.trim() });
    }), 'Tankvorgang aktualisiert');
    renderAll();
  };
  dlg.returnValue = '';
  dlg.showModal();
}

async function deleteEntry(id) {
  const e = state.data.entries.find((x) => x.id === id);
  if (!e || !confirm(`Tankvorgang „${e.maschine}“ vom ${fmtDate(e.zeitstempel)} löschen?`)) return;
  await withBusy(() => mutate('entries', (rows) => {
    const i = rows.findIndex((x) => x.id === id);
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
      <div class="item-actions">
        <button type="button" data-edit-machine="${esc(m.id)}" aria-label="Bearbeiten" title="Bearbeiten">${ICON_EDIT}</button>
        <button type="button" class="del" data-del-machine="${esc(m.id)}" aria-label="Löschen" title="Löschen">${ICON_DEL}</button>
      </div>
    </li>`;
  }).join('');
}

function openMachineDialog(id) {
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
    if (dupe && !confirm(`„${vals.name}“ gibt es schon. Trotzdem speichern?`)) return;
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
  if (!m) return;
  const n = state.data.entries.filter((e) => e.maschine_id === id).length;
  const msg = `„${m.name}“ löschen?` + (n ? `\n\nDie ${n} Tankvorgänge dieser Maschine bleiben erhalten.` : '');
  if (!confirm(msg)) return;
  await withBusy(() => mutate('machines', (rows) => {
    const i = rows.findIndex((x) => x.id === id);
    if (i >= 0) rows.splice(i, 1);
  }), 'Maschine gelöscht');
  renderAll();
}

/* ---------------------------------- Nutzer ------------------------------- */

function renderUsers() {
  const list = $('#userList');
  const us = sortedUsers();
  if (!us.length) { list.innerHTML = '<li class="empty">Noch keine Personen angelegt.</li>'; return; }
  const totals = {};
  for (const e of state.data.entries) {
    const t = (totals[e.person_id] ||= { d: 0, a: 0, n: 0 });
    t.d += e.diesel_liter; t.a += e.adblue_liter; t.n++;
  }
  list.innerHTML = us.map((u) => {
    const t = totals[u.id] || { d: 0, a: 0, n: 0 };
    return `
    <li class="item">
      <div class="item-main">
        <div class="item-title">${esc(u.name)}</div>
        <div class="item-sub">${t.n} Tankvorgänge</div>
      </div>
      <div class="amounts">
        ${t.d ? `<div class="d">${fmtL(t.d)}</div>` : ''}
        ${t.a ? `<div class="a">${fmtL(t.a)}</div>` : ''}
      </div>
      <div class="item-actions">
        <button type="button" data-edit-user="${esc(u.id)}" aria-label="Umbenennen" title="Umbenennen">${ICON_EDIT}</button>
        <button type="button" class="del" data-del-user="${esc(u.id)}" aria-label="Löschen" title="Löschen">${ICON_DEL}</button>
      </div>
    </li>`;
  }).join('');
}

async function addUser(ev) {
  ev.preventDefault();
  const name = $('#userName').value.trim();
  if (!name) return;
  if (state.data.users.some((u) => collator.compare(u.name, name) === 0)) return toast(`„${name}“ gibt es schon.`, true);
  const ok = await withBusy(() => mutate('users', (rows) => { rows.push({ id: uid(), name, erstellt: nowStamp() }); return true; }), `${name} hinzugefügt`);
  if (ok) { $('#userName').value = ''; renderAll(); }
}

async function renameUser(id) {
  const u = state.data.users.find((x) => x.id === id);
  if (!u) return;
  const name = (prompt('Neuer Name:', u.name) || '').trim();
  if (!name || name === u.name) return;
  await withBusy(async () => {
    await mutate('users', (rows) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error('Person wurde inzwischen gelöscht.');
      r.name = name;
    });
    await mutate('entries', (rows) => { rows.forEach((e) => { if (e.person_id === id) e.person = name; }); });
  }, 'Name geändert');
  renderAll();
}

async function deleteUser(id) {
  const u = state.data.users.find((x) => x.id === id);
  if (!u) return;
  const n = state.data.entries.filter((e) => e.person_id === id).length;
  if (!confirm(`„${u.name}“ löschen?` + (n ? `\n\nDie ${n} Tankvorgänge bleiben in der Statistik erhalten.` : ''))) return;
  await withBusy(() => mutate('users', (rows) => {
    const i = rows.findIndex((x) => x.id === id);
    if (i >= 0) rows.splice(i, 1);
  }), 'Person gelöscht');
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

/* ------------------------------ Einstellungen ---------------------------- */

function renderSettings() {
  const f = $('#settingsForm');
  const s = state.settings;
  f.mode.value = s.mode;
  for (const k of ['owner', 'repo', 'branch', 'folder', 'token']) f[k].value = s[k] || '';
  toggleGhFields();
}
function toggleGhFields() {
  $('#ghFields').hidden = $('#settingsForm').mode.value !== 'github';
}
function readSettingsForm() {
  const f = $('#settingsForm');
  return {
    mode: f.mode.value,
    owner: f.owner.value.trim(),
    repo: f.repo.value.trim(),
    branch: f.branch.value.trim() || 'main',
    folder: f.folder.value.trim(),
    token: f.token.value.trim(),
  };
}
function settingsMsg(text, isErr) {
  const el = $('#settingsMsg');
  el.textContent = text;
  el.style.color = isErr ? 'var(--danger)' : 'var(--accent)';
}

async function testConnection() {
  const s = readSettingsForm();
  if (s.mode === 'github' && (!s.owner || !s.repo || !s.token)) return settingsMsg('Bitte Besitzer, Repository und Token ausfüllen.', true);
  settingsMsg('Teste Verbindung …');
  try {
    const msg = await makeBackend(s).test();
    settingsMsg(msg + ' ✓');
    return true;
  } catch (e) {
    settingsMsg(e.message, true);
    return false;
  }
}

async function saveSettings(ev) {
  ev.preventDefault();
  const s = readSettingsForm();
  if (s.mode === 'github') {
    if (!s.owner || !s.repo || !s.token) return settingsMsg('Bitte Besitzer, Repository und Token ausfüllen.', true);
    if (!(await testConnection())) return;
  }
  state.settings = s;
  store.set(SETTINGS_KEY, JSON.stringify(s));
  state.backend = makeBackend(s);
  await withBusy(loadAll, 'Einstellungen gespeichert');
  renderAll();
  settingsMsg(`Gespeichert – Daten kommen jetzt von: ${state.backend.label()}`);
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
function exportCSV(kind) {
  download(FILES[kind], new Blob([toCSV(kind, state.data[kind])], { type: 'text/csv;charset=utf-8' }));
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
    const sheet = (kind, headers, map) => XLSX.utils.json_to_sheet(state.data[kind].map(map), { header: headers });
    const entries = [...state.data.entries].sort((a, b) => a.zeitstempel.localeCompare(b.zeitstempel));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entries.map((e) => ({
      Zeitstempel: e.zeitstempel, Maschine: e.maschine, Person: e.person,
      'Diesel (L)': e.diesel_liter, 'AdBlue (L)': e.adblue_liter, Notiz: e.notiz,
    }))), 'Tankvorgänge');
    XLSX.utils.book_append_sheet(wb, sheet('machines', ['Name', 'Typ', 'Kennzeichen', 'Notiz', 'Erstellt'],
      (m) => ({ Name: m.name, Typ: m.typ, Kennzeichen: m.kennzeichen, Notiz: m.notiz, Erstellt: m.erstellt })), 'Maschinen');
    XLSX.utils.book_append_sheet(wb, sheet('users', ['Name', 'Erstellt'], (u) => ({ Name: u.name, Erstellt: u.erstellt })), 'Nutzer');
    // Auswertung pro Person als eigener Reiter
    const per = groupBy(entries, (e) => e.person_id || e.person, (e) => e.person).sort((a, b) => b.d - a.d);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(per.map((g) => ({
      Person: g.name, 'Diesel (L)': Math.round(g.d * 100) / 100, 'AdBlue (L)': Math.round(g.a * 100) / 100, Tankvorgänge: g.n,
    }))), 'Statistik');
    XLSX.writeFile(wb, `Tank-App_${nowStamp().slice(0, 10)}.xlsx`);
  });
}

/* ---------------------------------- Start -------------------------------- */

function bindEvents() {
  $$('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  window.addEventListener('hashchange', () => {
    const t = location.hash.slice(1);
    if ($(`#tab-${t}`)) showTab(t);
  });
  $('#reloadBtn').addEventListener('click', async () => { await withBusy(loadAll, 'Daten aktualisiert'); renderAll(); });

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

  $('#userForm').addEventListener('submit', addUser);
  $('#userList').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit-user]');
    const del = e.target.closest('[data-del-user]');
    if (ed) renameUser(ed.dataset.editUser);
    if (del) deleteUser(del.dataset.delUser);
  });

  $('#statRange').addEventListener('change', renderStats);
  $$('.seg [data-measure]').forEach((b) => b.addEventListener('click', () => {
    state.measure = b.dataset.measure;
    $$('.seg [data-measure]').forEach((x) => x.classList.toggle('on', x === b));
    renderStats();
  }));

  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#settingsForm').addEventListener('change', (e) => { if (e.target.name === 'mode') toggleGhFields(); });
  $('#testConn').addEventListener('click', testConnection);
  $$('[data-export]').forEach((b) => b.addEventListener('click', () => exportCSV(b.dataset.export)));
  $('#exportXlsx').addEventListener('click', exportXLSX);

  // Beim Zurückkehren zur App (z. B. Handy entsperrt) frische Daten holen
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && state.backend !== LocalBackend && busyCount === 0) {
      await withBusy(loadAll);
      renderAll();
    }
  });
}

async function init() {
  bindEvents();
  initTooltip();
  renderSettings();
  state.backend = makeBackend(state.settings);
  setSync(true);
  const start = location.hash.slice(1);
  showTab($(`#tab-${start}`) ? start : 'tanken');
  await withBusy(loadAll);
  renderAll();
  if (state.settings.mode === 'local' && !state.data.machines.length && !state.data.users.length) {
    toast('Tipp: Unter „Einstellungen“ ein GitHub-Repo verbinden, damit alle die Daten teilen.');
  }
}

init();
