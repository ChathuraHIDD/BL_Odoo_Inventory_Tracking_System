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

  // Fixed list of products counted by scanning every serial label (by product code, or by name when there is no code).
  // Every other product is counted by hand (Manual count step). The list can be changed in Settings.
  const SCAN_CODES = [
    'BL-AQAX-001', 'BL-AQAX-006', 'BL-AQAX-007', 'BL-BAT-008', 'BL-P3A-011', 'BL-P3A-012', 'BL-P3A-015',
    'BL-BAT-001', 'BL-BAT-002', 'BL-BAT-003', 'BL-BAT-004', 'BL-BAT-005', 'BL-BAT-006', 'IMP_USED',
    'BL-CON-001', 'BL-CON-002', 'BL-CON-003', 'BL-CON-004', 'BL-CON-005',
  ];
  const SCAN_NAMES = ['REPAIR PACK BATTERY MODULES', 'IMPORTED USED BATTERY', 'SCRAP USED BATTERY'];

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

  /** Spoken notice (browser text-to-speech). Follows the Sound on/off button. */
  function speak(text) {
    if (!prefs.sound || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel(); // never queue up behind an older message
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 1.05;
      u.volume = 1;
      window.speechSynthesis.speak(u);
    } catch { /* speech not available */ }
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
  let looseIndex = new Map(); // letters+digits only -> normalized serial (null when two serials collide)
  let R = null; // derived results (see compute())

  /** Letters and digits only. Scanner guns set to another keyboard layout often mistype "-" and "/". */
  const loose = (v) => String(v ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

  function rebuildIndex() {
    index = new Map();
    looseIndex = new Map();
    productKeys = new Map();
    if (!S) return;
    S.items.forEach((it, i) => {
      if (!productKeys.has(it.product)) productKeys.set(it.product, productKey(it.code, it.name));
      if (!it.key) return;
      index.set(it.key, i);
      const l = loose(it.key);
      if (l) looseIndex.set(l, looseIndex.has(l) && looseIndex.get(l) !== it.key ? null : it.key);
    });
  }

  /** Key used for the scan list: the product code, or the product name when there is no code. */
  const productKey = (code, name) => String(code || name || '').trim().toUpperCase();
  const SCAN_DEFAULT = [...SCAN_CODES, ...SCAN_NAMES];
  const loadScanSet = () => new Set(Array.isArray(prefs.scanList) ? prefs.scanList : SCAN_DEFAULT);
  let scanSet = loadScanSet();
  let productKeys = new Map(); // product (as in the report) -> scan-list key

  /** 'scan' or 'manual' for a product, from the scan list (Settings). */
  const modeOf = (product) => (scanSet.has(productKeys.get(product) || productKey('', product)) ? 'scan' : 'manual');

  function ensureModes() {
    if (!S) return;
    S.manual = S.manual || {};
  }

  function loadSession() {
    S = safeGet(localStorage, STORE_KEY);
    if (S && !Array.isArray(S.items)) S = null;
    ensureModes();
    rebuildIndex();
    if (S) {
      // re-match saved scans with the current rules (e.g. serials scanned with a mistyped "-" or "/")
      S.scans = (S.scans || []).map((sc) => ({ ...sc, key: resolveKey(sc.raw) || sc.key }));
      // one record per serial: drop any repeat scans saved by older versions
      const seen = new Set();
      S.scans = S.scans.filter((sc) => !seen.has(sc.key) && seen.add(sc.key));
    }
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
    // same serial with "-" or "/" mistyped or missing (scanner keyboard layout)
    const byLoose = (v) => { const l = loose(v); return l ? looseIndex.get(l) : undefined; };
    let hit = byLoose(raw);
    if (hit) return hit;
    // QR codes sometimes carry more than the serial (URL, "serial|product", key=value, JSON …).
    let text = String(raw);
    try { text = decodeURIComponent(text); } catch { /* keep raw */ }
    const tokens = text.split(/[\s,;|\t\r\n?&=#"'{}\[\]()<>:]+/).map(norm).filter(Boolean);
    for (const t of tokens) if (index.has(t)) return t;
    for (const t of tokens) if ((hit = byLoose(t))) return hit;
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
      if (idx !== undefined && modeOf(S.items[idx].product) === 'manual') {
        status = 'manual'; // product is counted by hand: the scan is kept in the log but not counted
      } else if (idx === undefined || !sel.has(S.items[idx].location)) {
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

    const scope = S.items.filter((it) => it.key && sel.has(it.location) && modeOf(it.product) === 'scan');
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
    // manual count: quantity on the report per product vs. the quantity typed in
    const man = new Map();
    for (const it of S.items) {
      if (!sel.has(it.location) || modeOf(it.product) !== 'manual') continue;
      let m = man.get(it.product);
      if (!m) { m = { product: it.product, name: it.name, code: it.code, unit: it.unit, expected: 0, locations: new Set() }; man.set(it.product, m); }
      m.expected += Number(it.qty) || 0;
      m.locations.add(it.location);
    }
    const manual = [...man.values()].map((m) => {
      const v = S.manual[m.product];
      const counted = v === undefined || v === null || v === '' ? null : Number(v);
      return { ...m, locations: [...m.locations], counted, diff: counted === null ? null : Math.round((counted - m.expected) * 1000) / 1000 };
    }).sort((a, b) => collator.compare(a.name, b.name));
    const sum = (arr, f) => arr.reduce((t, x) => t + (f(x) || 0), 0);
    const entered = manual.filter((m) => m.counted !== null);
    const manualStats = {
      products: manual.length,
      entered: entered.length,
      notCounted: manual.length - entered.length,
      match: entered.filter((m) => m.diff === 0).length,
      short: entered.filter((m) => m.diff < 0).length,
      over: entered.filter((m) => m.diff > 0).length,
      expected: sum(manual, (m) => m.expected),
      counted: sum(entered, (m) => m.counted),
      expectedEntered: sum(entered, (m) => m.expected),
    };

    const exc = [...exceptions.values()];
    R = {
      manual,
      man: manualStats,
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
    if (view !== 'upload' && view !== 'settings' && !(S && S.started)) view = 'upload';
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
    if (view === 'manual') renderManual();
    if (view === 'settings') renderSettings();
    if (view === 'report') renderReport();
    window.scrollTo({ top: 0 });
  }

  function updateStepper() {
    const started = !!(S && S.started);
    const order = ['upload', 'scan', 'manual', 'report'];
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
    $('#settings-btn').addEventListener('click', () => setView('settings'));
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

  /** Spreadsheet cell -> JSON-safe value (dates become YYYY-MM-DD). */
  function cellValue(v) {
    if (v instanceof Date) {
      if (isNaN(v)) return '';
      const p = (n) => String(n).padStart(2, '0');
      const d = `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
      return v.getHours() || v.getMinutes() ? `${d} ${p(v.getHours())}:${p(v.getMinutes())}` : d;
    }
    return v ?? '';
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
      // same rows again with real numbers/dates, used to rebuild the report in the original layout
      const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: true, blankrows: false });
      for (let h = 0; h < Math.min(rows.length, 20); h++) {
        const header = rows[h].map((c) => String(c).trim().toLowerCase());
        const cSerial = findCol(header, [/^lot\s*\/\s*serial(\s*number)?$/, /lot.*serial|serial.*lot/, /serial/, /^lot$/]);
        if (cSerial < 0) continue;
        const columns = rows[h].map((c) => String(c).trim());
        while (columns.length && !columns[columns.length - 1]) columns.pop();
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
          const product = cProduct >= 0 ? String(row[cProduct] ?? '').trim() : '';
          // rows with no serial: Odoo group headers (no product) are skipped; real stock lines are kept for manual count
          if (!serial && !product) continue;
          const key = serial ? norm(serial) : '';
          if (!serial) noSerial++;
          else if (seen.has(key)) { dupes++; continue; }
          else seen.add(key);
          const { code, name } = parseProduct(product);
          items.push({
            key,
            serial,
            product: product || '(no product)',
            code,
            name,
            location: cLocation >= 0 ? (String(row[cLocation] ?? '').trim() || '(no location)') : '(no location)',
            qty: cQty >= 0 ? Number(String(row[cQty]).replace(/,/g, '')) || 0 : (serial ? 1 : 0),
            unit: cUnit >= 0 ? String(row[cUnit] ?? '').trim() : '',
            cells: columns.map((_, c) => cellValue(rawRows[r] ? rawRows[r][c] : row[c])),
          });
        }
        if (!items.length) throw new Error('The "Lot/Serial Number" column was found but it has no values.');
        const locMap = new Map();
        items.forEach((it) => locMap.set(it.location, (locMap.get(it.location) || 0) + 1));
        const locations = [...locMap.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => collator.compare(a.name, b.name));
        return { items, columns, locations, noSerial, dupes, missingProductCol: cProduct < 0 };
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
        columns: parsed.columns,
        locations: parsed.locations,
        selected: parsed.locations.map((l) => l.name),
        started: false,
        scans: [],
        warnings: [
          parsed.noSerial ? `${fmtInt(parsed.noSerial)} stock line(s) without a serial number will be counted by hand (Manual count).` : '',
          parsed.dupes ? `${fmtInt(parsed.dupes)} duplicate serial row(s) in the file were merged.` : '',
          parsed.missingProductCol ? 'No "Product" column was found, so product names will be blank.' : '',
        ].filter(Boolean),
      };
      ensureModes();
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
      ? `<strong>${fmtInt(R.expected)}</strong> items to scan and <strong>${fmtInt(R.man.products)}</strong> products to count by hand in <strong>${S.selected.length}</strong> location${S.selected.length > 1 ? 's' : ''}.`
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
  const R_MARK = { found: '✓', duplicate: '2×', unknown: '!', other: '⌖', manual: '✎' };

  let lastHitProduct = null;
  let liveProduct = null; // product shown in the live counter (product of the latest scan)

  function addScan(raw, src = 'scanner', quiet = false) {
    const text = String(raw ?? '').trim();
    if (!text || !S || !S.started) return null;
    const key = resolveKey(text);
    if (!key) return null;
    const hitIdx = index.get(key);
    if (hitIdx !== undefined && modeOf(S.items[hitIdx].product) === 'manual') {
      // counted by hand: tell the user, but do not record the scan
      if (!quiet) { showFeedback({ raw: text, key, t: Date.now() }, 'manual'); beep('other'); }
      return 'manual';
    }
    const existing = S.scans.find((sc) => sc.key === key);
    if (existing) {
      if (!quiet) {
        showFeedback(existing, 'duplicate');
        beep('duplicate');
        speak('Already scanned');
        setLive(existing);
        renderLive(true);
      }
      return 'duplicate';
    }
    const scan = { id: uid(), raw: text, key, t: Date.now(), src };
    S.scans.push(scan);
    compute();
    const status = R.scanStatus.get(scan.id);
    if (!quiet) {
      saveSession();
      showFeedback(scan, status);
      beep(status);
      setLive(scan);
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
      title = 'Already scanned';
      sub = `<span class="mono">${esc(it ? it.serial : scan.raw)}</span>${it ? ` · ${esc(it.name)}` : ''} · first scanned at ${fmtTime(scan.t)}. Not counted again.`;
    } else if (status === 'manual') {
      title = 'This product is counted by hand';
      sub = `<span class="mono">${esc(it.serial)}</span> · ${esc(it.name)}. Not scanned: enter its quantity in <strong>Manual count</strong>.`;
    } else if (status === 'other') {
      title = 'On report, but in a location you are not counting';
      sub = `<span class="mono">${esc(it.serial)}</span> · ${esc(it.name)} · Odoo location: <strong>${esc(it.location)}</strong>`;
    } else {
      title = 'Not in stock report';
      sub = `<span class="mono">${esc(scan.raw)}</span> is not on the uploaded Odoo report. It is listed under exceptions.`;
    }
    const cls = status === 'manual' ? 'other' : ['found', 'duplicate', 'other'].includes(status) ? status : 'unknown';
    fb.className = `feedback ${cls}`;
    $('#fb-icon').innerHTML = ICONS[cls];
    $('#fb-title').textContent = title;
    $('#fb-sub').innerHTML = sub;
    void fb.offsetWidth;
    fb.classList.add('flash');
    lastHitProduct = status === 'found' ? it.product : null;
  }

  function resetFeedback() {
    liveProduct = null;
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
    $('#st-expected').textContent = fmtInt(R.expected);

    // recent scans (latest 60)
    const recent = S.scans.slice(-60).reverse();
    $('#recent-count').textContent = `${fmtInt(S.scans.length)} scanned`;
    $('#recent-list').innerHTML = recent.length
      ? recent.map((sc) => {
        const st = R.scanStatus.get(sc.id);
        const idx = index.get(sc.key);
        const it = idx === undefined ? null : S.items[idx];
        const label = st === 'found' ? '' : st === 'manual' ? 'Manual count product (not counted) · ' : st === 'other' ? `Other location (${it ? it.location : ''}) · ` : 'Not in report';
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
    renderLive(!!newId);
    $('#undo-btn').disabled = !S.scans.length;
  }

  /** Remember which product the latest scan belongs to. */
  function setLive(scan) {
    const idx = index.get(scan.key);
    if (idx !== undefined) liveProduct = S.items[idx].product;
  }

  /** Live counter beside the scan box: scanned so far vs. expected on the report, for the current product. */
  function renderLive(bump = false) {
    const box = $('#live');
    if (!box || !S || !R) return;
    if (!liveProduct || !R.products.some((p) => p.product === liveProduct)) {
      // after a reload: continue with the product of the latest matched scan
      liveProduct = null;
      for (let i = S.scans.length - 1; i >= 0; i--) {
        const idx = index.get(S.scans[i].key);
        if (idx !== undefined && R.products.some((p) => p.product === S.items[idx].product)) { liveProduct = S.items[idx].product; break; }
      }
    }
    const p = liveProduct && R.products.find((x) => x.product === liveProduct);
    if (!p) {
      box.className = 'live idle';
      box.innerHTML = `<div class="live-l">Now scanning</div>
        <div class="live-empty">Scan a label.<br>The product count shows here.</div>`;
      return;
    }
    const left = p.expected - p.found;
    const pct = p.expected ? (p.found / p.expected) * 100 : 0;
    const done = left <= 0;
    box.className = `live${done ? ' done' : ''}`;
    box.innerHTML = `<div class="live-l">Now scanning</div>
      <div class="live-name" title="${esc(p.product)}">${esc(p.name)}</div>
      ${p.code ? `<div class="live-code">${esc(p.code)}</div>` : ''}
      <div class="live-count${bump ? ' bump' : ''}"><b>${fmtInt(p.found)}</b><span>/ ${fmtInt(p.expected)}</span></div>
      <div class="live-sub">scanned / in report</div>
      <div class="bar ${done ? 'complete' : ''}"><i style="width:${pct}%"></i></div>
      <div class="live-foot"><span>${done ? '<strong>✔ All found</strong>' : `<strong>${fmtInt(left)}</strong> left`}</span><span>${Math.floor(pct)}%</span></div>`;
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
   * Step 3 — Manual count (products counted by hand)
   * ------------------------------------------------------------------ */
  const fmtQty = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 }));
  const fmtDiff = (d) => (d === null ? '—' : d > 0 ? `+${fmtQty(d)}` : d < 0 ? `−${fmtQty(-d)}` : '0');
  const manualStatus = (m) => (m.counted === null ? 'pending' : m.diff === 0 ? 'match' : m.diff < 0 ? 'short' : 'over');
  const MANUAL_LABEL = { pending: 'Not counted', match: 'Match', short: 'Short', over: 'Over' };
  const manualIcon = (m) => {
    const st = manualStatus(m);
    if (st === 'pending') return '<span class="pi pi-wait" title="Not counted yet">–</span>';
    return st === 'match'
      ? `<span class="pi pi-yes" title="Matches the report">${SVG_TICK}</span>`
      : `<span class="pi pi-no" title="${MANUAL_LABEL[st]}">${SVG_CROSS}</span>`;
  };

  function renderManualStats() {
    const m = R.man;
    $('#m-products').textContent = fmtInt(m.products);
    $('#m-entered').textContent = `${fmtInt(m.entered)} / ${fmtInt(m.products)}`;
    $('#m-match').textContent = fmtInt(m.match);
    $('#m-diff').textContent = fmtInt(m.short + m.over);
    $('#m-diff-s').textContent = `${fmtInt(m.short)} short · ${fmtInt(m.over)} over`;
  }

  function renderManual() {
    if (!S || !R) return;
    renderManualStats();
    const q = norm($('#man-filter').value);
    const list = R.manual.filter((m) => !q || norm(m.product).includes(q));
    $('#man-table tbody').innerHTML = list.map((m) => `<tr data-product="${esc(m.product)}" class="m-${manualStatus(m)}">
      <td><div class="t-prod">${esc(m.name)}</div></td>
      <td class="mono">${esc(m.code)}</td>
      <td class="tiny">${esc(m.locations.join(', '))}</td>
      <td class="num"><b>${fmtQty(m.expected)}</b>${m.unit ? ` <span class="muted tiny">${esc(m.unit)}</span>` : ''}</td>
      <td class="c-count"><input class="count-input" type="number" inputmode="decimal" min="0" step="any" value="${m.counted === null ? '' : m.counted}" placeholder="Qty" aria-label="Counted quantity for ${esc(m.name)}" /></td>
      <td class="num m-diff">${fmtDiff(m.diff)}</td>
      <td class="c-pi m-st">${manualIcon(m)}</td>
    </tr>`).join('');
    $('#man-empty').classList.toggle('hidden', R.manual.length > 0);
    $('#man-table').classList.toggle('hidden', !R.manual.length);
  }

  let manualSaveT;
  function onManualInput(input) {
    const tr = input.closest('tr[data-product]');
    const product = tr.dataset.product;
    const v = input.value.trim();
    const ok = v !== '' && !isNaN(Number(v)) && Number(v) >= 0;
    S.manual = Object.fromEntries(Object.entries(S.manual).filter(([k]) => k !== product));
    if (ok) S.manual[product] = Number(v);
    compute();
    const m = R.manual.find((x) => x.product === product);
    if (m) {
      tr.className = `m-${manualStatus(m)}`;
      tr.querySelector('.m-diff').textContent = fmtDiff(m.diff);
      tr.querySelector('.m-st').innerHTML = manualIcon(m);
    }
    renderManualStats();
    clearTimeout(manualSaveT);
    manualSaveT = setTimeout(saveSession, 250);
  }

  function initManual() {
    const tbody = $('#man-table tbody');
    tbody.addEventListener('input', (e) => { if (e.target.matches('.count-input')) onManualInput(e.target); });
    tbody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target.matches('.count-input')) return;
      e.preventDefault();
      const inputs = $$('#man-table .count-input');
      const next = inputs[inputs.indexOf(e.target) + 1];
      if (next) { next.focus(); next.select(); } else e.target.blur();
    });
    tbody.addEventListener('focusin', (e) => { if (e.target.matches('.count-input')) e.target.select(); });
    let t;
    $('#man-filter').addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderManual, 120); });
  }

  /* ------------------------------------------------------------------
   * Settings — which products are scanned and which are counted by hand
   * ------------------------------------------------------------------ */
  function renderSettings() {
    const rows = new Map(); // key -> { key, name, code, n }
    if (S) {
      for (const it of S.items) {
        const k = productKey(it.code, it.name);
        const r = rows.get(k) || { key: k, name: it.name, code: it.code, n: 0 };
        r.n++;
        rows.set(k, r);
      }
    }
    for (const k of scanSet) if (!rows.has(k)) rows.set(k, { key: k, name: '', code: k, n: null });
    const all = [...rows.values()].sort((a, b) => collator.compare(a.name || a.code, b.name || b.code));
    const item = (r, to) => `<li class="set-item">
        <div class="set-name">${esc(r.name || r.code)}${r.name && r.code ? `<small>${esc(r.code)}</small>` : ''}</div>
        ${r.n === null ? '<span class="set-n muted" title="Not in the loaded Odoo file">–</span>' : `<span class="set-n">${fmtInt(r.n)}</span>`}
        <button type="button" class="btn btn-ghost btn-sm" data-key="${esc(r.key)}" data-label="${esc(r.name || r.code)}" data-to="${to}">${to === 'manual' ? 'Move to manual →' : '← Move to scan'}</button>
      </li>`;
    const scan = all.filter((r) => scanSet.has(r.key));
    const manual = all.filter((r) => !scanSet.has(r.key));
    $('#set-scan').innerHTML = scan.map((r) => item(r, 'manual')).join('') || '<li class="empty">No products are scanned.</li>';
    $('#set-manual').innerHTML = manual.map((r) => item(r, 'scan')).join('')
      || `<li class="empty">${S ? 'No products are counted by hand.' : 'Upload an Odoo file to see the other products.'}</li>`;
    $('#set-scan-n').textContent = fmtInt(scan.length);
    $('#set-manual-n').textContent = fmtInt(manual.length);
    const custom = Array.isArray(prefs.scanList);
    $('#set-state').textContent = custom ? 'Changed from the default list on this computer.' : 'Using the default list.';
    $('#set-reset').disabled = !custom;
  }

  function applyScanList(list) {
    if (list) prefs.scanList = [...list];
    else prefs.scanList = undefined;
    safeSet(localStorage, PREFS_KEY, prefs);
    scanSet = loadScanSet();
    compute();
    renderSettings();
  }

  function initSettings() {
    $('#view-settings').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-key]');
      if (!b) return;
      const toScan = b.dataset.to === 'scan';
      const ok = await confirmDialog({
        title: 'Are you sure?',
        body: toScan
          ? `"${b.dataset.label}" will be counted by scanning every serial label instead of by hand. Any quantity typed in for it at Manual count will no longer be used.`
          : `"${b.dataset.label}" will be counted by hand instead of by scanning. Scans already made for it will no longer be counted.`,
        ok: toScan ? 'Yes, scan it' : 'Yes, count by hand',
        danger: true,
      });
      if (!ok) return;
      const set = new Set(scanSet);
      toScan ? set.add(b.dataset.key) : set.delete(b.dataset.key);
      applyScanList(set);
      toast(`${b.dataset.label}: ${toScan ? 'scan' : 'manual count'}`);
    });
    $('#set-reset').addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Are you sure?',
        body: 'This puts back the default list of scanned products. Every other product is counted by hand.',
        ok: 'Yes, reset',
        danger: true,
      });
      if (!ok) return;
      applyScanList(null);
      toast('Default list restored');
    });
  }

  /* ------------------------------------------------------------------
   * Step 4 — Report
   * ------------------------------------------------------------------ */
  const filt = { status: 'all', product: '', location: '', q: '' };
  const FALLBACK_COLS = ['Location', 'Product', 'Lot/Serial Number', 'Quantity', 'Unit'];
  const PI_COL = 'Physical Inventory';
  const TICK = '✔';
  const CROSS = '✘';
  const SVG_TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"/></svg>';
  const SVG_CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M7 7l10 10M17 7 7 17"/></svg>';
  const piIcon = (found) => (found
    ? `<span class="pi pi-yes" title="Found">${SVG_TICK}</span>`
    : `<span class="pi pi-no" title="Not found">${SVG_CROSS}</span>`);

  function itemRows() {
    return R.scope
      .map((it) => {
        const hit = R.firstScan.get(it.key);
        return { ...it, found: !!hit, scannedAt: hit ? hit.t : null };
      });
  }

  /** Columns of the uploaded Odoo report, in the original order (older saved counts fall back to the main ones). */
  const reportColumns = () => (S.columns && S.columns.length ? S.columns : FALLBACK_COLS);
  const cellsOf = (it) => (it.cells && it.cells.length ? it.cells : [it.location, it.product, it.serial, it.qty, it.unit]);
  const fmtCell = (v) => (typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 4 }) : String(v ?? ''));

  /** Columns worth showing on screen / PDF: every original column that has at least one value. */
  function visibleColumns(rows) {
    const cols = reportColumns();
    const idx = cols.map((_, c) => c).filter((c) => rows.some((r) => String(cellsOf(r)[c] ?? '').trim() !== ''));
    return idx.length ? idx : cols.map((_, c) => c);
  }
  const serialColIndex = () => reportColumns().findIndex((h) => /lot|serial/i.test(h));
  const numericCol = (h) => /^(quantity|qty|counted|difference|on\s*hand|reserved|value)/i.test(String(h).trim());

  function reportStamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return {
      file: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`,
      ref: `PI-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`,
    };
  }
  const accuracy = () => (R.expected ? (R.found / R.expected) * 100 : 0);

  function renderReport() {
    if (!S || !R) return;
    const meta = `${S.fileName} · Locations: ${S.selected.join(', ')} · Started ${fmtDateTime(S.startedAt)} · Generated ${fmtDateTime(Date.now())}`;
    $('#report-meta').textContent = meta;

    $('#r-expected').textContent = fmtInt(R.expected);
    $('#r-found').textContent = fmtInt(R.found);
    $('#r-found-s').textContent = R.expected ? `${accuracy().toFixed(1)}% accuracy` : '';
    $('#r-missing').textContent = fmtInt(R.missing);
    $('#r-unknown').textContent = fmtInt(R.unknown);
    $('#r-other').textContent = fmtInt(R.other);
    $('#sum-accuracy').textContent = R.expected ? `${accuracy().toFixed(1)}% of expected items physically verified` : '';

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
    $('#product-table tfoot').innerHTML = R.products.length > 1 ? `<tr>
      <td>Total</td><td></td>
      <td class="num">${fmtInt(R.expected)}</td>
      <td class="num">${fmtInt(R.found)}</td>
      <td class="num">${fmtInt(R.missing)}</td>
      <td>${accuracy().toFixed(1)}%</td>
    </tr>` : '';

    // filter dropdowns
    const fp = $('#f-product');
    fp.innerHTML = '<option value="">All products</option>' + R.products.map((p) => `<option value="${esc(p.product)}">${esc(p.name)}${p.code ? ` (${esc(p.code)})` : ''}</option>`).join('');
    fp.value = filt.product;
    const fl = $('#f-location');
    fl.innerHTML = '<option value="">All locations</option>' + S.selected.map((l) => `<option value="${esc(l)}">${esc(l)}</option>`).join('');
    fl.value = S.selected.includes(filt.location) ? filt.location : (filt.location = '');

    renderDetail();
    renderExceptions();
    renderReportManual();
  }

  function renderReportManual() {
    const m = R.man;
    $('#report-manual-card').classList.toggle('hidden', !m.products);
    $('#rm-note').textContent = m.products ? `${fmtInt(m.entered)} of ${fmtInt(m.products)} products counted` : '';
    $('#report-manual tbody').innerHTML = R.manual.map((x) => `<tr class="m-${manualStatus(x)}">
      <td class="t-prod">${esc(x.name)}</td>
      <td class="mono">${esc(x.code)}</td>
      <td class="tiny">${esc(x.locations.join(', '))}</td>
      <td class="num">${fmtQty(x.expected)}</td>
      <td class="num"><b>${x.counted === null ? '<span class="muted">—</span>' : fmtQty(x.counted)}</b></td>
      <td class="num m-diff">${fmtDiff(x.diff)}</td>
      <td class="c-pi">${manualIcon(x)}</td>
    </tr>`).join('');
    $('#report-manual tfoot').innerHTML = R.manual.length > 1 ? `<tr><td>Total</td><td></td><td></td>
      <td class="num">${fmtQty(m.expected)}</td><td class="num">${fmtQty(m.counted)}</td>
      <td class="num">${m.entered ? fmtDiff(Math.round((m.counted - m.expectedEntered) * 1000) / 1000) : '—'}</td><td></td></tr>` : '';
    $('#rs-m-products').textContent = fmtInt(m.products);
    $('#rs-m-entered').textContent = `${fmtInt(m.entered)} counted · ${fmtInt(m.notCounted)} not counted`;
    $('#rs-m-match').textContent = fmtInt(m.match);
    $('#rs-m-diff').textContent = fmtInt(m.short + m.over);
    $('#rs-m-diff-s').textContent = `${fmtInt(m.short)} short · ${fmtInt(m.over)} over`;
    $('#rs-m-qty').textContent = fmtQty(m.counted);
    $('#rs-m-qty-s').textContent = `counted · ${fmtQty(m.expected)} in report`;
  }

  function renderDetail() {
    const rows = itemRows();
    const q = norm(filt.q);
    const base = rows.filter((r) =>
      (!filt.product || r.product === filt.product) &&
      (!filt.location || r.location === filt.location) &&
      (!q || norm(r.serial).includes(q) || norm(r.product).includes(q)));
    const counts = { all: base.length, found: base.filter((r) => r.found).length };
    counts.notfound = counts.all - counts.found;
    $$('#status-seg button').forEach((b) => {
      b.classList.toggle('active', b.dataset.status === filt.status);
      b.querySelector('span').textContent = fmtInt(counts[b.dataset.status]);
    });
    const list = base.filter((r) => filt.status === 'all' || (filt.status === 'found' ? r.found : !r.found));

    const cols = reportColumns();
    const vis = visibleColumns(rows);
    const sc = serialColIndex();
    $('#detail-table thead').innerHTML = `<tr><th class="num">#</th>${vis.map((c) => `<th class="${numericCol(cols[c]) ? 'num' : ''}">${esc(cols[c])}</th>`).join('')}<th class="c-pi">${PI_COL}</th></tr>`;
    $('#detail-table tbody').innerHTML = list.map((r, i) => {
      const cells = cellsOf(r);
      return `<tr class="${r.found ? '' : 'row-miss'}">
      <td class="num muted">${i + 1}</td>
      ${vis.map((c) => `<td class="${c === sc ? 'mono' : numericCol(cols[c]) ? 'num' : ''}">${esc(fmtCell(cells[c]))}</td>`).join('')}
      <td class="c-pi">${piIcon(r.found)}</td>
    </tr>`;
    }).join('');
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
      <td class="muted">${fmtTime(e.first)}</td>
    </tr>`).join('');
  }

  /* ---------- Excel ---------- */
  const SCAN_LABEL = { found: 'Found', duplicate: 'Already scanned', other: 'Other location', unknown: 'Not in report', manual: 'Manual count product (not counted)' };
  const fmtFull = (t) => (t ? new Date(t).toLocaleString([], { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

  /** Summary block (rows) used below the report and on its own sheet. */
  function summaryRows(now) {
    const rows = [
      ['PHYSICAL INVENTORY SUMMARY'],
      ['Report file', S.fileName],
      ['Locations counted', S.selected.join(', ')],
      ['Count started', fmtDateTime(S.startedAt)],
      ['Generated', fmtDateTime(now)],
      [],
      ['Expected items', R.expected],
      [`${TICK} Found`, R.found],
      [`${CROSS} Not found`, R.missing],
      ['Accuracy', `${accuracy().toFixed(1)}%`],
      ['Scanned, not in report', R.unknown],
      ['Scanned, other location', R.other],
      ['Duplicate scans (not counted)', R.dup],
      [],
      ['Product', 'Code', 'Expected', `${TICK} Found`, `${CROSS} Not found`, 'Progress'],
    ];
    for (const p of R.products) rows.push([p.name, p.code, p.expected, p.found, p.expected - p.found, `${p.expected ? Math.floor((p.found / p.expected) * 100) : 0}%`]);
    rows.push(['TOTAL', '', R.expected, R.found, R.missing, `${accuracy().toFixed(1)}%`]);
    if (R.man.products) {
      const m = R.man;
      rows.push([], ['MANUAL COUNT (counted by hand)'],
        ['Products counted by hand', m.products],
        ['Quantities entered', `${m.entered} of ${m.products}`],
        [`${TICK} Match`, m.match],
        [`${CROSS} Short`, m.short],
        [`${CROSS} Over`, m.over],
        ['Not counted', m.notCounted],
        [],
        ...manualRows());
    }
    rows.push([], [`Legend: ${TICK} = physically found / matches the report · ${CROSS} = not found, or the manual count differs from the report`]);
    return rows;
  }

  const MANUAL_XLS = { pending: 'Not counted', match: `${TICK} Match`, short: `${CROSS} Short`, over: `${CROSS} Over` };

  /** Manual count table rows (header + one row per product + total). */
  function manualRows() {
    const m = R.man;
    const rows = [['Product', 'Code', 'Location', 'In report', 'Counted', 'Difference', 'Status']];
    for (const x of R.manual) rows.push([x.name, x.code, x.locations.join(', '), x.expected, x.counted === null ? '' : x.counted, x.diff === null ? '' : x.diff, MANUAL_XLS[manualStatus(x)]]);
    rows.push(['TOTAL', '', '', m.expected, m.entered ? m.counted : '', m.entered ? Math.round((m.counted - m.expectedEntered) * 1000) / 1000 : '', `${m.match} of ${m.products} match`]);
    return rows;
  }

  function fitCols(aoa, max = 48) {
    const width = Math.max(1, ...aoa.map((r) => r.length));
    return Array.from({ length: width }, (_, c) => ({
      wch: Math.min(max, Math.max(8, ...aoa.slice(0, 400).map((r) => String(r[c] ?? '').length)) + 2),
    }));
  }

  function exportExcel() {
    if (typeof XLSX === 'undefined') { toast('Spreadsheet library not loaded.'); return; }
    const now = new Date();
    const columns = reportColumns();
    const rows = itemRows();
    const header = [...columns, PI_COL];
    const line = (it) => [...columns.map((_, c) => cellsOf(it)[c] ?? ''), it.found ? TICK : CROSS];
    const wb = XLSX.utils.book_new();

    // Sheet 1: the uploaded report exactly as it was + Physical Inventory ✔/✘, summary underneath
    const report = [header, ...rows.map(line)];
    const dataEnd = report.length;
    report.push([], [], ...summaryRows(now));
    const ws = XLSX.utils.aoa_to_sheet(report);
    ws['!cols'] = fitCols(report.slice(0, dataEnd));
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: dataEnd - 1, c: header.length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, 'Physical Inventory');

    // Sheet 2: summary on its own
    const ws2 = XLSX.utils.aoa_to_sheet(summaryRows(now));
    ws2['!cols'] = [{ wch: 34 }, { wch: 22 }, { wch: 11 }, { wch: 11 }, { wch: 13 }, { wch: 11 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Summary');

    // Sheet: manual count
    if (R.man.products) {
      const mr = manualRows();
      const wsm = XLSX.utils.aoa_to_sheet(mr);
      wsm['!cols'] = fitCols(mr);
      wsm['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: mr.length - 2, c: mr[0].length - 1 } }) };
      XLSX.utils.book_append_sheet(wb, wsm, 'Manual Count');
    }

    // Sheet 3: only the items not found
    const miss = [header, ...rows.filter((r) => !r.found).map(line)];
    const ws3 = XLSX.utils.aoa_to_sheet(miss);
    ws3['!cols'] = fitCols(miss);
    if (miss.length > 1) ws3['!autofilter'] = { ref: ws3['!ref'] };
    XLSX.utils.book_append_sheet(wb, ws3, 'Not Found');

    // Sheet 4 (only when needed): labels scanned that are not on the counted report
    if (R.exceptions.length) {
      const extra = [['Lot/Serial Number', 'Product', 'Location', 'Status', 'Times scanned', 'First scanned']];
      for (const e of R.exceptions) {
        extra.push(e.item
          ? [e.item.serial, e.item.product, e.item.location, 'Scanned – location not counted', e.count, fmtFull(e.first)]
          : [e.raw, '', '', 'Scanned – not in report', e.count, fmtFull(e.first)]);
      }
      const ws4 = XLSX.utils.aoa_to_sheet(extra);
      ws4['!cols'] = fitCols(extra);
      XLSX.utils.book_append_sheet(wb, ws4, 'Not in Report');
    }

    // Sheet 5: every scan, in order (audit trail)
    const log = [['#', 'Scanned at', 'Scanned value', 'Matched serial', 'Product', 'Result', 'Source']];
    S.scans.forEach((sc, i) => {
      const idx = index.get(sc.key);
      const it = idx === undefined ? null : S.items[idx];
      log.push([i + 1, fmtFull(sc.t), sc.raw, it ? it.serial : '', it ? it.product : '', SCAN_LABEL[R.scanStatus.get(sc.id)] || '', sc.src || '']);
    });
    const ws5 = XLSX.utils.aoa_to_sheet(log);
    ws5['!cols'] = fitCols(log);
    if (log.length > 1) ws5['!autofilter'] = { ref: ws5['!ref'] };
    XLSX.utils.book_append_sheet(wb, ws5, 'Scan Log');

    XLSX.writeFile(wb, `Physical_Inventory_Report_${reportStamp(now).file}.xlsx`);
    toast('Excel report downloaded');
  }

  /* ---------- Branded PDF (print-ready document, saved with "Save as PDF") ---------- */
  function buildPdfHtml(now) {
    const rows = itemRows();
    const cols = reportColumns();
    const vis = visibleColumns(rows);
    const sc = serialColIndex();
    const { ref } = reportStamp(now);
    const logo = new URL('assets/logo.png', location.href).href;
    const acc = accuracy();
    const cls = (c) => (c === sc ? 'mono' : numericCol(cols[c]) ? 'num' : '');

    const body = rows.map((r, i) => {
      const cells = cellsOf(r);
      return `<tr class="${r.found ? '' : 'miss'}"><td class="num idx">${i + 1}</td>${vis.map((c) => `<td class="${cls(c)}">${esc(fmtCell(cells[c]))}</td>`).join('')}<td class="pi-c">${piIcon(r.found)}</td></tr>`;
    }).join('');

    const prodRows = R.products.map((p) => {
      const pct = p.expected ? (p.found / p.expected) * 100 : 0;
      return `<tr><td><b>${esc(p.name)}</b></td><td class="mono">${esc(p.code)}</td><td class="num">${fmtInt(p.expected)}</td><td class="num ok">${fmtInt(p.found)}</td><td class="num ${p.expected - p.found ? 'bad' : ''}">${fmtInt(p.expected - p.found)}</td><td><div class="bar"><i style="width:${pct}%"></i></div></td><td class="num">${Math.floor(pct)}%</td></tr>`;
    }).join('');

    const mm = R.man;
    const manualPdf = mm.products ? `
      <h2 style="margin-top:16px">Manual count · counted by hand</h2>
      <table class="grid">
        <thead><tr><th>Product</th><th>Code</th><th>Location</th><th class="num">In report</th><th class="num">Counted</th><th class="num">Difference</th><th class="pi-c">Status</th></tr></thead>
        <tbody>${R.manual.map((x) => `<tr class="${manualStatus(x) === 'match' || manualStatus(x) === 'pending' ? '' : 'miss'}"><td><b>${esc(x.name)}</b></td><td class="mono">${esc(x.code)}</td><td>${esc(x.locations.join(', '))}</td><td class="num">${fmtQty(x.expected)}</td><td class="num"><b>${x.counted === null ? '—' : fmtQty(x.counted)}</b></td><td class="num ${x.diff ? 'bad' : x.diff === 0 ? 'ok' : ''}">${fmtDiff(x.diff)}</td><td class="pi-c">${manualIcon(x)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td>Total</td><td></td><td></td><td class="num">${fmtQty(mm.expected)}</td><td class="num">${fmtQty(mm.counted)}</td><td class="num">${mm.entered ? fmtDiff(Math.round((mm.counted - mm.expectedEntered) * 1000) / 1000) : '—'}</td><td class="pi-c">${mm.match}/${mm.products}</td></tr></tfoot>
      </table>` : '';
    const manualKpis = mm.products ? `
        <h3>Manual count</h3>
        <div class="kpis">
          <div class="kpi"><span>Products</span><b>${fmtInt(mm.products)}</b><small>${fmtInt(mm.entered)} counted · ${fmtInt(mm.notCounted)} not counted</small></div>
          <div class="kpi g"><span>${TICK} Match</span><b>${fmtInt(mm.match)}</b><small>same as the report</small></div>
          <div class="kpi r"><span>${CROSS} Difference</span><b>${fmtInt(mm.short + mm.over)}</b><small>${fmtInt(mm.short)} short · ${fmtInt(mm.over)} over</small></div>
          <div class="kpi b"><span>Quantity</span><b>${fmtQty(mm.counted)}</b><small>counted · ${fmtQty(mm.expected)} in report</small></div>
        </div>` : '';

    const exc = R.exceptions.length ? `
      <h3>Exceptions: scanned but not expected</h3>
      <table class="grid"><thead><tr><th>Type</th><th>Scanned value</th><th>Product</th><th>Report location</th><th class="num">Scans</th><th>First scanned</th></tr></thead><tbody>
      ${R.exceptions.map((e) => `<tr><td>${e.type === 'unknown' ? 'Not in report' : 'Other location'}</td><td class="mono">${esc(e.item ? e.item.serial : e.raw)}</td><td>${e.item ? esc(e.item.name) : '—'}</td><td>${e.item ? esc(e.item.location) : '—'}</td><td class="num">${e.count}</td><td>${esc(fmtFull(e.first))}</td></tr>`).join('')}
      </tbody></table>` : '';

    return `<!doctype html><html><head><meta charset="utf-8"><title>Physical_Inventory_Report_${esc(reportStamp(now).file)}</title><style>
      @page { size: A4 landscape; margin: 12mm 11mm 14mm;
        @bottom-left { content: "BatteryLab · Physical Inventory Report · ${ref}"; font: 8px Helvetica, Arial, sans-serif; color: #8a98a5; }
        @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 8px Helvetica, Arial, sans-serif; color: #8a98a5; } }
      * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body { margin: 0; font: 9.5px/1.4 "Inter", -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2a33; }
      .mono { font-family: "JetBrains Mono", Menlo, Consolas, monospace; font-size: 9px; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .brandbar { height: 4px; background: linear-gradient(90deg, #2f3e4a 0 34%, #3ba7e6 34% 67%, #6dc24b 67%); border-radius: 2px; }
      header { display: flex; justify-content: space-between; align-items: center; padding: 12px 0 10px; }
      header img { height: 38px; }
      .ttl { text-align: right; }
      .ttl h1 { margin: 0; font-size: 17px; letter-spacing: .08em; text-transform: uppercase; color: #2f3e4a; }
      .ttl div { color: #6b7a88; font-size: 9px; margin-top: 2px; }
      .meta { display: flex; border: 1px solid #e3e8ed; border-radius: 6px; margin-bottom: 12px; }
      .meta div { flex: 1 1 auto; padding: 6px 10px; border-right: 1px solid #e3e8ed; }
      .meta div:last-child { border-right: 0; }
      .meta span { display: block; font-size: 7.5px; text-transform: uppercase; letter-spacing: .08em; color: #8a98a5; font-weight: 700; }
      .meta b { font-size: 9.5px; color: #1f2a33; font-weight: 650; }
      h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #2f3e4a; margin: 0 0 6px; padding-left: 7px; border-left: 3px solid #3ba7e6; }
      h3 { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #4a5b69; margin: 14px 0 6px; }
      table.grid { width: 100%; border-collapse: collapse; }
      .grid th { background: #2f3e4a; color: #fff; font-size: 8px; text-transform: uppercase; letter-spacing: .05em; text-align: left; padding: 5px 7px; font-weight: 700; }
      .grid th.num { text-align: right; }
      .grid td { padding: 4px 7px; border-bottom: 1px solid #eef2f5; vertical-align: middle; }
      .grid tbody tr:nth-child(even) td { background: #f8fafb; }
      .grid tr { break-inside: avoid; }
      .grid tr.miss td { background: #fdf1f1; }
      .grid tfoot td { font-weight: 800; border-top: 1.5px solid #2f3e4a; border-bottom: 0; background: #fff; }
      .idx { color: #8a98a5; width: 1%; }
      .grid .pi-c { text-align: center; width: 1%; white-space: nowrap; }
      .pi { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; border-radius: 50%; color: #fff; vertical-align: middle; }
      .pi svg { width: 9px; height: 9px; }
      .pi-yes { background: #4fae2e; }
      .pi-no { background: #d93b3b; }
      .pi-wait { background: #e3e8ed; color: #6b7a88; font-weight: 800; font-size: 9px; }
      .summary { break-before: page; }
      .kpis { display: flex; gap: 8px; margin-bottom: 6px; }
      .kpi { flex: 1; border: 1px solid #e3e8ed; border-top: 3px solid #2f3e4a; border-radius: 6px; padding: 8px 10px; }
      .kpi.g { border-top-color: #6dc24b; } .kpi.r { border-top-color: #d93b3b; } .kpi.b { border-top-color: #3ba7e6; } .kpi.v { border-top-color: #7a4fd6; }
      .kpi span { font-size: 7.5px; text-transform: uppercase; letter-spacing: .08em; color: #6b7a88; font-weight: 700; }
      .kpi b { display: block; font-size: 20px; color: #1f2a33; margin-top: 2px; }
      .kpi small { color: #8a98a5; }
      .ok { color: #2f7d17; font-weight: 700; } .bad { color: #b12a2a; font-weight: 700; }
      .bar { height: 6px; background: #eef2f5; border-radius: 3px; overflow: hidden; min-width: 90px; }
      .bar i { display: block; height: 100%; background: #6dc24b; }
      .legend { margin-top: 8px; color: #6b7a88; display: flex; gap: 16px; align-items: center; }
      .legend span { display: inline-flex; gap: 5px; align-items: center; }
      .sign { display: flex; gap: 28px; margin-top: 34px; break-inside: avoid; }
      .sign div { flex: 1; border-top: 1px solid #4a5b69; padding-top: 5px; color: #4a5b69; font-weight: 650; }
      .sign small { display: block; color: #8a98a5; font-weight: 400; margin-top: 2px; }
    </style></head><body>
      <div class="brandbar"></div>
      <header>
        <img src="${esc(logo)}" alt="BatteryLab">
        <div class="ttl"><h1>Physical Inventory Report</h1><div>Ref. ${esc(ref)} · Generated ${esc(fmtDateTime(now))}</div></div>
      </header>
      <div class="meta">
        <div><span>Source report</span><b>${esc(S.fileName)}</b></div>
        <div><span>Locations counted</span><b>${esc(S.selected.join(', '))}</b></div>
        <div><span>Count started</span><b>${esc(fmtDateTime(S.startedAt))}</b></div>
        <div><span>Scanned items</span><b>${fmtInt(R.expected)} expected · ${fmtInt(R.found)} found</b></div>
        <div><span>Manual count</span><b>${fmtInt(mm.match)} of ${fmtInt(mm.products)} products match</b></div>
        <div><span>Accuracy</span><b>${acc.toFixed(1)}%</b></div>
      </div>

      <h2>Scanned items · physical inventory status</h2>
      <table class="grid">
        <thead><tr><th class="num">#</th>${vis.map((c) => `<th class="${numericCol(cols[c]) ? 'num' : ''}">${esc(cols[c])}</th>`).join('')}<th class="pi-c">${PI_COL}</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
      <div class="legend"><span>${piIcon(true)} Physically found and scanned</span><span>${piIcon(false)} On the stock report, not found</span></div>
      ${manualPdf}

      <section class="summary">
        <h2>Summary</h2>
        <div class="kpis">
          <div class="kpi"><span>Expected</span><b>${fmtInt(R.expected)}</b><small>items on the report</small></div>
          <div class="kpi g"><span>${TICK} Found</span><b>${fmtInt(R.found)}</b><small>${acc.toFixed(1)}% accuracy</small></div>
          <div class="kpi r"><span>${CROSS} Not found</span><b>${fmtInt(R.missing)}</b><small>on report, not scanned</small></div>
          <div class="kpi v"><span>Not in report</span><b>${fmtInt(R.unknown)}</b><small>scanned, not on report</small></div>
          <div class="kpi b"><span>Other location</span><b>${fmtInt(R.other)}</b><small>on report, outside scope</small></div>
        </div>
        ${manualKpis}
        <h3>Scanned items by product</h3>
        <table class="grid">
          <thead><tr><th>Product</th><th>Code</th><th class="num">Expected</th><th class="num">${TICK} Found</th><th class="num">${CROSS} Not found</th><th>Progress</th><th class="num">%</th></tr></thead>
          <tbody>${prodRows}</tbody>
          <tfoot><tr><td>Total</td><td></td><td class="num">${fmtInt(R.expected)}</td><td class="num ok">${fmtInt(R.found)}</td><td class="num ${R.missing ? 'bad' : ''}">${fmtInt(R.missing)}</td><td><div class="bar"><i style="width:${acc}%"></i></div></td><td class="num">${acc.toFixed(1)}%</td></tr></tfoot>
        </table>
        ${exc}
        <div class="sign">
          <div>Counted by<small>Name, signature &amp; date</small></div>
          <div>Verified by<small>Name, signature &amp; date</small></div>
          <div>Approved by<small>Name, signature &amp; date</small></div>
        </div>
      </section>
    </body></html>`;
  }

  function exportPdf() {
    if (!S || !R) return;
    const now = new Date();
    const old = $('#pdf-frame');
    if (old) old.remove();
    const frame = document.createElement('iframe');
    frame.id = 'pdf-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(buildPdfHtml(now));
    doc.close();

    const title = document.title;
    let printed = false;
    const go = () => {
      if (printed) return;
      printed = true;
      // the browser suggests the PDF file name from the page title
      document.title = `Physical_Inventory_Report_${reportStamp(now).file}`;
      frame.contentWindow.focus();
      frame.contentWindow.print();
      setTimeout(() => { document.title = title; }, 1000);
    };
    const pending = Array.from(doc.images).filter((im) => !im.complete);
    let left = pending.length;
    const done = () => { if (--left <= 0) go(); };
    pending.forEach((im) => { im.addEventListener('load', done); im.addEventListener('error', done); });
    if (!left) setTimeout(go, 50);
    setTimeout(go, 2500); // never wait forever for the logo
    toast('Choose "Save as PDF" in the print dialog');
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
    $('#pdf-btn').addEventListener('click', exportPdf);
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
    initManual();
    initSettings();
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
