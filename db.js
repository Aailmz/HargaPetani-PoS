const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const db = new Database(path.join(__dirname, 'resto-bot.db'));

// ========== SKEMA ==========

db.exec(`
  CREATE TABLE IF NOT EXISTS kategori (
    id TEXT PRIMARY KEY,              -- dari menu.json, misal "gorengan"
    nama TEXT NOT NULL,               -- "Gorengan"
    jenis TEXT,                       -- 'makanan' | 'minuman'
    urutan INTEGER DEFAULT 0,         -- urutan tampil sesuai buku menu
    foto_path TEXT,                   -- foto/kategori_<id>.jpg
    foto_ilustrasi INTEGER DEFAULT 0, -- 1 kalau foto sampul buatan AI
    kartu_path TEXT                   -- kartu_kategori/<id>.jpg
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS menu_item (
    id TEXT PRIMARY KEY,              -- dari menu.json, misal "aren_latte" (BUKAN autoincrement lagi)
    nama TEXT NOT NULL,
    jenis TEXT,                       -- 'makanan' | 'minuman'
    kategori_id TEXT,
    deskripsi TEXT,
    deskripsi_sumber TEXT,            -- 'menu' | 'draf_umum' | 'draf_dari_nama'
    alias TEXT,                       -- JSON array string, misal '["kopi aren","kopi susu aren"]'
    alergen TEXT,                     -- JSON array string, misal '["susu"]'
    suhu TEXT,                        -- JSON array, misal '["panas","dingin"]' atau null kalau tidak relevan
    isi TEXT,                         -- JSON array (untuk Mix Plate), atau null
    andalan INTEGER DEFAULT 0,
    tersedia INTEGER DEFAULT 1,
    foto_path TEXT,                   -- foto/<id>.jpg, bisa null
    foto_perlu_cek INTEGER DEFAULT 0,
    kartu_path TEXT,                  -- kartu/<id>.jpg
    catatan TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (kategori_id) REFERENCES kategori(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS menu_varian (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_id TEXT NOT NULL,
    sku TEXT NOT NULL UNIQUE,         -- misal "sate_ayam", "sate_ayam_setengah"
    label TEXT,                       -- "Reguler" | "1/2 Porsi"
    harga INTEGER NOT NULL,
    nama_di_menu TEXT,                -- teks asli buku menu (termasuk typo), buat arsip
    FOREIGN KEY (menu_id) REFERENCES menu_item(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS menu_pilihan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    menu_id TEXT NOT NULL,
    nama TEXT NOT NULL,               -- "Suhu" | "Sambal" | "Biji kopi"
    opsi TEXT NOT NULL,               -- JSON array string, misal '["Panas","Dingin"]'
    wajib INTEGER DEFAULT 0,
    default_opsi TEXT,                -- misal "Dengan sambal" buat Sambal
    biaya_tambahan INTEGER DEFAULT 0, -- BARU: dari field biaya_tambahan di JSON (saat ini selalu 0, tapi disiapkan)
    FOREIGN KEY (menu_id) REFERENCES menu_item(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    jid TEXT PRIMARY KEY,
    nama TEXT,
    nomor_meja TEXT,                         -- diisi begitu customer bilang sudah sampai / kasir assign
    status_kedatangan TEXT DEFAULT 'BELUM_SAMPAI', -- 'BELUM_SAMPAI' | 'DI_RESTO'
    status_cs TEXT DEFAULT 'BOT',            -- 'BOT' | 'ESKALASI'
    eskalasi_at TEXT,
    is_registered INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS operators (
    jid TEXT PRIMARY KEY,
    nama TEXT,
    is_utama INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pesanan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_jid TEXT NOT NULL,
    nomor_meja TEXT,
    status TEXT DEFAULT 'DRAFT_MENUNGGU_KONFIRMASI',
    -- status: DRAFT_MENUNGGU_KONFIRMASI -> MENUNGGU_BAYAR -> SELESAI
    --         (atau DIBATALKAN)
    subtotal INTEGER,
    kode_unik INTEGER,
    nominal_transfer INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pesanan_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pesanan_id INTEGER NOT NULL,
    menu_id TEXT,
    varian_sku TEXT,
    nama_snapshot TEXT NOT NULL,
    qty INTEGER NOT NULL,
    harga_satuan_snapshot INTEGER,
    pilihan_terpilih TEXT,
    catatan TEXT,
    status_item TEXT DEFAULT 'AKTIF',
    -- status_item: 'AKTIF' | 'MENUNGGU_KEPUTUSAN_HABIS' | 'DIGANTI' | 'DIBATALKAN_HABIS'
    item_pengganti_id INTEGER,       -- kalau DIGANTI, menunjuk ke pesanan_item baru hasil ganti
    habis_dilaporkan_at TEXT,        -- waktu kasir lapor habis, buat hitung timeout 10 menit
    FOREIGN KEY (pesanan_id) REFERENCES pesanan(id),
    FOREIGN KEY (menu_id) REFERENCES menu_item(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS refund (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pesanan_id INTEGER NOT NULL,
    pesanan_item_id INTEGER,
    nominal INTEGER NOT NULL,
    alasan TEXT,                     -- misal "Mendoan habis setelah bayar, dibatalkan"
    metode TEXT DEFAULT 'belum_ditentukan', -- 'tunai' | 'qris' | 'belum_ditentukan'
    sudah_diproses INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pesanan_id) REFERENCES pesanan(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// ---------- MIGRASI KOLOM BARU ----------
function tambahKolomJikaBelum(tabel, kolom, definisi) {
  const ada = db.prepare(`PRAGMA table_info(${tabel})`).all().some((c) => c.name === kolom);
  if (!ada) db.exec(`ALTER TABLE ${tabel} ADD COLUMN ${kolom} ${definisi}`);
}
tambahKolomJikaBelum('pesanan', 'total_dibayar', 'INTEGER DEFAULT 0'); // nominal riil yang diterima (tanpa kode unik)
tambahKolomJikaBelum('pesanan', 'paid_at', 'TEXT');

// [Alur 3 fase] Kelompok kategori: 'berat' | 'camilan' | 'kopi' | 'non_kopi' (kopi & non_kopi = fase minuman)
tambahKolomJikaBelum('kategori', 'kelompok', 'TEXT');
const KELOMPOK_DEFAULT = {
  soto_sop: 'berat', nasi_mie: 'berat', tongseng_gulai: 'berat', sate_bakar: 'berat',
  gorengan: 'camilan', rebusan_kukus: 'camilan', cimplung: 'camilan',
  espresso_based: 'kopi', manual_brew: 'kopi', flavored_coffee: 'kopi',
  non_coffee: 'non_kopi', flavored_tea: 'non_kopi', tradisional: 'non_kopi',
  refreshments: 'non_kopi', jus_teh_air: 'non_kopi',
};
// Backfill kategori lama supaya tidak wajib seed ulang
for (const [id, kelompok] of Object.entries(KELOMPOK_DEFAULT)) {
  db.prepare('UPDATE kategori SET kelompok = ? WHERE id = ? AND kelompok IS NULL').run(kelompok, id);
}

// [Alur 3 fase] State alur per customer
tambahKolomJikaBelum('customers', 'jalur', 'TEXT');                    // 'berat' | 'camilan' | NULL
tambahKolomJikaBelum('customers', 'fase_selesai', 'TEXT');             // JSON array: ['camilan','minuman',...]
tambahKolomJikaBelum('customers', 'alur_tutup', 'INTEGER DEFAULT 0');  // 1 = sudah bayar, pesanan berikutnya tanpa fase
tambahKolomJikaBelum('customers', 'alur_updated_at', 'TEXT');

// Backfill pesanan lama yang sudah SELESAI (aman dijalankan berulang)
db.exec(`
  UPDATE pesanan SET total_dibayar = COALESCE(subtotal, 0), paid_at = updated_at
  WHERE status = 'SELESAI' AND paid_at IS NULL
`);

// [#2] State pending (klarifikasi/pilihan) disimpan di DB supaya tidak hilang saat restart
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_state (
    jid TEXT NOT NULL,
    jenis TEXT NOT NULL,              -- 'klarifikasi' | 'pilihan'
    data TEXT NOT NULL,               -- JSON
    updated_at TEXT NOT NULL,
    PRIMARY KEY (jid, jenis)
  )
`);

