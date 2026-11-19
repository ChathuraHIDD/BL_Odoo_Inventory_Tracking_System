/* =========================================================
   BatteryLab · Stock Count
   Client-side stock reconciliation against an Odoo stock.quant export.
   No server and no database: the count is kept in this browser
   (localStorage) so a refresh or an accidental close never loses scans.
   ========================================================= */
(() => {
  'use strict';

  /* ------------------------------------------------------------------
   * Config
   * ------------------------------------------------------------------ */
  // SHA-256 of "bl-inv|<username>|<password>". Credentials are not stored in plain text.
  const AUTH_HASH = 'd2294eee85f7cb16d9a2b562603d8832ef0db7420908d3fdebcf24aac7c5326b';
  const AUTH_KEY = 'bl_inv_auth';
  const AUTH_TTL_MS = 10 * 60 * 60 * 1000; // 10 h working day
  const STORE_KEY = 'bl_inv_session_v1';
  const PREFS_KEY = 'bl_inv_prefs';
  const CAMERA_REPEAT_MS = 2500; // ignore the same code seen by the camera within this window

  /* ------------------------------------------------------------------
   * Small helpers
   * ------------------------------------------------------------------ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtInt = (n) => Number(n || 0).toLocaleString();
  const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');
  const fmtDateTime = (t) => (t ? new Date(t).toLocaleString([], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  /** Canonical form used for matching: no control chars, no whitespace, upper case. */
  const norm = (v) => String(v ?? '').replace(/[\u0000-\u001F\u007F​-‍﻿]/g, '').replace(/\s+/g, '').toUpperCase();

  function safeGet(storage, key) {
    try { return JSON.parse(storage.getItem(key)); } catch { return null; }
  }
  function safeSet(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }
  function safeDel(storage, key) {
    try { storage.removeItem(key); } catch { /* ignore */ }
  }

  /** Compact SHA-256 (works on file:// where crypto.subtle may be unavailable). */
  function sha256(str) {
    const K = [];
    const primes = [];
    for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
    primes.forEach((p) => K.push((Math.cbrt(p) % 1) * 2 ** 32 >>> 0));
    let H = primes.slice(0, 8).map((p) => (Math.sqrt(p) % 1) * 2 ** 32 >>> 0);

    const bytes = new TextEncoder().encode(str);
    const len = bytes.length;
    const padded = (((len + 9) + 63) >> 6) << 6;
    const m = new Uint8Array(padded);
    m.set(bytes);
    m[len] = 0x80;
    const dv = new DataView(m.buffer);
    dv.setUint32(padded - 4, (len * 8) >>> 0);
    dv.setUint32(padded - 8, Math.floor((len * 8) / 2 ** 32));

    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let i = 0; i < padded; i += 64) {
      for (let t = 0; t < 16; t++) W[t] = dv.getUint32(i + t * 4);
      for (let t = 16; t < 64; t++) {
        const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
        const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let t = 0; t < 64; t++) {
        const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + W[t]) >>> 0;
        const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = [a, b, c, d, e, f, g, h].map((x, k) => (H[k] + x) >>> 0);
    }
    return H.map((x) => x.toString(16).padStart(8, '0')).join('');
  }

  /* ------------------------------------------------------------------
   * Toast / modal
   * ------------------------------------------------------------------ */
  let toastTimer;
  function toast(msg, ms = 2600) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }

  function confirmDialog({ title, body, ok = 'OK', danger = false }) {
    return new Promise((resolve) => {
      const modal = $('#modal');
      $('#modal-title').textContent = title;
      $('#modal-body').textContent = body;
      const okBtn = $('#modal-ok');
      okBtn.textContent = ok;
      okBtn.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
      modal.classList.remove('hidden');
      okBtn.focus();
      const done = (val) => {
        modal.classList.add('hidden');
        okBtn.onclick = cancel.onclick = modal.onclick = document.onkeydown = null;
        resolve(val);
      };
      const cancel = $('#modal-cancel');
      okBtn.onclick = () => done(true);
      cancel.onclick = () => done(false);
      modal.onclick = (e) => { if (e.target === modal) done(false); };
      document.onkeydown = (e) => { if (e.key === 'Escape') done(false); };
    });
  }

  /* ------------------------------------------------------------------
   * Sound feedback (Web Audio, no files needed)
   * ------------------------------------------------------------------ */
  const prefs = Object.assign({ sound: true }, safeGet(localStorage, PREFS_KEY) || {});
  let audioCtx;
  function tone(freq, start, dur, type = 'sine', vol = 0.18) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.value = freq;
    const t0 = audioCtx.currentTime + start;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }
  function beep(kind) {
    if (!prefs.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      if (kind === 'found') { tone(1046, 0, 0.09); tone(1568, 0.07, 0.12); }
      else if (kind === 'duplicate') { tone(660, 0, 0.1, 'triangle'); tone(660, 0.14, 0.1, 'triangle'); }
      else if (kind === 'other') { tone(784, 0, 0.12, 'triangle'); tone(587, 0.12, 0.16, 'triangle'); }
      else { tone(196, 0, 0.35, 'square', 0.12); }
    } catch { /* audio not available */ }
  }

  /* ------------------------------------------------------------------
   * Authentication
   * ------------------------------------------------------------------ */
  function isAuthed() {
    const a = safeGet(sessionStorage, AUTH_KEY);
    return !!(a && a.exp > Date.now());
  }

  function initLogin() {
    const form = $('#login-form');
    const user = $('#login-user');
    const pass = $('#login-pass');
    const err = $('#login-error');

    $('#pw-toggle').addEventListener('click', (e) => {
      const show = pass.type === 'password';
      pass.type = show ? 'text' : 'password';
      e.currentTarget.textContent = show ? 'Hide' : 'Show';
      pass.focus();
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      err.textContent = '';
      const u = user.value.trim();
      const p = pass.value;
      if (!u || !p) { err.textContent = 'Enter your username and password.'; return; }
      if (sha256(`bl-inv|${u}|${p}`) === AUTH_HASH) {
        safeSet(sessionStorage, AUTH_KEY, { user: u, exp: Date.now() + AUTH_TTL_MS });
        pass.value = '';
        enterApp();
      } else {
        err.textContent = 'Incorrect username or password.';
        form.classList.remove('shake');
        void form.offsetWidth;
        form.classList.add('shake');
        pass.select();
      }
    });
  }

  function showLogin() {
    stopCamera();
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    setTimeout(() => $('#login-user').focus(), 50);
  }

  function enterApp() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    loadSession();
    if (S && S.started) setView('scan');
    else setView('upload');
  }

  /* ------------------------------------------------------------------
   * Session state
   * S = {
   *   fileName, uploadedAt, startedAt,
   *   items:  [{ key, serial, product, code, name, location, qty, unit }],
   *   locations: [{ name, count }], selected: [locationName],
   *   started: bool,
   *   scans:  [{ id, raw, key, t, src }]
   * }
   * ------------------------------------------------------------------ */
  let S = null;
  let index = new Map(); // normalized serial -> item index
  let R = null; // derived results (see compute())

  function rebuildIndex() {
    index = new Map();
    if (!S) return;
    S.items.forEach((it, i) => index.set(it.key, i));
  }

  function loadSession() {
    S = safeGet(localStorage, STORE_KEY);
    if (S && !Array.isArray(S.items)) S = null;
    rebuildIndex();
    compute();
  }

  function saveSession() {
    if (!S) { safeDel(localStorage, STORE_KEY); return; }
    if (!safeSet(localStorage, STORE_KEY, S)) {
      toast('Browser storage is full or blocked. Export the report now so nothing is lost.', 5000);
    }
  }

  function clearSession() {
    S = null;
    rebuildIndex();
    compute();
    saveSession();
  }

  /** Find the report serial a scanned value refers to. Returns a normalized key. */
  function resolveKey(raw) {
    const k = norm(raw);
    if (!k || index.has(k)) return k;
    // QR codes sometimes carry more than the serial (URL, "serial|product", key=value …).
    let text = String(raw);
    try { text = decodeURIComponent(text); } catch { /* keep raw */ }
    const tokens = text.split(/[\s,;|\t\r\n?&=#]+/).map(norm).filter(Boolean);
    for (const t of tokens) if (index.has(t)) return t;
    // URL path: try the last segments joined (serials can contain "/")
    const segs = text.split('/').map(norm).filter(Boolean);
    for (let n = 1; n <= Math.min(3, segs.length); n++) {
      const cand = segs.slice(-n).join('/');
      if (index.has(cand)) return cand;
    }
    return k;
  }

  /**
   * Derive every result from the raw scan log.
   * Status of each scan depends only on order, so deleting a scan just recomputes.
   *   found     – first scan of a serial on the report, inside the selected locations
   *   duplicate – the same serial scanned again
   *   other     – serial is on the report but in a location that is not being counted
   *   unknown   – serial is not on the report at all
   */
  function compute() {
    if (!S) { R = null; return; }
    const sel = new Set(S.selected);
    const firstScan = new Map(); // key -> scan
    const exceptions = new Map(); // key -> { type, raw, key, count, first, item }
    const scanStatus = new Map(); // scan id -> status
    let dup = 0;

    for (const sc of S.scans) {
      const idx = index.get(sc.key);
      let status;
      if (idx === undefined || !sel.has(S.items[idx].location)) {
        const type = idx === undefined ? 'unknown' : 'other';
        const ex = exceptions.get(sc.key);
        if (ex) { ex.count++; status = 'duplicate'; dup++; }
        else {
          exceptions.set(sc.key, { type, raw: sc.raw, key: sc.key, count: 1, first: sc.t, item: idx === undefined ? null : S.items[idx] });
          status = type;
        }
      } else if (firstScan.has(sc.key)) {
        status = 'duplicate'; dup++;
      } else {
        firstScan.set(sc.key, sc);
        status = 'found';
      }
      scanStatus.set(sc.id, status);
    }

    const scope = S.items.filter((it) => sel.has(it.location));
    const byProduct = new Map();
    let found = 0;
    for (const it of scope) {
      const hit = firstScan.get(it.key);
      if (hit) found++;
      let p = byProduct.get(it.product);
      if (!p) { p = { product: it.product, name: it.name, code: it.code, expected: 0, found: 0 }; byProduct.set(it.product, p); }
      p.expected++;
      if (hit) p.found++;
    }
    const exc = [...exceptions.values()];
    R = {
      scope,
      firstScan,
      scanStatus,
      exceptions: exc,
      unknown: exc.filter((e) => e.type === 'unknown').length,
      other: exc.filter((e) => e.type === 'other').length,
      dup,
      expected: scope.length,
      found,
      missing: scope.length - found,
      products: [...byProduct.values()].sort((a, b) => collator.compare(a.name, b.name)),
    };
  }

  /* ------------------------------------------------------------------
   * Views / navigation
   * ------------------------------------------------------------------ */
  let currentView = 'upload';

  function setView(view) {
    if ((view === 'scan' || view === 'report') && !(S && S.started)) view = 'upload';
    currentView = view;
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
    if (view !== 'scan') stopCamera();
    updateStepper();
    if (view === 'upload') renderUpload();
    if (view === 'scan') {
      const last = S.scans[S.scans.length - 1];
      if (last) showFeedback(last, R.scanStatus.get(last.id)); else resetFeedback();
      renderScan();
      focusScan();
    }
    if (view === 'report') renderReport();
    window.scrollTo({ top: 0 });
  }

  function updateStepper() {
    const started = !!(S && S.started);
    const order = ['upload', 'scan', 'report'];
    const cur = order.indexOf(currentView);
    $$('.step').forEach((btn) => {
      const v = btn.dataset.view;
      const i = order.indexOf(v);
      btn.disabled = v !== 'upload' && !started;
      btn.classList.toggle('active', v === currentView);
      btn.classList.toggle('done', i < cur || (v === 'upload' && started && currentView !== 'upload'));
    });
  }

  function initNav() {
    $$('.step').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) setView(g.dataset.goto);
    });
    $('#logout-btn').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Sign out?',
        body: S && S.started ? 'Your current count stays saved on this computer. Sign in again to carry on.' : 'You will need to sign in again.',
        ok: 'Sign out',
      });
      if (!ok) return;
      safeDel(sessionStorage, AUTH_KEY);
      showLogin();
    });
  }

  /* ------------------------------------------------------------------
   * Step 1 — Upload & parse
   * ------------------------------------------------------------------ */
  function parseProduct(raw) {
    const s = String(raw ?? '').trim();
    const m = s.match(/^\[([^\]]+)\]\s*(.*)$/);
    let code = m ? m[1].trim() : '';
    let name = m ? m[2] : s;
    if (code) name = name.replace(new RegExp(`\\s*-{1,2}\\s*${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '');
    name = name.trim() || s || '(no product)';
    return { code, name };
  }

  function findCol(header, tests) {
    for (const t of tests) {
      const i = header.findIndex((h) => t.test(h));
      if (i >= 0) return i;
    }
    return -1;
  }

  async function parseFile(file) {
    if (typeof XLSX === 'undefined') throw new Error('The spreadsheet reader did not load. Check that the "vendor" folder is next to index.html.');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });

    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: false, blankrows: false });
      for (let h = 0; h < Math.min(rows.length, 20); h++) {
        const header = rows[h].map((c) => String(c).trim().toLowerCase());
        const cSerial = findCol(header, [/^lot\s*\/\s*serial(\s*number)?$/, /lot.*serial|serial.*lot/, /serial/, /^lot$/]);
        if (cSerial < 0) continue;
        const cProduct = findCol(header, [/^product$/, /^product\s*name$/, /^product(?!.*(categ|uom|unit))/]);
        const cLocation = findCol(header, [/^location$/, /location/]);
        const cQty = findCol(header, [/^quantity$/, /^on\s*hand/, /^quantity/, /^qty/]);
        const cUnit = findCol(header, [/^unit$/, /unit of measure|uom/, /^unit/]);

        const items = [];
        const seen = new Set();
        let noSerial = 0;
        let dupes = 0;
        for (let r = h + 1; r < rows.length; r++) {
          const row = rows[r];
          const serial = String(row[cSerial] ?? '').trim();
          if (!serial) { if (row.some((c) => String(c).trim())) noSerial++; continue; }
          const key = norm(serial);
          if (seen.has(key)) { dupes++; continue; }
          seen.add(key);
          const product = cProduct >= 0 ? String(row[cProduct] ?? '').trim() : '';
          const { code, name } = parseProduct(product);
          items.push({
            key,
            serial,
            product: product || '(no product)',
            code,
            name,
            location: cLocation >= 0 ? (String(row[cLocation] ?? '').trim() || '(no location)') : '(no location)',
            qty: cQty >= 0 ? Number(String(row[cQty]).replace(/,/g, '')) || 0 : 1,
            unit: cUnit >= 0 ? String(row[cUnit] ?? '').trim() : '',
          });
        }
        if (!items.length) throw new Error('The "Lot/Serial Number" column was found but it has no values.');
        const locMap = new Map();
        items.forEach((it) => locMap.set(it.location, (locMap.get(it.location) || 0) + 1));
        const locations = [...locMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => collator.compare(a.name, b.name));
        return { items, locations, noSerial, dupes, missingProductCol: cProduct < 0 };
      }
    }
    throw new Error('Could not find a "Lot/Serial Number" column. Export the stock.quant list from Odoo with that column included.');
  }

  async function handleFile(file) {
    if (!file) return;
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) { toast('Choose an Excel (.xlsx / .xls) or CSV file.'); return; }

    if (S && S.started && S.scans.length) {
      const ok = await confirmDialog({
        title: 'Replace the current count?',
        body: `The count in progress has ${fmtInt(S.scans.length)} scans. Loading a new file deletes them. Export the report first if you need it.`,
        ok: 'Replace & start over',
        danger: true,
      });
      if (!ok) return;
    }

    try {
      const parsed = await parseFile(file);
      S = {
        fileName: file.name,
        uploadedAt: Date.now(),
        startedAt: null,
        items: parsed.items,
        locations: parsed.locations,
        selected: parsed.locations.map((l) => l.name),
        started: false,
        scans: [],
        warnings: [
          parsed.noSerial ? `${fmtInt(parsed.noSerial)} row(s) without a serial number were skipped.` : '',
          parsed.dupes ? `${fmtInt(parsed.dupes)} duplicate serial row(s) in the file were merged.` : '',
          parsed.missingProductCol ? 'No "Product" column was found, so product names will be blank.' : '',
        ].filter(Boolean),
      };
      rebuildIndex();
      compute();
      saveSession();
      renderUpload();
      updateStepper();
      toast(`Loaded ${fmtInt(parsed.items.length)} serial items from ${file.name}`);
    } catch (err) {
      console.error(err);
      confirmDialog({ title: 'Could not read this file', body: err.message || String(err), ok: 'OK' });
    }
  }

  function initUpload() {
    const dz = $('#dropzone');
    const input = $('#file-input');
    input.addEventListener('change', () => { handleFile(input.files[0]); input.value = ''; });
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
    dz.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));
    // keep the browser from opening files dropped outside the zone
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    $('#replace-file').addEventListener('click', () => input.click());
    $('#loc-all').addEventListener('click', () => { S.selected = S.locations.map((l) => l.name); afterScopeChange(); });
    $('#loc-none').addEventListener('click', () => { S.selected = []; afterScopeChange(); });
    $('#loc-list').addEventListener('change', (e) => {
      const cb = e.target.closest('input[type=checkbox]');
      if (!cb) return;
      const set = new Set(S.selected);
      cb.checked ? set.add(cb.value) : set.delete(cb.value);
      S.selected = S.locations.map((l) => l.name).filter((n) => set.has(n));
      afterScopeChange();
    });
    $('#start-scan').addEventListener('click', () => {
      if (!S || !S.selected.length) return;
      if (!S.started) { S.started = true; S.startedAt = Date.now(); }
      saveSession();
      setView('scan');
    });
  }

  function afterScopeChange() {
    compute();
    saveSession();
    renderUpload();
  }

  function renderUpload() {
    const has = !!S;
    $('#upload-summary').classList.toggle('hidden', !has);
    $('#dropzone').classList.toggle('compact', has);
    $('#active-session-banner').classList.toggle('hidden', !(has && S.started));
    if (!has) return;

    if (S.started) {
      $('#active-session-text').textContent = `${S.fileName}: ${fmtInt(R.found)} of ${fmtInt(R.expected)} found, ${fmtInt(S.scans.length)} scans so far.`;
    }
    $('#sum-file').textContent = S.fileName;
    $('#sum-time').textContent = `Loaded ${fmtDateTime(S.uploadedAt)}`;
    $('#sum-items').textContent = fmtInt(S.items.length);
    $('#sum-products').textContent = fmtInt(new Set(S.items.map((i) => i.product)).size);
    $('#sum-locations').textContent = fmtInt(S.locations.length);
    $('#sum-warnings').innerHTML = (S.warnings || []).map((w) => `<div class="alert alert-warn">${esc(w)}</div>`).join('');

    const sel = new Set(S.selected);
    $('#loc-list').innerHTML = S.locations.map((l) => `
      <label class="loc-item ${sel.has(l.name) ? 'on' : ''}">
        <input type="checkbox" value="${esc(l.name)}" ${sel.has(l.name) ? 'checked' : ''} />
        <span class="loc-name">${esc(l.name)}</span>
        <span class="loc-count">${fmtInt(l.count)}</span>
      </label>`).join('');

    const btn = $('#start-scan');
    btn.disabled = !S.selected.length;
    btn.innerHTML = `${S.started ? 'Continue scanning' : 'Start scanning'} <span aria-hidden="true">→</span>`;
    $('#scope-note').innerHTML = S.selected.length
      ? `<strong>${fmtInt(R.expected)}</strong> items in <strong>${S.selected.length}</strong> location${S.selected.length > 1 ? 's' : ''} will be counted.`
      : 'Select at least one location to count.';
  }

  /* ------------------------------------------------------------------
   * Step 2 — Scanning
   * ------------------------------------------------------------------ */
  const ICONS = {
    found: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>',
    duplicate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    unknown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>',
    other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-6.3-7-11a7 7 0 0 1 14 0c0 4.7-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
    idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg>',
  };
  const R_MARK = { found: '✓', duplicate: '2×', unknown: '!', other: '⌖' };

  let lastHitProduct = null;

  function addScan(raw, src = 'scanner', quiet = false) {
    const text = String(raw ?? '').trim();
    if (!text || !S || !S.started) return null;
    const key = resolveKey(text);
    if (!key) return null;
    const scan = { id: uid(), raw: text, key, t: Date.now(), src };
    S.scans.push(scan);
    compute();
    const status = R.scanStatus.get(scan.id);
    if (!quiet) {
      saveSession();
      showFeedback(scan, status);
      beep(status);
      renderScan(scan.id);
    }
    return status;
  }

  function showFeedback(scan, status) {
    const fb = $('#feedback');
    const idx = index.get(scan.key);
    const it = idx === undefined ? null : S.items[idx];
    let title, sub;
    if (status === 'found') {
      title = 'Matched';
      sub = `<span class="mono">${esc(it.serial)}</span> · ${esc(it.name)}${it.code ? ` <span class="muted">(${esc(it.code)})</span>` : ''} · ${esc(it.location)}`;
    } else if (status === 'duplicate') {
      const first = R.firstScan.get(scan.key) || R.exceptions.find((e) => e.key === scan.key);
      title = 'Already scanned';
      sub = `<span class="mono">${esc(it ? it.serial : scan.raw)}</span>${it ? ' · ' + esc(it.name) : ''} was first scanned at ${fmtTime(first && (first.t || first.first))}. Not counted twice.`;
    } else if (status === 'other') {
      title = 'On report, but in a location you are not counting';
      sub = `<span class="mono">${esc(it.serial)}</span> · ${esc(it.name)} · Odoo location: <strong>${esc(it.location)}</strong>`;
    } else {
      title = 'Not in stock report';
      sub = `<span class="mono">${esc(scan.raw)}</span> is not on the uploaded Odoo report. It is listed under exceptions.`;
    }
    const cls = status === 'found' ? 'found' : status === 'duplicate' ? 'duplicate' : status === 'other' ? 'other' : 'unknown';
    fb.className = `feedback ${cls}`;
    $('#fb-icon').innerHTML = ICONS[cls];
    $('#fb-title').textContent = title;
    $('#fb-sub').innerHTML = sub;
    void fb.offsetWidth;
    fb.classList.add('flash');
    lastHitProduct = status === 'found' ? it.product : null;
  }

  function resetFeedback() {
    $('#feedback').className = 'feedback idle';
    $('#fb-icon').innerHTML = ICONS.idle;
    $('#fb-title').textContent = 'Waiting for first scan';
    $('#fb-sub').textContent = 'Scan a QR label. The result shows up here.';
  }

  function renderScan(newId) {
    if (!S || !R) return;
    // progress ring
    const pct = R.expected ? Math.floor((R.found / R.expected) * 1000) / 10 : 0;
    const C = 2 * Math.PI * 52;
    const ring = $('#ring-fg');
    ring.style.strokeDasharray = C;
    ring.style.strokeDashoffset = C * (1 - (R.expected ? R.found / R.expected : 0));
    ring.classList.toggle('zero', !R.found);
    $('#ring-pct').textContent = `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
    $('#st-found').textContent = fmtInt(R.found);
    $('#st-missing').textContent = fmtInt(R.missing);
    $('#st-unknown').textContent = fmtInt(R.unknown);
    $('#st-other').textContent = fmtInt(R.other);
    $('#st-dup').textContent = fmtInt(R.dup);
    $('#st-expected').textContent = fmtInt(R.expected);

    // recent scans (latest 60)
    const recent = S.scans.slice(-60).reverse();
    $('#recent-count').textContent = `${fmtInt(S.scans.length)} total`;
    $('#recent-list').innerHTML = recent.length
      ? recent.map((sc) => {
        const st = R.scanStatus.get(sc.id);
        const idx = index.get(sc.key);
        const it = idx === undefined ? null : S.items[idx];
        const label = st === 'found' ? '' : st === 'duplicate' ? 'Duplicate · ' : st === 'other' ? `Other location (${it ? it.location : ''}) · ` : 'Not in report';
        return `<li class="${sc.id === newId ? 'new' : ''}">
          <span class="r-ico ${st}">${R_MARK[st]}</span>
          <div class="r-main">
            <div class="r-serial">${esc(it ? it.serial : sc.raw)}</div>
            <div class="r-prod">${esc(label)}${it ? esc(it.name) : ''}</div>
          </div>
          <span class="r-time">${fmtTime(sc.t)}</span>
          <button class="r-del" data-del="${sc.id}" title="Remove this scan" aria-label="Remove this scan">×</button>
        </li>`;
      }).join('')
      : '<li class="empty" style="display:block;border:0">No scans yet.</li>';

    renderProductProgress();
    $('#undo-btn').disabled = !S.scans.length;
  }

  function renderProductProgress() {
    const q = norm($('#prod-filter').value);
    const list = R.products.filter((p) => !q || norm(p.product).includes(q));
    $('#product-progress').innerHTML = list.map((p) => {
      const pct = p.expected ? (p.found / p.expected) * 100 : 0;
      return `<li class="${p.product === lastHitProduct ? 'hit' : ''}">
        <div class="pp-top"><span class="pp-name" title="${esc(p.product)}">${esc(p.name)}</span><span class="pp-num"><b>${p.found}</b> / ${p.expected}</span></div>
        ${p.code ? `<div class="pp-code">${esc(p.code)}</div>` : ''}
        <div class="bar ${p.found === p.expected ? 'complete' : ''}"><i style="width:${pct}%"></i></div>
      </li>`;
    }).join('') || '<li class="empty" style="border:0">No products match.</li>';
    lastHitProduct = null;
  }

  function focusScan() {
    const input = $('#scan-input');
    if (currentView === 'scan' && document.activeElement !== input) input.focus({ preventScroll: true });
  }

  async function removeScan(id) {
    const i = S.scans.findIndex((s) => s.id === id);
    if (i < 0) return;
    const [removed] = S.scans.splice(i, 1);
    compute();
    saveSession();
    renderScan();
    if (!S.scans.length) resetFeedback();
    toast(`Removed scan ${removed.raw}`);
    focusScan();
  }

  function initScan() {
    const form = $('#scan-form');
    const input = $('#scan-input');
    const card = $('#scan-card');

    const submit = () => {
      const v = input.value;
      input.value = '';
      if (v.trim()) addScan(v, 'scanner');
    };
    form.addEventListener('submit', (e) => { e.preventDefault(); submit(); focusScan(); });
    // Some scanners finish with Tab instead of Enter.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && input.value.trim()) { e.preventDefault(); submit(); }
    });
    // Paste several serials at once (one per line).
    input.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!/[\r\n]/.test(text.trim())) return;
      e.preventDefault();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      let last = null;
      lines.forEach((l) => { last = addScan(l, 'paste', true) || last; });
      saveSession();
      const lastScan = S.scans[S.scans.length - 1];
      if (lastScan) showFeedback(lastScan, R.scanStatus.get(lastScan.id));
      beep(last || 'found');
      renderScan();
      toast(`Added ${fmtInt(lines.length)} pasted serial numbers`);
    });

    input.addEventListener('focus', () => { card.classList.add('focused'); $('#ready-text').textContent = 'Ready to scan'; });
    input.addEventListener('blur', () => { card.classList.remove('focused'); $('#ready-text').textContent = 'Paused: click here or start scanning to resume'; });
    card.addEventListener('click', (e) => { if (!e.target.closest('button, input, a, #camera-wrap')) focusScan(); });

    // If the scanner "types" while focus is elsewhere on the scan page, send it to the scan box.
    document.addEventListener('keydown', (e) => {
      if (currentView !== 'scan' || $('#app').classList.contains('hidden') || !$('#modal').classList.contains('hidden')) return;
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT')) return;
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) focusScan();
    });

    $('#recent-list').addEventListener('click', (e) => {
      const b = e.target.closest('[data-del]');
      if (b) removeScan(b.dataset.del);
    });
    $('#undo-btn').addEventListener('click', () => {
      if (S && S.scans.length) removeScan(S.scans[S.scans.length - 1].id);
    });
    $('#prod-filter').addEventListener('input', renderProductProgress);

    const soundBtn = $('#sound-btn');
    const paintSound = () => {
      soundBtn.setAttribute('aria-pressed', String(prefs.sound));
      $('#sound-label').textContent = prefs.sound ? 'Sound on' : 'Sound off';
      $('#sound-wave').style.display = prefs.sound ? '' : 'none';
    };
    paintSound();
    soundBtn.addEventListener('click', () => {
      prefs.sound = !prefs.sound;
      safeSet(localStorage, PREFS_KEY, prefs);
      paintSound();
      if (prefs.sound) beep('found');
      focusScan();
    });

    $('#camera-btn').addEventListener('click', () => (camera ? stopCamera() : startCamera()));
    resetFeedback();
  }

  /* ---- camera scanning (html5-qrcode) ---- */
  let camera = null;
  let lastCam = { text: '', t: 0 };

  async function startCamera() {
    if (typeof Html5Qrcode === 'undefined') { toast('Camera scanner library did not load.'); return; }
    if (!window.isSecureContext) {
      confirmDialog({ title: 'Camera needs a secure page', body: 'Browsers only allow the camera on https:// or http://localhost. Start the app with start.command (Mac) or start.bat (Windows), then open http://localhost:8080.', ok: 'OK' });
      return;
    }
    $('#camera-wrap').classList.remove('hidden');
    $('#camera-label').textContent = 'Stop camera';
    try {
      camera = new Html5Qrcode('camera-box', { verbose: false });
      await camera.start(
        { facingMode: 'environment' },
        { fps: 12, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
        (text) => {
          const now = Date.now();
          if (text === lastCam.text && now - lastCam.t < CAMERA_REPEAT_MS) return;
          lastCam = { text, t: now };
          addScan(text, 'camera');
        },
        () => {}
      );
    } catch (err) {
      console.error(err);
      toast('Could not start the camera. Check browser permissions.', 4000);
      stopCamera();
    }
  }

  async function stopCamera() {
    const cam = camera;
    camera = null;
    $('#camera-wrap')?.classList.add('hidden');
    const lbl = $('#camera-label');
    if (lbl) lbl.textContent = 'Use camera';
    if (cam) {
      try { if (cam.isScanning) await cam.stop(); cam.clear(); } catch { /* ignore */ }
    }
  }

  /* ------------------------------------------------------------------
   * Step 3 — Report
   * ------------------------------------------------------------------ */
  const filt = { status: 'all', product: '', location: '', q: '' };

  function itemRows() {
    return R.scope
      .map((it) => {
        const hit = R.firstScan.get(it.key);
        return { ...it, found: !!hit, scannedAt: hit ? hit.t : null };
      })
      .sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.product, b.product) || collator.compare(a.serial, b.serial));
  }

  function renderReport() {
    if (!S || !R) return;
    const meta = `${S.fileName} · Locations: ${S.selected.join(', ')} · Started ${fmtDateTime(S.startedAt)} · Generated ${fmtDateTime(Date.now())}`;
    $('#report-meta').textContent = meta;
    $('#print-meta').textContent = meta + ' · Counted by odooadmin';

    $('#r-expected').textContent = fmtInt(R.expected);
    $('#r-found').textContent = fmtInt(R.found);
    $('#r-found-s').textContent = R.expected ? `${((R.found / R.expected) * 100).toFixed(1)}% accuracy` : '';
    $('#r-missing').textContent = fmtInt(R.missing);
    $('#r-unknown').textContent = fmtInt(R.unknown);
    $('#r-other').textContent = fmtInt(R.other);

    // product summary
    $('#product-table tbody').innerHTML = R.products.map((p) => {
      const pct = p.expected ? (p.found / p.expected) * 100 : 0;
      return `<tr data-product="${esc(p.product)}" class="${filt.product === p.product ? 'selected' : ''}">
        <td class="t-prod">${esc(p.name)}</td>
        <td class="mono">${esc(p.code)}</td>
        <td class="num">${fmtInt(p.expected)}</td>
        <td class="num">${fmtInt(p.found)}</td>
        <td class="num">${p.expected - p.found ? `<b style="color:var(--red)">${fmtInt(p.expected - p.found)}</b>` : '0'}</td>
        <td><div class="prog-cell"><div class="bar ${pct === 100 ? 'complete' : ''}"><i style="width:${pct}%"></i></div><span>${Math.floor(pct)}%</span></div></td>
      </tr>`;
    }).join('');

    // filter dropdowns
    const fp = $('#f-product');
    fp.innerHTML = '<option value="">All products</option>' + R.products.map((p) => `<option value="${esc(p.product)}">${esc(p.name)}${p.code ? ` (${esc(p.code)})` : ''}</option>`).join('');
    fp.value = filt.product;
    const fl = $('#f-location');
    fl.innerHTML = '<option value="">All locations</option>' + S.selected.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
    fl.value = S.selected.includes(filt.location) ? filt.location : (filt.location = '');

    renderDetail();
    renderExceptions();
  }

  function renderDetail() {
    const rows = itemRows();
    const q = norm(filt.q);
    const base = rows.filter((r) =>
      (!filt.product || r.product === filt.product) &&
      (!filt.location || r.location === filt.location) &&
      (!q || norm(r.serial).includes(q) || norm(r.product).includes(q)));
    const counts = { all: base.length, found: base.filter((r) => r.found).length };
    counts.missing = counts.all - counts.found;
    $$('#status-seg button').forEach((b) => {
      b.classList.toggle('active', b.dataset.status === filt.status);
      b.querySelector('span').textContent = fmtInt(counts[b.dataset.status]);
    });
    const list = base.filter((r) => filt.status === 'all' || (filt.status === 'found' ? r.found : !r.found));
    $('#detail-table tbody').innerHTML = list.map((r, i) => `<tr>
      <td class="num muted">${i + 1}</td>
      <td>${r.found ? '<span class="badge badge-found">Found</span>' : '<span class="badge badge-missing">Missing</span>'}</td>
      <td class="mono">${esc(r.serial)}</td>
      <td><div class="t-prod">${esc(r.name)}</div>${r.code ? `<div class="t-sub mono">${esc(r.code)}</div>` : ''}</td>
      <td>${esc(r.location)}</td>
      <td class="muted">${r.scannedAt ? fmtDateTime(r.scannedAt) : '—'}</td>
    </tr>`).join('');
    $('#detail-empty').classList.toggle('hidden', list.length > 0);
  }

  function renderExceptions() {
    const ex = R.exceptions;
    $('#exc-count').textContent = ex.length ? `${fmtInt(ex.length)} label${ex.length > 1 ? 's' : ''}` : '';
    $('#exc-empty').classList.toggle('hidden', ex.length > 0);
    $('#exc-table').classList.toggle('hidden', !ex.length);
    $('#exc-table tbody').innerHTML = ex.map((e) => `<tr>
      <td>${e.type === 'unknown' ? '<span class="badge badge-unknown">Not in report</span>' : '<span class="badge badge-other">Other location</span>'}</td>
      <td class="mono">${esc(e.item ? e.item.serial : e.raw)}</td>
      <td>${e.item ? esc(e.item.name) : '<span class="muted">Unknown</span>'}</td>
      <td>${e.item ? esc(e.item.location) : '—'}</td>
      <td class="num">${e.count}</td>
      <td class="muted">${fmtTime(e.first)}</td>
    </tr>`).join('');
  }

  function exportExcel() {
    if (typeof XLSX === 'undefined') { toast('Spreadsheet library not loaded.'); return; }
    const now = new Date();
    const rows = itemRows();
    const fmtX = (t) => (t ? new Date(t).toLocaleString() : '');

    const summary = [
      ['BatteryLab: Stock Reconciliation Report'],
      [],
      ['Source file', S.fileName],
      ['Locations counted', S.selected.join(', ')],
      ['Count started', fmtX(S.startedAt)],
      ['Report generated', fmtX(now)],
      ['Counted by', 'odooadmin'],
      [],
      ['Expected items (on report)', R.expected],
      ['Found', R.found],
      ['Missing', R.missing],
      ['Accuracy', R.expected ? `${((R.found / R.expected) * 100).toFixed(2)}%` : '—'],
      ['Scanned, not in report', R.unknown],
      ['Scanned, in another location', R.other],
      ['Duplicate scans (ignored)', R.dup],
      ['Total scans', S.scans.length],
    ];

    const detail = rows.map((r, i) => ({
      '#': i + 1,
      Status: r.found ? '✔ FOUND' : '✘ MISSING',
      'Lot/Serial Number': r.serial,
      'Product Code': r.code,
      'Product Name': r.name,
      'Product (Odoo)': r.product,
      Location: r.location,
      Quantity: r.qty,
      Unit: r.unit,
      'Scanned At': fmtX(r.scannedAt),
    }));
    const byProduct = R.products.map((p) => ({
      'Product Code': p.code,
      'Product Name': p.name,
      Expected: p.expected,
      Found: p.found,
      Missing: p.expected - p.found,
      'Progress %': p.expected ? Math.round((p.found / p.expected) * 1000) / 10 : 0,
    }));
    const exceptions = R.exceptions.map((e) => ({
      Type: e.type === 'unknown' ? 'Not in report' : 'In report, other location',
      'Scanned Value': e.raw,
      'Lot/Serial Number': e.item ? e.item.serial : '',
      Product: e.item ? e.item.product : '',
      'Report Location': e.item ? e.item.location : '',
      'Times Scanned': e.count,
      'First Scanned': fmtX(e.first),
    }));
    const log = S.scans.map((sc, i) => {
      const idx = index.get(sc.key);
      const it = idx === undefined ? null : S.items[idx];
      const st = R.scanStatus.get(sc.id);
      return {
        '#': i + 1,
        Time: fmtX(sc.t),
        'Scanned Value': sc.raw,
        Result: { found: 'Found', duplicate: 'Duplicate', other: 'Other location', unknown: 'Not in report' }[st],
        Product: it ? it.product : '',
        Source: sc.src,
      };
    });

    const wb = XLSX.utils.book_new();
    const add = (name, ws, cols) => {
      if (cols) ws['!cols'] = cols.map((w) => ({ wch: w }));
      if (ws['!ref'] && name !== 'Summary') ws['!autofilter'] = { ref: ws['!ref'] };
      XLSX.utils.book_append_sheet(wb, ws, name);
    };
    const sheet = (data, header) => XLSX.utils.json_to_sheet(data, { header });
    add('Summary', XLSX.utils.aoa_to_sheet(summary), [32, 60]);
    add('Full Report', sheet(detail, Object.keys(detail[0] || { '#': 0, Status: '', 'Lot/Serial Number': '' })), [6, 12, 24, 16, 30, 40, 26, 9, 7, 22]);
    add('Missing', sheet(detail.filter((d) => d.Status.includes('MISSING')).map((d, i) => ({ ...d, '#': i + 1 }))), [6, 12, 24, 16, 30, 40, 26, 9, 7, 22]);
    add('Found', sheet(detail.filter((d) => d.Status.includes('FOUND')).map((d, i) => ({ ...d, '#': i + 1 }))), [6, 12, 24, 16, 30, 40, 26, 9, 7, 22]);
    add('By Product', sheet(byProduct), [16, 34, 10, 10, 10, 11]);
    add('Exceptions', sheet(exceptions.length ? exceptions : [{ Type: 'None', 'Scanned Value': 'Every scanned label was on the report' }]), [24, 28, 24, 40, 26, 14, 22]);
    add('Scan Log', sheet(log.length ? log : [{ '#': '', Time: 'No scans' }]), [6, 22, 28, 16, 40, 10]);

    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `BatteryLab_Stock_Count_${stamp}.xlsx`);
    toast('Excel report downloaded');
  }

  function initReport() {
    $('#status-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      filt.status = b.dataset.status;
      renderDetail();
    });
    $('#f-product').addEventListener('change', (e) => { filt.product = e.target.value; renderReport(); });
    $('#f-location').addEventListener('change', (e) => { filt.location = e.target.value; renderDetail(); });
    let t;
    $('#f-search').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { filt.q = e.target.value; renderDetail(); }, 120); });
    $('#product-table tbody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-product]');
      if (!tr) return;
      filt.product = filt.product === tr.dataset.product ? '' : tr.dataset.product;
      renderReport();
      if (filt.product) $('#detail-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('#export-btn').addEventListener('click', exportExcel);
    $('#print-btn').addEventListener('click', () => window.print());
    $('#new-count').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Start a new count?',
        body: 'This clears the uploaded report and every scan from this computer. Export the Excel report first if you need to keep it.',
        ok: 'Clear & start new',
        danger: true,
      });
      if (!ok) return;
      clearSession();
      Object.assign(filt, { status: 'all', product: '', location: '', q: '' });
      $('#f-search').value = '';
      resetFeedback();
      setView('upload');
      toast('Ready for a new count');
    });
  }

  /* ------------------------------------------------------------------
   * Boot
   * ------------------------------------------------------------------ */
  function boot() {
    initLogin();
    initNav();
    initUpload();
    initScan();
    initReport();
    // keep other open tabs of the app in sync (e.g. report open in a second tab)
    window.addEventListener('storage', (e) => {
      if (e.key !== STORE_KEY || $('#app').classList.contains('hidden')) return;
      loadSession();
      setView(currentView);
    });
    if (isAuthed()) enterApp();
    else showLogin();
  }

  // exposed for automated tests only
  window.__blInv = { sha256, norm, parseProduct };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
