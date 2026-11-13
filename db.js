const Database = require('better-sqlite3');
const path = require('path');
require('dotenv').config();

const db = new Database(path.join(__dirname, 'resto-bot.db'));

// ========== SKEMA ==========

db.exec(`
  CREATE TABLE IF NOT EXISTS menu_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nama TEXT NOT NULL UNIQUE,
    kategori TEXT,
    deskripsi TEXT,          -- konteks bebas: bahan, level pedas, allergen, dll. Dipakai AI buat jawab Q&A
    harga INTEGER NOT NULL,
    status TEXT DEFAULT 'tersedia',  -- 'tersedia' | 'habis'
    foto_path TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
    menu_id INTEGER,
    nama_snapshot TEXT NOT NULL,
    qty INTEGER NOT NULL,
    harga_satuan_snapshot INTEGER,
    catatan TEXT,              -- note bebas: "pedas level 1", "no bawang"
    FOREIGN KEY (pesanan_id) REFERENCES pesanan(id),
    FOREIGN KEY (menu_id) REFERENCES menu_item(id)
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

function setNomorMeja(jid, nomorMeja) {
  getOrCreateCustomer(jid);
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

function upsertMenu({ nama, kategori, deskripsi, harga, status, foto_path }) {
  const existing = db.prepare('SELECT * FROM menu_item WHERE nama = ?').get(nama);
  const now = new Date().toISOString();

  if (existing) {
    db.prepare(`
      UPDATE menu_item SET
        kategori = COALESCE(?, kategori),
        deskripsi = COALESCE(?, deskripsi),
        harga = COALESCE(?, harga),
        status = COALESCE(?, status),
        foto_path = COALESCE(?, foto_path),
        updated_at = ?
      WHERE nama = ?
    `).run(kategori ?? null, deskripsi ?? null, harga ?? null, status ?? null, foto_path ?? null, now, nama);
    return existing.id;
  }

  const result = db.prepare(`
    INSERT INTO menu_item (nama, kategori, deskripsi, harga, status, foto_path, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(nama, kategori ?? null, deskripsi ?? null, harga, status ?? 'tersedia', foto_path ?? null, now);
  return result.lastInsertRowid;
}

function getAllMenu() {
  return db.prepare('SELECT * FROM menu_item ORDER BY kategori, nama').all();
}

function getMenuTersedia() {
  return db.prepare(`SELECT * FROM menu_item WHERE status = 'tersedia' ORDER BY kategori, nama`).all();
}

function getMenuById(id) {
  return db.prepare('SELECT * FROM menu_item WHERE id = ?').get(id);
}

// ========== PESANAN ==========

function buatPesananBaru(customerJid, nomorMeja) {
  const result = db.prepare(`
    INSERT INTO pesanan (customer_jid, nomor_meja, status) VALUES (?, ?, 'DRAFT_MENUNGGU_KONFIRMASI')
  `).run(customerJid, nomorMeja ?? null);
  return result.lastInsertRowid;
}

function tambahItemPesanan(pesananId, item) {
  db.prepare(`
    INSERT INTO pesanan_item (pesanan_id, menu_id, nama_snapshot, qty, harga_satuan_snapshot, catatan)
    VALUES (@pesanan_id, @menu_id, @nama_snapshot, @qty, @harga_satuan_snapshot, @catatan)
  `).run({ pesanan_id: pesananId, ...item });
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

function setKodeUnikDanNominal(id, kodeUnik, nominalTransfer) {
  db.prepare(`UPDATE pesanan SET kode_unik = ?, nominal_transfer = ? WHERE id = ?`).run(kodeUnik, nominalTransfer, id);
}

function getNextKodeUnikHarian() {
  const row = db.prepare(`
    SELECT COUNT(*) as total FROM pesanan
    WHERE kode_unik IS NOT NULL AND date(created_at) = date('now', 'localtime')
  `).get();
  return row.total + 1;
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

function getStatistikHarian() {
  const jumlahPerStatus = db.prepare(`
    SELECT status, COUNT(*) as jumlah FROM pesanan
    WHERE date(created_at) = date('now', 'localtime')
    GROUP BY status
  `).all();

  const omzetHariIni = db.prepare(`
    SELECT COALESCE(SUM(subtotal), 0) as total FROM pesanan
    WHERE status = 'SELESAI' AND date(updated_at) = date('now', 'localtime')
  `).get();

  const menuTerlaris = db.prepare(`
    SELECT pi.nama_snapshot, COUNT(*) as jumlah_order, SUM(pi.qty) as total_qty
    FROM pesanan_item pi
    JOIN pesanan p ON p.id = pi.pesanan_id
    WHERE date(p.created_at) = date('now', 'localtime')
    GROUP BY pi.nama_snapshot
    ORDER BY jumlah_order DESC LIMIT 5
  `).all();

  return { jumlah_per_status: jumlahPerStatus, omzet_selesai_hari_ini: omzetHariIni.total, menu_terlaris: menuTerlaris };
}

// ========== CHAT HISTORY ==========

const MAX_HISTORI_PER_JID = 20;

function simpanChatHistory(jid, role, content) {
  db.prepare('INSERT INTO chat_history (jid, role, content) VALUES (?, ?, ?)').run(jid, role, content);
  const total = db.prepare('SELECT COUNT(*) as c FROM chat_history WHERE jid = ?').get(jid).c;
  if (total > MAX_HISTORI_PER_JID) {
    db.prepare(`
      DELETE FROM chat_history WHERE id IN (
        SELECT id FROM chat_history WHERE jid = ? ORDER BY created_at ASC LIMIT ?
      )
    `).run(jid, total - MAX_HISTORI_PER_JID);
  }
}

function getChatHistory(jid, limit = MAX_HISTORI_PER_JID) {
  const rows = db.prepare(`
    SELECT role, content FROM chat_history WHERE jid = ? ORDER BY created_at ASC LIMIT ?
  `).all(jid, limit);
  return rows.map((r) => ({ role: r.role, content: r.content }));
}

module.exports = {
  db,
  isOperator, isOperatorUtama, tambahOperator, hapusOperator, getAllOperators,
  getOrCreateCustomer, getCustomer, isCustomerRegistered, registerCustomer,
  setCustomerNama, setNomorMeja, getAllRegisteredCustomers, cariCustomer,
  setStatusCs, getStatusCs, getAllCustomerEskalasi,
  upsertMenu, getAllMenu, getMenuTersedia, getMenuById,
  buatPesananBaru, tambahItemPesanan, getPesananById, getItemsByPesananId,
  getDraftAtauMenungguBayarByCustomer, hapusItemPesanan, setStatusPesanan, setHargaFixPesanan,
  setKodeUnikDanNominal, getNextKodeUnikHarian, getPesananAktifByCustomer,
  getPesananMenungguBayar, getPesananAktifSemua, getStatistikHarian,
  hapusPesanan, hapusSemuaPesanan,
  simpanChatHistory, getChatHistory,
};