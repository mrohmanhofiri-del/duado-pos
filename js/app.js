/* Duado Snack POS - frontend local-first (tanpa build). Data master disimpan di perangkat; transaksi masuk antrean lalu disinkronkan. */
(function () {
'use strict';
const C = window.CONFIG || {};
const $ = s => document.querySelector(s);
const rp = n => 'Rp\u00a0' + Math.round(Number(n) || 0).toLocaleString('id-ID');
const num = n => Math.round(Number(n) || 0).toLocaleString('id-ID');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LS = {
  get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { toast('Penyimpanan perangkat penuh'); } },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const T = v => String(v).toUpperCase() === 'TRUE';
const S = {token: LS.get('token', null), data: LS.get('data', null), queue: LS.get('queue', []), tab: 'kasir', ch: null, cat: 'Semua', q: '',
  cart: [], diskon: '', metode: 'tunai', terima: '', catatan: '', nomor: {}, mt: 'products', stab: 'varian', day: null, pb: {items: [], ongkir: '', sup: ''}, rc: null};
const own = () => !!(S.data && S.data.user.role === 'owner');
const vById = id => S.data.variants.find(v => v.id === id);
const pById = id => S.data.products.find(p => p.id === id);
const vName = v => { const p = pById(v.product_id); return p ? p.nama : '(produk dihapus)'; };
const vSub = v => [v.ukuran, v.level_pedas].filter(Boolean).join(' · ');
const priceOf = (vid, ch) => { const x = S.data.prices.find(p => p.variant_id === vid && p.channel_id === ch); return x ? Number(x.harga_jual) : null; };
const chName = id => { const c = S.data.channels.find(c => c.id === id); return c ? c.nama : '-'; };
const p2 = n => ('0' + n).slice(-2);
const fmtDT = d => { d = new Date(d); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); };
const today = () => fmtDT(new Date()).slice(0, 10);
function toast(m) { const t = $('#toast'); t.textContent = m; t.className = 'show'; clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', 2600); }
function sheet(html) { const b = $('#sheet'); b.innerHTML = '<div class="sheet-bg" data-act="close"></div><div class="sheet" role="dialog">' + html + '</div>'; b.hidden = false; }
function closeSheet() { const b = $('#sheet'); b.hidden = true; b.innerHTML = ''; }

/* ---------- API dan sinkronisasi ---------- */
async function api(action, payload) {
  if (!C.API_URL || C.API_URL.indexOf('http') !== 0) throw new Error('API_URL belum diisi di js/config.js');
  const r = await fetch(C.API_URL, {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'}, body: JSON.stringify({action: action, token: S.token, payload: payload || {}})});
  const j = await r.json();
  if (!j.ok) { const e = new Error(j.error); e.server = true; e.auth = /^Sesi/.test(j.error); throw e; }
  return j.data;
}
function applyQueueStock() {
  S.queue.forEach(q => { if (q.status === 'pending') q.payload.items.forEach(it => { const v = vById(it.variant_id); if (v) v.stok = (Number(v.stok) || 0) - it.qty; }); });
}
async function loadData() { S.data = await api('bootstrap'); applyQueueStock(); LS.set('data', S.data); }
let lastRef = 0;
async function refresh(force) {
  if (!S.token || (!force && Date.now() - lastRef < 60000)) return;
  lastRef = Date.now();
  try { await loadData(); if ($('#sheet').hidden) render(); } catch (e) { if (e.auth) softLogout(); }
}
let flushing = false;
async function flush() {
  if (flushing || !S.token || !S.data || !navigator.onLine) return;
  flushing = true;
  try {
    for (const q of S.queue.filter(x => x.status === 'pending' && x.uid === S.data.user.uid)) {
      try {
        const r = await api('sale.create', q.payload);
        if (r.sale) { S.nomor[q.rid] = r.sale.nomor; Object.keys(r.stok || {}).forEach(id => { const v = vById(id); if (v) v.stok = r.stok[id]; }); }
        S.queue = S.queue.filter(x => x !== q); refreshRc();
      } catch (e) {
        if (e.auth) { softLogout(); break; }
        if (e.server) { q.status = 'review'; q.error = e.message; } else break; // gagal jaringan: coba lagi nanti
      }
      LS.set('queue', S.queue);
    }
  } finally { flushing = false; LS.set('queue', S.queue); LS.set('data', S.data); badge(); if (S.tab === 'riwayat' && $('#sheet').hidden) vRiwayat(); }
}
function softLogout(msg) { S.token = null; LS.del('token'); renderLogin(msg || 'Sesi berakhir, silakan masuk lagi.'); }
function logout() { S.token = null; S.data = null; S.cart = []; LS.del('token'); LS.del('data'); renderLogin(); }

/* ---------- Login ---------- */
function renderLogin(msg) {
  $('#app').innerHTML = '<div class="login"><img src="icons/icon-192.png" alt="Duado Snack" width="96" height="96"><h1>Duado Snack</h1>' +
    '<label>Username<input id="lu" class="inp" autocomplete="username" autocapitalize="none" value="' + esc(LS.get('lastUser', '')) + '"></label>' +
    '<label>PIN<input id="lp" class="inp" type="password" inputmode="numeric" autocomplete="current-password"></label>' +
    '<button class="btn pri" data-act="login">Masuk</button><div class="err" id="lerr">' + esc(msg || '') + '</div>' +
    (S.queue.length ? '<div class="muted">' + S.queue.length + ' transaksi menunggu dikirim setelah masuk.</div>' : '') + '</div>';
}
async function doLogin() {
  const u = $('#lu').value.trim(), p = $('#lp').value; if (!u || !p) return;
  $('#lerr').textContent = 'Masuk...';
  try {
    const r = await api('login', {username: u, pin: p}); S.token = r.token; LS.set('token', r.token); LS.set('lastUser', u);
    await loadData(); S.tab = 'kasir'; render(); flush();
  } catch (e) { $('#lerr').textContent = e.server ? e.message : 'Tidak dapat terhubung ke server. ' + e.message; }
}

/* ---------- Kerangka ---------- */
function render() {
  if (!S.token || !S.data) return renderLogin();
  const d = S.data; if (!S.ch || !d.channels.some(c => c.id === S.ch)) S.ch = d.channels[0] && d.channels[0].id;
  const tabs = [['kasir', 'Kasir'], ['riwayat', 'Riwayat'], ['stok', 'Stok'], ['menu', 'Menu']], inMenu = ['menu', 'master', 'users', 'settings'].indexOf(S.tab) >= 0;
  $('#app').innerHTML = '<header class="top"><b>' + esc(d.settings.nama_usaha || 'Duado Snack') + '</b><span class="badge" id="badge"></span></header><main id="main"></main><div id="cartbar"></div>' +
    '<nav class="nav">' + tabs.map(t => '<button data-act="tab" data-t="' + t[0] + '" class="' + ((S.tab === t[0] || (t[0] === 'menu' && inMenu)) ? 'on' : '') + '">' + t[1] + '</button>').join('') + '</nav>';
  badge();
  ({kasir: vKasir, riwayat: vRiwayat, stok: vStok, menu: vMenu, master: vMaster, users: vUsers, settings: vSettings})[S.tab]();
  cartbar();
}
function badge() {
  const b = $('#badge'); if (!b) return;
  const p = S.queue.filter(q => q.status === 'pending').length, r = S.queue.filter(q => q.status === 'review').length;
  b.className = 'badge ' + (r ? 'warn' : p ? 'wait' : 'ok');
  b.textContent = r ? r + ' perlu ditinjau' : p ? p + ' menunggu sinkron' : (navigator.onLine ? 'Tersinkron' : 'Offline');
}

/* ---------- Kasir ---------- */
function calc() {
  const s = S.data.settings; let sub = 0; S.cart.forEach(l => { sub += l.qty * (priceOf(l.v, S.ch) || 0); });
  const dis = Math.min(Math.max(Number(S.diskon) || 0, 0), sub), base = sub - dis, pp = Number(s.ppn_persen) || 0; let ppn = 0, total = base;
  if (T(s.ppn_aktif) && pp > 0) { if (T(s.ppn_inklusif)) ppn = Math.round(base * pp / (100 + pp)); else { ppn = Math.round(base * pp / 100); total = base + ppn; } }
  return {sub: sub, dis: dis, ppn: ppn, total: total};
}
function vKasir() {
  const d = S.data, cats = ['Semua'].concat(Array.from(new Set(d.products.map(p => p.kategori).filter(Boolean))));
  $('#main').innerHTML = '<div class="chips">' + d.channels.map(c => '<button class="chip ' + (c.id === S.ch ? 'on' : '') + '" data-act="chan" data-c="' + esc(c.id) + '">' + esc(c.nama) + '</button>').join('') + '</div>' +
    '<input id="q" class="inp" data-in="q" placeholder="Cari produk atau SKU" value="' + esc(S.q) + '">' +
    '<div class="chips">' + cats.map(c => '<button class="chip ' + (c === S.cat ? 'on' : '') + '" data-act="cat" data-c="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div><div class="grid" id="grid"></div>';
  grid();
}
function grid() {
  const d = S.data, q = S.q.toLowerCase(), block = T(d.settings.blokir_stok_minus);
  const list = d.variants.filter(v => (S.cat === 'Semua' || (pById(v.product_id) || {}).kategori === S.cat) && (!q || (vName(v) + ' ' + vSub(v) + ' ' + v.sku).toLowerCase().indexOf(q) >= 0));
  $('#grid').innerHTML = list.map(v => {
    const pr = priceOf(v.id, S.ch), st = Number(v.stok) || 0, off = pr == null || (block && st <= 0);
    return '<button class="card" data-act="add" data-v="' + esc(v.id) + '"' + (off ? ' disabled' : '') + '><b>' + esc(vName(v)) + '</b><span class="muted">' + esc(vSub(v)) + '</span><span class="pr">' + (pr == null ? 'Harga belum diatur' : rp(pr)) + '</span><span class="stk ' + (st <= 0 ? 'zero' : '') + '">Stok ' + num(st) + '</span></button>';
  }).join('') || '<p class="muted">Belum ada produk. Owner dapat menambahkannya di Menu, lalu Data Master.</p>';
}
function cartbar() {
  const el = $('#cartbar'); if (!el) return;
  if (S.tab !== 'kasir' || !S.cart.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<button class="cartbar" data-act="cart"><span>' + S.cart.reduce((a, l) => a + l.qty, 0) + ' item</span><b>' + rp(calc().total) + '</b><span>Lihat keranjang</span></button>';
}
function addToCart(id) {
  const v = vById(id), l = S.cart.find(x => x.v === id), q = (l ? l.qty : 0) + 1;
  if (T(S.data.settings.blokir_stok_minus) && q > (Number(v.stok) || 0)) return toast('Stok tidak cukup');
  if (l) l.qty = q; else S.cart.push({v: id, qty: 1}); cartbar();
}
function cartSheet() {
  const c = calc();
  const lines = S.cart.map((l, i) => { const v = vById(l.v); return '<div class="li"><div><b>' + esc(vName(v)) + '</b><div class="muted">' + esc(vSub(v)) + ' · ' + rp(priceOf(l.v, S.ch)) + '</div></div><div class="qty"><button data-act="dec" data-i="' + i + '" aria-label="Kurangi">−</button><span>' + l.qty + '</span><button data-act="inc" data-i="' + i + '" aria-label="Tambah">+</button></div></div>'; }).join('');
  const ms = ['tunai', 'transfer', 'qris'].map(m => '<button class="chip ' + (S.metode === m ? 'on' : '') + '" data-act="metode" data-m="' + m + '">' + m.toUpperCase() + '</button>').join('');
  let cash = '';
  if (S.metode === 'tunai') {
    const q = [c.total].concat([5000, 10000, 20000, 50000, 100000].map(n => Math.ceil(c.total / n) * n)).filter((x, i, a) => x > 0 && a.indexOf(x) === i).slice(0, 4);
    cash = '<label>Uang diterima (Rp)<input class="inp" data-in="terima" inputmode="numeric" value="' + esc(S.terima) + '"></label><div class="chips">' + q.map(x => '<button class="chip" data-act="qk" data-n="' + x + '">' + num(x) + '</button>').join('') + '</div>';
  }
  sheet('<h2>Keranjang · ' + esc(chName(S.ch)) + '</h2>' + lines + '<label>Diskon (Rp)<input class="inp" data-in="diskon" inputmode="numeric" value="' + esc(S.diskon) + '"></label><div class="chips">' + ms + '</div>' + cash +
    '<label>Catatan<input class="inp" data-in="catatan" value="' + esc(S.catatan) + '"></label><div id="tot"></div><button class="btn pri" data-act="pay">Bayar</button>');
  upd();
}
function upd() {
  const c = calc(), s = S.data.settings, kv = (a, b, cl) => '<div class="kv ' + (cl || '') + '"><span>' + a + '</span><span>' + b + '</span></div>';
  let h = kv('Subtotal', rp(c.sub)); if (c.dis) h += kv('Diskon', '-' + rp(c.dis)); if (c.ppn) h += kv(T(s.ppn_inklusif) ? 'PPN (sudah termasuk)' : 'PPN', rp(c.ppn));
  h += kv('Total', rp(c.total), 'big'); if (S.metode === 'tunai' && S.terima !== '') h += kv('Kembalian', rp((Number(S.terima) || 0) - c.total));
  const t = $('#tot'); if (t) t.innerHTML = h; cartbar();
}
function pay() {
  if (!S.cart.length) return; const c = calc(), tunai = S.metode === 'tunai', terima = tunai ? (S.terima === '' ? c.total : Number(S.terima) || 0) : c.total;
  if (tunai && terima < c.total) return toast('Uang diterima kurang');
  const rid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2);
  const payload = {request_id: rid, channel_id: S.ch, items: S.cart.map(l => ({variant_id: l.v, qty: l.qty})), diskon: c.dis, metode_bayar: S.metode, catatan: S.catatan};
  const rc = {rid: rid, time: Date.now(), ch: chName(S.ch), metode: S.metode, terima: terima, kembali: terima - c.total, sub: c.sub, dis: c.dis, ppn: c.ppn, total: c.total,
    lines: S.cart.map(l => { const v = vById(l.v); return {n: vName(v) + ' ' + vSub(v), q: l.qty, h: priceOf(l.v, S.ch)}; })};
  S.queue.push({rid: rid, payload: payload, status: 'pending', ts: Date.now(), uid: S.data.user.uid, total: c.total, ch: rc.ch}); LS.set('queue', S.queue);
  S.cart.forEach(l => { const v = vById(l.v); v.stok = (Number(v.stok) || 0) - l.qty; }); LS.set('data', S.data);
  S.cart = []; S.diskon = ''; S.terima = ''; S.catatan = ''; render(); showReceipt(rc); flush();
}
function receiptText(rc) {
  const w = 32, s = S.data.settings, line = '-'.repeat(w), L = (a, b) => { a = String(a); b = String(b); return a + ' '.repeat(Math.max(1, w - a.length - b.length)) + b; };
  const o = [(s.nama_usaha || 'Duado Snack').toUpperCase(), line, 'No : ' + (S.nomor[rc.rid] || '(menunggu sinkron)'), 'Tgl: ' + fmtDT(rc.time), 'Via: ' + rc.ch, line];
  rc.lines.forEach(l => { o.push(l.n); o.push(L(' ' + l.q + ' x ' + num(l.h), num(l.q * l.h))); });
  o.push(line, L('Subtotal', num(rc.sub))); if (rc.dis) o.push(L('Diskon', '-' + num(rc.dis))); if (rc.ppn) o.push(L(T(s.ppn_inklusif) ? 'PPN (incl.)' : 'PPN', num(rc.ppn)));
  o.push(L('TOTAL', num(rc.total)), L('Bayar (' + rc.metode + ')', num(rc.terima))); if (rc.metode === 'tunai') o.push(L('Kembali', num(rc.kembali)));
  o.push(line, s.footer_struk || 'Terima kasih'); return o.join('\n');
}
function showReceipt(rc) {
  S.rc = rc;
  sheet('<h2>Pembayaran berhasil</h2><pre class="rc" id="rtxt"></pre><label>No. WhatsApp pelanggan (opsional)<input class="inp" id="wa" inputmode="tel" placeholder="08xxxxxxxxxx"></label>' +
    '<div class="row2"><button class="btn pri" data-act="wa">Kirim WhatsApp</button><button class="btn sec" data-act="rawbt">Cetak (RawBT)</button></div>' +
    '<div class="row2"><button class="btn sec" data-act="print">Cetak (browser)</button><button class="btn sec" data-act="close">Selesai</button></div>');
  refreshRc();
}
function refreshRc() { const el = $('#rtxt'); if (el && S.rc) el.textContent = receiptText(S.rc); }

/* ---------- Riwayat ---------- */
async function vRiwayat() {
  const day = S.day || today();
  $('#main').innerHTML = '<label>Tanggal<input type="date" class="inp" data-chg="day" value="' + day + '"></label><div id="rq"></div><div id="rsum"></div><div id="rlist"><p class="muted">Memuat...</p></div>';
  const qs = S.queue.map((q, i) => '<div class="li"><div><b>' + rp(q.total) + '</b> <span class="muted">' + esc(q.ch) + ' · ' + fmtDT(q.ts).slice(11) + '</span>' +
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
  try {
    const r = await api('stock.adjust', {tipe: t, id: id, stok_baru: $('#a_s').value, hpp: $('#a_h').value, alasan: $('#a_r').value});
    const it = t === 'bahan' ? S.data.materials.find(m => m.id === id) : vById(id); it.stok = r.stok; it.hpp_rata2 = r.hpp_rata2; LS.set('data', S.data); closeSheet(); render(); toast('Stok disimpan');
  } catch (e) { toast(e.message); }
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
  const pb = S.pb; if (!pb.items.length) return toast('Daftar masih kosong');
  try {
    const r = await api('purchase.create', {supplier_id: pb.sup, ongkir: Number(pb.ongkir) || 0, items: pb.items.map(i => ({material_id: i.id, qty: i.qty, harga_satuan: i.harga}))});
    r.materials.forEach(u => { const m = S.data.materials.find(x => x.id === u.id); if (m) { m.stok = u.stok; m.hpp_rata2 = u.hpp_rata2; } });
    LS.set('data', S.data); S.pb = {items: [], ongkir: '', sup: ''}; closeSheet(); render(); toast('Pembelian tersimpan, HPP diperbarui');
  } catch (e) { toast(e.message); }
}

/* ---------- Menu, data master, pengguna, pengaturan ---------- */
function vMenu() {
  const u = S.data.user, o = own(), b = (a, t, c) => '<button class="btn ' + (c || 'sec') + '" data-act="' + a + '">' + t + '</button>';
  $('#main').innerHTML = '<div class="li"><div><b>' + esc(u.nama) + '</b><div class="muted">' + esc(u.role) + ' · versi ' + esc(C.VERSION || '') + '</div></div><span class="badge ok">' + (navigator.onLine ? 'Online' : 'Offline') + '</span></div>' +
    (o ? b('go_master', 'Data Master (produk, varian, harga, bahan)') + b('go_users', 'Pengguna') + b('go_settings', 'Pengaturan (PPN, struk, stok)') : '') + b('sync', 'Perbarui data dan kirim antrean') +
    b('logout', 'Keluar', 'dan') + '<p class="muted">Pasang di layar utama: menu Chrome, lalu "Tambahkan ke layar utama".</p>';
}
const RT = {};
const MT = {
  products: {l: 'Produk', k: 'products', f: [['nama', 'Nama produk'], ['kategori', 'Kategori (mis. Basreng)']], t: r => r.nama + (r.kategori ? ' · ' + r.kategori : '')},
  product_variants: {l: 'Varian', k: 'variants', f: [['product_id', 'Produk', 'ref:products'], ['sku', 'SKU'], ['ukuran', 'Ukuran kemasan (mis. 100 g)'], ['level_pedas', 'Level pedas (mis. Level 3)']], t: r => vName(r) + ' · ' + vSub(r)},
  channel_prices: {l: 'Harga jual', k: 'prices', f: [['variant_id', 'Varian', 'ref:variants'], ['channel_id', 'Channel', 'ref:channels'], ['harga_jual', 'Harga jual (Rp)', 'number']], t: r => { const v = vById(r.variant_id); return (v ? vName(v) + ' ' + vSub(v) : '?') + ' · ' + chName(r.channel_id) + ' · ' + rp(r.harga_jual); }},
  materials: {l: 'Bahan dan kemasan', k: 'materials', f: [['nama', 'Nama'], ['tipe', 'Tipe', 'sel:bahan,kemasan,barang jadi beli'], ['satuan', 'Satuan (kg, gram, pcs)'], ['stok_minimum', 'Stok minimum', 'number']], t: r => r.nama + ' (' + r.satuan + ')'},
  suppliers: {l: 'Supplier', k: 'suppliers', f: [['nama', 'Nama'], ['kontak', 'Kontak'], ['catatan', 'Catatan']], t: r => r.nama},
  channels: {l: 'Channel', k: 'channels', f: [['nama', 'Nama'], ['fee_persen', 'Fee (%)', 'number'], ['fee_tetap', 'Fee tetap (Rp)', 'number']], t: r => r.nama + ' · fee ' + (r.fee_persen || 0) + '%'}
};
Object.keys(MT).forEach(k => RT[MT[k].k] = MT[k].t);
function field(f, val) {
  const k = f[0], l = f[1], t = f[2] || '', v = val == null ? '' : val;
  if (t.indexOf('ref:') === 0) { const key = t.slice(4); return '<label>' + l + '<select class="inp" data-f="' + k + '"><option value="">- pilih -</option>' + S.data[key].map(r => '<option value="' + esc(r.id) + '"' + (r.id === v ? ' selected' : '') + '>' + esc(RT[key](r)) + '</option>').join('') + '</select></label>'; }
  if (t.indexOf('sel:') === 0) return '<label>' + l + '<select class="inp" data-f="' + k + '">' + t.slice(4).split(',').map(o => '<option' + (o === v ? ' selected' : '') + '>' + o + '</option>').join('') + '</select></label>';
  return '<label>' + l + '<input class="inp" data-f="' + k + '"' + (t === 'number' ? ' inputmode="decimal"' : '') + ' value="' + esc(v) + '"></label>';
}
function readForm() { const o = {}; document.querySelectorAll('#sheet [data-f]').forEach(e => o[e.dataset.f] = e.type === 'checkbox' ? e.checked : e.value); return o; }
function vMaster() {
  const cfg = MT[S.mt], rows = S.data[cfg.k] || [];
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div class="chips" style="margin-top:8px">' + Object.keys(MT).map(k => '<button class="chip ' + (k === S.mt ? 'on' : '') + '" data-act="mt" data-k="' + k + '">' + MT[k].l + '</button>').join('') + '</div>' +
    '<button class="btn pri" data-act="medit" data-id="">+ Tambah ' + cfg.l.toLowerCase() + '</button><div style="height:8px"></div>' +
    rows.map(r => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left" data-act="medit" data-id="' + esc(r.id) + '"><span>' + esc(cfg.t(r)) + '</span><span class="muted">Ubah</span></button>').join('');
}
function meditSheet(id) {
  const cfg = MT[S.mt], r = id ? S.data[cfg.k].find(x => x.id === id) : {};
  sheet('<h2>' + (id ? 'Ubah ' : 'Tambah ') + cfg.l.toLowerCase() + '</h2>' + cfg.f.map(f => field(f, r[f[0]])).join('') + '<button class="btn pri" data-act="msave" data-id="' + esc(id) + '">Simpan</button>' + (id ? '<button class="btn dan" data-act="mdel" data-id="' + esc(id) + '">Hapus</button>' : ''));
}
async function mSave(id) {
  const data = readForm(); if (id) data.id = id;
  ['harga_jual', 'fee_persen', 'fee_tetap', 'stok_minimum'].forEach(k => { if (k in data) data[k] = Number(data[k]) || 0; });
  try { await api('master.save', {table: S.mt, data: data}); await loadData(); closeSheet(); render(); toast('Tersimpan'); } catch (e) { toast(e.message); }
}
async function mDel(id) {
  if (!confirm('Hapus data ini?')) return;
  try { await api('master.remove', {table: S.mt, id: id}); await loadData(); closeSheet(); render(); toast('Dihapus'); } catch (e) { toast(e.message); }
}
async function vUsers() {
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><button class="btn pri" data-act="uedit" data-id="">+ Tambah pengguna</button><div id="ul"><p class="muted">Memuat...</p></div>';
  try { S.users = await api('user.list'); $('#ul').innerHTML = S.users.map(u => '<button class="li" style="width:100%;border:0;font:inherit;text-align:left;margin-top:8px" data-act="uedit" data-id="' + esc(u.id) + '"><span><b>' + esc(u.nama) + '</b> <span class="muted">@' + esc(u.username) + ' · ' + esc(u.role) + '</span></span>' + (String(u.aktif) === 'false' ? '<span class="tag red">Nonaktif</span>' : '') + '</button>').join(''); }
  catch (e) { $('#ul').innerHTML = '<p class="muted">' + esc(e.message) + '</p>'; }
}
function ueditSheet(id) {
  const u = id ? S.users.find(x => x.id === id) : {role: 'kasir', aktif: true};
  sheet('<h2>' + (id ? 'Ubah' : 'Tambah') + ' pengguna</h2>' + field(['nama', 'Nama'], u.nama) + field(['username', 'Username'], u.username) + field(['role', 'Peran', 'sel:kasir,owner'], u.role) +
    '<label>PIN (4-8 angka)' + (id ? ', kosongkan jika tidak diganti' : '') + '<input class="inp" data-f="pin" inputmode="numeric" type="password"></label><label><input type="checkbox" data-f="aktif"' + (String(u.aktif) !== 'false' ? ' checked' : '') + '> Aktif</label><button class="btn pri" data-act="usave" data-id="' + esc(id) + '">Simpan</button>');
}
async function uSave(id) {
  const d = readForm(); if (id) d.id = id;
  try { await api('user.save', d); closeSheet(); vUsers(); toast('Tersimpan'); } catch (e) { toast(e.message); }
}
function vSettings() {
  const s = S.data.settings, cb = (k, l) => '<label style="margin:8px 0"><input type="checkbox" data-f="' + k + '"' + (T(s[k]) ? ' checked' : '') + '> ' + l + '</label>';
  $('#main').innerHTML = '<button class="chip" data-act="tab" data-t="menu">← Menu</button><div id="sf" style="margin-top:8px">' + field(['nama_usaha', 'Nama usaha'], s.nama_usaha) + field(['footer_struk', 'Teks bawah struk'], s.footer_struk) +
    cb('ppn_aktif', 'PPN aktif') + field(['ppn_persen', 'Tarif PPN (%)', 'number'], s.ppn_persen) + cb('ppn_inklusif', 'Harga jual sudah termasuk PPN') + cb('blokir_stok_minus', 'Blokir penjualan jika stok kurang') +
    field(['overhead_per_unit', 'Overhead per bungkus (Rp, untuk HPP produksi)', 'number'], s.overhead_per_unit) + '</div><button class="btn pri" data-act="ssave">Simpan pengaturan</button>';
}
async function sSave() {
  const v = {}; document.querySelectorAll('#sf [data-f]').forEach(e => v[e.dataset.f] = e.type === 'checkbox' ? e.checked : e.value);
  try { await api('setting.setMany', {values: v}); await loadData(); render(); toast('Pengaturan tersimpan'); } catch (e) { toast(e.message); }
}

/* ---------- Aksi (event delegation) ---------- */
const ACT = {
  login: doLogin, logout: logout, close: closeSheet, cart: cartSheet, pay: pay,
  tab: el => { S.tab = el.dataset.t; render(); },
  chan: el => { S.ch = el.dataset.c; vKasir(); cartbar(); },
  cat: el => { S.cat = el.dataset.c; vKasir(); },
  add: el => addToCart(el.dataset.v),
  inc: el => { S.cart[el.dataset.i].qty++; const l = S.cart[el.dataset.i]; if (T(S.data.settings.blokir_stok_minus) && l.qty > (Number(vById(l.v).stok) || 0)) { l.qty--; toast('Stok tidak cukup'); } cartSheet(); },
  dec: el => { const l = S.cart[el.dataset.i]; l.qty--; if (l.qty <= 0) S.cart.splice(el.dataset.i, 1); if (!S.cart.length) { closeSheet(); cartbar(); } else cartSheet(); },
  metode: el => { S.metode = el.dataset.m; cartSheet(); },
  qk: el => { S.terima = el.dataset.n; cartSheet(); },
  wa: () => { let n = ($('#wa').value || '').replace(/\D/g, ''); if (n.indexOf('0') === 0) n = '62' + n.slice(1); window.open('https://wa.me/' + n + '?text=' + encodeURIComponent(receiptText(S.rc)), '_blank'); },
  rawbt: () => { location.href = 'rawbt:base64,' + btoa(unescape(encodeURIComponent(receiptText(S.rc)))); },
  print: () => window.print(),
  qretry: el => { S.queue[el.dataset.i].status = 'pending'; LS.set('queue', S.queue); flush(); vRiwayat(); },
  qdel: el => { if (confirm('Hapus transaksi ini dari antrean? Stok di perangkat akan dikembalikan.')) { const q = S.queue.splice(el.dataset.i, 1)[0]; q.payload.items.forEach(it => { const v = vById(it.variant_id); if (v) v.stok = (Number(v.stok) || 0) + it.qty; }); LS.set('queue', S.queue); LS.set('data', S.data); badge(); vRiwayat(); } },
  stab: el => { S.stab = el.dataset.s; vStok(); },
  adj: el => adjSheet(el.dataset.t, el.dataset.id), adjsave: el => adjSave(el.dataset.t, el.dataset.id),
  pbopen: pbSheet, pbdel: el => { S.pb.items.splice(el.dataset.i, 1); pbSheet(); }, pbsave: pbSave,
  pbadd: () => { const q = Number($('#pb_q').value), h = Number($('#pb_h').value), id = $('#pb_m').value; if (!id || !(q > 0) || !(h >= 0) || $('#pb_h').value === '') return toast('Isi jumlah dan harga'); S.pb.items.push({id: id, qty: q, harga: h}); pbSheet(); },
  go_master: () => { S.tab = 'master'; render(); }, go_users: () => { S.tab = 'users'; render(); }, go_settings: () => { S.tab = 'settings'; render(); },
  mt: el => { S.mt = el.dataset.k; vMaster(); }, medit: el => meditSheet(el.dataset.id), msave: el => mSave(el.dataset.id), mdel: el => mDel(el.dataset.id),
  uedit: el => ueditSheet(el.dataset.id), usave: el => uSave(el.dataset.id), ssave: sSave,
  sync: async () => { toast('Menyinkronkan...'); await refresh(true); await flush(); toast('Selesai'); }
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
document.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.chg === 'day') { S.day = e.target.value; vRiwayat(); } });
document.addEventListener('keydown', e => { if (e.key === 'Enter' && $('#lp') && document.activeElement === $('#lp')) doLogin(); });

/* ---------- Mulai ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('online', () => { badge(); flush(); refresh(true); });
window.addEventListener('offline', badge);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refresh(); flush(); } });
setInterval(flush, 20000);
if (S.token && S.data) { render(); refresh(true); flush(); } else renderLogin();
})();
