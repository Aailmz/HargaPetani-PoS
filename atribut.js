// Atribut menu (rasa, bahan, bumbu, cara masak, berkuah, pedas) dari atribut_menu.json.
// File ini TERPISAH dari data_menu/menu.json supaya data menu di VPS tidak tersentuh.
// Selama status menu = "asumsi", bot harus memakai kata "umumnya/biasanya".
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'atribut_menu.json');
let cache = null;

function muat() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('⚠️  atribut_menu.json tidak terbaca:', err.message);
    cache = { kosakata: { rasa: [], masak: [], bahan: [], bumbu: [] }, alias: {}, kategori_alias: {}, item: {} };
  }
  return cache;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Ubah kata dari customer/AI jadi nilai kosakata. Mengembalikan null kalau tidak dikenal.
function resolveNilai(jenis, kata) {
  const { kosakata, alias } = muat();
  const k = norm(kata);
  if (!k) return null;
  const daftar = kosakata[jenis] || [];
  const langsung = daftar.find((v) => norm(v) === k);
  if (langsung) return langsung;
  const peta = alias[jenis] || {};
  for (const [kataAlias, nilai] of Object.entries(peta)) if (norm(kataAlias) === k) return nilai;
  // "daging sapi" -> coba kata terakhir / tiap kata
  for (const bagian of k.split(' ')) {
    const hit = daftar.find((v) => norm(v) === bagian);
    if (hit) return hit;
    for (const [kataAlias, nilai] of Object.entries(peta)) if (norm(kataAlias) === bagian) return nilai;
  }
  return null;
}

function resolveDaftar(jenis, nilai) {
  const arr = Array.isArray(nilai) ? nilai : nilai == null || nilai === '' ? [] : [nilai];
  const ok = []; const tidakDikenal = [];
  for (const n of arr) {
    const r = resolveNilai(jenis, n);
    if (r) { if (!ok.includes(r)) ok.push(r); } else tidakDikenal.push(String(n));
  }
  return { ok, tidakDikenal };
}

function getAtribut(menuId) {
  return muat().item[menuId] || null;
}

// Sambal opsional dibaca dari pilihan menu (bukan dari atribut): pelanggan bisa memilih dengan/tanpa sambal.
function sambalOpsional(menu) {
  return (menu.pilihan || []).some((p) => /sambal/i.test(p.nama || ''));
}

function ringkas(menu) {
  const a = getAtribut(menu.id);
  if (!a) return null;
  return {
    rasa: a.rasa,
    rasa_dominan: a.rasa[0] || null,
    bahan_utama: a.bahan,
    bumbu: a.bumbu,
    cara_masak: a.masak,
    berkuah: a.kuah,
    pedas: a.pedas,
    sambal_opsional: sambalOpsional(menu),
    status_data: a.status,
  };
}

// ---- Kategori dari teks bebas ("minuman tradisional", "gorengan", "sate") ----
// Mengembalikan id kategori hanya kalau teks menunjuk TEPAT satu kategori.
function cariKategoriDariTeks(teks, daftarKategori, { persis = false } = {}) {
  const t = norm(teks);
  if (!t) return null;
  const { kategori_alias } = muat();
  const kata = new Set(t.split(' '));
  let terbaik = null;
  for (const kat of daftarKategori) {
    const frasa = [kat.nama, kat.id, ...(kategori_alias[kat.id] || [])].map(norm).filter(Boolean);
    for (const f of frasa) {
      const cocok = f === t || (!persis && new RegExp('(^| )' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '( |$)').test(t));
      if (cocok && (!terbaik || f.length > terbaik.panjang)) terbaik = { id: kat.id, panjang: f.length, frasa: f };
    }
  }
  void kata;
  return terbaik ? terbaik.id : null;
}

// ---- Pencarian berdasarkan atribut ----
function cari(menuList, f = {}) {
  const rasa = resolveDaftar('rasa', f.rasa);
  const bahan = resolveDaftar('bahan', f.bahan);
  const tanpaBahan = resolveDaftar('bahan', f.tanpa_bahan);
  const bumbu = resolveDaftar('bumbu', f.bumbu);
  const tanpaBumbu = resolveDaftar('bumbu', f.tanpa_bumbu);
  const masak = resolveDaftar('masak', f.masak);
  const tidakDikenal = [
    ...rasa.tidakDikenal.map((x) => 'rasa: ' + x), ...bahan.tidakDikenal.map((x) => 'bahan: ' + x),
    ...tanpaBahan.tidakDikenal.map((x) => 'tanpa_bahan: ' + x), ...bumbu.tidakDikenal.map((x) => 'bumbu: ' + x),
    ...tanpaBumbu.tidakDikenal.map((x) => 'tanpa_bumbu: ' + x), ...masak.tidakDikenal.map((x) => 'masak: ' + x),
  ];

  const cocok = menuList.filter((m) => {
    const a = getAtribut(m.id);
    if (!a) return false;
    if (rasa.ok.length && !rasa.ok.some((r) => a.rasa.includes(r))) return false;
    if (bahan.ok.length && !bahan.ok.some((b) => a.bahan.includes(b))) return false;
    if (tanpaBahan.ok.some((b) => a.bahan.includes(b))) return false;
    if (bumbu.ok.length && !bumbu.ok.some((b) => a.bumbu.includes(b))) return false;
    if (tanpaBumbu.ok.some((b) => a.bumbu.includes(b))) return false;
    if (masak.ok.length && !masak.ok.includes(a.masak)) return false;
    if (typeof f.kuah === 'boolean' && a.kuah !== f.kuah) return false;
    if (typeof f.pedas === 'boolean' && a.pedas !== f.pedas) return false;
    return true;
  });

  // Rasa dominan yang cocok didahulukan, lalu andalan
  cocok.sort((x, y) => {
    const dx = rasa.ok.includes(getAtribut(x.id).rasa[0]) ? 0 : 1;
    const dy = rasa.ok.includes(getAtribut(y.id).rasa[0]) ? 0 : 1;
    return dx - dy || (y.andalan ? 1 : 0) - (x.andalan ? 1 : 0);
  });
  return { cocok, tidakDikenal };
}

// Validasi: setiap menu punya atribut, nilai ada di kosakata. Mengembalikan daftar masalah (kosong = aman).
function validasi(daftarIdMenu) {
  const { kosakata, item } = muat();
  const masalah = [];
  for (const id of daftarIdMenu) if (!item[id]) masalah.push(`menu "${id}" belum punya atribut`);
  for (const [id, a] of Object.entries(item)) {
    if (daftarIdMenu && !daftarIdMenu.includes(id)) masalah.push(`atribut "${id}" tidak ada di menu`);
    for (const r of a.rasa || []) if (!kosakata.rasa.includes(r)) masalah.push(`${id}: rasa "${r}" di luar kosakata`);
    for (const b of a.bahan || []) if (!kosakata.bahan.includes(b)) masalah.push(`${id}: bahan "${b}" di luar kosakata`);
    for (const b of a.bumbu || []) if (!kosakata.bumbu.includes(b)) masalah.push(`${id}: bumbu "${b}" di luar kosakata`);
    if (a.masak && !kosakata.masak.includes(a.masak)) masalah.push(`${id}: masak "${a.masak}" di luar kosakata`);
    if (typeof a.pedas !== 'boolean' || typeof a.kuah !== 'boolean') masalah.push(`${id}: pedas/kuah harus boolean`);
  }
  return masalah;
}

module.exports = { muat, getAtribut, ringkas, cari, validasi, resolveNilai, resolveDaftar, cariKategoriDariTeks, sambalOpsional, norm };
