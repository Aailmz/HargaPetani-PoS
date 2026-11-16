// seed.js — jalankan sekali (atau berulang, karena upsert): node seed.js
// Baca data_menu/menu.json dan isi semua tabel kategori, menu_item, menu_varian, menu_pilihan.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { normalisasiNama, cariKandidatMenu } = require('./matcher');

// Sesuaikan path ini ke lokasi folder "Bot Resto" hasil ekstrak zip menu
const SUMBER_DIR = path.join(__dirname, 'data_menu');
const MENU_JSON_PATH = path.join(SUMBER_DIR, 'menu.json');

// true kalau semua kata alias muncul berurutan sebagai bagian dari nama lain yang lebih panjang.
// Contoh: "ubi" ada di "Cimplung Ubi"; "matcha" ada di "Matcha Berry Latte".
function potonganKataDariNama(alias, namaLain) {
  const a = normalisasiNama(alias).split(' ').filter(Boolean);
  const t = normalisasiNama(namaLain).split(' ').filter(Boolean);
  if (a.length === 0 || a.length >= t.length) return false; // sama panjang = sama persis, dicek di aturan lain
  for (let i = 0; i + a.length <= t.length; i++) {
    if (a.every((kata, j) => t[i + j] === kata)) return true;
  }
  return false;
}

// Alias dianggap ambigu (dibuang, supaya bot nanya/jelasin, bukan menebak) kalau:
//  1. sama persis dengan nama resmi menu lain,
//  2. dipakai juga sebagai alias menu lain,
//  3. cuma potongan kata dari nama menu lain, jadi bisa berarti beberapa menu
//     (misal "ubi" -> Ubi Goreng / Cimplung Ubi, "matcha" -> Matcha Latte / Matcha Berry Latte).
// Alias lain (typo, ejaan lain, nama panggilan) aman dan dipertahankan.
// Nama resmi tidak pernah dibuang. Return: daftar alias yang dibuang (alias sudah dihapus dari item).
function bersihkanAliasAmbigu(items) {
  const keputusan = [];

  // Fase 1: putuskan dari data asli (bukan data yang sudah diubah), supaya hasilnya tidak tergantung urutan
  for (const item of items) {
    const lain = items.filter((o) => o.id !== item.id);
    for (const alias of item.alias || []) {
      const na = normalisasiNama(alias);
      let alasan = null;

      const samaNama = lain.find((o) => normalisasiNama(o.nama) === na);
      const samaAlias = lain.find((o) => (o.alias || []).some((a) => normalisasiNama(a) === na));
      const potongan = lain.find((o) => potonganKataDariNama(alias, o.nama));

      if (!na) alasan = 'kosong';
      else if (samaNama) alasan = `sama dengan nama menu "${samaNama.nama}"`;
      else if (samaAlias) alasan = `juga dipakai alias "${samaAlias.nama}"`;
      else if (potongan) alasan = `potongan nama menu lain, misal "${potongan.nama}"`;

      if (alasan) keputusan.push({ item, alias, alasan });
    }
  }

  // Fase 2: terapkan
  for (const { item, alias } of keputusan) {
    item.alias = (item.alias || []).filter((a) => a !== alias);
  }
  return keputusan.map(({ item, alias, alasan }) => ({ menu: item.nama, alias, alasan }));
}

// Cek hasil akhir pakai pencocok yang SAMA dengan bot: tiap nama resmi & alias harus langsung
// (YAKIN) menuju menu pemiliknya. Return daftar yang masih bermasalah.
function verifikasiTidakAmbigu() {
  const masalah = [];
  for (const m of db.getAllMenu()) {
    for (const nama of [m.nama, ...(m.alias || [])]) {
      const r = cariKandidatMenu(nama);
      if (r.statusMatch !== 'YAKIN' || r.kandidatTerbaik.id !== m.id) {
        masalah.push(`"${nama}" (${m.nama}) -> ${r.statusMatch}`);
      }
    }
  }
  return masalah;
}

