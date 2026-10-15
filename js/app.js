/* Duado Snack POS - frontend local-first (tanpa build). Data master disimpan di perangkat; transaksi masuk antrean lalu disinkronkan. */
(function () {
'use strict';
const C = window.CONFIG || {};
const $ = s => document.querySelector(s);
const rp = n => 'Rp\u00a0' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const num = n => Math.round(Number(n) || 0).toLocaleString('id-ID');
/* angka dari keyboard Indonesia: "0,5" = 0.5; "1.250" = 1250; "1.250,5" = 1250.5; "0.125" = 0.125 */
function dnum(s) {
  if (typeof s === 'number') return s; s = String(s == null ? '' : s).trim().replace(/\s/g, ''); if (!s) return NaN;
  s = /^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s) && !/^0\./.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(',', '.'); return Number(s);
}
const qf = n => (Math.round(Number(n) * 1000) / 1000).toLocaleString('id-ID', {maximumFractionDigits: 3});
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
/* Penyimpanan lokal: IndexedDB (kapasitas besar, tidak memblokir layar) dengan cermin di memori agar pembacaan tetap sinkron.
   Cadangan ke localStorage bila IndexedDB tidak tersedia. Data lama di localStorage dimigrasi sekali. Kunci penting (antrean, keranjang, sesi) ditulis seketika. */
const Store = (() => {
  const mem = {}, dirty = {}, CRIT = ['queue', 'cart', 'token', 'hideOut', 'metode', 'ch']; let db = null, idb = false, timer = null, writing = Promise.resolve();
  const journal = (k, o) => { try { localStorage.setItem('j:' + k, JSON.stringify(o)); } catch (e) {} }; // jurnal sinkron: selamat walau halaman ditutup sebelum IndexedDB selesai menulis
  const open = () => new Promise((res, rej) => { const r = indexedDB.open('duado', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked')); });
  const readAll = () => new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').openCursor(); q.onsuccess = () => { const c = q.result; if (c) { mem[c.key] = c.value; c.continue(); } else res(); }; q.onerror = () => rej(q.error); });
  function flushNow() {
    clearTimeout(timer); const keys = Object.keys(dirty); if (!idb || !keys.length) return writing;
    const batch = keys.map(k => [k, dirty[k]]); keys.forEach(k => delete dirty[k]);
    writing = writing.then(() => new Promise(res => {
      const undo = () => { batch.forEach(([k, op]) => { if (!(k in dirty)) dirty[k] = op; }); res(); };
      try { const tx = db.transaction('kv', 'readwrite'), st = tx.objectStore('kv'); batch.forEach(([k, op]) => { if (op === 2) st.delete(k); else st.put(mem[k], k); }); tx.oncomplete = () => { batch.forEach(([k]) => { if (!(k in dirty)) { try { localStorage.removeItem('j:' + k); } catch (e) {} } }); res(); }; tx.onerror = tx.onabort = undo; } catch (e) { undo(); }
    }));
    return writing;
  }
  async function init() {
    try { if (window.indexedDB) { db = await open(); await readAll(); idb = true; } } catch (e) { idb = false; }
    try { // terapkan jurnal yang belum sempat masuk IndexedDB (mis. aplikasi ditutup tepat setelah transaksi)
      if (idb) Object.keys(localStorage).filter(k => k.indexOf('j:') === 0).forEach(jk => { const k = jk.slice(2); try { const o = JSON.parse(localStorage.getItem(jk)); if (o && o.x) { delete mem[k]; dirty[k] = 2; } else if (o && 'v' in o) { mem[k] = o.v; dirty[k] = 1; } } catch (e) {} });
      if (idb && Object.keys(dirty).length) await flushNow();
    } catch (e) {}
    try {
      const moved = []; Object.keys(localStorage).forEach(k => { if (k.indexOf('j:') !== 0 && !(k in mem)) { try { const v = JSON.parse(localStorage.getItem(k)); if (v != null) { mem[k] = v; if (idb) dirty[k] = 1; moved.push(k); } } catch (e) {} } });
      if (idb && moved.length) { await flushNow(); if (!Object.keys(dirty).length) moved.forEach(k => localStorage.removeItem(k)); } // hapus salinan lama hanya setelah berhasil tertulis
    } catch (e) {}
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {} // minta agar data tidak dibersihkan otomatis oleh browser
  }
  return {
    init: init, flush: flushNow, mode: () => idb ? 'IndexedDB' : 'localStorage',
    get: (k, d) => mem[k] == null ? d : mem[k],
    set: (k, v, now) => { mem[k] = v; if (idb) { if (CRIT.indexOf(k) >= 0) journal(k, {v: v}); dirty[k] = 1; if (now) flushNow(); else { clearTimeout(timer); timer = setTimeout(flushNow, 400); } } else { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Penyimpanan perangkat penuh'); } } },
    del: k => { delete mem[k]; if (idb) { if (CRIT.indexOf(k) >= 0) journal(k, {x: 1}); dirty[k] = 2; if (CRIT.indexOf(k) >= 0) flushNow(); else { clearTimeout(timer); timer = setTimeout(flushNow, 400); } } else { try { localStorage.removeItem(k); } catch (e) {} } }
  };
})();
const LS = {get: Store.get, set: (k, v) => Store.set(k, v, ['queue', 'cart', 'token', 'hideOut', 'metode', 'ch'].indexOf(k) >= 0), del: Store.del};
const T = v => String(v).toUpperCase() === 'TRUE';
const APP = window.APP = {views: {}};
const S = {token: null, data: null, queue: [], tab: 'kasir', ch: null, cat: 'Semua', q: '',
  cart: [], diskon: '', metode: 'tunai', terima: '', catatan: '', nomor: {}, mt: 'products', stab: 'varian', day: null, pb: {items: [], ongkir: '', sup: ''}, rc: null,
  sq: '', scat: 'Semua', hideOut: false, dirty: false, rcustom: false, installEv: null};
const own = () => !!(S.data && S.data.user.role === 'owner');
const vById = id => S.data.variants.find(v => v.id === id);
const pById = id => S.data.products.find(p => p.id === id);
const vName = v => { const p = pById(v.product_id); return p ? p.nama : '(produk dihapus)'; };
const lvl = x => /^\d+$/.test(String(x).trim()) ? 'Level ' + String(x).trim() : x;
const vSub = v => [v.ukuran, v.level_pedas === '' || v.level_pedas == null ? '' : lvl(v.level_pedas)].filter(x => x !== '' && x != null).join(' · ');
const r6 = x => Math.round(Number(x) * 1e6) / 1e6;
const priceOf = (vid, ch) => { const x = S.data.prices.find(p => p.variant_id === vid && p.channel_id === ch); return x ? Number(x.harga_jual) : null; };
const chName = id => { const c = S.data.channels.find(c => c.id === id); return c ? c.nama : '-'; };
const p2 = n => ('0' + n).slice(-2);
const fmtDT = d => { d = new Date(d); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
const today = () => fmtDT(new Date()).slice(0, 10);
function toast(m) { const t = $('#toast'); t.textContent = m; t.className = 'show'; clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', 2600); }
function sheet(html) { const b = $('#sheet'); b.innerHTML = '<div class="sheet-bg" data-act="close"></div><div class="sheet" role="dialog">' + html + '</div>'; b.hidden = false; }
function closeSheet() { const b = $('#sheet'); S.qopen = false; b.hidden = true; b.innerHTML = ''; if (S.deferRender) { S.deferRender = false; render(); } }

/* ---------- API dan sinkronisasi ---------- */
let pending = 0;
function netState() { document.body.classList.toggle('net', pending > 0); badge(); }
async function api(action, payload, opt) {
  if (!C.API_URL || C.API_URL.indexOf('http') !== 0) throw new Error('API_URL belum diisi di js/config.js');
  const silent = !!(opt && opt.silent); if (!silent) { pending++; netState(); }
  try {
    const r = await fetch(C.API_URL, {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify({action: action, token: S.token, payload: payload || {}})});
    const j = await r.json();
    if (!j.ok) { const e = new Error(j.error); e.server = true; e.auth = /^Sesi/.test(j.error); throw e; }
    if (j.ver && S.data && j.ver_prev && S.data.ver === j.ver_prev) S.data.ver = j.ver; // perubahan ini dibuat perangkat ini sendiri: tidak perlu muat ulang
    return j.data;
  } finally { if (!silent) { pending--; netState(); } }
}
/* Animasi loading: overlay untuk aksi simpan/muat ulang, bar di atas untuk semua panggilan server, skeleton untuk daftar */
async function busy(label, fn) {
  if (S.busyOn) return; S.busyOn = true;
  const el = $('#busy'); el.innerHTML = '<div class="busybox"><div class="loader"></div><div class="lbl">' + esc(label) + '</div></div>'; el.hidden = false;
  try { return await fn(); } finally { S.busyOn = false; el.hidden = true; el.innerHTML = ''; }
}
function busyLabel(t) { const l = document.querySelector('#busy .lbl'); if (l) l.textContent = t; }
const skel = n => Array.from({length: n || 3}, () => '<div class="sk"></div>').join('');
function applyQueueStock() {
  S.queue.forEach(q => { if (q.status === 'pending') q.payload.items.forEach(it => { const v = vById(it.variant_id); if (v) v.stok = (Number(v.stok) || 0) - it.qty; }); });
}
async function loadData() { S.data = await api('bootstrap'); applyQueueStock(); S.lastSync = Date.now(); LS.set('lastsync', S.lastSync); LS.set('data', S.data); if (S.cat !== 'Semua' && !S.data.products.some(p => p.kategori === S.cat)) S.cat = 'Semua'; }
/* Sinkronisasi hanya bila perlu: cek versi data (ping senyap, tanpa animasi); muat ulang penuh hanya jika versi berubah. Tanpa polling berkala. */
let lastChk = 0;
async function checkUpdates(force) {
  if (!S.token || !S.data || (!force && Date.now() - lastChk < 30000)) return;
  lastChk = Date.now();
  try {
    const p = await api('ping', {}, {silent: true});
    if (p.ver !== S.data.ver) { await loadData(); if ($('#sheet').hidden && !S.dirty) render(); else S.deferRender = true; toast('Data terbaru dimuat'); }
  } catch (e) { if (e.auth) softLogout(); }
}
let flushing = false, flushDelay = 15000, flushTimer = null;
const mine = () => S.queue.filter(x => x.status === 'pending' && x.uid === S.data.user.uid);
const hasPending = () => !!S.data && mine().length > 0;
const pendingQty = id => S.queue.reduce((a, q) => a + (q.status === 'pending' ? q.payload.items.filter(i => i.variant_id === id).reduce((b, i) => b + i.qty, 0) : 0), 0);
function scheduleFlush() { // percobaan ulang hanya selama ada transaksi tertunda, dengan jeda yang makin panjang
  clearTimeout(flushTimer); if (!hasPending()) { flushDelay = 15000; S.nextFlush = 0; return; }
  S.nextFlush = Date.now() + flushDelay; flushTimer = setTimeout(flush, flushDelay); flushDelay = Math.min(flushDelay * 2, 120000);
}
async function sendBatch(batch) { // satu permintaan untuk banyak transaksi; mundur ke satu per satu bila server lama belum mengenal sale.batch
  if (!S.noBatch) { try { return await api('sale.batch', {sales: batch.map(q => q.payload)}); } catch (e) { if (!(e.server && /Aksi tidak dikenal/.test(e.message))) throw e; S.noBatch = true; } }
  const out = []; for (const q of batch) { try { out.push({ok: true, data: await api('sale.create', q.payload)}); } catch (e) { if (!e.server) throw e; out.push({ok: false, error: e.message}); } } return out;
}
async function flush() {
  if (flushing || !S.token || !S.data || !hasPending()) return;
  if (!navigator.onLine) { badge(); return; }
  flushing = true; let netFail = false;
  try {
    while (hasPending() && !netFail) {
      const batch = mine().slice(0, 10); batch.forEach(q => { q.state = 'sending'; q.tries = (q.tries || 0) + 1; q.lastTry = Date.now(); }); badge(); let res;
      try { res = await sendBatch(batch); }
      catch (e) {
        if (e.auth) { softLogout(); break; }
        batch.forEach(q => { q.error = e.server ? e.message : 'Tidak ada koneksi ke server'; if (e.server) { q.status = 'review'; q.state = 'error'; } else q.state = 'waiting'; });
        if (!e.server) netFail = true; LS.set('queue', S.queue); continue;
      }
      batch.forEach((q, i) => { const r = res[i];
        if (r && r.ok) { const d = r.data || {}; if (d.sale) S.nomor[q.rid] = d.sale.nomor; S.queue = S.queue.filter(x => x !== q); Object.keys(d.stok || {}).forEach(id => { const v = vById(id); if (v) v.stok = r6(d.stok[id] - pendingQty(id)); }); }
        else { q.status = 'review'; q.state = 'error'; q.error = (r && r.error) || 'Ditolak server'; } });
      LS.set('queue', S.queue); refreshRc(); flushDelay = 15000;
    }
  } finally { flushing = false; S.queue.forEach(q => { if (q.state === 'sending') q.state = 'waiting'; }); LS.set('queue', S.queue); LS.set('data', S.data); badge(); if (S.tab === 'riwayat' && $('#sheet').hidden) vRiwayat(); scheduleFlush(); }
}
function softLogout(msg) { S.token = null; LS.del('token'); renderLogin(msg || 'Sesi berakhir, silakan masuk lagi.'); }
function logout() { S.token = null; S.data = null; S.cart = []; LS.del('token'); LS.del('data'); LS.del('cart'); renderLogin(); }

/* ---------- Ikon, tampilan, diagnostik, struk ---------- */
const cfg = k => (S.data && S.data.settings[k]);
const IC = {
  dash: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  kasir: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  riwayat: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>',
  stok: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  produksi: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
  menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
  laporan: '<line x1="12" x2="12" y1="20" y2="10"/><line x1="18" x2="18" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="16"/>',
  cek: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  master: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  shopee: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  settings: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
  sync: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  diag: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  chev: '<path d="m9 18 6-6-6-6"/>', search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>', check: '<path d="M20 6 9 17l-5-5"/>'
};
const svg = (n, sz) => '<svg class="ic" viewBox="0 0 24 24" width="' + (sz || 22) + '" height="' + (sz || 22) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + IC[n] + '</svg>';
const FLAME = 'M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z';
const heatN = lv => { const n = parseInt(String(lv == null ? '' : lv).replace(/\D/g, ''), 10); return isNaN(n) ? -1 : Math.min(n, 5); };
function heat(lv) { // level pedas sebagai nyala api (1-5); teks biasa untuk level non-angka seperti "Original"
  const raw = String(lv == null ? '' : lv).trim(), n = heatN(lv); if (!raw) return '';
  if (n < 0) return '<span class="lv0">' + esc(raw) + '</span>';
  return '<span class="heat" title="Level pedas ' + n + '"><span class="sr">Level ' + n + '</span>' + [1, 2, 3, 4, 5].map(i => '<svg viewBox="0 0 24 24" width="13" height="13" class="' + (i <= n ? 'on' : '') + '" fill="currentColor" aria-hidden="true"><path d="' + FLAME + '"/></svg>').join('') + '</span>';
}
const skuAbbr = n => { const w = String(n || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean); if (!w.length) return 'PRD'; if (w.length > 1) return w.slice(0, 3).map(x => x[0]).join(''); let t = w[0][0] + w[0].slice(1).replace(/[AEIOU]/g, ''); if (t.length < 3) t = w[0]; return t.slice(0, 3); };
const skuSize = u => { const t = String(u == null ? '' : u).toUpperCase(), m = t.match(/(\d+(?:[.,]\d+)?)\s*(KG|GR|G|ML|LT|L|PCS|PACK)?/); if (m) return m[1].replace(/[.,]/g, '') + (m[2] || ''); const x = t.replace(/[^A-Z]/g, ''); return x ? x[0] : ''; };
const skuLevel = lv => { const raw = String(lv == null ? '' : lv).trim(); if (!raw) return ''; const n = parseInt(raw.replace(/\D/g, ''), 10); return isNaN(n) ? raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) : 'L' + n; };
function genSkuLocal(f, selfId) {
  const p = pById(f.product_id), base = [skuAbbr(p && p.nama), skuSize(f.ukuran), skuLevel(f.level_pedas)].filter(Boolean).join('-'), taken = new Set(S.data.variants.filter(v => v.id !== selfId).map(v => String(v.sku || '').trim().toUpperCase()));
  let sku = base, i = 2; while (taken.has(sku)) sku = base + '-' + i++; return sku;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const idDate = d => { const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? (+m[3]) + ' ' + MON[+m[2] - 1] + ' ' + m[1] : String(d || ''); };
const idRange = (a, b) => { if (a === b) return idDate(a); if (a.slice(0, 7) === b.slice(0, 7)) return (+a.slice(8, 10)) + ' – ' + idDate(b); if (a.slice(0, 4) === b.slice(0, 4)) return (+a.slice(8, 10)) + ' ' + MON[+a.slice(5, 7) - 1] + ' – ' + idDate(b); return idDate(a) + ' – ' + idDate(b); };
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00'); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); };
const emptyState = (ic, t, d, a) => '<div class="empty-s"><div class="es-i">' + svg(ic, 34) + '</div><h3>' + t + '</h3><p>' + d + '</p>' + (a || '') + '</div>';
const wrapChips = h => '<div class="chips-wrap"><div class="chips">' + h + '</div></div>';
function initFades() { // petunjuk geser: gradient di tepi chip yang bisa digeser, dan chip aktif otomatis terlihat
  document.querySelectorAll('.chips-wrap').forEach(w => {
    const c = w.firstElementChild; if (!c) return;
    const upd = () => { w.classList.toggle('fade-r', c.scrollWidth - c.clientWidth - c.scrollLeft > 4); w.classList.toggle('fade-l', c.scrollLeft > 4); };
    if (!c._fx) { c._fx = 1; c.addEventListener('scroll', upd, {passive: true}); }
    if (!c._sc) { c._sc = 1; const on = c.querySelector('.chip.on'); if (on) c.scrollLeft = Math.max(0, on.offsetLeft - (c.clientWidth - on.offsetWidth) / 2); }
    upd();
  });
}
const isAddon = v => String((pById(v.product_id) || {}).kategori || '').trim().toLowerCase() === 'tambahan'; // produk tambahan (mis. kantong kresek) tampil di menu pembayaran, bukan di daftar produk
const lvText = lv => { const raw = String(lv == null ? '' : lv).trim(); return !raw ? '' : /^\d+$/.test(raw) ? 'Lv ' + raw : raw; };
IC.install = '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>';
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} };
/* Galat milik ekstensi browser (chrome-extension://, moz-extension://, dan sejenisnya) bukan galat aplikasi: tidak dicatat */
const foreign = e => { const t = String((e && e.stack) || '') + ' ' + String((e && e.filename) || ''); return /(chrome|moz|safari-web|ms-browser)-extension:\/\//.test(t) && t.indexOf(location.origin) < 0; };
function logErr(e, ctx) { if (foreign(e)) return; try { const l = LS.get('errlog', []); l.unshift({t: Date.now(), c: ctx || '', m: String((e && e.message) || e), s: String((e && e.stack) || '').split('\n').slice(0, 3).join(' | ')}); LS.set('errlog', l.slice(0, 20)); } catch (x) {} }
window.addEventListener('error', ev => { if (/-extension:\/\//.test(String(ev.filename || ''))) return; logErr(ev.error || ev.message, 'error'); });
window.addEventListener('unhandledrejection', ev => logErr(ev.reason, 'promise'));
/* struk: satu sumber teks untuk layar, WhatsApp, dan printer; lebar mengikuti pengaturan (32 = 58 mm, 48 = 80 mm) */
const rcWidth = () => Number(cfg('lebar_struk')) === 48 ? 48 : 32;
const wrapTxt = (t, w) => { const o = []; t = String(t); while (t.length > w) { o.push(t.slice(0, w)); t = t.slice(w); } o.push(t); return o; };
function receiptLines(rc, w) {
  w = w || rcWidth(); const line = '-'.repeat(w), L = (a, b) => { a = String(a); b = String(b); return a + ' '.repeat(Math.max(1, w - a.length - b.length)) + b; };
  const o = [String(cfg('nama_usaha') || 'Duado Snack').toUpperCase(), line, 'No : ' + (S.nomor[rc.rid] || '(menunggu sinkron)'), 'Tgl: ' + fmtDT(rc.time), 'Via: ' + rc.ch, line];
  rc.lines.forEach(l => { wrapTxt(l.n, w).forEach(x => o.push(x)); o.push(L(' ' + l.q + ' x ' + num(l.h), num(l.q * l.h))); });
  o.push(line, L('Subtotal', num(rc.sub))); if (rc.dis) o.push(L('Diskon', '-' + num(rc.dis))); if (rc.ppn) o.push(L(T(cfg('ppn_inklusif')) ? 'PPN (incl.)' : 'PPN', num(rc.ppn)));
  o.push(L('TOTAL', num(rc.total)), L('Bayar (' + rc.metode + ')', num(rc.terima))); if (rc.metode === 'tunai') o.push(L('Kembali', num(rc.kembali)));
  o.push(line); wrapTxt(cfg('footer_struk') || 'Terima kasih', w).forEach(x => o.push(x)); return o;
}
const receiptText = rc => receiptLines(rc).join('\n');
const ascii = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[·•–—]/g, '-').replace(/[^\x20-\x7E]/g, '?');
function escpos(rc) { // byte ESC/POS untuk printer thermal (dikirim lewat RawBT)
  const lines = receiptLines(rc), out = [0x1B, 0x40], add = a => { for (const c of ascii(a)) out.push(c.charCodeAt(0)); out.push(10); }, w = rcWidth();
  out.push(0x1B, 0x61, 1, 0x1B, 0x45, 1); if (lines[0].length * 2 <= w) out.push(0x1D, 0x21, 0x11); add(lines[0]); out.push(0x1D, 0x21, 0, 0x1B, 0x45, 0, 0x1B, 0x61, 0);
  lines.slice(1).forEach(add); out.push(0x1B, 0x64, 4); return new Uint8Array(out);
}
const b64 = u8 => { let t = ''; for (let i = 0; i < u8.length; i += 0x8000) t += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(t); };
function go(url, blank) { const a = document.createElement('a'); a.href = url; if (blank) { a.target = '_blank'; a.rel = 'noopener'; } a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => a.remove(), 800); }
const isAndroid = () => /Android/i.test(navigator.userAgent);
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BT_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', '0000ff00-0000-1000-8000-00805f9b34fb', '49535343-fe7d-4ae5-8fa9-9fafd205e455', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000ffe0-0000-1000-8000-00805f9b34fb', '0000fee7-0000-1000-8000-00805f9b34fb'];
const BT = {dev: null, chr: null};
async function btConnect(pick) { // Web Bluetooth: hanya printer BLE (bukan Bluetooth klasik/SPP)
  if (!navigator.bluetooth) throw new Error('Browser ini tidak mendukung Web Bluetooth');
  if (!BT.dev && !pick && navigator.bluetooth.getDevices) { try { const ds = await navigator.bluetooth.getDevices(), n = LS.get('btname', ''); BT.dev = ds.find(d => d.name === n) || null; } catch (e) {} }
  if (!BT.dev || pick) { BT.dev = await navigator.bluetooth.requestDevice({acceptAllDevices: true, optionalServices: BT_SERVICES}); BT.chr = null; LS.set('btname', BT.dev.name || ''); if (BT.dev.addEventListener) BT.dev.addEventListener('gattserverdisconnected', () => { BT.chr = null; }); }
  if (!BT.dev.gatt.connected) { BT.chr = null; await BT.dev.gatt.connect(); }
  if (!BT.chr) {
    for (const sv of await BT.dev.gatt.getPrimaryServices()) { const w = (await sv.getCharacteristics()).find(c => c.properties.writeWithoutResponse || c.properties.write); if (w) { BT.chr = w; break; } }
    if (!BT.chr) throw new Error('Printer tidak menyediakan jalur tulis BLE yang dikenali. Pastikan printer BLE, atau pakai RawBT di Android.');
  }
  return BT.chr;
}
async function btPrint(rc) {
  const bytes = escpos(rc), chr = await btConnect(false);
  for (let i = 0; i < bytes.length; i += 100) { const part = bytes.slice(i, i + 100); if (chr.properties.writeWithoutResponse) await chr.writeValueWithoutResponse(part); else await chr.writeValue(part); await sleep(25); }
}
function iosHelp() {
  sheet('<div class="grab"></div><h2>Cetak dari iPhone</h2><p class="muted">Safari dan Chrome di iPhone tidak bisa mengirim data ke printer Bluetooth. Pilihan yang bisa dipakai:</p>' +
    '<div class="li" style="display:block"><b>1. Browser dengan Web Bluetooth</b><div class="muted">Pasang browser seperti Bluefy, buka alamat aplikasi ini di sana, lalu tekan Cetak Bluetooth. Printer harus tipe <b>BLE</b>; printer Bluetooth klasik (kebanyakan printer murah) tidak dikenali iPhone.</div><button class="btn sec sm" data-act="copyurl">Salin alamat aplikasi</button></div>' +
    '<div class="li" style="display:block"><b>2. AirPrint atau PDF</b><div class="muted">Tombol Cetak memakai menu cetak iOS (printer AirPrint, atau simpan sebagai PDF).</div><button class="btn sec sm" data-act="print">Cetak</button></div>' +
    '<div class="li" style="display:block"><b>3. Bagikan struk</b><div class="muted">Kirim ke WhatsApp atau aplikasi printer lain lewat menu bagikan iOS.</div><button class="btn sec sm" data-act="share">Bagikan…</button></div>' +
    '<div class="li" style="display:block"><b>4. Android + RawBT</b><div class="muted">Untuk printer Bluetooth klasik, gunakan HP Android dengan aplikasi RawBT.</div></div><button class="btn pri" data-act="close">Mengerti</button>');
}
async function printBT(rc) {
  if (!rc) return toast('Tidak ada struk untuk dicetak');
  const direct = !!LS.get('btdirect', false);
  if (isAndroid() && !(direct && navigator.bluetooth)) return go('intent:base64,' + b64(escpos(rc)) + '#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;');
  if (navigator.bluetooth) {
    try { toast('Mencetak ke printer…'); await btPrint(rc); toast('Struk dikirim ke printer'); }
    catch (e) { logErr(e, 'btprint'); BT.chr = null; if (e && e.name === 'NotFoundError') toast('Pemilihan printer dibatalkan'); else toast('Gagal mencetak: ' + e.message); }
    return;
  }
  if (isIOS()) return iosHelp();
  toast('Bluetooth tidak tersedia di browser ini. Memakai cetak browser.'); printBrowser();
}
function printBrowser() { const d = document.querySelector('#rtxt'); if (d && d.closest('details')) d.closest('details').open = true; setTimeout(() => window.print(), 60); }
function waSend(rc, number) {
  let n = String(number || '').replace(/\D/g, ''); if (n.indexOf('0') === 0) n = '62' + n.slice(1); else if (n.indexOf('8') === 0) n = '62' + n;
  go((n ? 'https://wa.me/' + n : 'https://api.whatsapp.com/send') + '?text=' + encodeURIComponent('```' + receiptText(rc) + '```'), true);
}
async function copyText(t, msg) {
  msg = msg || 'Struk disalin. Tempel di WhatsApp atau aplikasi lain.';
  try { await navigator.clipboard.writeText(t); toast(msg); }
  catch (e) { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (x) {} ta.remove(); toast(ok ? msg : 'Tidak bisa menyalin.'); }
}
async function shareRc(rc) {
  const text = receiptText(rc);
  if (navigator.share) { try { await navigator.share({title: 'Struk ' + (cfg('nama_usaha') || 'Duado Snack'), text: text}); } catch (e) { if (e && e.name !== 'AbortError') copyText(text); } } else copyText(text);
}
const testRc = () => { S.nomor.uji = 'UJI-001'; return {rid: 'uji', time: Date.now(), ch: 'Uji coba', metode: 'tunai', terima: 20000, kembali: 3000, sub: 17000, dis: 0, ppn: 0, total: 17000, lines: [{n: 'Contoh Produk A 80gr', q: 1, h: 7000}, {n: 'Contoh Produk B 100gr', q: 1, h: 10000}]}; };

/* ---------- Login ---------- */
function renderLogin(msg) {
  $('#app').innerHTML = '<div class="login"><div class="lg-hero"><img src="icons/icon-192.png" alt="Duado Snack" width="116" height="116"><h1 class="wordmark">DUADO SNACK</h1><p>Jajanan Cemilan Pedas</p></div><div class="lg-card">' +
    '<label>Username<input id="lu" class="inp" autocomplete="username" autocapitalize="none" value="' + esc(LS.get('lastUser', '')) + '"></label>' +
    '<label>PIN<input id="lp" class="inp" type="password" inputmode="numeric" autocomplete="current-password"></label>' +
    '<button class="btn pri big" data-act="login">Masuk</button><div class="err" id="lerr">' + esc(msg || '') + '</div>' +
    (S.queue.length ? '<div class="muted">' + S.queue.length + ' transaksi menunggu dikirim setelah masuk.</div>' : '') + '</div></div>';
}
async function doLogin() {
  const u = $('#lu').value.trim(), p = $('#lp').value; if (!u || !p) return;
  $('#lerr').textContent = '';
  await busy('Masuk…', async () => { try {
    const r = await api('login', {username: u, pin: p}); S.token = r.token; LS.set('token', r.token); LS.set('lastUser', u);
    await loadData(); S.tab = own() ? 'dash' : 'kasir'; render(); flush();
  } catch (e) { $('#lerr').textContent = e.server ? e.message : 'Tidak dapat terhubung ke server. ' + e.message; } });
}

/* ---------- Kerangka ---------- */
const MENU_TABS = ['menu', 'master', 'users', 'settings', 'resep', 'laporan', 'shopee', 'cek', 'diag', 'arsip'];
function render() {
  if (!S.token || !S.data) return renderLogin();
  const d = S.data; if (!S.ch || !d.channels.some(c => c.id === S.ch)) S.ch = d.channels[0] && d.channels[0].id;
  const o = own(), tabs = o ? [['dash', 'Beranda'], ['kasir', 'Kasir'], ['stok', 'Stok'], ['produksi', 'Produksi'], ['menu', 'Menu']] : [['kasir', 'Kasir'], ['riwayat', 'Riwayat'], ['stok', 'Stok'], ['menu', 'Menu']],
    inMenu = MENU_TABS.concat(o ? ['riwayat'] : []).indexOf(S.tab) >= 0;
  $('#app').innerHTML = '<header class="top"><img class="logo" src="icons/icon-192.png" alt="" width="38" height="38"><div class="brand"><b class="wordmark">' + esc(String(d.settings.nama_usaha || 'Duado Snack').toUpperCase()) + '</b><small>Jajanan Cemilan Pedas</small></div><button class="badge" id="badge" data-act="queue" aria-label="Status sinkronisasi"></button></header><div class="accent"></div><main id="main"></main><div id="cartbar"></div>' +
    '<nav class="nav">' + tabs.map(t => '<button data-act="tab" data-t="' + t[0] + '" class="' + ((S.tab === t[0] || (t[0] === 'menu' && inMenu)) ? 'on' : '') + '"><span class="ni">' + svg(t[0], 22) + '</span><span>' + t[1] + '</span></button>').join('') + '</nav>';
  badge();
  (APP.views[S.tab] || vKasir)();
  cartbar();
}
function badge() {
  const b = $('#badge');
  if (b) {
    const mineQ = S.data ? S.queue.filter(q => q.uid === S.data.user.uid) : S.queue, p = mineQ.filter(q => q.status === 'pending').length, r = mineQ.filter(q => q.status === 'review').length, off = !navigator.onLine, busyNow = pending > 0 || mineQ.some(q => q.state === 'sending');
    let cls, txt;
    if (r) { cls = 'warn'; txt = r + ' perlu ditinjau'; }
    else if (off) { cls = 'off'; txt = 'Offline' + (p ? ' · ' + p : ''); }
    else if (busyNow) { cls = 'wait spin'; txt = 'Menyinkronkan'; }
    else if (p) { cls = 'wait'; txt = 'Menunggu kirim ' + p; }
    else { cls = 'ok'; txt = 'Tersinkron'; }
    b.className = 'badge ' + cls; b.textContent = txt;
  }
  qstatUpd(); if (S.qopen && !$('#sheet').hidden) queueSheet();
}
function qstatUpd() {
  const el = $('#qstat'); if (!el) return;
  const mineQ = S.data ? S.queue.filter(q => q.uid === S.data.user.uid) : [], p = mineQ.filter(q => q.status === 'pending').length, r = mineQ.filter(q => q.status === 'review').length, sending = mineQ.some(q => q.state === 'sending'), off = !navigator.onLine;
  if (!p && !r && !off) { el.className = ''; el.innerHTML = ''; return; }
  const msg = r ? r + ' transaksi ditolak server, perlu ditinjau' : sending ? 'Mengirim ' + p + ' transaksi…' : off ? (p ? 'Offline: ' + p + ' transaksi tersimpan di perangkat, dikirim otomatis saat online' : 'Mode offline: transaksi tetap tersimpan di perangkat dan dikirim saat online') : p + ' transaksi menunggu dikirim';
  el.className = 'qstat ' + (r ? 'err' : off ? 'off' : 'wait'); el.innerHTML = '<span class="qdot"></span><span class="qt">' + esc(msg) + '</span>' + svg('chev', 16);
}
const qrefresh = () => { if (S.qopen && !$('#sheet').hidden) queueSheet(); else if (S.tab === 'riwayat') vRiwayat(); };
function queueSheet() {
  S.qopen = true; const mineQ = S.data ? S.queue.filter(q => q.uid === S.data.user.uid) : S.queue, off = !navigator.onLine;
  const secs = n => n < 60 ? n + ' detik' : Math.round(n / 60) + ' menit', next = S.nextFlush && S.nextFlush > Date.now() ? 'Percobaan otomatis berikutnya sekitar ' + secs(Math.round((S.nextFlush - Date.now()) / 1000)) + '.' : '';
  const item = q => { const i = S.queue.indexOf(q), n = q.payload.items.reduce((a, x) => a + x.qty, 0), st = q.status === 'review' ? '<span class="tag red">Perlu ditinjau</span>' : q.state === 'sending' ? '<span class="tag busy">Mengirim…</span>' : '<span class="tag">Menunggu</span>';
    return '<div class="li" style="display:block"><div class="kv"><b>' + rp(q.total) + '</b>' + st + '</div><div class="muted">' + esc(fmtDT(q.ts).slice(11)) + ' · ' + esc(q.ch) + ' · ' + n + ' item' + (q.tries ? ' · percobaan ke-' + q.tries : '') + '</div>' + (q.error ? '<div style="color:var(--err);font-size:13px">' + esc(q.error) + '</div>' : '') +
      (q.status === 'review' ? '<div class="row2"><button class="btn sec sm" data-act="qretry" data-i="' + i + '">Coba lagi</button><button class="btn dan sm" data-act="qdel" data-i="' + i + '">Hapus</button></div>' : '') + '</div>'; };
  sheet('<div class="grab"></div><h2>Antrean transaksi</h2><div class="qs-top"><span class="tag ' + (off ? '' : 'grn') + '">' + (off ? 'Offline' : 'Online') + '</span><span class="muted">Terakhir sinkron: ' + (S.lastSync ? fmtDT(S.lastSync).slice(11) : '-') + ' · penyimpanan: ' + Store.mode() + '</span></div>' +
    (mineQ.length ? mineQ.map(item).join('') : '<div class="okmark sm">' + svg('check', 22) + '</div><p class="muted" style="text-align:center">Semua transaksi sudah terkirim ke server.</p>') + (next ? '<p class="muted">' + next + '</p>' : '') +
    (mineQ.some(q => q.status === 'pending') ? '<button class="btn pri" data-act="qnow">Kirim sekarang</button>' : '') + '<button class="btn sec" data-act="close">Tutup</button>');
  S.qopen = true;
}

/* ---------- Kasir ---------- */
function calc() {
  const s = S.data.settings; let sub = 0; S.cart.forEach(l => { sub += l.qty * (priceOf(l.v, S.ch) || 0); });
  const dis = Math.min(Math.max(Number(S.diskon) || 0, 0), sub), base = sub - dis, pp = Number(s.ppn_persen) || 0; let ppn = 0, total = base;
  if (T(s.ppn_aktif) && pp > 0) { if (T(s.ppn_inklusif)) ppn = Math.round(base * pp / (100 + pp)); else { ppn = Math.round(base * pp / 100); total = base + ppn; } }
  return {sub: sub, dis: dis, ppn: ppn, total: total};
}
const cartQty = id => { const l = S.cart.find(x => x.v === id); return l ? l.qty : 0; };
const saveCart = () => LS.set('cart', S.cart);
const chShort = n => /whatsapp/i.test(n) ? 'WA / IG' : n;
const isWide = () => !!(window.matchMedia && matchMedia('(min-width: 900px)').matches); // tablet: layar terbagi, daftar produk kiri dan pesanan kanan
function vKasir() {
  const d = S.data, wide = isWide(); S.cart = S.cart.filter(l => vById(l.v));
  const withAny = new Set(d.variants.map(v => v.product_id)), withV = new Set(d.variants.filter(v => !isAddon(v)).map(v => v.product_id)), cats = ['Semua'].concat(Array.from(new Set(d.products.filter(p => withV.has(p.id)).map(p => String(p.kategori == null ? '' : p.kategori)).filter(Boolean)))), noV = d.products.filter(p => !withAny.has(p.id)).length;
  if (S.cat !== 'Semua' && cats.indexOf(S.cat) < 0) S.cat = 'Semua';
  const top = '<div class="kasir-top">' + (own() && noV ? '<div class="notice"><span>' + noV + ' produk belum punya varian, jadi belum tampil di sini.</span><button class="chip" data-act="go_cek">Periksa data</button></div>' : '') + '<button id="qstat" data-act="queue"></button>' +
    '<div class="seg">' + d.channels.map(c => '<button class="' + (c.id === S.ch ? 'on' : '') + '" data-act="chan" data-c="' + esc(c.id) + '">' + esc(chShort(c.nama)) + '</button>').join('') + '</div>' +
    '<label class="search">' + svg('search', 18) + '<input id="q" class="inp" data-in="q" placeholder="Cari produk atau SKU" value="' + esc(S.q) + '" aria-label="Cari produk"></label>' +
    wrapChips(cats.map(c => '<button class="chip ' + (c === S.cat ? 'on' : '') + '" data-act="cat" data-c="' + esc(c) + '">' + esc(c) + '</button>').join('')) +
    '<div class="krow"><span class="muted" id="kcount"></span><label class="sw sm"><input type="checkbox" data-act="hideout"' + (S.hideOut ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l">Sembunyikan yang habis</span></label></div></div>';
  const m = $('#main'); m.className = wide ? 'split' : '';
  m.innerHTML = wide ? '<div class="kleft">' + top + '<div class="grid" id="grid"></div></div><aside class="kright" id="cpanel">' + cartInner(true) + '</aside>' : top + '<div class="grid" id="grid"></div>';
  grid(); if (wide) mountCart(); qstatUpd();
}
const isOff = v => priceOf(v.id, S.ch) == null || (T(cfg('blokir_stok_minus')) && (Number(v.stok) || 0) <= 0);
function cardHtml(v) {
  const pr = priceOf(v.id, S.ch), st = Number(v.stok) || 0, q = cartQty(v.id), off = isOff(v), lv = lvText(v.level_pedas);
  const stk = st <= 0 ? '' : st <= 5 ? '<span class="stk low">Sisa ' + num(st) + '</span>' : '<span class="stk">Stok ' + num(st) + '</span>';
  const bad = pr == null ? '<span class="badge-out warn">Harga?</span>' : st <= 0 ? '<span class="badge-out">HABIS</span>' : '';
  return '<i class="hb"></i>' + bad + '<b class="pn">' + esc(vName(v)) + (lv ? ' <span class="lvt">· ' + esc(lv) + '</span>' : '') + '</b><div class="pm">' + (v.ukuran ? '<span class="sz">' + esc(v.ukuran) + '</span>' : '') + heat(v.level_pedas) + '</div>' +
    '<div class="pf"><div class="pp"><span class="pr">' + (pr == null ? 'Harga belum diatur' : rp(pr)) + '</span>' + stk + '</div>' +
    (q ? '<div class="step"><button data-act="dec1" data-v="' + esc(v.id) + '" aria-label="Kurangi">−</button><b>' + q + '</b><button data-act="inc1" data-v="' + esc(v.id) + '" aria-label="Tambah">+</button></div>' : '<span class="plus' + (off ? ' dis' : '') + '" role="button" aria-disabled="' + (off ? 'true' : 'false') + '" aria-label="Tambah ' + esc(vName(v)) + '">+</span>') + '</div>';
}
function grid() {
  const d = S.data, q = S.q.toLowerCase(), avail = v => (Number(v.stok) || 0) > 0;
  const base = d.variants.filter(v => !isAddon(v) && (S.cat === 'Semua' || String((pById(v.product_id) || {}).kategori) === S.cat) && (!q || (vName(v) + ' ' + vSub(v) + ' ' + v.sku).toLowerCase().indexOf(q) >= 0));
  let list = S.hideOut ? base.filter(avail) : base;
  list = list.map((v, i) => [v, i]).sort((x, y) => (avail(y[0]) - avail(x[0])) || (x[1] - y[1])).map(x => x[0]); // tersedia di atas, habis di bawah, urutan asli dijaga
  const kc = $('#kcount'); if (kc) kc.textContent = list.length + ' produk' + (S.hideOut && base.length > list.length ? ' · ' + (base.length - list.length) + ' habis disembunyikan' : '');
  $('#grid').innerHTML = list.map(v => {
    const off = isOff(v), n = heatN(v.level_pedas);
    return '<div class="card pc h' + (n < 0 ? 'x' : n) + (off ? ' off' : '') + (cartQty(v.id) ? ' in' : '') + '" data-act="add" data-v="' + esc(v.id) + '" role="button" tabindex="0" aria-disabled="' + (off ? 'true' : 'false') + '">' + cardHtml(v) + '</div>';
  }).join('') || (S.hideOut && base.length ? emptyState('stok', 'Semua produk habis', 'Matikan "Sembunyikan yang habis" untuk melihat daftar lengkap.', '<button class="btn sec" data-act="showout">Tampilkan yang habis</button>') :
    own() ? emptyState('stok', 'Belum ada produk untuk dijual', 'Produk harus punya varian dan harga agar tampil di sini.', '<button class="btn pri" data-act="go_cek">Periksa data</button>') : emptyState('stok', 'Belum ada produk', 'Tidak ada produk di kategori ini.', ''));
}
function updCard(id) { // perbarui satu kartu saja, tanpa menggambar ulang seluruh daftar
  const el = document.querySelector('#grid .card[data-v="' + id + '"]'), v = vById(id); if (!el || !v) return;
  el.innerHTML = cardHtml(v); el.classList.toggle('in', cartQty(id) > 0); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}
function barRender() {
  const el = $('#cartbar'); if (!el) return;
  if (S.tab !== 'kasir' || !S.cart.length) { el.innerHTML = ''; return; }
  const c = calc(), n = S.cart.reduce((a, l) => a + l.qty, 0);
  el.innerHTML = '<button class="cartbar" data-act="cart"><span class="cb-i">' + svg('kasir', 20) + '<em>' + n + '</em></span><span class="cb-t"><small>' + n + ' item</small><b>' + rp(c.total) + '</b></span><span class="cb-go">Bayar ' + svg('chev', 18) + '</span></button>';
}
function cartbar() { // ponsel: bilah bawah; tablet: panel pesanan di kanan
  if (isWide()) { const b = $('#cartbar'); if (b) b.innerHTML = ''; if (S.tab === 'kasir' && $('#cpanel')) { cartLines(); cashBox(); upd(); } return; }
  barRender();
}
function addToCart(id) {
  const v = vById(id); if (!v) return;
  if (priceOf(id, S.ch) == null) return toast('Harga belum diatur untuk channel ini');
  const l = S.cart.find(x => x.v === id), q = (l ? l.qty : 0) + 1, st = Number(v.stok) || 0;
  if (T(cfg('blokir_stok_minus')) && q > st) return toast(st > 0 ? 'Stok tidak cukup' : 'Stok habis');
  if (l) l.qty = q; else S.cart.push({v: id, qty: 1});
  saveCart(); updCard(id); syncCart(); buzz();
}
function dropFromCart(id) {
  const i = S.cart.findIndex(x => x.v === id); if (i < 0) return;
  S.cart[i].qty--; if (S.cart[i].qty <= 0) S.cart.splice(i, 1); saveCart(); updCard(id); syncCart();
}
const methodChips = () => ['tunai', 'transfer', 'qris'].map(m => '<button class="chip ' + (S.metode === m ? 'on' : '') + '" data-act="metode" data-m="' + m + '">' + m.toUpperCase() + '</button>').join('');
function cartLines() {
  const el = $('#cl'); if (!el) return;
  if (!S.cart.length) { el.innerHTML = '<div class="cp-empty">' + svg('kasir', 34) + '<p>Ketuk produk di sebelah kiri untuk menambahkannya ke pesanan.</p></div>'; return; }
  el.innerHTML = S.cart.map((l, i) => { const v = vById(l.v), p = priceOf(l.v, S.ch) || 0;
    return '<div class="li cl-i"><div class="cl-n"><b>' + esc(vName(v)) + '</b><div class="muted">' + esc([vSub(v), rp(p)].filter(Boolean).join(' · ')) + '</div></div><div class="qty"><button data-act="dec" data-i="' + i + '" aria-label="Kurangi">−</button><span>' + l.qty + '</span><button data-act="inc" data-i="' + i + '" aria-label="Tambah">+</button></div><b class="cl-t">' + rp(p * l.qty) + '</b></div>'; }).join('');
}
function cashBox() {
  const el = $('#cashbox'); if (!el) return;
  if (S.metode !== 'tunai') { el.innerHTML = '<p class="muted">Pembayaran ' + esc(S.metode.toUpperCase()) + ' dicatat lunas saat disimpan.</p>'; return; }
  const t = calc().total, q = [t].concat([5000, 10000, 20000, 50000, 100000].map(n => Math.ceil(t / n) * n)).filter((x, i, a) => x > 0 && a.indexOf(x) === i).slice(0, 4);
  el.innerHTML = '<label>Uang diterima (Rp)<input class="inp" data-in="terima" inputmode="numeric" placeholder="' + num(t) + '" value="' + esc(S.terima) + '"></label><div class="chips">' + q.map((x, i) => '<button class="chip" data-act="qk" data-n="' + x + '">' + (i === 0 ? 'Uang pas' : num(x)) + '</button>').join('') + '</div>';
}
function cartInner(panel) {
  return (panel ? '<div class="cp-h"><h2>Pesanan</h2><span class="muted">' + esc(chName(S.ch)) + '</span></div>' : '<div class="grab"></div><div class="sh-h"><h2>Pembayaran</h2><span class="muted">' + esc(chName(S.ch)) + '</span></div>') +
    '<div id="cl"></div><div id="addons"></div><div class="paybox"><div class="chips" id="mchips">' + methodChips() + '</div><div id="cashbox"></div></div>' +
    '<details class="more"' + (S.diskon || S.catatan ? ' open' : '') + '><summary>Diskon dan catatan</summary><label>Diskon (Rp)<input class="inp" data-in="diskon" inputmode="numeric" value="' + esc(S.diskon) + '"></label><label>Catatan<input class="inp" data-in="catatan" value="' + esc(S.catatan) + '"></label></details>' +
    '<div id="tot"></div><button class="btn pri big" id="paybtn" data-act="pay">Bayar</button>';
}
function addonsRender() { // menu pembayaran: "Tambahan" seperti retail modern (kantong kresek, dll.)
  const el = $('#addons'); if (!el) return; const L = S.data.variants.filter(v => isAddon(v) && priceOf(v.id, S.ch) != null), block = T(cfg('blokir_stok_minus'));
  if (!L.length) { el.innerHTML = own() ? '<p class="muted ad-none">Belum ada produk tambahan (mis. kantong kresek). Buat di Pengaturan, kartu "Kantong & Tambahan".</p>' : ''; return; }
  el.innerHTML = '<div class="ad-h">Tambahan</div>' + L.map(v => { const q = cartQty(v.id), st = Number(v.stok) || 0, out = block && st <= 0, nm = esc(vName(v) + (v.ukuran ? ' ' + v.ukuran : ''));
    return '<div class="ad-row"><div class="ad-n"><b>' + nm + '</b><small>' + rp(priceOf(v.id, S.ch)) + (out ? ' · habis' : '') + '</small></div>' +
      (q ? '<div class="qty"><button data-act="dec1" data-v="' + esc(v.id) + '" aria-label="Kurangi ' + nm + '">−</button><span>' + q + '</span><button data-act="inc1" data-v="' + esc(v.id) + '" aria-label="Tambah ' + nm + '">+</button></div>' : '<button class="chip ad-add" data-act="inc1" data-v="' + esc(v.id) + '"' + (out ? ' aria-disabled="true"' : '') + '>+ Tambah</button>') + '</div>'; }).join('');
}
function refreshCart() { cartLines(); addonsRender(); cashBox(); upd(); if (!S.cart.length && !isWide() && $('#sheet') && !$('#sheet').hidden && $('#cl')) closeSheet(); }
const syncCart = () => { if ($('#cl')) refreshCart(); else cartbar(); };
const mountCart = () => { cartLines(); addonsRender(); cashBox(); upd(); };
function cartSheet() { if (isWide() || !S.cart.length) return; sheet(cartInner(false)); mountCart(); }
function upd() {
  const c = calc(), s = S.data.settings, kv = (a, b, cl) => '<div class="kv ' + (cl || '') + '"><span>' + a + '</span><span>' + b + '</span></div>', tunai = S.metode === 'tunai', terima = S.terima === '' ? null : Number(S.terima) || 0;
  let h = kv('Subtotal', rp(c.sub)); if (c.dis) h += kv('Diskon', '-' + rp(c.dis)); if (c.ppn) h += kv(T(s.ppn_inklusif) ? 'PPN (sudah termasuk)' : 'PPN', rp(c.ppn));
  h += kv('Total', rp(c.total), 'big'); if (tunai && terima !== null) h += kv(terima >= c.total ? 'Kembalian' : 'Kurang', rp(Math.abs(terima - c.total)), terima >= c.total ? 'ok-r' : 'err-r');
  const t = $('#tot'); if (t) t.innerHTML = h;
  const b = $('#paybtn'); if (b) { const short = tunai && terima !== null && terima < c.total; b.disabled = short || !S.cart.length; b.textContent = !S.cart.length ? 'Bayar' : short ? 'Uang kurang ' + rp(c.total - terima) : 'Bayar ' + rp(c.total); }
  if (!isWide()) barRender();
}
function pay() {
  if (S.paying || !S.cart.length) return;
  if (S.cart.some(l => !vById(l.v))) { S.cart = S.cart.filter(l => vById(l.v)); saveCart(); toast('Ada produk yang sudah tidak tersedia; keranjang diperbarui'); if (S.cart.length) { if (!isWide()) cartSheet(); } else closeSheet(); cartbar(); return; }
  const c = calc(), tunai = S.metode === 'tunai', terima = tunai ? (S.terima === '' ? c.total : Number(S.terima) || 0) : c.total;
  if (tunai && terima < c.total) return toast('Uang diterima kurang');
  S.paying = true; let rc;
  try {
    const rid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2);
    const payload = {request_id: rid, channel_id: S.ch, items: S.cart.map(l => ({variant_id: l.v, qty: l.qty})), diskon: c.dis, metode_bayar: S.metode, catatan: S.catatan};
    rc = {rid: rid, time: Date.now(), ch: chName(S.ch), metode: S.metode, terima: terima, kembali: terima - c.total, sub: c.sub, dis: c.dis, ppn: c.ppn, total: c.total,
      lines: S.cart.map(l => { const v = vById(l.v); return {n: (vName(v) + ' ' + vSub(v)).trim(), q: l.qty, h: priceOf(l.v, S.ch)}; })};
    S.queue.push({rid: rid, payload: payload, status: 'pending', state: 'waiting', ts: Date.now(), uid: S.data.user.uid, total: c.total, ch: rc.ch}); LS.set('queue', S.queue);
    S.cart.forEach(l => { const v = vById(l.v); if (v) v.stok = r6((Number(v.stok) || 0) - l.qty); }); LS.set('data', S.data);
  } catch (e) { S.paying = false; logErr(e, 'bayar'); return toast('Transaksi gagal disimpan: ' + e.message); }
  /* transaksi sudah aman di antrean: kosongkan keranjang lebih dulu agar tidak pernah tersisa, apa pun yang terjadi setelah ini */
  S.cart = []; S.diskon = ''; S.terima = ''; S.catatan = ''; LS.del('cart'); closeSheet();
  try { render(); } catch (e) { logErr(e, 'render'); }
  try { showReceipt(rc); } catch (e) { logErr(e, 'struk'); toast('Transaksi tersimpan, tetapi struk gagal ditampilkan.'); }
  if (T(cfg('auto_cetak'))) { try { printBT(rc); } catch (e) { logErr(e, 'cetak'); } }
  S.paying = false; flush();
}
function showReceipt(rc) {
  S.rc = rc; const tunai = rc.metode === 'tunai';
  sheet('<div class="grab"></div><div class="okmark">' + svg('check', 30) + '</div><h2 class="c">Pembayaran berhasil</h2><div class="rc-sum"><div><small>Total</small><b>' + rp(rc.total) + '</b></div><div><small>' + (tunai ? 'Kembalian' : 'Metode') + '</small><b>' + (tunai ? rp(Math.max(rc.kembali, 0)) : esc(rc.metode.toUpperCase())) + '</b></div></div>' +
    '<label>No. WhatsApp pelanggan (opsional)<input class="inp" id="wa" inputmode="tel" placeholder="08xxxxxxxxxx"></label>' +
    '<div class="row2"><button class="btn wa" data-act="wa">Kirim WhatsApp</button><button class="btn dark" data-act="rawbt">Cetak Bluetooth</button></div>' +
    '<div class="row3"><button class="btn sec sm" data-act="share">Bagikan…</button><button class="btn sec sm" data-act="copyrc">Salin</button><button class="btn sec sm" data-act="print">Cetak</button></div>' +
    '<details class="more"><summary>Lihat struk</summary><pre class="rc" id="rtxt"></pre></details><button class="btn pri big" data-act="close">Transaksi baru</button>');
  refreshRc();
}
function refreshRc() { const el = $('#rtxt'); if (el && S.rc) el.textContent = receiptText(S.rc); }

/* ---------- Riwayat ---------- */
async function vRiwayat() {
  const t0 = today(), day = S.day || t0, yd = addDays(t0, -1), pre = S.rcustom ? 'custom' : day === t0 ? 'today' : day === yd ? 'yday' : 'custom';
  $('#main').innerHTML = wrapChips('<button class="chip ' + (pre === 'today' ? 'on' : '') + '" data-act="rday" data-p="today">Hari ini</button><button class="chip ' + (pre === 'yday' ? 'on' : '') + '" data-act="rday" data-p="yday">Kemarin</button><button class="chip ' + (pre === 'custom' ? 'on' : '') + '" data-act="rday" data-p="custom">Pilih tanggal</button>') +
    '<p class="muted rcap">' + esc(idDate(day)) + '</p>' + (pre === 'custom' ? '<label>Tanggal<input type="date" class="inp" data-chg="day" value="' + day + '"></label>' : '') + '<div id="rq"></div><div id="rsum"></div><div id="rlist">' + skel(3) + '</div>';
  const qs = S.queue.map((q, i) => q.uid !== S.data.user.uid ? '' : '<div class="li"><div><b>' + rp(q.total) + '</b> <span class="muted">' + esc(q.ch) + ' · ' + fmtDT(q.ts).slice(11) + '</span>' +
    (q.status === 'review' ? '<div class="muted" style="color:var(--err)">' + esc(q.error) + '</div>' : '') + '</div><div class="r"><span class="tag ' + (q.status === 'review' ? 'red' : '') + '">' + (q.status === 'review' ? 'Perlu ditinjau' : 'Menunggu kirim') + '</span>' +
    (q.status === 'review' ? '<div><button class="chip" data-act="qretry" data-i="' + i + '">Coba lagi</button> <button class="chip" data-act="qdel" data-i="' + i + '">Hapus</button></div>' : '') + '</div></div>').join('');
  $('#rq').innerHTML = qs;
  try {
    const rows = await api('sales.list', {tanggal: day}); if (S.tab !== 'riwayat' || !$('#rlist')) return;
    const done = rows.filter(r => r.status === 'selesai'), omzet = done.reduce((a, r) => a + Number(r.total), 0), avg = done.length ? omzet / done.length : 0;
    $('#rsum').innerHTML = '<div class="kgrid"><div class="kpi"><div class="muted">Omzet</div><b>' + rp(omzet) + '</b></div><div class="kpi"><div class="muted">Transaksi</div><b>' + done.length + '</b></div><div class="kpi wide"><div class="muted">Rata-rata per transaksi</div><b>' + rp(avg) + '</b></div>' + (own() ? '<div class="kpi wide"><div class="muted">Produk terlaris</div><b id="rtop">' + (done.length ? 'Memuat…' : '-') + '</b></div>' : '') + '</div>';
    if (own() && done.length) api('report.get', {type: 'penjualan', from: day, to: day}, {silent: true}).then(r => { const el = $('#rtop'); if (!el) return; const best = r.rows.slice().sort((a, b) => b[2] - a[2])[0]; el.innerHTML = best ? esc((best[0] + ' ' + best[1]).trim()) + ' <small class="muted">' + qf(best[2]) + ' terjual</small>' : '-'; }).catch(() => { const el = $('#rtop'); if (el) el.textContent = '-'; });
    $('#rlist').innerHTML = rows.map(r => '<div class="li"><div><b>' + esc(r.nomor) + '</b><div class="muted">' + esc(String(r.tanggal).slice(11, 16)) + ' · ' + esc(chName(r.channel_id)) + ' · ' + esc(r.metode_bayar) + '</div></div><b>' + rp(r.total) + '</b></div>').join('') ||
      emptyState('riwayat', 'Belum ada transaksi', 'Tidak ada transaksi pada ' + esc(idDate(day)) + '.', '<button class="btn pri" data-act="tab" data-t="kasir">Mulai transaksi</button>');
  } catch (e) { if ($('#rlist')) $('#rlist').innerHTML = '<p class="muted">Tidak bisa memuat riwayat dari server (' + esc(e.message) + ').</p>'; }
}

/* ---------- Stok dan pembelian ---------- */
const stState = (st, min, thr) => st <= 0 ? 'out' : (min > 0 ? st <= min : st < thr) ? 'low' : 'ok';
const stBadge = x => x === 'out' ? '<span class="bdg out">Habis</span>' : x === 'low' ? '<span class="bdg low">Menipis</span>' : '';
function vStok() {
  const o = own(), bahan = S.stab === 'bahan' && o;
  const tabs = o ? wrapChips('<button class="chip ' + (S.stab === 'varian' ? 'on' : '') + '" data-act="stab" data-s="varian">Produk jadi</button><button class="chip ' + (S.stab === 'bahan' ? 'on' : '') + '" data-act="stab" data-s="bahan">Bahan dan kemasan</button>') : '';
  const cats = bahan ? ['Semua', 'bahan', 'kemasan', 'barang jadi beli'] : ['Semua'].concat(Array.from(new Set(S.data.variants.map(v => String((pById(v.product_id) || {}).kategori || '')).filter(Boolean))));
  if (cats.indexOf(S.scat) < 0) S.scat = 'Semua';
  $('#main').innerHTML = tabs + (bahan ? '<button class="btn pri" data-act="pbopen" style="margin-top:0">+ Pembelian bahan</button>' : '') +
    '<label class="search" style="margin-top:8px">' + svg('search', 18) + '<input id="sq" class="inp" data-in="sq" placeholder="' + (bahan ? 'Cari bahan' : 'Cari produk atau SKU') + '" value="' + esc(S.sq) + '" aria-label="Cari stok"></label>' +
    wrapChips(cats.map(c => '<button class="chip ' + (c === S.scat ? 'on' : '') + '" data-act="scat" data-c="' + esc(c) + '">' + esc(c === 'Semua' || !bahan ? c : c.charAt(0).toUpperCase() + c.slice(1)) + '</button>').join('')) + '<div id="ssum" class="ssum"></div><div id="slist"></div>';
  stokList();
}
function stokList() {
  const o = own(), bahan = S.stab === 'bahan' && o, q = S.sq.toLowerCase(), thr = Number(cfg('stok_menipis')) > 0 ? Number(cfg('stok_menipis')) : 5; let rows;
  if (bahan) rows = S.data.materials.filter(m => (S.scat === 'Semua' || m.tipe === S.scat) && (!q || (m.nama + ' ' + m.satuan).toLowerCase().indexOf(q) >= 0)).map(m => ({id: m.id, t: 'bahan', name: String(m.nama), lv: '', sub: 'HPP rata-rata ' + rp(m.hpp_rata2) + '/' + m.satuan, val: qf(m.stok) + ' ' + m.satuan, st: stState(Number(m.stok) || 0, Number(m.stok_minimum) || 0, thr)}));
  else rows = S.data.variants.filter(v => (S.scat === 'Semua' || String((pById(v.product_id) || {}).kategori) === S.scat) && (!q || (vName(v) + ' ' + vSub(v) + ' ' + v.sku).toLowerCase().indexOf(q) >= 0)).map(v => ({id: v.id, t: 'varian', name: String(vName(v)), lv: lvText(v.level_pedas), sub: [v.ukuran].filter(Boolean).join('') + (o ? ' · HPP ' + rp(v.hpp_rata2) : ''), val: num(v.stok), st: stState(Number(v.stok) || 0, 0, thr)}));
  const rank = {out: 0, low: 1, ok: 2}; rows.sort((a, b) => rank[a.st] - rank[b.st] || a.name.localeCompare(b.name, 'id') || a.sub.localeCompare(b.sub, 'id')); // habis dan menipis di atas
  const nOut = rows.filter(r => r.st === 'out').length, nLow = rows.filter(r => r.st === 'low').length, ss = $('#ssum');
  if (ss) ss.innerHTML = nOut || nLow ? (nOut ? '<span class="bdg out">' + nOut + ' habis</span>' : '') + (nLow ? '<span class="bdg low">' + nLow + ' menipis</span>' : '') : '<span class="muted">' + rows.length + ' item · semua stok aman</span>';
  const row = r => { const body = '<div class="st-n"><b>' + esc(r.name) + (r.lv ? ' <span class="lvt">· ' + esc(r.lv) + '</span>' : '') + '</b><div class="muted">' + esc(r.sub) + '</div></div><div class="st-v"><b>' + esc(r.val) + '</b>' + stBadge(r.st) + '</div>';
    return o ? '<button class="li st-row" data-act="adj" data-t="' + r.t + '" data-id="' + esc(r.id) + '">' + body + svg('chev', 18) + '</button>' : '<div class="li st-row">' + body + '</div>'; };
  $('#slist').innerHTML = rows.length ? rows.map(row).join('') : (S.sq || S.scat !== 'Semua' ? emptyState('stok', 'Tidak ditemukan', 'Coba kata kunci atau kategori lain.', '') :
    bahan ? emptyState('stok', 'Belum ada bahan', 'Tambahkan bahan dan kemasan yang dipakai resep di Data Master.', '<button class="btn pri" data-act="rimat">Tambah bahan</button>') :
    emptyState('stok', 'Belum ada produk', o ? 'Tambahkan produk, varian, dan stok awal di Data Master.' : 'Minta owner menambahkan produk.', o ? '<button class="btn pri" data-act="go_master">Buka Data Master</button>' : ''));
}
function adjSheet(t, id) {
  const it = t === 'bahan' ? S.data.materials.find(m => m.id === id) : vById(id); if (!it) return;
  sheet('<h2>Penyesuaian stok</h2><p class="muted">' + esc(t === 'bahan' ? it.nama : vName(it) + ' ' + vSub(it)) + ' · stok sekarang ' + qf(it.stok) + '</p><label>Stok baru<input class="inp" id="a_s" inputmode="decimal" value="' + esc(String(it.stok).replace('.', ',')) + '"></label>' +
    '<label>HPP rata-rata (kosongkan jika tidak diubah; isi untuk stok awal)<input class="inp" id="a_h" inputmode="decimal" placeholder="' + esc(it.hpp_rata2) + '"></label><label>Alasan<input class="inp" id="a_r" value="Stok opname"></label>' +
    '<button class="btn pri" data-act="adjsave" data-t="' + t + '" data-id="' + esc(id) + '">Simpan</button>');
}
async function adjSave(t, id) {
  return busy('Menyimpan stok…', async () => {
  try {
    const r = await api('stock.adjust', {tipe: t, id: id, stok_baru: dnum($('#a_s').value), hpp: $('#a_h').value.trim() === '' ? '' : dnum($('#a_h').value), alasan: $('#a_r').value});
    const it = t === 'bahan' ? S.data.materials.find(m => m.id === id) : vById(id); it.stok = r.stok; it.hpp_rata2 = r.hpp_rata2; LS.set('data', S.data); closeSheet(); render(); toast('Stok disimpan');
  } catch (e) { toast(e.message); }
  });
}
function pbSheet() {
  const m = S.data.materials, pb = S.pb, tot = pb.items.reduce((a, i) => a + i.qty * i.harga, 0);
  sheet('<h2>Pembelian bahan</h2><label>Supplier<select class="inp" data-in="pbsup"><option value="">- tanpa supplier -</option>' + S.data.suppliers.map(s => '<option value="' + esc(s.id) + '"' + (s.id === pb.sup ? ' selected' : '') + '>' + esc(s.nama) + '</option>').join('') + '</select></label>' +
    pb.items.map((i, n) => { const x = m.find(y => y.id === i.id); return '<div class="li"><div><b>' + esc(x ? x.nama : '?') + '</b><div class="muted">' + qf(i.qty) + ' ' + esc(x ? x.satuan : '') + ' @ ' + rp(i.harga) + '</div></div><button class="chip" data-act="pbdel" data-i="' + n + '">Hapus</button></div>'; }).join('') +
    '<label>Bahan<select class="inp" id="pb_m">' + m.map(x => '<option value="' + esc(x.id) + '">' + esc(x.nama) + ' (' + esc(x.satuan) + ')</option>').join('') + '</select></label><div class="row2"><div style="flex:1"><label>Jumlah<input class="inp" id="pb_q" inputmode="decimal"></label></div><div style="flex:1"><label>Harga satuan (Rp)<input class="inp" id="pb_h" inputmode="decimal"></label></div></div>' +
    '<button class="btn sec" data-act="pbadd">Tambah ke daftar</button><label>Ongkir (Rp, dialokasikan ke HPP)<input class="inp" data-in="pbongkir" inputmode="numeric" value="' + esc(pb.ongkir) + '"></label>' +
    '<div class="kv big"><span>Total</span><span>' + rp(tot + (Number(pb.ongkir) || 0)) + '</span></div><button class="btn pri" data-act="pbsave">Simpan pembelian</button>');
}
async function pbSave() {
  return busy('Menyimpan pembelian…', async () => {
  const pb = S.pb; if (!pb.items.length) return toast('Daftar masih kosong');
  try {
    const r = await api('purchase.create', {supplier_id: pb.sup, ongkir: Number(pb.ongkir) || 0, items: pb.items.map(i => ({material_id: i.id, qty: i.qty, harga_satuan: i.harga}))});
    r.materials.forEach(u => { const m = S.data.materials.find(x => x.id === u.id); if (m) { m.stok = u.stok; m.hpp_rata2 = u.hpp_rata2; } });
    LS.set('data', S.data); S.pb = {items: [], ongkir: '', sup: ''}; closeSheet(); render(); toast('Pembelian tersimpan, HPP diperbarui');
  } catch (e) { toast(e.message); }
  });
}

/* ---------- Menu, data master, pengguna, pengaturan ---------- */
const standalone = () => !!((window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true);
function confirmLogout() {
  const p = S.queue.length; if (!confirm(p ? 'Masih ada ' + p + ' transaksi yang belum terkirim ke server. Transaksi itu tetap tersimpan di perangkat dan dikirim saat Anda masuk lagi. Tetap keluar?' : 'Keluar dari akun ini?')) return;
  S.dirty = false; logout();
}
function vMenu() {
  const u = S.data.user, o = own(), nIssue = o && APP.issueCount ? APP.issueCount() : 0;
  const mi = (a, ic, t, sub, cl, bd) => '<button class="mi ' + (cl || '') + '" data-act="' + a + '"><span class="mi-i">' + svg(ic, 20) + '</span><span class="mi-t"><b>' + t + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span>' + (bd ? '<span class="mi-b" aria-label="' + bd + ' masalah">' + bd + '</span>' : '') + svg('chev', 18) + '</button>';
  const inst = S.installEv && !standalone() ? '<div class="grp">' + mi('install', 'install', 'Pasang Aplikasi', 'Tambahkan ke layar utama agar terbuka seperti aplikasi') + '</div>' :
    (isIOS() && !standalone() ? '<div class="li" style="display:block"><b>Pasang di layar utama</b><div class="muted">Di Safari, ketuk tombol Bagikan lalu pilih "Tambah ke Layar Utama".</div></div>' : '');
  $('#main').innerHTML = '<div class="profile"><div class="av">' + esc(String(u.nama || '?').charAt(0).toUpperCase()) + '</div><div class="pi"><b>' + esc(u.nama) + '</b><div class="muted">' + esc(u.role) + ' · versi ' + esc(C.VERSION || '') + '</div></div><span class="badge ' + (navigator.onLine ? 'ok' : 'off') + '">' + (navigator.onLine ? 'Online' : 'Offline') + '</span></div>' +
    '<p class="muted note">Data terakhir diperbarui: ' + (S.lastSync ? fmtDT(S.lastSync).slice(11) : 'dari cache perangkat') + '. Aplikasi hanya memuat ulang jika ada data baru.</p>' + inst +
    (o ? '<div class="grp"><h3>Operasional</h3>' + mi('go_riwayat', 'riwayat', 'Riwayat penjualan', 'Transaksi per tanggal') + mi('go_laporan', 'laporan', 'Laporan', 'Laba rugi, penjualan, HPP, stok') + mi('go_cek', 'cek', 'Pemeriksaan data', nIssue ? nIssue + ' hal perlu diperbaiki' : 'Kelengkapan data dan kesesuaian stok', '', nIssue) + '</div>' +
      '<div class="grp"><h3>Data</h3>' + mi('go_master', 'master', 'Data Master', 'Produk, varian, harga, bahan, resep, biaya') + mi('go_shopee', 'shopee', 'Impor pesanan Shopee', 'Dari file CSV') + mi('go_users', 'users', 'Pengguna', 'Owner dan kasir') + mi('go_settings', 'settings', 'Pengaturan', 'Usaha, PPN, stok, printer, HPP') + mi('go_arsip', 'master', 'Arsip data', 'Rapikan data lama agar tetap cepat') + '</div>' : '') +
    '<div class="grp"><h3>Sistem</h3>' + mi('sync', 'sync', 'Perbarui data', 'Muat ulang dan kirim antrean') + mi('go_diag', 'diag', 'Diagnostik dan uji cetak', 'Cek koneksi, WhatsApp, dan printer') + '</div>' +
    '<div class="grp grp-out">' + mi('logout', 'out', 'Keluar', 'Keluar dari akun ini', 'danger') + '</div>';
}
function vDiag() {
  const q = S.queue, errs = LS.get('errlog', []), kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>', standalone = window.matchMedia && matchMedia('(display-mode: standalone)').matches;
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div class="card-s"><h3>Info perangkat</h3>' + kv('Versi aplikasi', esc(C.VERSION || '-')) + kv('Mode', standalone ? 'Terpasang (layar utama)' : 'Browser') + kv('Koneksi', navigator.onLine ? 'Online' : 'Offline') +
    kv('Android (untuk RawBT)', isAndroid() ? 'Ya' : 'Tidak') + kv('Fitur Bagikan', navigator.share ? 'Tersedia' : 'Tidak tersedia') + kv('Antrean transaksi', q.filter(x => x.status === 'pending').length + ' menunggu, ' + q.filter(x => x.status === 'review').length + ' perlu ditinjau') + kv('Lebar struk', rcWidth() + ' karakter') + '</div>' +
    '<div class="card-s"><h3>Uji koneksi server</h3><button class="btn sec" data-act="dping">Uji koneksi</button><div id="dres" class="muted" style="margin-top:6px"></div></div>' +
    '<div class="card-s"><h3>Printer Bluetooth</h3>' + kv('Android (RawBT)', isAndroid() ? 'Ya' : 'Tidak') + kv('iPhone / iPad', isIOS() ? 'Ya' : 'Tidak') + kv('Web Bluetooth (BLE langsung)', navigator.bluetooth ? 'Tersedia' : 'Tidak tersedia') + kv('Printer tersimpan', esc(LS.get('btname', '') || '-')) + '<label style="margin:8px 0"><input type="checkbox" data-act="btdirect"' + (LS.get('btdirect', false) ? ' checked' : '') + '> Cetak langsung via BLE (tanpa RawBT)</label><button class="btn sec" data-act="btpick">Pilih printer BLE</button>' + (isIOS() ? '<p class="muted">iPhone: gunakan browser dengan Web Bluetooth (mis. Bluefy) dan printer BLE.</p>' : '') + '</div>' +
    '<div class="card-s"><h3>Uji struk</h3><p class="muted">Memeriksa WhatsApp dan printer tanpa membuat transaksi.</p><div class="row2"><button class="btn wa" data-act="dtwa">Uji WhatsApp</button><button class="btn dark" data-act="dtbt">Uji cetak Bluetooth</button></div><button class="btn sec" data-act="dtshare">Uji Bagikan</button>' +
    '<p class="muted">Cetak Bluetooth memakai aplikasi <b>RawBT</b> (Android): pasang dari Play Store, pasangkan printer di dalam RawBT, lalu coba cetak dari RawBT dulu.</p></div>' +
    '<div class="card-s"><h3>Catatan kesalahan</h3>' + (errs.length ? errs.slice(0, 8).map(e => '<div class="muted" style="margin-bottom:6px">' + esc(fmtDT(e.t).slice(5)) + ' · ' + esc(e.c) + ': ' + esc(e.m) + '</div>').join('') : '<p class="muted">Belum ada.</p>') + '<div class="row2"><button class="btn sec" data-act="dcopy">Salin log</button><button class="btn sec" data-act="dclear">Hapus catatan</button></div><p class="muted">Galat dari ekstensi browser tidak ikut dicatat.</p></div>';
}
const RT = {};
const MT = {
  products: {l: 'Produk', k: 'products', f: [['nama', 'Nama produk'], ['kategori', 'Kategori (mis. Basreng)']], t: r => r.nama + (r.kategori ? ' · ' + r.kategori : '')},
  product_variants: {l: 'Varian', k: 'variants', f: [['product_id', 'Produk', 'ref:products'], ['sku', 'SKU (kosongkan untuk otomatis)'], ['ukuran', 'Ukuran kemasan (mis. 100 g)'], ['level_pedas', 'Level pedas (mis. Level 3)']], t: r => vName(r) + ' · ' + vSub(r)},
  channel_prices: {l: 'Harga jual', k: 'prices', f: [['variant_id', 'Varian', 'ref:variants'], ['channel_id', 'Channel', 'ref:channels'], ['harga_jual', 'Harga jual (Rp)', 'number']], t: r => { const v = vById(r.variant_id); return (v ? vName(v) + ' ' + vSub(v) : '?') + ' · ' + chName(r.channel_id) + ' · ' + rp(r.harga_jual); }},
  materials: {l: 'Bahan dan kemasan', k: 'materials', f: [['nama', 'Nama'], ['tipe', 'Tipe', 'sel:bahan,kemasan,barang jadi beli'], ['satuan', 'Satuan (kg, gram, pcs)'], ['stok_minimum', 'Stok minimum', 'number'], ['satuan_kecil', 'Satuan kecil untuk resep (opsional, mis. ml)'], ['faktor_kecil', 'Isi satuan kecil per 1 satuan (mis. 1000)', 'number']], t: r => r.nama + ' (' + r.satuan + ')'},
  suppliers: {l: 'Supplier', k: 'suppliers', f: [['nama', 'Nama'], ['kontak', 'Kontak'], ['catatan', 'Catatan']], t: r => r.nama},
  expenses: {l: 'Biaya operasional', k: 'expenses', f: [['tanggal', 'Tanggal', 'date'], ['kategori', 'Kategori', 'sel:Gas,Listrik,Air,Sewa,Gaji/Tenaga kerja,Transport,Pemasaran,Lain-lain'], ['nominal', 'Nominal (Rp)', 'number'], ['catatan', 'Catatan']], t: r => String(r.tanggal).slice(0, 10) + ' · ' + r.kategori + ' · ' + rp(r.nominal)},
  channels: {l: 'Channel', k: 'channels', f: [['nama', 'Nama'], ['fee_persen', 'Fee (%)', 'number'], ['fee_tetap', 'Fee tetap (Rp)', 'number']], t: r => r.nama + ' · fee ' + (r.fee_persen || 0) + '%'}
};
Object.keys(MT).forEach(k => RT[MT[k].k] = MT[k].t);
function field(f, val) {
  const k = f[0], l = f[1], t = f[2] || '', v = val == null ? '' : val;
  if (t.indexOf('ref:') === 0) { const key = t.slice(4); return '<label>' + l + '<select class="inp" data-f="' + k + '"><option value="">- pilih -</option>' + S.data[key].map(r => '<option value="' + esc(r.id) + '"' + (r.id === v ? ' selected' : '') + '>' + esc(RT[key](r)) + '</option>').join('') + '</select></label>'; }
  if (t.indexOf('sel:') === 0) return '<label>' + l + '<select class="inp" data-f="' + k + '">' + t.slice(4).split(',').map(o => '<option' + (o === v ? ' selected' : '') + '>' + o + '</option>').join('') + '</select></label>';
  if (t === 'date') return '<label>' + l + '<input type="date" class="inp" data-f="' + k + '" value="' + esc(String(v).slice(0, 10)) + '"></label>';
  const uq = a => Array.from(new Set(a.filter(Boolean))), D = S.data || {products: [], variants: []};
  const sug = k === 'kategori' ? uq((D.products || []).map(p => p.kategori)) : k === 'ukuran' ? uq((D.variants || []).map(x => x.ukuran).concat(['50 g', '100 g', '250 g', '500 g'])) :
    k === 'level_pedas' ? uq((D.variants || []).map(x => x.level_pedas).concat(['Original', 'Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5'])) : null;
  return '<label>' + l + '<input class="inp" data-f="' + k + '"' + (sug ? ' list="dl_' + k + '"' : '') + (t === 'number' ? ' inputmode="decimal"' : '') + ' value="' + esc(v) + '">' +
    (sug ? '<datalist id="dl_' + k + '">' + sug.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist>' : '') + '</label>';
}
function readForm() { const o = {}; document.querySelectorAll('#sheet [data-f]').forEach(e => o[e.dataset.f] = e.type === 'checkbox' ? e.checked : e.value); return o; }
function vMaster() {
  const cfg = MT[S.mt], rows = S.mt === 'expenses' ? (S.exp || []) : (S.data[cfg.k] || []);
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div class="chips" style="margin-top:8px">' + Object.keys(MT).map(k => '<button class="chip ' + (k === S.mt ? 'on' : '') + '" data-act="mt" data-k="' + k + '">' + MT[k].l + '</button>').join('') + '<button class="chip" data-act="go_resep">Resep</button></div>' +
    '<button class="btn pri" data-act="medit" data-id="">+ Tambah ' + cfg.l.toLowerCase() + '</button><div style="height:8px"></div>' +
    rows.map(r => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left" data-act="medit" data-id="' + esc(r.id) + '"><span>' + esc(cfg.t(r)) + '</span><span class="muted">Ubah</span></button>').join('') + (S.mt === 'expenses' && !S.expLoaded ? skel(3) : '');
  if (S.mt === 'expenses' && !S.expLoaded) loadExp();
}
async function loadExp() { try { S.exp = await api('master.list', {table: 'expenses'}); S.expLoaded = true; if (S.tab === 'master') vMaster(); } catch (e) { toast(e.message); } }
function meditSheet(id) {
  const cfg = MT[S.mt], r = id ? (S.mt === 'expenses' ? S.exp : S.data[cfg.k]).find(x => x.id === id) : {tanggal: today()};
  sheet('<h2>' + (id ? 'Ubah ' : 'Tambah ') + cfg.l.toLowerCase() + '</h2>' + cfg.f.map(f => field(f, r[f[0]])).join('') + (S.mt === 'product_variants' ? '<button class="btn sec sm" data-act="skugen" data-id="' + esc(id) + '">Buat SKU otomatis</button>' : '') + '<button class="btn pri" data-act="msave" data-id="' + esc(id) + '">Simpan</button>' + (id ? '<button class="btn dan" data-act="mdel" data-id="' + esc(id) + '">Hapus</button>' : ''));
}
async function mSave(id) {
  return busy('Menyimpan data…', async () => {
  const data = readForm(); if (id) data.id = id;
  ['harga_jual', 'fee_persen', 'fee_tetap', 'stok_minimum', 'nominal', 'faktor_kecil'].forEach(k => { if (k in data) data[k] = dnum(data[k]) || 0; });
  try { await api('master.save', {table: S.mt, data: data}); S.expLoaded = false; await loadData(); closeSheet(); render(); toast('Tersimpan'); } catch (e) { toast(e.message); }
  });
}
async function mDel(id) {
  return busy('Menghapus…', async () => {
  if (!confirm('Hapus data ini?')) return;
  try { await api('master.remove', {table: S.mt, id: id}); S.expLoaded = false; await loadData(); closeSheet(); render(); toast('Dihapus'); } catch (e) { toast(e.message); }
  });
}
async function vUsers() {
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><button class="btn pri" data-act="uedit" data-id="">+ Tambah pengguna</button><div id="ul">' + skel(3) + '</div>';
  try { S.users = await api('user.list'); if (!$('#ul')) return; $('#ul').innerHTML = S.users.map(u => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left;margin-top:8px" data-act="uedit" data-id="' + esc(u.id) + '"><span><b>' + esc(u.nama) + '</b> <span class="muted">@' + esc(u.username) + ' · ' + esc(u.role) + '</span></span>' + (String(u.aktif) === 'false' ? '<span class="tag red">Nonaktif</span>' : '') + '</button>').join(''); }
  catch (e) { if ($('#ul')) $('#ul').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }
}
function ueditSheet(id) {
  const u = id ? S.users.find(x => x.id === id) : {role: 'kasir', aktif: true};
  sheet('<h2>' + (id ? 'Ubah' : 'Tambah') + ' pengguna</h2>' + field(['nama', 'Nama'], u.nama) + field(['username', 'Username'], u.username) + field(['role', 'Peran', 'sel:kasir,owner'], u.role) +
    '<label>PIN (4-8 angka)' + (id ? ', kosongkan jika tidak diganti' : '') + '<input class="inp" data-f="pin" inputmode="numeric" type="password"></label><label><input type="checkbox" data-f="aktif"' + (String(u.aktif) !== 'false' ? ' checked' : '') + '> Aktif</label><button class="btn pri" data-act="usave" data-id="' + esc(id) + '">Simpan</button>');
}
async function uSave(id) {
  return busy('Menyimpan pengguna…', async () => {
  const d = readForm(); if (id) d.id = id;
  try { await api('user.save', d); closeSheet(); vUsers(); toast('Tersimpan'); } catch (e) { toast(e.message); }
  });
}
const selF = (k, l, pairs, cur) => '<label>' + l + '<select class="inp" data-f="' + k + '">' + pairs.map(p => '<option value="' + p[0] + '"' + (String(cur) === p[0] ? ' selected' : '') + '>' + p[1] + '</option>').join('') + '</select></label>';
const setSnap = () => JSON.stringify(Array.from(document.querySelectorAll('#sf [data-f]')).map(e => e.type === 'checkbox' ? e.checked : e.value));
function sDepUpd() { // field yang bergantung: tarif PPN hanya saat PPN aktif; overhead sesuai cara hitung yang dipilih
  const on = k => { const e = document.querySelector('#sf [data-f=' + k + ']'); return e && e.checked; }, m = (document.querySelector('#sf [data-f=metode_overhead]') || {}).value || 'per_unit';
  const set = (id, show) => { const e = $('#' + id); if (e) e.hidden = !show; };
  set('ppn-x', on('ppn_aktif')); set('oh-unit', m === 'per_unit'); set('oh-batch', m === 'per_batch');
  const h = $('#oh-hint'); if (h) h.textContent = m === 'per_batch' ? 'Biaya overhead (gas, listrik, dll.) dihitung tetap setiap sekali produksi, berapa pun hasilnya.' : 'Biaya overhead (gas, listrik, dll.) dihitung per bungkus yang dihasilkan. Contoh: Rp300 × 118 bungkus.';
}
function sDirty() { S.dirty = setSnap() !== S.sSnap; const b = $('#ssavebtn'); if (b) b.disabled = !S.dirty; sDepUpd(); }
const swRow = (attr, l, sub, on, dis) => '<label class="sw"><input type="checkbox" ' + attr + (on ? ' checked' : '') + (dis ? ' disabled' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>' + l + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span></label>';
function addonSheet() {
  sheet('<div class="grab"></div><h2>Buat produk tambahan</h2><p class="muted">Contoh: kantong kresek. Muncul di menu pembayaran kasir sebagai "Tambahan". Harga berlaku untuk semua channel; stok berkurang otomatis setiap terjual.</p>' +
    '<label>Nama<input class="inp" id="ad_n" value="Kantong Kresek"></label><div class="row2"><div style="flex:1"><label>Harga jual (Rp)<input class="inp" id="ad_h" inputmode="decimal" value="500"></label></div><div style="flex:1"><label>Biaya/HPP per buah (Rp)<input class="inp" id="ad_c" inputmode="decimal" value="0"></label></div></div>' +
    '<label>Stok awal (jumlah)<input class="inp" id="ad_s" inputmode="decimal" value="100"></label><button class="btn pri" data-act="addonsave">Simpan</button><button class="btn sec" data-act="close">Batal</button>');
}
function resetSheet() {
  const n = S.queue.length;
  sheet('<div class="grab"></div><h2>Reset data transaksi</h2><div class="warn-b" role="alert"><div><b>Tidak bisa dibatalkan dari aplikasi.</b><div class="muted">Menghapus riwayat transaksi untuk pemutihan. Data master (produk, varian, harga, bahan, resep, pengguna, pengaturan) tidak dihapus. Cadangan seluruh database dibuat otomatis di Google Drive (folder "Duado Backup") sebelum menghapus; bila cadangan gagal, tidak ada yang dihapus.</div></div></div>' +
    '<div class="set-card" style="padding:4px 12px">' + swRow('', 'Penjualan dan rinciannya', 'Selalu dihapus', true, true) + swRow('data-rs="pembelian"', 'Pembelian bahan', '', true) + swRow('data-rs="produksi"', 'Produksi dan biayanya', '', true) + swRow('data-rs="biaya"', 'Biaya operasional', '', true) +
    swRow('data-rs="nol"', 'Nolkan juga semua stok', 'Tanpa ini, stok dan HPP saat ini dipertahankan sebagai saldo awal', false) + '</div>' +
    (n ? '<p class="err">Masih ada ' + n + ' transaksi belum terkirim di perangkat ini. Kirim dulu lewat Menu, Perbarui data.</p>' : '<p class="muted">Pastikan semua perangkat kasir berstatus Tersinkron sebelum reset.</p>') +
    '<label>Ketik <b>RESET</b> untuk melanjutkan<input class="inp" id="rs_c" data-rs="c" autocomplete="off" autocapitalize="characters"></label><button class="btn dan big" id="rsbtn" data-act="resetgo" disabled>Reset sekarang</button><button class="btn sec" data-act="close">Batal</button>');
}
function resetResult(r) {
  const L = {sales: 'Penjualan', sale_items: 'Rincian penjualan', purchases: 'Pembelian', purchase_items: 'Rincian pembelian', production_orders: 'Produksi', production_costs: 'Biaya produksi', expenses: 'Biaya operasional', stock_movements: 'Mutasi stok'};
  sheet('<div class="grab"></div><div class="okmark">' + svg('check', 30) + '</div><h2 class="c">Reset selesai</h2>' + Object.keys(r.dihapus).map(k => '<div class="kv"><span>' + (L[k] || k) + '</span><span>' + num(r.dihapus[k]) + ' baris dihapus</span></div>').join('') +
    '<p class="muted">Cadangan sebelum reset: <a href="' + esc(r.backup) + '" target="_blank" rel="noopener">buka di Google Drive</a>.</p><button class="btn pri big" data-act="close">Selesai</button>');
}
function vSettings() {
  const s = S.data.settings, g = (k, d) => (s[k] == null || s[k] === '' ? d : s[k]), card = (t, h) => '<section class="set-card"><h3>' + t + '</h3>' + h + '</section>';
  const sw = (k, l, sub) => '<label class="sw"><input type="checkbox" data-f="' + k + '"' + (T(s[k]) ? ' checked' : '') + '><span class="sw-t" aria-hidden="true"></span><span class="sw-l"><b>' + l + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span></label>';
  const m = $('#main'); m.className = 'col';
  m.innerHTML = '<button class="chip" data-act="tab" data-t="menu" style="align-self:flex-start">← Menu</button><div id="sf" style="margin-top:8px">' +
    card('Usaha & Struk', field(['nama_usaha', 'Nama usaha'], s.nama_usaha) + field(['footer_struk', 'Teks bawah struk'], s.footer_struk) + selF('lebar_struk', 'Lebar kertas struk', [['32', '58 mm (32 karakter)'], ['48', '80 mm (48 karakter)']], g('lebar_struk', '32'))) +
    card('Pajak (PPN)', sw('ppn_aktif', 'Aktifkan PPN', 'Hitung PPN pada setiap transaksi') + '<div id="ppn-x">' + field(['ppn_persen', 'Tarif PPN (%)', 'number'], s.ppn_persen) + sw('ppn_inklusif', 'Harga jual sudah termasuk PPN') + '</div>') +
    card('Stok', sw('blokir_stok_minus', 'Blokir penjualan jika stok kurang', 'Kasir tidak bisa menjual produk yang stoknya habis') + field(['stok_menipis', 'Batas "Menipis" produk jadi (jumlah)', 'number'], g('stok_menipis', '5'))) +
    card('Kantong & Tambahan', '<p class="muted">Produk berkategori "Tambahan" (mis. kantong kresek) muncul di menu pembayaran kasir sebagai pilihan tambahan, bukan di daftar produk.</p>' +
      (S.data.variants.filter(isAddon).map(v => '<div class="kv"><span>' + esc(vName(v)) + '</span><span>' + rp(priceOf(v.id, S.ch) || 0) + ' · stok ' + num(v.stok) + '</span></div>').join('') || '<p class="muted">Belum ada produk tambahan.</p>') +
      '<button class="btn sec sm" data-act="addonnew">+ Buat produk tambahan (kresek)</button>') +
    card('Printer', sw('auto_cetak', 'Langsung cetak setelah bayar', 'RawBT (Android) atau printer Bluetooth BLE') + '<button class="btn sec sm" data-act="go_diag">Atur dan uji printer</button>') +
    card('HPP & Overhead', selF('metode_overhead', 'Cara menghitung overhead', [['per_unit', 'Per bungkus'], ['per_batch', 'Per sekali produksi']], g('metode_overhead', 'per_unit')) + '<p class="muted" id="oh-hint"></p><div id="oh-unit">' + field(['overhead_per_unit', 'Overhead per bungkus (Rp)', 'number'], s.overhead_per_unit) + '</div><div id="oh-batch">' + field(['overhead_per_batch', 'Overhead per sekali produksi (Rp)', 'number'], s.overhead_per_batch) + '</div>' + field(['target_margin', 'Target margin minimum (%)', 'number'], g('target_margin', 30))) +
    card('Zona berbahaya', '<p class="muted">Pemutihan data: menghapus riwayat transaksi. Data master tidak dihapus dan cadangan Google Drive dibuat otomatis lebih dulu.</p><button class="btn dan sm" data-act="resetopen">Reset data transaksi…</button>') +
    '</div><div class="savebar"><button class="btn pri big" id="ssavebtn" data-act="ssave" disabled>Simpan pengaturan</button></div>';
  S.sSnap = setSnap(); S.dirty = false; sDepUpd();
}
async function sSave() {
  return busy('Menyimpan pengaturan…', async () => {
  const v = {}; document.querySelectorAll('#sf [data-f]').forEach(e => v[e.dataset.f] = e.type === 'checkbox' ? e.checked : e.value);
  ['ppn_persen', 'overhead_per_unit', 'overhead_per_batch', 'target_margin', 'stok_menipis'].forEach(k => { if (k in v) { const n = dnum(v[k]); v[k] = isNaN(n) ? 0 : n; } });
  try { await api('setting.setMany', {values: v}); S.dirty = false; await loadData(); render(); toast('Pengaturan tersimpan'); } catch (e) { toast(e.message); }
  });
}

/* ---------- Aksi (event delegation) ---------- */
const ACT = {
  login: doLogin, logout: confirmLogout, close: closeSheet, cart: cartSheet, pay: pay,
  hideout: el => { S.hideOut = !!el.checked; LS.set('hideOut', S.hideOut); grid(); }, showout: () => { S.hideOut = false; LS.set('hideOut', false); vKasir(); },
  rday: el => { const p = el.dataset.p; if (p === 'today') { S.day = today(); S.rcustom = false; } else if (p === 'yday') { S.day = addDays(today(), -1); S.rcustom = false; } else S.rcustom = true; vRiwayat(); },
  scat: el => { S.scat = el.dataset.c; vStok(); },
  install: async () => { const ev = S.installEv; if (!ev) return; try { ev.prompt(); await ev.userChoice; } catch (e) {} S.installEv = null; if (S.tab === 'menu') vMenu(); },
  tab: el => { S.tab = el.dataset.t; render(); },
  chan: el => { S.ch = el.dataset.c; LS.set('ch', S.ch); vKasir(); cartbar(); },
  cat: el => { S.cat = el.dataset.c; vKasir(); },
  add: el => { if (el.classList.contains('off')) { const v = vById(el.dataset.v); return toast(priceOf(el.dataset.v, S.ch) == null ? 'Harga belum diatur untuk channel ini' : 'Stok habis'); } addToCart(el.dataset.v); },
  inc1: el => addToCart(el.dataset.v), dec1: el => dropFromCart(el.dataset.v),
  inc: el => { const l = S.cart[el.dataset.i]; if (!l) return; const st = Number(vById(l.v).stok) || 0; if (T(cfg('blokir_stok_minus')) && l.qty + 1 > st) return toast('Stok tidak cukup'); l.qty++; saveCart(); cartLines(); addonsRender(); cashBox(); upd(); updCard(l.v); buzz(); },
  dec: el => { const l = S.cart[el.dataset.i]; if (!l) return; const id = l.v; l.qty--; if (l.qty <= 0) S.cart.splice(el.dataset.i, 1); saveCart(); if (!S.cart.length && !isWide()) closeSheet(); cartLines(); addonsRender(); cashBox(); upd(); updCard(id); },
  metode: el => { S.metode = el.dataset.m; LS.set('metode', S.metode); const c = $('#mchips'); if (c) c.innerHTML = methodChips(); cashBox(); upd(); },
  qk: el => { S.terima = el.dataset.n; cashBox(); upd(); },
  wa: () => waSend(S.rc, ($('#wa') || {}).value), rawbt: () => printBT(S.rc), print: () => printBrowser(), share: () => shareRc(S.rc), copyrc: () => copyText(receiptText(S.rc)),
  addonnew: () => { if (S.dirty) return toast('Simpan perubahan pengaturan dulu.'); addonSheet(); },
  addonsave: () => { const n = $('#ad_n').value.trim(), h = dnum($('#ad_h').value), c = dnum($('#ad_c').value), st = dnum($('#ad_s').value); if (!n) return toast('Isi nama produk tambahan'); if (!(h >= 0)) return toast('Harga jual tidak valid');
    return busy('Membuat produk tambahan…', async () => { try { await api('addon.create', {nama: n, harga: h, hpp: isNaN(c) ? 0 : c, stok: isNaN(st) ? 0 : st}); await loadData(); closeSheet(); render(); toast('Produk tambahan dibuat'); } catch (e) { toast(e.message); } }); },
  resetopen: () => { if (S.dirty) return toast('Simpan perubahan pengaturan dulu.'); resetSheet(); },
  resetgo: () => { const q = k => { const e = document.querySelector('#sheet [data-rs=' + k + ']'); return !!(e && e.checked); };
    return busy('Membuat cadangan dan mereset data…', async () => { try { const r = await api('data.reset', {konfirmasi: 'RESET', pembelian: q('pembelian'), produksi: q('produksi'), biaya: q('biaya'), nol_stok: q('nol')});
      ['hari', 'minggu', 'bulan'].forEach(p => LS.del('dash_' + p)); S.exp = null; S.expLoaded = false; S.day = null; await loadData(); closeSheet(); render(); resetResult(r); } catch (e) { toast(e.message); } }); },
  go_diag: () => { S.tab = 'diag'; render(); }, go_arsip: () => { S.tab = 'arsip'; render(); },
  queue: queueSheet, qnow: () => { flush(); setTimeout(() => { if (S.qopen) queueSheet(); }, 700); },
  btdirect: el => { LS.set('btdirect', !!el.checked); toast(el.checked ? 'Cetak langsung via BLE aktif' : 'Cetak lewat RawBT (Android)'); },
  btpick: async () => { try { await btConnect(true); toast('Printer dipilih: ' + (BT.dev.name || 'tanpa nama')); vDiag(); } catch (e) { toast(e && e.name === 'NotFoundError' ? 'Pemilihan printer dibatalkan' : 'Gagal: ' + (e.message || e)); } },
  skugen: el => { const f = {}; document.querySelectorAll('#sheet [data-f]').forEach(e => f[e.dataset.f] = e.value); if (!f.product_id) return toast('Pilih produk dulu'); const i = document.querySelector('#sheet [data-f=sku]'); if (i) i.value = genSkuLocal(f, el.dataset.id || ''); },
  dtwa: () => waSend(testRc(), ''), dtbt: () => printBT(testRc()), dtshare: () => shareRc(testRc()),
  dping: async () => { const el = $('#dres'); el.textContent = 'Menguji…'; const t0 = performance.now(); try { await api('ping', {}, {silent: true}); el.textContent = 'Berhasil: ' + Math.round(performance.now() - t0) + ' ms'; } catch (e) { el.textContent = 'Gagal: ' + e.message; logErr(e, 'ping'); } },
  dcopy: () => copyText(JSON.stringify({v: C.VERSION, ua: navigator.userAgent, online: navigator.onLine, queue: S.queue.length, penyimpanan: Store.mode(), err: LS.get('errlog', [])}, null, 1), 'Log disalin. Tempel untuk dikirim.'),
  dclear: () => { LS.set('errlog', []); vDiag(); toast('Catatan kesalahan dihapus'); },
  copyurl: () => copyText(location.href.split('#')[0], 'Alamat aplikasi disalin.'),
  qretry: el => { const q = S.queue[el.dataset.i]; if (q) { q.status = 'pending'; q.state = 'waiting'; q.error = ''; } LS.set('queue', S.queue); qrefresh(); flush(); },
  qdel: el => { if (confirm('Hapus transaksi ini dari antrean? Stok di perangkat akan dikembalikan.')) { const q = S.queue.splice(el.dataset.i, 1)[0]; q.payload.items.forEach(it => { const v = vById(it.variant_id); if (v) v.stok = r6((Number(v.stok) || 0) + it.qty); }); LS.set('queue', S.queue); LS.set('data', S.data); badge(); qrefresh(); } },
  stab: el => { S.stab = el.dataset.s; S.scat = 'Semua'; S.sq = ''; vStok(); },
  adj: el => adjSheet(el.dataset.t, el.dataset.id), adjsave: el => adjSave(el.dataset.t, el.dataset.id),
  pbopen: pbSheet, pbdel: el => { S.pb.items.splice(el.dataset.i, 1); pbSheet(); }, pbsave: pbSave,
  pbadd: () => { const q = dnum($('#pb_q').value), h = dnum($('#pb_h').value), id = $('#pb_m').value; if (!id || !(q > 0) || !(h >= 0) || $('#pb_h').value === '') return toast('Isi jumlah dan harga'); S.pb.items.push({id: id, qty: q, harga: h}); pbSheet(); },
  go_master: () => { S.tab = 'master'; render(); }, go_riwayat: () => { S.tab = 'riwayat'; render(); }, go_laporan: () => { S.tab = 'laporan'; render(); }, go_shopee: () => { S.tab = 'shopee'; render(); }, go_resep: () => { S.tab = 'resep'; render(); }, go_cek: () => { S.tab = 'cek'; render(); }, go_users: () => { S.tab = 'users'; render(); }, go_settings: () => { S.tab = 'settings'; render(); },
  mt: el => { S.mt = el.dataset.k; vMaster(); }, medit: el => meditSheet(el.dataset.id), msave: el => mSave(el.dataset.id), mdel: el => mDel(el.dataset.id),
  uedit: el => ueditSheet(el.dataset.id), usave: el => uSave(el.dataset.id), ssave: sSave,
  sync: () => busy('Memperbarui data…', async () => { try { if (own()) await api('sistem.refresh', {}); await loadData(); lastChk = Date.now(); render(); await flush(); toast('Data diperbarui'); } catch (e) { if (e.auth) softLogout(); else toast('Gagal memperbarui: ' + e.message); } })
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'), a = el && el.dataset.act; if (!el || !ACT[a]) return;
  if (S.dirty && S.tab === 'settings' && (a === 'tab' || a === 'logout' || a === 'sync' || /^go_/.test(a))) { if (!confirm('Perubahan pengaturan belum disimpan. Keluar tanpa menyimpan?')) return; S.dirty = false; }
  ACT[a](el);
});
document.addEventListener('input', e => { if (S.tab === 'settings' && e.target.closest && e.target.closest('#sf')) sDirty(); const d = e.target.dataset; if (d && d.rs === 'c') { const b = $('#rsbtn'); if (b) b.disabled = !(e.target.value.trim() === 'RESET' && !S.queue.length); } });
document.addEventListener('change', e => { if (S.tab === 'settings' && e.target.closest && e.target.closest('#sf')) sDirty(); });
window.addEventListener('beforeunload', e => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEv = e; if (S.tab === 'menu' && S.data) vMenu(); });
window.addEventListener('appinstalled', () => { S.installEv = null; if (S.tab === 'menu' && S.data) vMenu(); });
window.addEventListener('resize', () => initFades());
document.addEventListener('input', e => {
  const k = e.target.dataset && e.target.dataset.in; if (!k) return; let v = e.target.value;
  if (k === 'q') { S.q = v; return grid(); }
  if (k === 'sq') { S.sq = v; return stokList(); }
  if (k === 'pbsup') { S.pb.sup = v; return; }
  if (k === 'pbongkir') { S.pb.ongkir = v.replace(/\D/g, ''); return; }
  if (k === 'catatan') { S.catatan = v; return; }
  if (k === 'diskon' || k === 'terima') { v = v.replace(/\D/g, ''); S[k] = v; return upd(); }
});
document.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.chg === 'day') { S.day = e.target.value; vRiwayat(); } });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && $('#lp') && document.activeElement === $('#lp')) doLogin(); });

/* ---------- Mulai ---------- */
let swReg = null;
function updBanner() { const b = $('#upd'); b.hidden = false; b.innerHTML = 'Versi baru tersedia <button data-act="reload">Muat ulang</button>'; }
if ('serviceWorker' in navigator) {
  const had = !!navigator.serviceWorker.controller; let rl = false;
  navigator.serviceWorker.register('sw.js').then(reg => {
    swReg = reg; if (reg.waiting && had) updBanner();
    reg.addEventListener('updatefound', () => { const nw = reg.installing; if (nw) nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) updBanner(); }); });
  }).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had && !rl) { rl = true; location.reload(); } });
}
ACT.reload = () => { if (swReg && swReg.waiting) swReg.waiting.postMessage({type: 'SKIP_WAITING'}); else location.reload(); };
window.addEventListener('online', () => { badge(); flush(); checkUpdates(true); });
window.addEventListener('offline', badge);
document.addEventListener('visibilitychange', () => { if (document.hidden) Store.flush(); if (!document.hidden) { checkUpdates(); flush(); if (swReg) swReg.update().catch(() => {}); } });
async function start() {
  await Store.init();
  S.token = LS.get('token', null); S.data = LS.get('data', null); S.queue = LS.get('queue', []); S.ch = LS.get('ch', null); S.cart = LS.get('cart', []); S.metode = LS.get('metode', 'tunai'); S.lastSync = LS.get('lastsync', 0) || null; S.hideOut = !!LS.get('hideOut', false);
  if (S.token && S.data) { S.tab = own() ? 'dash' : 'kasir'; render(); checkUpdates(true); flush(); } else renderLogin();
}
window.addEventListener('pagehide', () => Store.flush());
if (window.MutationObserver) new MutationObserver(() => { cancelAnimationFrame(S.fr); S.fr = requestAnimationFrame(initFades); }).observe(document.getElementById('app'), {childList: true, subtree: true});
if (window.matchMedia) { const mq = matchMedia('(min-width: 900px)'); (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(() => { if (S.token && S.data && $('#sheet').hidden && !S.dirty) render(); }); }
Object.assign(APP.views, {kasir: vKasir, riwayat: vRiwayat, stok: vStok, menu: vMenu, master: vMaster, users: vUsers, settings: vSettings, diag: vDiag});
Object.assign(APP, {S: S, api: api, $: $, rp: rp, num: num, esc: esc, LS: LS, T: T, sheet: sheet, closeSheet: closeSheet, toast: toast, busy: busy, busyLabel: busyLabel, skel: skel, ACT: ACT,
  render: render, loadData: loadData, checkUpdates: checkUpdates, dnum: dnum, qf: qf, r6: r6, flush: flush, Store: Store, isWide: isWide, skuLevel: skuLevel, wrapChips: wrapChips, isAddon: isAddon, emptyState: emptyState, idDate: idDate, idRange: idRange, addDays: addDays, lvText: lvText, vById: vById, pById: pById, vName: vName, vSub: vSub, chName: chName, fmtDT: fmtDT, today: today, own: own, start: start});
})();