// [#7b] Tagihan tambahan (kurang bayar akibat ganti menu lebih mahal)
db.exec(`
  CREATE TABLE IF NOT EXISTS tagihan_tambahan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pesanan_id INTEGER NOT NULL,
    pesanan_item_id INTEGER,
    nominal INTEGER NOT NULL,
    kode_unik INTEGER,
    nominal_transfer INTEGER,
    status TEXT DEFAULT 'MENUNGGU_KONFIRMASI', -- MENUNGGU_KONFIRMASI -> MENUNGGU_BAYAR -> LUNAS | BATAL
    alasan TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pesanan_id) REFERENCES pesanan(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS info_resto (
    kunci TEXT PRIMARY KEY,           -- 'restoran' | 'aturan_layanan' | 'catatan_alergen' | 'versi_data'
    nilai TEXT NOT NULL,              -- JSON
    updated_at TEXT
  )
`);

function setupOperatorUtama() {
  const jidUtama = process.env.OPERATOR_JID;
  if (!jidUtama) {
    console.log('⚠️  OPERATOR_JID belum di-set di .env!');
    return;
  }
  const sudahAda = db.prepare('SELECT jid FROM operators WHERE jid = ?').get(jidUtama);
  if (!sudahAda) {
    db.prepare('INSERT INTO operators (jid, is_utama) VALUES (?, 1)').run(jidUtama);
    console.log(`✅ Operator utama (kasir) terdaftar: ${jidUtama}`);
  }
}
setupOperatorUtama();

// ========== OPERATOR / KASIR ==========

function isOperator(jid) {
  return !!db.prepare('SELECT jid FROM operators WHERE jid = ?').get(jid);
}

function isOperatorUtama(jid) {
  const row = db.prepare('SELECT is_utama FROM operators WHERE jid = ?').get(jid);
  return !!row && row.is_utama === 1;
}

function tambahOperator(jid, nama = null) {
  const sudahAda = db.prepare('SELECT jid FROM operators WHERE jid = ?').get(jid);
  if (sudahAda) return false;
  db.prepare('INSERT INTO operators (jid, nama, is_utama) VALUES (?, ?, 0)').run(jid, nama);
  return true;
}