function main() {
  if (!fs.existsSync(MENU_JSON_PATH)) {
    console.error(`❌ File tidak ditemukan: ${MENU_JSON_PATH}`);
    console.error('   Pastikan folder "Bot Resto" (dari zip) di-copy ke ./data_menu/');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(MENU_JSON_PATH, 'utf-8'));

  console.log(`📦 Memuat menu.json versi: ${data.versi || '(tidak diketahui)'}`);

  // ---------- KATEGORI ----------
  let jumlahKategori = 0;
  for (const kat of data.kategori) {
    db.upsertKategori({
      id: kat.id,
      nama: kat.nama,
      jenis: kat.jenis,
      urutan: kat.urutan,
      foto_path: kat.foto || null,
      foto_ilustrasi: !!kat.foto_ilustrasi,
      kartu_path: `kartu_kategori/${kat.id}.jpg`,
      kelompok: kat.kelompok, // opsional: 'berat' | 'camilan' | 'kopi' | 'non_kopi', default ikut KELOMPOK_DEFAULT di db.js
    });
    jumlahKategori++;
  }
  console.log(`✅ ${jumlahKategori} kategori dimasukkan.`);

  // ---------- BERSIHKAN ALIAS AMBIGU (sebelum masuk DB) ----------
  const nama = new Map();
  for (const item of data.item) {
    const k = normalisasiNama(item.nama);
    nama.set(k, [...(nama.get(k) || []), item.nama]);
  }
  const kembar = [...nama.values()].filter((v) => v.length > 1);
  if (kembar.length > 0) {
    console.error(`❌ Ada nama menu resmi yang kembar di menu.json: ${kembar.map((v) => v.join(' / ')).join('; ')}`);
    process.exit(1);
  }

  const aliasDibuang = bersihkanAliasAmbigu(data.item);
  if (aliasDibuang.length > 0) {
    console.log(`🧹 ${aliasDibuang.length} alias ambigu dibuang (tidak dipakai bot):`);
    for (const d of aliasDibuang) console.log(`   - "${d.alias}" di ${d.menu}: ${d.alasan}`);
  }

  // ---------- MENU + VARIAN + PILIHAN ----------
  let jumlahMenu = 0;
  let jumlahVarian = 0;
  let jumlahPilihan = 0;

  for (const item of data.item) {
    db.upsertMenu({
      id: item.id,
      nama: item.nama,
      jenis: item.jenis,
      kategori_id: item.kategori,
      deskripsi: item.deskripsi,
      deskripsi_sumber: item.deskripsi_sumber,
      alias: item.alias || [],
      alergen: item.alergen || [],
      suhu: item.suhu || null,
      isi: item.isi || null,
      andalan: !!item.andalan,
      tersedia: db.getMenuById(item.id) ? db.getMenuById(item.id).tersedia : item.tersedia !== false,
      foto_path: item.foto || null,
      foto_perlu_cek: !!item.foto_perlu_cek,
      kartu_path: `kartu/${item.id}.jpg`,
      catatan: item.catatan || null,
    });
    jumlahMenu++;

    for (const v of item.varian || []) {
      db.upsertVarian({
        sku: v.sku,
        menu_id: item.id,
        label: v.label,
        harga: v.harga,
        nama_di_menu: v.nama_di_menu,
      });
      jumlahVarian++;
    }

    for (const p of item.pilihan || []) {
      db.upsertPilihan({
        menu_id: item.id,
        nama: p.nama,
        opsi: p.opsi || [],
        wajib: !!p.wajib,
        default_opsi: p.default || null,
        biaya_tambahan: p.biaya_tambahan || 0,
      });
      jumlahPilihan++;
    }
  }

  console.log(`✅ ${jumlahMenu} menu dimasukkan (${jumlahVarian} varian, ${jumlahPilihan} baris pilihan).`);
  
  // ---------- INFO RESTO (top-level menu.json) ----------
  for (const kunci of ['restoran', 'aturan_layanan', 'catatan_alergen']) {
    if (data[kunci] !== undefined) db.setInfoResto(kunci, data[kunci]);
  }
  db.setInfoResto('versi_data', data.versi ?? null);
  console.log('✅ Info resto (restoran, aturan_layanan, catatan_alergen) disimpan.');

  // ---------- VERIFIKASI: tidak ada nama/alias yang ambigu ----------
  const masalah = verifikasiTidakAmbigu();
  if (masalah.length > 0) {
    console.error(`❌ Masih ada ${masalah.length} nama/alias ambigu:\n   ${masalah.join('\n   ')}`);
    process.exit(1);
  }
  console.log('✅ Verifikasi: semua nama menu & alias langsung cocok ke 1 menu (tidak ada yang ambigu).');

  console.log('🎉 Seed selesai.');
}

main();