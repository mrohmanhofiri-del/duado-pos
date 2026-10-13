/* Duado Snack POS - frontend local-first (tanpa build). Data master disimpan di perangkat; transaksi masuk antrean lalu disinkronkan. */
(function () {
'use strict';
const C = window.CONFIG || {};
const $ = s => document.querySelector(s);
const rp = n => 'Rp\u00a0' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const num = n => { const x = Number(n) || 0; return Number.isInteger(x) ? x.toLocaleString('id-ID') : x.toLocaleString('id-ID', {minimumFractionDigits: 0, maximumFractionDigits: 4}); };
const parseDec = s => { if (s == null) return 0; if (typeof s === 'number') return isNaN(s) ? 0 : s; const n = parseFloat(String(s).trim().replace(',', '.')); return isNaN(n) ? 0 : n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Penyimpanan perangkat penuh'); } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const T = v => String(v).toUpperCase() === 'TRUE';
const APP = window.APP = {views: {}};
const S = {token: LS.get('token', null), data: LS.get('data', null), queue: LS.get('queue', []), tab: 'kasir', ch: LS.get('ch', null), cat: 'Semua', q: '',
  cart: LS.get('cart', []), diskon: '', metode: LS.get('metode', 'tunai'), terima: '', catatan: '', nomor: {}, mt: 'products', stab: 'varian', day: null, pb: {items: [], ongkir: '', sup: ''}, rc: null};
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
function closeSheet() { const b = $('#sheet'); b.hidden = true; b.innerHTML = ''; if (S.deferRender) { S.deferRender = false; render(); } }

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
async function loadData() { S.data = await api('bootstrap'); applyQueueStock(); S.lastSync = Date.now(); LS.set('data', S.data); if (S.cat !== 'Semua' && !S.data.products.some(p => p.kategori === S.cat)) S.cat = 'Semua'; }
/* Sinkronisasi hanya bila perlu: cek versi data (ping senyap, tanpa animasi); muat ulang penuh hanya jika versi berubah. Tanpa polling berkala. */
let lastChk = 0;
async function checkUpdates(force) {
  if (!S.token || !S.data || (!force && Date.now() - lastChk < 30000)) return;
  lastChk = Date.now();
  try {
    const p = await api('ping', {}, {silent: true});
    if (p.ver !== S.data.ver) { await loadData(); if ($('#sheet').hidden) render(); else S.deferRender = true; toast('Data terbaru dimuat'); }
  } catch (e) { if (e.auth) softLogout(); }
}
let flushing = false, flushDelay = 15000, flushTimer = null;
const hasPending = () => !!S.data && S.queue.some(x => x.status === 'pending' && x.uid === S.data.user.uid);
const pendingQty = id => S.queue.reduce((a, q) => a + (q.status === 'pending' ? q.payload.items.filter(i => i.variant_id === id).reduce((b, i) => b + i.qty, 0) : 0), 0);
function scheduleFlush() { // percobaan ulang hanya selama ada transaksi tertunda, dengan jeda yang makin panjang
  clearTimeout(flushTimer); if (!hasPending()) { flushDelay = 15000; return; }
  flushTimer = setTimeout(flush, flushDelay); flushDelay = Math.min(flushDelay * 2, 120000);
}
async function flush() {
  if (flushing || !S.token || !S.data || !hasPending() || !navigator.onLine) return;
  flushing = true;
  try {
    for (const q of S.queue.filter(x => x.status === 'pending' && x.uid === S.data.user.uid)) {
      try {
        const r = await api('sale.create', q.payload);
        if (r.sale) S.nomor[q.rid] = r.sale.nomor;
        S.queue = S.queue.filter(x => x !== q);
        Object.keys(r.stok || {}).forEach(id => { const v = vById(id); if (v) v.stok = r6(r.stok[id] - pendingQty(id)); });
        refreshRc(); flushDelay = 15000;
      } catch (e) {
        if (e.auth) { softLogout(); break; }
        if (e.server) { q.status = 'review'; q.error = e.message; } else break; // gagal jaringan: coba lagi nanti
      }
      LS.set('queue', S.queue);
    }
  } finally { flushing = false; LS.set('queue', S.queue); LS.set('data', S.data); badge(); if (S.tab === 'riwayat' && $('#sheet').hidden) vRiwayat(); scheduleFlush(); }
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
const buzz = () => { try { navigator.vibrate && navigator.vibrate(12); } catch (e) {} };
function logErr(e, ctx) { try { const l = LS.get('errlog', []); l.unshift({t: Date.now(), c: ctx || '', m: String((e && e.message) || e), s: String((e && e.stack) || '').split('\n').slice(0, 3).join(' | ')}); LS.set('errlog', l.slice(0, 20)); } catch (x) {} }
window.addEventListener('error', ev => logErr(ev.error || ev.message, 'error'));
window.addEventListener('unhandledrejection', ev => logErr(ev.reason, 'promise'));
/* struk: satu sumber teks untuk layar, WhatsApp, dan printer; lebar mengikuti pengaturan (32 = 58 mm, 48 = 80 mm) */
const rcWidth = () => Number(cfg('lebar_struk')) === 48 ? 48 : 32;
const wrapTxt = (t, w) => { const o = []; t = String(t); while (t.length > w) { o.push(t.slice(0, w)); t = t.slice(w); } o.push(t); return o; };
function receiptLines(rc, w) {
  w = w || rcWidth(); const line = '-'.repeat(w), L = (a, b) => { a = String(a); b = String(b); return a + ' '.repeat(Math.max(1, w - a.length - b.length)) + b; };
  const o = [(cfg('nama_usaha') || 'Duado Snack').toUpperCase(), line, 'No : ' + (S.nomor[rc.rid] || '(menunggu sinkron)'), 'Tgl: ' + fmtDT(rc.time), 'Via: ' + rc.ch, line];
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
let btDevice = null, btChar = null;
async function printWebBT(rc) {
  if (!navigator.bluetooth) return false;
  try {
    if (!btDevice || !btDevice.gatt.connected || !btChar) {
      toast('Mencari printer Bluetooth…');
      btDevice = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [
          '000018f0-0000-1000-8000-00805f9b34fb',
          'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
          '49535343-fe7d-4ae5-8fa9-9fafd205e455',
          '0000ff00-0000-1000-8000-00805f9b34fb',
          '0000af30-0000-1000-8000-00805f9b34fb'
        ]
      });
      const server = await btDevice.gatt.connect();
      const services = await server.getPrimaryServices();
      for (const s of services) {
        try {
          const chars = await s.getCharacteristics();
          for (const c of chars) {
            if (c.properties.write || c.properties.writeWithoutResponse) { btChar = c; break; }
          }
        } catch (x) {}
        if (btChar) break;
      }
    }
    if (!btChar) throw new Error('Karakteristik cetak tidak ditemukan');
    const bytes = escpos(rc), chunk = 512;
    for (let i = 0; i < bytes.length; i += chunk) {
      const part = bytes.slice(i, i + chunk);
      if (btChar.properties.writeWithoutResponse) await btChar.writeValueWithoutResponse(part);
      else await btChar.writeValue(part);
    }
    toast('Struk berhasil dicetak via Bluetooth');
    return true;
  } catch (e) {
    if (e.name === 'NotFoundError') return true;
    console.warn('Web Bluetooth:', e);
    return false;
  }
}
async function printBT(rc) {
  if (!rc) return toast('Tidak ada struk untuk dicetak');
  if (navigator.bluetooth) {
    const ok = await printWebBT(rc);
    if (ok) return;
  }
  if (isAndroid()) {
    go('intent:base64,' + b64(escpos(rc)) + '#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;');
    return;
  }
  toast('Di iPhone: gunakan browser Bluefy untuk Bluetooth langsung, atau Cetak Browser.');
  printBrowser();
}
function printBrowser() { const d = document.querySelector('#rtxt'); if (d && d.closest('details')) d.closest('details').open = true; setTimeout(() => window.print(), 60); }
function waSend(rc, number) {
  let n = String(number || '').replace(/\D/g, ''); if (n.indexOf('0') === 0) n = '62' + n.slice(1); else if (n.indexOf('8') === 0) n = '62' + n;
  go((n ? 'https://wa.me/' + n : 'https://api.whatsapp.com/send') + '?text=' + encodeURIComponent('```' + receiptText(rc) + '```'), true);
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Struk disalin. Tempel di WhatsApp atau aplikasi lain.'); }
  catch (e) { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (x) {} ta.remove(); toast(ok ? 'Struk disalin.' : 'Tidak bisa menyalin struk.'); }
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
const MENU_TABS = ['menu', 'master', 'users', 'settings', 'resep', 'laporan', 'shopee', 'cek', 'diag'];
function render() {
  if (!S.token || !S.data) return renderLogin();
  const d = S.data; if (!S.ch || !d.channels.some(c => c.id === S.ch)) S.ch = d.channels[0] && d.channels[0].id;
  const o = own(), tabs = o ? [['dash', 'Beranda'], ['kasir', 'Kasir'], ['stok', 'Stok'], ['produksi', 'Produksi'], ['menu', 'Menu']] : [['kasir', 'Kasir'], ['riwayat', 'Riwayat'], ['stok', 'Stok'], ['menu', 'Menu']],
    inMenu = MENU_TABS.concat(o ? ['riwayat'] : []).indexOf(S.tab) >= 0;
  $('#app').innerHTML = '<header class="top"><img class="logo" src="icons/icon-192.png" alt="" width="38" height="38"><div class="brand"><b class="wordmark">' + esc((d.settings.nama_usaha || 'Duado Snack').toUpperCase()) + '</b><small>Jajanan Cemilan Pedas</small></div><span class="badge" id="badge"></span></header><div class="accent"></div><main id="main"></main><div id="cartbar"></div>' +
    '<nav class="nav">' + tabs.map(t => '<button data-act="tab" data-t="' + t[0] + '" class="' + ((S.tab === t[0] || (t[0] === 'menu' && inMenu)) ? 'on' : '') + '"><span class="ni">' + svg(t[0], 22) + '</span><span>' + t[1] + '</span></button>').join('') + '</nav>';
  badge();
  (APP.views[S.tab] || vKasir)();
  cartbar();
}
function badge() {
  const b = $('#badge'); if (!b) return;
  const p = S.queue.filter(q => q.status === 'pending').length, r = S.queue.filter(q => q.status === 'review').length;
  b.className = 'badge ' + (r ? 'warn' : p ? 'wait' : navigator.onLine ? 'ok' : 'off') + (pending > 0 ? ' spin' : '');
  b.textContent = pending > 0 ? 'Menyinkronkan' : r ? r + ' perlu ditinjau' : p ? p + ' menunggu sinkron' : (navigator.onLine ? 'Tersinkron' : 'Offline');
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
function vKasir() {
  const d = S.data; S.cart = S.cart.filter(l => vById(l.v));
  const withV = new Set(d.variants.map(v => v.product_id)), cats = ['Semua'].concat(Array.from(new Set(d.products.filter(p => withV.has(p.id)).map(p => p.kategori).filter(Boolean)))), noV = d.products.filter(p => !withV.has(p.id)).length;
  if (S.cat !== 'Semua' && cats.indexOf(S.cat) < 0) S.cat = 'Semua';
  $('#main').innerHTML = '<div class="kasir-top">' + (own() && noV ? '<div class="notice"><span>' + noV + ' produk belum punya varian, jadi belum tampil di sini.</span><button class="chip" data-act="go_cek">Periksa data</button></div>' : '') +
    '<div class="seg">' + d.channels.map(c => '<button class="' + (c.id === S.ch ? 'on' : '') + '" data-act="chan" data-c="' + esc(c.id) + '">' + esc(chShort(c.nama)) + '</button>').join('') + '</div>' +
    '<label class="search">' + svg('search', 18) + '<input id="q" class="inp" data-in="q" placeholder="Cari produk atau SKU" value="' + esc(S.q) + '" aria-label="Cari produk"></label>' +
    '<div class="chips">' + cats.map(c => '<button class="chip ' + (c === S.cat ? 'on' : '') + '" data-act="cat" data-c="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div></div><div class="grid" id="grid"></div>';
  grid();
}
function cardHtml(v) {
  const pr = priceOf(v.id, S.ch), st = Number(v.stok) || 0, q = cartQty(v.id);
  const stk = st <= 0 ? '<span class="stk zero">Habis</span>' : st <= 5 ? '<span class="stk low">Sisa ' + num(st) + '</span>' : '<span class="stk">Stok ' + num(st) + '</span>';
  return '<i class="hb"></i><b class="pn">' + esc(vName(v)) + '</b><div class="pm">' + (v.ukuran ? '<span class="sz">' + esc(v.ukuran) + '</span>' : '') + heat(v.level_pedas) + '</div>' +
    '<div class="pf"><div class="pp"><span class="pr">' + (pr == null ? 'Harga belum diatur' : rp(pr)) + '</span>' + stk + '</div>' +
    (q ? '<div class="step"><button data-act="dec1" data-v="' + esc(v.id) + '" aria-label="Kurangi">−</button><b>' + q + '</b><button data-act="inc1" data-v="' + esc(v.id) + '" aria-label="Tambah">+</button></div>' : '<span class="plus" aria-hidden="true">+</span>') + '</div>';
}
function grid() {
  const d = S.data, q = S.q.toLowerCase(), block = T(d.settings.blokir_stok_minus);
  const list = d.variants.filter(v => (S.cat === 'Semua' || (pById(v.product_id) || {}).kategori === S.cat) && (!q || (vName(v) + ' ' + vSub(v) + ' ' + v.sku).toLowerCase().indexOf(q) >= 0));
  $('#grid').innerHTML = list.map(v => {
    const pr = priceOf(v.id, S.ch), st = Number(v.stok) || 0, off = pr == null || (block && st <= 0), n = heatN(v.level_pedas);
    return '<div class="card pc h' + (n < 0 ? 'x' : n) + (off ? ' off' : '') + (cartQty(v.id) ? ' in' : '') + '" data-act="add" data-v="' + esc(v.id) + '" role="button" tabindex="0">' + cardHtml(v) + '</div>';
  }).join('') || '<p class="muted empty">' + (own() ? 'Tidak ada produk untuk ditampilkan. Produk harus punya varian dan harga: lihat Menu, Pemeriksaan data.' : 'Belum ada produk di kategori ini.') + '</p>';
}
function updCard(id) { // perbarui satu kartu saja, tanpa menggambar ulang seluruh daftar
  const el = document.querySelector('#grid .card[data-v="' + id + '"]'), v = vById(id); if (!el || !v) return;
  el.innerHTML = cardHtml(v); el.classList.toggle('in', cartQty(id) > 0); el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
}
function cartbar() {
  const el = $('#cartbar'); if (!el) return;
  if (S.tab !== 'kasir' || !S.cart.length) { el.innerHTML = ''; return; }
  const c = calc(), n = S.cart.reduce((a, l) => a + l.qty, 0);
  el.innerHTML = '<button class="cartbar" data-act="cart"><span class="cb-i">' + svg('kasir', 20) + '<em>' + n + '</em></span><span class="cb-t"><small>' + n + ' item</small><b>' + rp(c.total) + '</b></span><span class="cb-go">Bayar ' + svg('chev', 18) + '</span></button>';
}
function addToCart(id) {
  const v = vById(id); if (!v) return;
  if (priceOf(id, S.ch) == null) return toast('Harga belum diatur untuk channel ini');
  const l = S.cart.find(x => x.v === id), q = (l ? l.qty : 0) + 1, st = Number(v.stok) || 0;
  if (T(cfg('blokir_stok_minus')) && q > st) return toast(st > 0 ? 'Stok tidak cukup' : 'Stok habis');
  if (l) l.qty = q; else S.cart.push({v: id, qty: 1});
  saveCart(); updCard(id); cartbar(); buzz();
}
function dropFromCart(id) {
  const i = S.cart.findIndex(x => x.v === id); if (i < 0) return;
  S.cart[i].qty--; if (S.cart[i].qty <= 0) S.cart.splice(i, 1); saveCart(); updCard(id); cartbar();
}
const methodChips = () => ['tunai', 'transfer', 'qris'].map(m => '<button class="chip ' + (S.metode === m ? 'on' : '') + '" data-act="metode" data-m="' + m + '">' + m.toUpperCase() + '</button>').join('');
function cartLines() {
  const el = $('#cl'); if (!el) return;
  el.innerHTML = S.cart.map((l, i) => { const v = vById(l.v), p = priceOf(l.v, S.ch) || 0;
    return '<div class="li cl-i"><div class="cl-n"><b>' + esc(vName(v)) + '</b><div class="muted">' + esc(vSub(v)) + ' · ' + rp(p) + '</div></div><div class="qty"><button data-act="dec" data-i="' + i + '" aria-label="Kurangi">−</button><span>' + l.qty + '</span><button data-act="inc" data-i="' + i + '" aria-label="Tambah">+</button></div><b class="cl-t">' + rp(p * l.qty) + '</b></div>'; }).join('');
}
function cashBox() {
  const el = $('#cashbox'); if (!el) return;
  if (S.metode !== 'tunai') { el.innerHTML = '<p class="muted">Pembayaran ' + esc(S.metode.toUpperCase()) + ' dicatat lunas saat disimpan.</p>'; return; }
  const t = calc().total, q = [t].concat([5000, 10000, 20000, 50000, 100000].map(n => Math.ceil(t / n) * n)).filter((x, i, a) => x > 0 && a.indexOf(x) === i).slice(0, 4);
  el.innerHTML = '<label>Uang diterima (Rp)<input class="inp" data-in="terima" inputmode="numeric" placeholder="' + num(t) + '" value="' + esc(S.terima) + '"></label><div class="chips">' + q.map((x, i) => '<button class="chip" data-act="qk" data-n="' + x + '">' + (i === 0 ? 'Uang pas' : num(x)) + '</button>').join('') + '</div>';
}
function cartSheet() {
  if (!S.cart.length) return;
  sheet('<div class="grab"></div><div class="sh-h"><h2>Pembayaran</h2><span class="muted">' + esc(chName(S.ch)) + '</span></div><div id="cl"></div><div class="paybox"><div class="chips" id="mchips">' + methodChips() + '</div><div id="cashbox"></div></div>' +
    '<details class="more"' + (S.diskon || S.catatan ? ' open' : '') + '><summary>Diskon dan catatan</summary><label>Diskon (Rp)<input class="inp" data-in="diskon" inputmode="numeric" value="' + esc(S.diskon) + '"></label><label>Catatan<input class="inp" data-in="catatan" value="' + esc(S.catatan) + '"></label></details>' +
    '<div id="tot"></div><button class="btn pri big" id="paybtn" data-act="pay">Bayar</button>');
  cartLines(); cashBox(); upd();
}
function upd() {
  const c = calc(), s = S.data.settings, kv = (a, b, cl) => '<div class="kv ' + (cl || '') + '"><span>' + a + '</span><span>' + b + '</span></div>', tunai = S.metode === 'tunai', terima = S.terima === '' ? null : Number(S.terima) || 0;
  let h = kv('Subtotal', rp(c.sub)); if (c.dis) h += kv('Diskon', '-' + rp(c.dis)); if (c.ppn) h += kv(T(s.ppn_inklusif) ? 'PPN (sudah termasuk)' : 'PPN', rp(c.ppn));
  h += kv('Total', rp(c.total), 'big'); if (tunai && terima !== null) h += kv(terima >= c.total ? 'Kembalian' : 'Kurang', rp(Math.abs(terima - c.total)), terima >= c.total ? 'ok-r' : 'err-r');
  const t = $('#tot'); if (t) t.innerHTML = h;
  const b = $('#paybtn'); if (b) { const short = tunai && terima !== null && terima < c.total; b.disabled = short; b.textContent = short ? 'Uang kurang ' + rp(c.total - terima) : 'Bayar ' + rp(c.total); }
  cartbar();
}
function pay() {
  if (S.paying || !S.cart.length) return;
  if (S.cart.some(l => !vById(l.v))) { S.cart = S.cart.filter(l => vById(l.v)); saveCart(); toast('Ada produk yang sudah tidak tersedia; keranjang diperbarui'); if (S.cart.length) cartSheet(); else closeSheet(); cartbar(); return; }
  const c = calc(), tunai = S.metode === 'tunai', terima = tunai ? (S.terima === '' ? c.total : Number(S.terima) || 0) : c.total;
  if (tunai && terima < c.total) return toast('Uang diterima kurang');
  S.paying = true; let rc;
  try {
    const rid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2);
    const payload = {request_id: rid, channel_id: S.ch, items: S.cart.map(l => ({variant_id: l.v, qty: l.qty})), diskon: c.dis, metode_bayar: S.metode, catatan: S.catatan};
    rc = {rid: rid, time: Date.now(), ch: chName(S.ch), metode: S.metode, terima: terima, kembali: terima - c.total, sub: c.sub, dis: c.dis, ppn: c.ppn, total: c.total,
      lines: S.cart.map(l => { const v = vById(l.v); return {n: vName(v) + ' ' + vSub(v), q: l.qty, h: priceOf(l.v, S.ch)}; })};
    S.queue.push({rid: rid, payload: payload, status: 'pending', ts: Date.now(), uid: S.data.user.uid, total: c.total, ch: rc.ch}); LS.set('queue', S.queue);
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
  const day = S.day || today();
  $('#main').innerHTML = '<label>Tanggal<input type="date" class="inp" data-chg="day" value="' + day + '"></label><div id="rq"></div><div id="rsum"></div><div id="rlist">' + skel(3) + '</div>';
  const qs = S.queue.map((q, i) => q.uid !== S.data.user.uid ? '' : '<div class="li"><div><b>' + rp(q.total) + '</b> <span class="muted">' + esc(q.ch) + ' · ' + fmtDT(q.ts).slice(11) + '</span>' +
    (q.status === 'review' ? '<div class="muted" style="color:var(--err)">' + esc(q.error) + '</div>' : '') + '</div><div class="r"><span class="tag ' + (q.status === 'review' ? 'red' : '') + '">' + (q.status === 'review' ? 'Perlu ditinjau' : 'Menunggu sinkron') + '</span>' +
    (q.status === 'review' ? '<div><button class="chip" data-act="qretry" data-i="' + i + '">Coba lagi</button> <button class="chip" data-act="qdel" data-i="' + i + '">Hapus</button></div>' : '') + '</div></div>').join('');
  $('#rq').innerHTML = qs;
  try {
    const rows = await api('sales.list', {tanggal: day}); if (S.tab !== 'riwayat') return;
    const done = rows.filter(r => r.status === 'selesai');
    $('#rsum').innerHTML = '<div class="li"><div><div class="muted">Omzet ' + day + '</div><b style="font-size:20px">' + rp(done.reduce((a, r) => a + Number(r.total), 0)) + '</b></div><div class="r"><div class="muted">Transaksi</div><b style="font-size:20px">' + done.length + '</b></div></div>';
    $('#rlist').innerHTML = rows.map(r => '<div class="li"><div><b>' + esc(r.nomor) + '</b><div class="muted">' + esc(String(r.tanggal).slice(11, 16)) + ' · ' + esc(chName(r.channel_id)) + ' · ' + esc(r.metode_bayar) + '</div></div><b>' + rp(r.total) + '</b></div>').join('') || '<p class="muted">Belum ada transaksi.</p>';
  } catch (e) { $('#rlist').innerHTML = '<p class="muted">Tidak bisa memuat riwayat dari server (' + esc(e.message) + ').</p>'; }
}

/* ---------- Stok dan pembelian ---------- */
function vStok() {
  const o = own(); let h = '';
  if (o) h += '<div class="chips"><button class="chip ' + (S.stab === 'varian' ? 'on' : '') + '" data-act="stab" data-s="varian">Produk jadi</button><button class="chip ' + (S.stab === 'bahan' ? 'on' : '') + '" data-act="stab" data-s="bahan">Bahan dan kemasan</button></div>';
  if (S.stab === 'bahan' && o) {
    h += '<button class="btn pri" data-act="pbopen">+ Pembelian bahan</button><div style="height:8px"></div>';
    h += S.data.materials.map(m => { const low = Number(m.stok_minimum) > 0 && Number(m.stok) <= Number(m.stok_minimum);
      return '<button class="li" style="width:100%;border:0;font:inherit;text-align:left" data-act="adj" data-t="bahan" data-id="' + esc(m.id) + '"><div><b>' + esc(m.nama) + '</b><div class="muted">HPP rata-rata ' + rp(m.hpp_rata2) + '/' + esc(m.satuan) + '</div></div><div class="r"><b>' + num(m.stok) + ' ' + esc(m.satuan) + '</b>' + (low ? '<div><span class="tag">Menipis</span></div>' : '') + '</div></button>'; }).join('') || '<p class="muted">Belum ada bahan. Tambahkan di Menu, lalu Data Master.</p>';
  } else {
    h += S.data.variants.map(v => '<' + (o ? 'button data-act="adj" data-t="varian" data-id="' + esc(v.id) + '" style="width:100%;border:0;font:inherit;text-align:left"' : 'div') + ' class="li"><div><b>' + esc(vName(v)) + '</b><div class="muted">' + esc(vSub(v)) + (o ? ' · HPP ' + rp(v.hpp_rata2) : '') + '</div></div><b class="stk ' + (Number(v.stok) <= 0 ? 'zero' : '') + '" style="font-size:15px">' + num(v.stok) + '</b></' + (o ? 'button' : 'div') + '>').join('') || '<p class="muted">Belum ada produk.</p>';
  }
  $('#main').innerHTML = h;
}
function adjSheet(t, id) {
  const it = t === 'bahan' ? S.data.materials.find(m => m.id === id) : vById(id); if (!it) return;
  sheet('<h2>Penyesuaian stok</h2><p class="muted">' + esc(t === 'bahan' ? it.nama : vName(it) + ' ' + vSub(it)) + ' · stok sekarang ' + num(it.stok) + '</p><label>Stok baru<input class="inp" id="a_s" inputmode="decimal" value="' + esc(it.stok) + '"></label>' +
    '<label>HPP rata-rata (kosongkan jika tidak diubah; isi untuk stok awal)<input class="inp" id="a_h" inputmode="decimal" placeholder="' + esc(it.hpp_rata2) + '"></label><label>Alasan<input class="inp" id="a_r" value="Stok opname"></label>' +
    '<button class="btn pri" data-act="adjsave" data-t="' + t + '" data-id="' + esc(id) + '">Simpan</button>');
}
async function adjSave(t, id) {
  return busy('Menyimpan stok…', async () => {
  try {
    const r = await api('stock.adjust', {tipe: t, id: id, stok_baru: parseDec($('#a_s').value), hpp: $('#a_h').value ? parseDec($('#a_h').value) : '', alasan: $('#a_r').value});
    const it = t === 'bahan' ? S.data.materials.find(m => m.id === id) : vById(id); it.stok = r.stok; it.hpp_rata2 = r.hpp_rata2; LS.set('data', S.data); closeSheet(); render(); toast('Stok disimpan');
  } catch (e) { toast(e.message); }
  });
}
function pbSheet() {
  const m = S.data.materials, pb = S.pb, tot = pb.items.reduce((a, i) => a + i.qty * i.harga, 0);
  sheet('<h2>Pembelian bahan</h2><label>Supplier<select class="inp" data-in="pbsup"><option value="">- tanpa supplier -</option>' + S.data.suppliers.map(s => '<option value="' + esc(s.id) + '"' + (s.id === pb.sup ? ' selected' : '') + '>' + esc(s.nama) + '</option>').join('') + '</select></label>' +
    pb.items.map((i, n) => { const x = m.find(y => y.id === i.id); return '<div class="li"><div><b>' + esc(x ? x.nama : '?') + '</b><div class="muted">' + num(i.qty) + ' ' + esc(x ? x.satuan : '') + ' @ ' + rp(i.harga) + '</div></div><button class="chip" data-act="pbdel" data-i="' + n + '">Hapus</button></div>'; }).join('') +
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
function vMenu() {
  const u = S.data.user, o = own(), mi = (a, ic, t, sub, cl) => '<button class="mi ' + (cl || '') + '" data-act="' + a + '"><span class="mi-i">' + svg(ic, 20) + '</span><span class="mi-t"><b>' + t + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</span>' + svg('chev', 18) + '</button>';
  $('#main').innerHTML = '<div class="profile"><div class="av">' + esc(String(u.nama || '?').charAt(0).toUpperCase()) + '</div><div class="pi"><b>' + esc(u.nama) + '</b><div class="muted">' + esc(u.role) + ' · versi ' + esc(C.VERSION || '') + '</div></div><span class="badge ' + (navigator.onLine ? 'ok' : 'off') + '">' + (navigator.onLine ? 'Online' : 'Offline') + '</span></div>' +
    '<p class="muted note">Data terakhir diperbarui: ' + (S.lastSync ? fmtDT(S.lastSync).slice(11) : 'dari cache perangkat') + '. Aplikasi hanya memuat ulang jika ada data baru.</p>' +
    (o ? '<div class="grp"><h3>Operasional</h3>' + mi('go_riwayat', 'riwayat', 'Riwayat penjualan', 'Transaksi per tanggal') + mi('go_laporan', 'laporan', 'Laporan', 'Laba rugi, penjualan, HPP, stok') + mi('go_cek', 'cek', 'Pemeriksaan data', 'Kelengkapan data dan kesesuaian stok') + '</div>' +
      '<div class="grp"><h3>Data</h3>' + mi('go_master', 'master', 'Data Master', 'Produk, varian, harga, bahan, resep, biaya') + mi('go_shopee', 'shopee', 'Impor pesanan Shopee', 'Dari file CSV') + mi('go_users', 'users', 'Pengguna', 'Owner dan kasir') + mi('go_settings', 'settings', 'Pengaturan', 'PPN, struk, HPP, stok') + '</div>' : '') +
    '<div class="grp"><h3>Sistem</h3>' + mi('sync', 'sync', 'Perbarui data', 'Muat ulang dan kirim antrean') + mi('go_diag', 'diag', 'Diagnostik dan uji cetak', 'Cek koneksi, WhatsApp, dan printer') + mi('logout', 'out', 'Keluar', '', 'danger') + '</div>' +
    '<p class="muted note">Pasang di layar utama: menu Chrome, lalu "Tambahkan ke layar utama".</p>';
}
function vDiag() {
  const q = S.queue, errs = LS.get('errlog', []), kv = (a, b) => '<div class="kv"><span>' + a + '</span><span>' + b + '</span></div>', standalone = window.matchMedia && matchMedia('(display-mode: standalone)').matches;
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div class="card-s"><h3>Info perangkat</h3>' + kv('Versi aplikasi', esc(C.VERSION || '-')) + kv('Mode', standalone ? 'Terpasang (layar utama)' : 'Browser') + kv('Koneksi', navigator.onLine ? 'Online' : 'Offline') +
    kv('Android (untuk RawBT)', isAndroid() ? 'Ya' : 'Tidak') + kv('Fitur Bagikan', navigator.share ? 'Tersedia' : 'Tidak tersedia') + kv('Antrean transaksi', q.filter(x => x.status === 'pending').length + ' menunggu, ' + q.filter(x => x.status === 'review').length + ' perlu ditinjau') + kv('Lebar struk', rcWidth() + ' karakter') + '</div>' +
    '<div class="card-s"><h3>Uji koneksi server</h3><button class="btn sec" data-act="dping">Uji koneksi</button><div id="dres" class="muted" style="margin-top:6px"></div></div>' +
    '<div class="card-s"><h3>Uji struk</h3><p class="muted">Memeriksa WhatsApp dan printer tanpa membuat transaksi.</p><div class="row2"><button class="btn wa" data-act="dtwa">Uji WhatsApp</button><button class="btn dark" data-act="dtbt">Uji cetak Bluetooth</button></div><button class="btn sec" data-act="dtshare">Uji Bagikan</button>' +
    '<p class="muted">Cetak Bluetooth memakai aplikasi <b>RawBT</b> (Android): pasang dari Play Store, pasangkan printer di dalam RawBT, lalu coba cetak dari RawBT dulu.</p></div>' +
    '<div class="card-s"><h3>Catatan kesalahan</h3>' + (errs.length ? errs.slice(0, 8).map(e => '<div class="muted" style="margin-bottom:6px">' + esc(fmtDT(e.t).slice(5)) + ' · ' + esc(e.c) + ': ' + esc(e.m) + '</div>').join('') : '<p class="muted">Belum ada.</p>') + '<button class="btn sec" data-act="dcopy">Salin log</button></div>';
}
const RT = {};
const MT = {
  products: {l: 'Produk', k: 'products', f: [['nama', 'Nama produk'], ['kategori', 'Kategori (mis. Basreng)']], t: r => r.nama + (r.kategori ? ' · ' + r.kategori : '')},
  product_variants: {l: 'Varian', k: 'variants', f: [['product_id', 'Produk', 'ref:products'], ['sku', 'SKU'], ['ukuran', 'Ukuran kemasan (mis. 100 g)'], ['level_pedas', 'Level pedas (mis. Level 3)']], t: r => vName(r) + ' · ' + vSub(r)},
  channel_prices: {l: 'Harga jual', k: 'prices', f: [['variant_id', 'Varian', 'ref:variants'], ['channel_id', 'Channel', 'ref:channels'], ['harga_jual', 'Harga jual (Rp)', 'number']], t: r => { const v = vById(r.variant_id); return (v ? vName(v) + ' ' + vSub(v) : '?') + ' · ' + chName(r.channel_id) + ' · ' + rp(r.harga_jual); }},
  materials: {l: 'Bahan dan kemasan', k: 'materials', f: [['nama', 'Nama'], ['tipe', 'Tipe', 'sel:bahan,kemasan,barang jadi beli'], ['satuan', 'Satuan (kg, gram, pcs)'], ['stok_minimum', 'Stok minimum', 'number']], t: r => r.nama + ' (' + r.satuan + ')'},
  suppliers: {l: 'Supplier', k: 'suppliers', f: [['nama', 'Nama'], ['kontak', 'Kontak'], ['catatan', 'Catatan']], t: r => r.nama},
  expenses: {l: 'Biaya operasional', k: 'expenses', f: [['tanggal', 'Tanggal', 'date'], ['kategori', 'Kategori', 'sel:Gas,Listrik,Air,Sewa,Gaji/Tenaga kerja,Transport,Pemasaran,Lain-lain'], ['nominal', 'Nominal (Rp)', 'number'], ['catatan', 'Catatan']], t: r => String(r.tanggal).slice(0, 10) + ' · ' + r.kategori + ' · ' + rp(r.nominal)},
  channels: {l: 'Channel', k: 'channels', f: [['nama', 'Nama'], ['fee_persen', 'Fee (%)', 'number'], ['fee_tetap', 'Fee tetap (Rp)', 'number']], t: r => r.nama + ' · fee ' + (r.fee_persen || 0) + '%'}
};
Object.keys(MT).forEach(k => RT[MT[k].k] = MT[k].t);
function field(f, val) {
  const k = f[0], l = f[1], t = f[2] || '', v = val == null ? '' : val;
  if (k === 'sku') {
    return '<div class="f-sku"><label>' + l + '<input class="inp" data-f="sku" value="' + esc(v) + '"></label>' +
      '<button type="button" class="btn sec btn-sku" data-act="gensku" title="Susun SKU dari nama produk, ukuran, dan level pedas">✨ Auto SKU</button></div>';
  }
  if (t.indexOf('ref:') === 0) { const key = t.slice(4); return '<label>' + l + '<select class="inp" data-f="' + k + '"><option value="">- pilih -</option>' + S.data[key].map(r => '<option value="' + esc(r.id) + '"' + (r.id === v ? ' selected' : '') + '>' + esc(RT[key](r)) + '</option>').join('') + '</select></label>'; }
  if (t.indexOf('sel:') === 0) return '<label>' + l + '<select class="inp" data-f="' + k + '">' + t.slice(4).split(',').map(o => '<option' + (o === v ? ' selected' : '') + '>' + o + '</option>').join('') + '</select></label>';
  if (t === 'date') return '<label>' + l + '<input type="date" class="inp" data-f="' + k + '" value="' + esc(String(v).slice(0, 10)) + '"></label>';
  const uq = a => Array.from(new Set(a.filter(Boolean))), D = S.data || {products: [], variants: []};
  const sug = k === 'kategori' ? uq((D.products || []).map(p => p.kategori)) : k === 'ukuran' ? uq((D.variants || []).map(x => x.ukuran).concat(['50 g', '100 g', '250 g', '500 g'])) :
    k === 'level_pedas' ? uq((D.variants || []).map(x => x.level_pedas).concat(['Original', 'Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5'])) : null;
  return '<label>' + l + '<input class="inp" data-f="' + k + '"' + (sug ? ' list="dl_' + k + '"' : '') + (t === 'number' ? ' inputmode="decimal"' : '') + ' value="' + esc(v) + '">' +
    (sug ? '<datalist id="dl_' + k + '">' + sug.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist>' : '') + '</label>';
}
function autoGenSku() {
  const pidEl = document.querySelector('#sheet [data-f="product_id"]');
  const ukEl = document.querySelector('#sheet [data-f="ukuran"]');
  const lvEl = document.querySelector('#sheet [data-f="level_pedas"]');
  const skuEl = document.querySelector('#sheet [data-f="sku"]');
  if (!skuEl) return;
  const p = pidEl ? pById(pidEl.value) : null;
  const pName = p ? p.nama : '';
  const uk = ukEl ? ukEl.value.trim() : '';
  const lv = lvEl ? lvEl.value.trim() : '';

  let pCode = '';
  if (pName) {
    const words = pName.replace(/[^a-zA-Z0-9\s]/g, '').trim().split(/\s+/);
    pCode = words.length > 1 ? words.map(w => w[0]).join('').toUpperCase().slice(0, 4) : pName.slice(0, 3).toUpperCase();
  } else {
    pCode = 'PRD';
  }
  let ukCode = uk.toUpperCase().replace(/\s+/g, '').replace(/GRAM|GR/, 'G').replace(/KILOGRAM/, 'KG');
  if (!ukCode) ukCode = 'STD';
  let lvCode = '';
  const hn = heatN(lv);
  if (hn >= 0) lvCode = 'LV' + hn;
  else if (/ori/i.test(lv)) lvCode = 'ORIG';
  else if (lv) lvCode = lv.toUpperCase().replace(/\s+/g, '').slice(0, 4);
  else lvCode = 'LV0';

  const sku = (pCode + '-' + ukCode + '-' + lvCode).toUpperCase();
  skuEl.value = sku;
  toast('SKU dibuat: ' + sku);
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
  sheet('<h2>' + (id ? 'Ubah ' : 'Tambah ') + cfg.l.toLowerCase() + '</h2>' + cfg.f.map(f => field(f, r[f[0]])).join('') + '<button class="btn pri" data-act="msave" data-id="' + esc(id) + '">Simpan</button>' + (id ? '<button class="btn dan" data-act="mdel" data-id="' + esc(id) + '">Hapus</button>' : ''));
}
async function mSave(id) {
  return busy('Menyimpan data…', async () => {
  const data = readForm(); if (id) data.id = id;
  ['harga_jual', 'fee_persen', 'fee_tetap', 'stok_minimum', 'nominal'].forEach(k => { if (k in data) data[k] = parseDec(data[k]); });
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
  try { S.users = await api('user.list'); $('#ul').innerHTML = S.users.map(u => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left;margin-top:8px" data-act="uedit" data-id="' + esc(u.id) + '"><span><b>' + esc(u.nama) + '</b> <span class="muted">@' + esc(u.username) + ' · ' + esc(u.role) + '</span></span>' + (String(u.aktif) === 'false' ? '<span class="tag red">Nonaktif</span>' : '') + '</button>').join(''); }
  catch (e) { $('#ul').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }
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
function vSettings() {
  const s = S.data.settings, cb = (k, l) => '<label style="margin:8px 0"><input type="checkbox" data-f="' + k + '"' + (T(s[k]) ? ' checked' : '') + '> ' + l + '</label>';
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div id="sf" style="margin-top:8px">' + field(['nama_usaha', 'Nama usaha'], s.nama_usaha) + field(['footer_struk', 'Teks bawah struk'], s.footer_struk) +
    cb('ppn_aktif', 'PPN aktif') + field(['ppn_persen', 'Tarif PPN (%)', 'number'], s.ppn_persen) + cb('ppn_inklusif', 'Harga jual sudah termasuk PPN') + cb('blokir_stok_minus', 'Blokir penjualan jika stok kurang') + field(['lebar_struk', 'Lebar struk (32 = kertas 58 mm, 48 = kertas 80 mm)', 'sel:32,48'], s.lebar_struk || '32') + cb('auto_cetak', 'Langsung cetak Bluetooth (RawBT) setelah bayar') +
    field(['overhead_per_unit', 'Overhead per bungkus (Rp, metode per_unit)', 'number'], s.overhead_per_unit) + field(['metode_overhead', 'Metode overhead produksi', 'sel:per_unit,per_batch'], s.metode_overhead || 'per_unit') + field(['overhead_per_batch', 'Overhead per batch (Rp, metode per_batch)', 'number'], s.overhead_per_batch) + field(['target_margin', 'Target margin minimum (%)', 'number'], s.target_margin || 30) + '</div><button class="btn pri" data-act="ssave">Simpan pengaturan</button>';
}
async function sSave() {
  return busy('Menyimpan pengaturan…', async () => {
  const v = {}; document.querySelectorAll('#sf [data-f]').forEach(e => v[e.dataset.f] = e.type === 'checkbox' ? e.checked : e.value);
  try { await api('setting.setMany', {values: v}); await loadData(); render(); toast('Pengaturan tersimpan'); } catch (e) { toast(e.message); }
  });
}

/* ---------- Aksi (event delegation) ---------- */
const ACT = {
  login: doLogin, logout: logout, close: closeSheet, cart: cartSheet, pay: pay,
  tab: el => { S.tab = el.dataset.t; render(); },
  chan: el => { S.ch = el.dataset.c; LS.set('ch', S.ch); vKasir(); cartbar(); },
  cat: el => { S.cat = el.dataset.c; vKasir(); },
  add: el => { if (el.classList.contains('off')) { const v = vById(el.dataset.v); return toast(priceOf(el.dataset.v, S.ch) == null ? 'Harga belum diatur untuk channel ini' : 'Stok habis'); } addToCart(el.dataset.v); },
  inc1: el => addToCart(el.dataset.v), dec1: el => dropFromCart(el.dataset.v),
  inc: el => { const l = S.cart[el.dataset.i]; if (!l) return; const st = Number(vById(l.v).stok) || 0; if (T(cfg('blokir_stok_minus')) && l.qty + 1 > st) return toast('Stok tidak cukup'); l.qty++; saveCart(); cartLines(); upd(); updCard(l.v); buzz(); },
  dec: el => { const l = S.cart[el.dataset.i]; if (!l) return; const id = l.v; l.qty--; if (l.qty <= 0) S.cart.splice(el.dataset.i, 1); saveCart(); if (!S.cart.length) closeSheet(); else cartLines(); upd(); updCard(id); },
  metode: el => { S.metode = el.dataset.m; LS.set('metode', S.metode); const c = $('#mchips'); if (c) c.innerHTML = methodChips(); cashBox(); upd(); },
  qk: el => { S.terima = el.dataset.n; cashBox(); upd(); },
  wa: () => waSend(S.rc, ($('#wa') || {}).value), rawbt: () => printBT(S.rc), print: () => printBrowser(), share: () => shareRc(S.rc), copyrc: () => copyText(receiptText(S.rc)),
  go_diag: () => { S.tab = 'diag'; render(); },
  dtwa: () => waSend(testRc(), ''), dtbt: () => printBT(testRc()), dtshare: () => shareRc(testRc()),
  dping: async () => { const el = $('#dres'); el.textContent = 'Menguji…'; const t0 = performance.now(); try { await api('ping', {}, {silent: true}); el.textContent = 'Berhasil: ' + Math.round(performance.now() - t0) + ' ms'; } catch (e) { el.textContent = 'Gagal: ' + e.message; logErr(e, 'ping'); } },
  dcopy: () => copyText(JSON.stringify({v: C.VERSION, ua: navigator.userAgent, online: navigator.onLine, queue: S.queue.length, err: LS.get('errlog', [])}, null, 1)),
  qretry: el => { S.queue[el.dataset.i].status = 'pending'; LS.set('queue', S.queue); flush(); vRiwayat(); },
  qdel: el => { if (confirm('Hapus transaksi ini dari antrean? Stok di perangkat akan dikembalikan.')) { const q = S.queue.splice(el.dataset.i, 1)[0]; q.payload.items.forEach(it => { const v = vById(it.variant_id); if (v) v.stok = (Number(v.stok) || 0) + it.qty; }); LS.set('queue', S.queue); LS.set('data', S.data); badge(); vRiwayat(); } },
  stab: el => { S.stab = el.dataset.s; vStok(); },
  adj: el => adjSheet(el.dataset.t, el.dataset.id), adjsave: el => adjSave(el.dataset.t, el.dataset.id),
  gensku: autoGenSku,
  pbopen: pbSheet, pbdel: el => { S.pb.items.splice(el.dataset.i, 1); pbSheet(); }, pbsave: pbSave,
  pbadd: () => { const q = parseDec($('#pb_q').value), h = parseDec($('#pb_h').value), id = $('#pb_m').value; if (!id || !(q > 0) || !(h >= 0) || $('#pb_h').value === '') return toast('Isi jumlah dan harga'); S.pb.items.push({id: id, qty: q, harga: h}); pbSheet(); },
  go_master: () => { S.tab = 'master'; render(); }, go_riwayat: () => { S.tab = 'riwayat'; render(); }, go_laporan: () => { S.tab = 'laporan'; render(); }, go_shopee: () => { S.tab = 'shopee'; render(); }, go_resep: () => { S.tab = 'resep'; render(); }, go_cek: () => { S.tab = 'cek'; render(); }, go_users: () => { S.tab = 'users'; render(); }, go_settings: () => { S.tab = 'settings'; render(); },
  mt: el => { S.mt = el.dataset.k; vMaster(); }, medit: el => meditSheet(el.dataset.id), msave: el => mSave(el.dataset.id), mdel: el => mDel(el.dataset.id),
  uedit: el => ueditSheet(el.dataset.id), usave: el => uSave(el.dataset.id), ssave: sSave,
  sync: () => busy('Memperbarui data…', async () => { try { if (own()) await api('sistem.refresh', {}); await loadData(); lastChk = Date.now(); render(); await flush(); toast('Data diperbarui'); } catch (e) { if (e.auth) softLogout(); else toast('Gagal memperbarui: ' + e.message); } })
};
document.addEventListener('click', e => { const el = e.target.closest('[data-act]'); if (el && ACT[el.dataset.act]) ACT[el.dataset.act](el); });
document.addEventListener('input', e => {
  const k = e.target.dataset && e.target.dataset.in; if (!k) return; let v = e.target.value;
  if (k === 'q') { S.q = v; return grid(); }
  if (k === 'pbsup') { S.pb.sup = v; return; }
  if (k === 'pbongkir') { S.pb.ongkir = v.replace(/\D/g, ''); return; }
  if (k === 'catatan') { S.catatan = v; return; }
  if (k === 'diskon' || k === 'terima') { v = v.replace(/\D/g, ''); S[k] = v; return upd(); }
});
document.addEventListener('change', e => {
  if (e.target.dataset && e.target.dataset.chg === 'day') { S.day = e.target.value; vRiwayat(); }
  if (e.target.dataset && e.target.dataset.f) {
    const f = e.target.dataset.f;
    if (f === 'product_id' || f === 'ukuran' || f === 'level_pedas') {
      const sEl = document.querySelector('#sheet [data-f="sku"]');
      if (sEl && !sEl.value.trim()) autoGenSku();
    }
  }
});
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkUpdates(); flush(); if (swReg) swReg.update().catch(() => {}); } });
function start() { if (S.token && S.data) { S.tab = own() ? 'dash' : 'kasir'; render(); checkUpdates(true); flush(); } else renderLogin(); }
Object.assign(APP.views, {kasir: vKasir, riwayat: vRiwayat, stok: vStok, menu: vMenu, master: vMaster, users: vUsers, settings: vSettings, diag: vDiag});
Object.assign(APP, {S: S, api: api, $: $, rp: rp, num: num, parseDec: parseDec, esc: esc, LS: LS, T: T, sheet: sheet, closeSheet: closeSheet, toast: toast, busy: busy, busyLabel: busyLabel, skel: skel, ACT: ACT, autoGenSku: autoGenSku,
  render: render, loadData: loadData, checkUpdates: checkUpdates, vById: vById, pById: pById, vName: vName, vSub: vSub, chName: chName, fmtDT: fmtDT, today: today, own: own, start: start});
})();