function hapusOperator(jid) {
  const row = db.prepare('SELECT is_utama FROM operators WHERE jid = ?').get(jid);
  if (!row || row.is_utama === 1) return false;
  db.prepare('DELETE FROM operators WHERE jid = ?').run(jid);
  return true;
}

function getAllOperators() {
  return db.prepare('SELECT * FROM operators').all();
}

// ========== CUSTOMER ==========

function getOrCreateCustomer(jid) {
  let customer = db.prepare('SELECT * FROM customers WHERE jid = ?').get(jid);
  if (!customer) {
    db.prepare('INSERT INTO customers (jid) VALUES (?)').run(jid);
    customer = db.prepare('SELECT * FROM customers WHERE jid = ?').get(jid);
  }
  return customer;
}

function getCustomer(jid) {
  return getOrCreateCustomer(jid);
}

function isCustomerRegistered(jid) {
  return getOrCreateCustomer(jid).is_registered === 1;
}

function registerCustomer(jid) {
  getOrCreateCustomer(jid);
  db.prepare('UPDATE customers SET is_registered = 1 WHERE jid = ?').run(jid);
}

function setCustomerNama(jid, nama) {
  getOrCreateCustomer(jid);
  db.prepare('UPDATE customers SET nama = ? WHERE jid = ?').run(nama, jid);
}

// "Meja 05" / "meja 5" / " 5 " -> "5"; "a3" -> "A3"
function normalisasiMeja(nomor) {
  if (nomor === null || nomor === undefined) return null;
  const n = String(nomor).trim().toUpperCase().replace(/^MEJA\s*/, '').replace(/\s+/g, '').replace(/^0+(?=\d)/, '');
  return n || null;
}

// Customer lain yang sedang menempati meja ini (kunci meja per orang)
function getPemakaiMeja(nomorMeja, kecualiJid = null) {
  return db.prepare(`
    SELECT * FROM customers
    WHERE nomor_meja = ? AND status_kedatangan = 'DI_RESTO' AND jid != ?
  `).get(normalisasiMeja(nomorMeja), kecualiJid ?? '');
}

function getCustomerDiMeja(nomorMeja) {
  return db.prepare(`
    SELECT * FROM customers WHERE nomor_meja = ? AND status_kedatangan = 'DI_RESTO'
  `).all(normalisasiMeja(nomorMeja));
}

// Kosongkan meja customer + reset alur fase (kunjungan berikutnya mulai dari awal)
function kosongkanMejaCustomer(jid) {
  db.prepare(`
    UPDATE customers SET nomor_meja = NULL, status_kedatangan = 'BELUM_SAMPAI' WHERE jid = ?
  `).run(jid);
  resetAlur(jid);
}

// ---------- ALUR 3 FASE ----------
function hariIniLokal(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleDateString('en-CA');
}

function getAlur(jid) {
  const c = getOrCreateCustomer(jid);
  // State dari hari sebelumnya dianggap kunjungan lama -> mulai dari awal
  if (c.alur_updated_at && hariIniLokal(c.alur_updated_at) !== hariIniLokal()) {
    resetAlur(jid);
    return { jalur: null, selesai: [], tutup: false };
  }
  let selesai = [];
  try { selesai = c.fase_selesai ? JSON.parse(c.fase_selesai) : []; } catch { selesai = []; }
  return { jalur: c.jalur || null, selesai, tutup: !!c.alur_tutup };
}

function setAlur(jid, { jalur, selesai, tutup }) {
  getOrCreateCustomer(jid);
  db.prepare(`
    UPDATE customers SET jalur = ?, fase_selesai = ?, alur_tutup = ?, alur_updated_at = ? WHERE jid = ?
  `).run(jalur ?? null, JSON.stringify(selesai || []), tutup ? 1 : 0, new Date().toISOString(), jid);
}

function resetAlur(jid) {
  db.prepare(`
    UPDATE customers SET jalur = NULL, fase_selesai = NULL, alur_tutup = 0, alur_updated_at = NULL WHERE jid = ?
  `).run(jid);
}

function setNomorMeja(jid, nomorMeja) {
  getOrCreateCustomer(jid);
  nomorMeja = normalisasiMeja(nomorMeja);
  db.prepare(`
    UPDATE customers SET nomor_meja = ?, status_kedatangan = 'DI_RESTO' WHERE jid = ?
  `).run(nomorMeja, jid);

  // Order aktif yang masih berjalan ikut di-update nomor mejanya
  db.prepare(`
    UPDATE pesanan SET nomor_meja = ?
    WHERE customer_jid = ? AND status NOT IN ('SELESAI', 'DIBATALKAN')
  `).run(nomorMeja, jid);
}

function getAllRegisteredCustomers() {
  return db.prepare('SELECT * FROM customers WHERE is_registered = 1').all();
}

function cariCustomer(kataKunci) {
  const pola = `%${kataKunci}%`;
  return db.prepare(`
    SELECT * FROM customers
    WHERE is_registered = 1 AND (nama LIKE ? OR nomor_meja LIKE ?)
    ORDER BY created_at DESC LIMIT 10
  `).all(pola, pola);
}

function setStatusCs(jid, status) {
  getOrCreateCustomer(jid);
  const eskalasiAt = status === 'ESKALASI' ? new Date().toISOString() : null;
  db.prepare('UPDATE customers SET status_cs = ?, eskalasi_at = ? WHERE jid = ?').run(status, eskalasiAt, jid);
}

