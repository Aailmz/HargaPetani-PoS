// seed.js — jalankan sekali (atau berulang, karena upsert): node seed.js
// Baca data_menu/menu.json dan isi semua tabel kategori, menu_item, menu_varian, menu_pilihan.
const fs = require('fs');
const path = require('path');
const db = require('./db');

// Sesuaikan path ini ke lokasi folder "Bot Resto" hasil ekstrak zip menu
const SUMBER_DIR = path.join(__dirname, 'data_menu');
const MENU_JSON_PATH = path.join(SUMBER_DIR, 'menu.json');

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
    });
    jumlahKategori++;
  }
  console.log(`✅ ${jumlahKategori} kategori dimasukkan.`);

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
  
  console.log('🎉 Seed selesai.');
}

main();