function getStatusCs(jid) {
  return getOrCreateCustomer(jid).status_cs || 'BOT';
}

function getAllCustomerEskalasi() {
  return db.prepare(`SELECT * FROM customers WHERE status_cs = 'ESKALASI' ORDER BY eskalasi_at ASC`).all();
}

// ========== MENU ==========

// ---------- helper: parse field JSON dari kolom menu_item/menu_pilihan ----------
function parseMenuRow(row) {
  if (!row) return row;
  return {
    ...row,
    alias: row.alias ? JSON.parse(row.alias) : [],
    alergen: row.alergen ? JSON.parse(row.alergen) : [],
    suhu: row.suhu ? JSON.parse(row.suhu) : null,
    isi: row.isi ? JSON.parse(row.isi) : null,
    andalan: !!row.andalan,
    tersedia: !!row.tersedia,
    foto_perlu_cek: !!row.foto_perlu_cek,
  };
}

function lampirkanVarianDanPilihan(menu) {
  menu.varian = db.prepare('SELECT * FROM menu_varian WHERE menu_id = ?').all(menu.id);
  menu.pilihan = db.prepare('SELECT * FROM menu_pilihan WHERE menu_id = ?').all(menu.id)
    .map((p) => ({ ...p, opsi: JSON.parse(p.opsi), wajib: !!p.wajib }));
  return menu;
}

// ---------- KATEGORI ----------

function upsertKategori({ id, nama, jenis, urutan, foto_path, foto_ilustrasi, kartu_path, kelompok }) {
  // kelompok dari menu.json kalau ada, kalau tidak pakai mapping default
  const kel = kelompok ?? KELOMPOK_DEFAULT[id] ?? (jenis === 'minuman' ? 'non_kopi' : 'camilan');
  const existing = db.prepare('SELECT id FROM kategori WHERE id = ?').get(id);
  if (existing) {
    db.prepare(`
      UPDATE kategori SET nama = ?, jenis = ?, urutan = ?, foto_path = ?, foto_ilustrasi = ?, kartu_path = ?, kelompok = ?
      WHERE id = ?
    `).run(nama, jenis ?? null, urutan ?? 0, foto_path ?? null, foto_ilustrasi ? 1 : 0, kartu_path ?? null, kel, id);
  } else {
    db.prepare(`
      INSERT INTO kategori (id, nama, jenis, urutan, foto_path, foto_ilustrasi, kartu_path, kelompok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, nama, jenis ?? null, urutan ?? 0, foto_path ?? null, foto_ilustrasi ? 1 : 0, kartu_path ?? null, kel);
  }
}

// kelompok: 'berat' | 'camilan' | 'kopi' | 'non_kopi' | 'minuman' (= kopi + non_kopi)
function getKategoriByKelompok(kelompok) {
  const daftar = kelompok === 'minuman' ? ['kopi', 'non_kopi'] : [kelompok];
  return getAllKategori().filter((k) => daftar.includes(k.kelompok));
}

function getAllKategori() {
  return db.prepare('SELECT * FROM kategori ORDER BY urutan').all();
}

function getKategoriById(id) {
  return db.prepare('SELECT * FROM kategori WHERE id = ?').get(id);
}

// ---------- MENU ----------

function upsertMenu({
  id, nama, jenis, kategori_id, deskripsi, deskripsi_sumber,
  alias, alergen, suhu, isi, andalan, tersedia,
  foto_path, foto_perlu_cek, kartu_path, catatan,
}) {
  const existing = db.prepare('SELECT id FROM menu_item WHERE id = ?').get(id);
  const now = new Date().toISOString();

  const params = {
    id, nama, jenis: jenis ?? null, kategori_id: kategori_id ?? null,
    deskripsi: deskripsi ?? null, deskripsi_sumber: deskripsi_sumber ?? null,
    alias: JSON.stringify(alias ?? []), alergen: JSON.stringify(alergen ?? []),
    suhu: suhu ? JSON.stringify(suhu) : null, isi: isi ? JSON.stringify(isi) : null,
    andalan: andalan ? 1 : 0, tersedia: tersedia === false ? 0 : 1,
    foto_path: foto_path ?? null, foto_perlu_cek: foto_perlu_cek ? 1 : 0,
    kartu_path: kartu_path ?? null, catatan: catatan ?? null, updated_at: now,
  };

  if (existing) {
    db.prepare(`
      UPDATE menu_item SET
        nama=@nama, jenis=@jenis, kategori_id=@kategori_id, deskripsi=@deskripsi,
        deskripsi_sumber=@deskripsi_sumber, alias=@alias, alergen=@alergen, suhu=@suhu, isi=@isi,
        andalan=@andalan, tersedia=@tersedia, foto_path=@foto_path, foto_perlu_cek=@foto_perlu_cek,
        kartu_path=@kartu_path, catatan=@catatan, updated_at=@updated_at
      WHERE id=@id
    `).run(params);
  } else {
    db.prepare(`
      INSERT INTO menu_item
        (id, nama, jenis, kategori_id, deskripsi, deskripsi_sumber, alias, alergen, suhu, isi,
         andalan, tersedia, foto_path, foto_perlu_cek, kartu_path, catatan, updated_at)
      VALUES
        (@id, @nama, @jenis, @kategori_id, @deskripsi, @deskripsi_sumber, @alias, @alergen, @suhu, @isi,
         @andalan, @tersedia, @foto_path, @foto_perlu_cek, @kartu_path, @catatan, @updated_at)
    `).run(params);
  }
  return id;
}

function upsertVarian({ sku, menu_id, label, harga, nama_di_menu }) {
  const existing = db.prepare('SELECT id FROM menu_varian WHERE sku = ?').get(sku);
  if (existing) {
    db.prepare(`UPDATE menu_varian SET menu_id=?, label=?, harga=?, nama_di_menu=? WHERE sku=?`)
      .run(menu_id, label ?? null, harga, nama_di_menu ?? null, sku);
  } else {
    db.prepare(`
      INSERT INTO menu_varian (menu_id, sku, label, harga, nama_di_menu) VALUES (?, ?, ?, ?, ?)
    `).run(menu_id, sku, label ?? null, harga, nama_di_menu ?? null);
  }
}

function upsertPilihan({ menu_id, nama, opsi, wajib, default_opsi, biaya_tambahan }) {
  db.prepare('DELETE FROM menu_pilihan WHERE menu_id = ? AND nama = ?').run(menu_id, nama);
  db.prepare(`
    INSERT INTO menu_pilihan (menu_id, nama, opsi, wajib, default_opsi, biaya_tambahan)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(menu_id, nama, JSON.stringify(opsi ?? []), wajib ? 1 : 0, default_opsi ?? null, biaya_tambahan ?? 0);
}

function getAllMenu() {
  const rows = db.prepare(`
    SELECT m.*, k.nama as kategori_nama FROM menu_item m
    LEFT JOIN kategori k ON k.id = m.kategori_id
    ORDER BY k.urutan, m.nama
  `).all();
  return rows.map((r) => lampirkanVarianDanPilihan(parseMenuRow(r)));
}

function getMenuTersedia() {
  const rows = db.prepare(`
    SELECT m.*, k.nama as kategori_nama FROM menu_item m
    LEFT JOIN kategori k ON k.id = m.kategori_id
    WHERE m.tersedia = 1
    ORDER BY k.urutan, m.nama
  `).all();
  return rows.map((r) => lampirkanVarianDanPilihan(parseMenuRow(r)));
}

function getMenuById(id) {
  const row = db.prepare(`
    SELECT m.*, k.nama as kategori_nama FROM menu_item m
    LEFT JOIN kategori k ON k.id = m.kategori_id
    WHERE m.id = ?
  `).get(id);
  return row ? lampirkanVarianDanPilihan(parseMenuRow(row)) : null;
}

function getVarianBySku(sku) {
  return db.prepare('SELECT * FROM menu_varian WHERE sku = ?').get(sku);
}

function setMenuTersedia(id, tersedia) {
  db.prepare('UPDATE menu_item SET tersedia = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(tersedia ? 1 : 0, id);
}

// ========== PESANAN ==========

function buatPesananBaru(customerJid, nomorMeja) {
  const result = db.prepare(`
    INSERT INTO pesanan (customer_jid, nomor_meja, status) VALUES (?, ?, 'DRAFT_MENUNGGU_KONFIRMASI')
  `).run(customerJid, nomorMeja ?? null);
  return result.lastInsertRowid;
}

function tambahItemPesanan(pesananId, item) {
  const hasil = db.prepare(`
    INSERT INTO pesanan_item
      (pesanan_id, menu_id, varian_sku, nama_snapshot, qty, harga_satuan_snapshot, pilihan_terpilih, catatan)
    VALUES
      (@pesanan_id, @menu_id, @varian_sku, @nama_snapshot, @qty, @harga_satuan_snapshot, @pilihan_terpilih, @catatan)
  `).run({
    pesanan_id: pesananId,
    varian_sku: item.varian_sku ?? null,
    pilihan_terpilih: item.pilihan_terpilih ?? null,
    ...item,
  });
  return hasil.lastInsertRowid;
}

function setQtyItemPesanan(itemId, qty) {
  db.prepare('UPDATE pesanan_item SET qty = ? WHERE id = ?').run(qty, itemId);
}

function getPesananById(id) {
  return db.prepare('SELECT * FROM pesanan WHERE id = ?').get(id);
}

function getItemsByPesananId(pesananId) {
  return db.prepare('SELECT * FROM pesanan_item WHERE pesanan_id = ?').all(pesananId);
}
function getDraftAtauMenungguBayarByCustomer(customerJid) {
  return db.prepare(`
    SELECT * FROM pesanan
    WHERE customer_jid = ? AND status IN ('DRAFT_MENUNGGU_KONFIRMASI', 'MENUNGGU_BAYAR')
    ORDER BY created_at DESC LIMIT 1
  `).get(customerJid);
}

function hapusItemPesanan(pesananId) {
  db.prepare('DELETE FROM pesanan_item WHERE pesanan_id = ?').run(pesananId);
}

function setStatusPesanan(id, status) {
  db.prepare(`UPDATE pesanan SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, id);
}

function setHargaFixPesanan(id, subtotal) {
  db.prepare(`UPDATE pesanan SET subtotal = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(subtotal, id);
}

// [#4] Lunas = status SELESAI + kunci nominal yang diterima (omzet tidak ikut berubah saat subtotal dihitung ulang)
function setPesananLunas(id) {
  db.prepare(`
    UPDATE pesanan
    SET status = 'SELESAI', total_dibayar = COALESCE(subtotal, 0),
        paid_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

// ---------- [#7b] TAGIHAN TAMBAHAN ----------
function buatTagihanTambahan({ pesanan_id, pesanan_item_id, nominal, alasan }) {
  // Kalau sudah ada tagihan yang belum dikirimi QR untuk pesanan ini, gabungkan nominalnya
  const existing = db.prepare(`
    SELECT id FROM tagihan_tambahan WHERE pesanan_id = ? AND status = 'MENUNGGU_KONFIRMASI'
  `).get(pesanan_id);
  if (existing) {
    db.prepare(`UPDATE tagihan_tambahan SET nominal = nominal + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(nominal, existing.id);
    return existing.id;
  }
  return db.prepare(`
    INSERT INTO tagihan_tambahan (pesanan_id, pesanan_item_id, nominal, alasan) VALUES (?, ?, ?, ?)
  `).run(pesanan_id, pesanan_item_id ?? null, nominal, alasan ?? null).lastInsertRowid;
}

function getTagihanById(id) {
  return db.prepare('SELECT * FROM tagihan_tambahan WHERE id = ?').get(id);
}

function getTagihanBelumLunasByCustomer(customerJid) {
  return db.prepare(`
    SELECT t.* FROM tagihan_tambahan t
    JOIN pesanan p ON p.id = t.pesanan_id
    WHERE p.customer_jid = ? AND t.status IN ('MENUNGGU_KONFIRMASI', 'MENUNGGU_BAYAR')
    ORDER BY t.created_at DESC LIMIT 1
  `).get(customerJid);
}

function getTagihanMenungguBayar() {
  return db.prepare(`
    SELECT t.*, p.customer_jid, COALESCE(p.nomor_meja, c.nomor_meja) AS meja, c.nama
    FROM tagihan_tambahan t
    JOIN pesanan p ON p.id = t.pesanan_id
    JOIN customers c ON c.jid = p.customer_jid
    WHERE t.status = 'MENUNGGU_BAYAR'
    ORDER BY t.created_at ASC
  `).all();
}

function setTagihanMenungguBayar(id, kodeUnik, nominalTransfer) {
  db.prepare(`
    UPDATE tagihan_tambahan
    SET kode_unik = ?, nominal_transfer = ?, status = 'MENUNGGU_BAYAR', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(kodeUnik, nominalTransfer, id);
}

function setTagihanLunas(id) {
  const t = getTagihanById(id);
  db.prepare(`UPDATE tagihan_tambahan SET status = 'LUNAS', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  db.prepare(`UPDATE pesanan SET total_dibayar = COALESCE(total_dibayar, 0) + ? WHERE id = ?`).run(t.nominal, t.pesanan_id);
}

function setKodeUnikDanNominal(id, kodeUnik, nominalTransfer) {
  db.prepare(`UPDATE pesanan SET kode_unik = ?, nominal_transfer = ? WHERE id = ?`).run(kodeUnik, nominalTransfer, id);
}

// Kode unik 1-99: hindari kode yang sudah dipakai hari ini (pesanan + tagihan tambahan).
// Kalau 1-99 habis, cadangan: hindari yang masih MENUNGGU_BAYAR saja (lalu lanjut sampai 999).
function getNextKodeUnikHarian(excludePesananId = null) {
  const exclude = excludePesananId ?? -1;
  const ambil = (rows) => rows.map((r) => r.kode_unik);

  const terpakaiHariIni = new Set([
    ...ambil(db.prepare(`
      SELECT kode_unik FROM pesanan
      WHERE kode_unik IS NOT NULL AND status != 'DIBATALKAN' AND id != ?
        AND date(created_at, 'localtime') = date('now', 'localtime')
    `).all(exclude)),
    ...ambil(db.prepare(`
      SELECT kode_unik FROM tagihan_tambahan
      WHERE kode_unik IS NOT NULL AND status != 'BATAL'
        AND date(created_at, 'localtime') = date('now', 'localtime')
    `).all()),
  ]);

  const sedangMenunggu = new Set([
    ...ambil(db.prepare(`
      SELECT kode_unik FROM pesanan
      WHERE kode_unik IS NOT NULL AND status = 'MENUNGGU_BAYAR' AND id != ?
    `).all(exclude)),
    ...ambil(db.prepare(`
      SELECT kode_unik FROM tagihan_tambahan
      WHERE kode_unik IS NOT NULL AND status = 'MENUNGGU_BAYAR'
    `).all()),
  ]);

  for (let k = 1; k <= 99; k++) if (!terpakaiHariIni.has(k)) return k;
  for (let k = 1; k <= 999; k++) if (!sedangMenunggu.has(k)) return k;
  return 1;
}

function getPesananAktifByCustomer(customerJid) {
  return db.prepare(`
    SELECT * FROM pesanan WHERE customer_jid = ? AND status NOT IN ('SELESAI', 'DIBATALKAN')
    ORDER BY created_at DESC
  `).all(customerJid);
}

function getPesananMenungguBayar() {
  return db.prepare(`
    SELECT p.*, c.nama, c.nomor_meja as nomor_meja_customer FROM pesanan p
    JOIN customers c ON c.jid = p.customer_jid
    WHERE p.status = 'MENUNGGU_BAYAR'
    ORDER BY p.created_at ASC
  `).all();
}

function getPesananAktifSemua() {
  return db.prepare(`
    SELECT p.*, c.nama FROM pesanan p
    JOIN customers c ON c.jid = p.customer_jid
    WHERE p.status NOT IN ('SELESAI', 'DIBATALKAN')
    ORDER BY p.created_at ASC
  `).all();
}

function hapusPesanan(pesananId) {
  db.prepare('DELETE FROM pesanan_item WHERE pesanan_id = ?').run(pesananId);
  const result = db.prepare('DELETE FROM pesanan WHERE id = ?').run(pesananId);
  return result.changes > 0;
}

function hapusSemuaPesanan() {
  db.prepare('DELETE FROM pesanan_item').run();
  const result = db.prepare('DELETE FROM pesanan').run();
  return result.changes;
}

function setStatusItemPesanan(itemId, statusItem, extra = {}) {
  const fields = ['status_item = ?'];
  const params = [statusItem];

  if (extra.item_pengganti_id !== undefined) {
    fields.push('item_pengganti_id = ?');
    params.push(extra.item_pengganti_id);
  }
  if (extra.habis_dilaporkan_at !== undefined) {
    fields.push('habis_dilaporkan_at = ?');
    params.push(extra.habis_dilaporkan_at);
  }

  params.push(itemId);
  db.prepare(`UPDATE pesanan_item SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

function getItemPesananById(itemId) {
  return db.prepare('SELECT * FROM pesanan_item WHERE id = ?').get(itemId);
}

function getItemMenungguKeputusanHabis() {
  return db.prepare(`
    SELECT pi.*, p.customer_jid, p.nomor_meja, p.status as status_pesanan
    FROM pesanan_item pi
    JOIN pesanan p ON p.id = pi.pesanan_id
    WHERE pi.status_item = 'MENUNGGU_KEPUTUSAN_HABIS'
    ORDER BY pi.habis_dilaporkan_at ASC
  `).all();
}

function getItemMenungguKeputusanHabisByCustomer(customerJid) {
  return db.prepare(`
    SELECT pi.* FROM pesanan_item pi
    JOIN pesanan p ON p.id = pi.pesanan_id
    WHERE p.customer_jid = ? AND pi.status_item = 'MENUNGGU_KEPUTUSAN_HABIS'
    ORDER BY pi.habis_dilaporkan_at ASC
  `).all(customerJid);
}

function catatRefund({ pesanan_id, pesanan_item_id, nominal, alasan, metode }) {
  const result = db.prepare(`
    INSERT INTO refund (pesanan_id, pesanan_item_id, nominal, alasan, metode)
    VALUES (?, ?, ?, ?, ?)
  `).run(pesanan_id, pesanan_item_id ?? null, nominal, alasan ?? null, metode ?? 'belum_ditentukan');
  return result.lastInsertRowid;
}

function getRefundByPesanan(pesananId) {
  return db.prepare('SELECT * FROM refund WHERE pesanan_id = ?').all(pesananId);
}

function tandaiRefundDiproses(refundId) {
  db.prepare('UPDATE refund SET sudah_diproses = 1 WHERE id = ?').run(refundId);
}

// Update ulang subtotal pesanan berdasar item yang masih AKTIF (dipanggil setelah ada item dibatalkan/diganti)
function hitungUlangSubtotalAktif(pesananId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(harga_satuan_snapshot * qty), 0) as total
    FROM pesanan_item WHERE pesanan_id = ? AND status_item = 'AKTIF'
  `).get(pesananId);
  db.prepare('UPDATE pesanan SET subtotal = ? WHERE id = ?').run(row.total, pesananId);
  return row.total;
}

function getStatistikHarian() {
  const hariIni = `date('now', 'localtime')`;

  const jumlahPerStatus = db.prepare(`
    SELECT status, COUNT(*) as jumlah FROM pesanan
    WHERE date(created_at, 'localtime') = ${hariIni}
    GROUP BY status
  `).all();

  const omzetKotor = db.prepare(`
    SELECT COALESCE(SUM(total_dibayar), 0) as total FROM pesanan
    WHERE paid_at IS NOT NULL AND date(paid_at, 'localtime') = ${hariIni}
  `).get().total;

  const totalRefund = db.prepare(`
    SELECT COALESCE(SUM(nominal), 0) as total FROM refund
    WHERE date(created_at, 'localtime') = ${hariIni}
  `).get().total;

  const menuTerlaris = db.prepare(`
    SELECT pi.nama_snapshot, COUNT(*) as jumlah_order, SUM(pi.qty) as total_qty
    FROM pesanan_item pi
    JOIN pesanan p ON p.id = pi.pesanan_id
    WHERE pi.status_item = 'AKTIF'
      AND p.status IN ('MENUNGGU_BAYAR', 'SELESAI')
      AND date(p.created_at, 'localtime') = ${hariIni}
    GROUP BY pi.nama_snapshot
    ORDER BY jumlah_order DESC LIMIT 5
  `).all();

  return {
    jumlah_per_status: jumlahPerStatus,
    omzet_kotor: omzetKotor,
    total_refund: totalRefund,
    omzet_bersih: omzetKotor - totalRefund,
    menu_terlaris: menuTerlaris,
  };
}

// ========== INFO RESTO ==========
function setInfoResto(kunci, nilai) {
  db.prepare(`
    INSERT INTO info_resto (kunci, nilai, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(kunci) DO UPDATE SET nilai = excluded.nilai, updated_at = excluded.updated_at
  `).run(kunci, JSON.stringify(nilai ?? null), new Date().toISOString());
}

function getInfoResto(kunci) {
  const row = db.prepare('SELECT nilai FROM info_resto WHERE kunci = ?').get(kunci);
  if (!row) return null;
  try { return JSON.parse(row.nilai); } catch { return null; }
}

// Pesanan customer yang relevan untuk ditanyakan statusnya: dibuat hari ini (termasuk yang sudah lunas),
// ditambah yang masih draft/menunggu bayar walau dibuat kemarin. Yang DIBATALKAN tidak ikut.
function getPesananHariIniByCustomer(customerJid) {
  return db.prepare(`
    SELECT * FROM pesanan
    WHERE customer_jid = ? AND status != 'DIBATALKAN'
      AND (
        date(created_at, 'localtime') = date('now', 'localtime')
        OR status IN ('DRAFT_MENUNGGU_KONFIRMASI', 'MENUNGGU_BAYAR')
      )
    ORDER BY id DESC
  `).all(customerJid);
}

// ========== CHAT HISTORY ==========

// ========== PENDING STATE (klarifikasi/pilihan) ==========
const PENDING_TTL_MS = 30 * 60 * 1000; // kadaluarsa 30 menit

function setPendingState(jid, jenis, data) {
  db.prepare(`
    INSERT INTO pending_state (jid, jenis, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(jid, jenis) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(jid, jenis, JSON.stringify(data), new Date().toISOString());
}

function getPendingState(jid, jenis) {
  const row = db.prepare('SELECT data, updated_at FROM pending_state WHERE jid = ? AND jenis = ?').get(jid, jenis);
  if (!row) return null;
  if (Date.now() - new Date(row.updated_at).getTime() > PENDING_TTL_MS) {
    clearPendingState(jid, jenis);
    return null;
  }
  try { return JSON.parse(row.data); } catch { return null; }
}

function clearPendingState(jid, jenis) {
  db.prepare('DELETE FROM pending_state WHERE jid = ? AND jenis = ?').run(jid, jenis);
}

const MAX_HISTORI_PER_JID = 20;

function simpanChatHistory(jid, role, content) {
  db.prepare('INSERT INTO chat_history (jid, role, content) VALUES (?, ?, ?)').run(jid, role, content);
  const total = db.prepare('SELECT COUNT(*) as c FROM chat_history WHERE jid = ?').get(jid).c;
  if (total > MAX_HISTORI_PER_JID) {
    db.prepare(`
      DELETE FROM chat_history WHERE id IN (
        SELECT id FROM chat_history WHERE jid = ? ORDER BY id ASC LIMIT ?
      )
    `).run(jid, total - MAX_HISTORI_PER_JID);
  }
}

function getChatHistory(jid, limit = MAX_HISTORI_PER_JID) {
  const rows = db.prepare(`
    SELECT role, content FROM (
      SELECT id, role, content FROM chat_history WHERE jid = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `).all(jid, limit);
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

module.exports = {
  db,
  isOperator, isOperatorUtama, tambahOperator, hapusOperator, getAllOperators,
  getOrCreateCustomer, getCustomer, isCustomerRegistered, registerCustomer,
  setCustomerNama, setNomorMeja, getAllRegisteredCustomers, cariCustomer,
  normalisasiMeja, getPemakaiMeja, getCustomerDiMeja, kosongkanMejaCustomer,
  getAlur, setAlur, resetAlur, getKategoriByKelompok, setQtyItemPesanan,
  setStatusCs, getStatusCs, getAllCustomerEskalasi,
  upsertKategori, getAllKategori, getKategoriById,
  upsertMenu, upsertVarian, upsertPilihan,
  getAllMenu, getMenuTersedia, getMenuById, getVarianBySku, setMenuTersedia,
  buatPesananBaru, tambahItemPesanan, getPesananById, getItemsByPesananId,
  getDraftAtauMenungguBayarByCustomer, hapusItemPesanan, setStatusPesanan, setHargaFixPesanan,
  setKodeUnikDanNominal, getNextKodeUnikHarian, getPesananAktifByCustomer,
  getPesananMenungguBayar, getPesananAktifSemua, getStatistikHarian,
  hapusPesanan, hapusSemuaPesanan,
  setStatusItemPesanan, getItemPesananById, getItemMenungguKeputusanHabis,
  getItemMenungguKeputusanHabisByCustomer, catatRefund, getRefundByPesanan,
  tandaiRefundDiproses, hitungUlangSubtotalAktif,
  simpanChatHistory, getChatHistory,
  setPendingState, getPendingState, clearPendingState,
  setPesananLunas,
  buatTagihanTambahan, getTagihanById, getTagihanBelumLunasByCustomer,
  getTagihanMenungguBayar, setTagihanMenungguBayar, setTagihanLunas,
  setInfoResto, getInfoResto, getPesananHariIniByCustomer,
};