// Konfigurasi bisnis yang dibaca dari data_menu/info_resto.json (bisa diedit pemilik, tanpa restart):
// pajak, jam operasional + last order, info resto lengkap, live music, Ruang Meeting Cablaka, aturan reservasi, menu margin.
// Nomor official restoran dan rekening DP dibaca dari .env (RESTO_NOMOR_OFFICIAL, BOOKING_DP_BANK, BOOKING_DP_REKENING, BOOKING_DP_ATAS_NAMA).
const fs = require('fs');
const path = require('path');
const { ZONA_BOT, parseJam, formatJam, rp } = require('./format');

// File data dibaca dari data_menu/ (milik pemilik, diedit di VPS). Kalau belum ada di sana, dipakai salinan bawaan
// di data_default/ (ikut git), jadi fitur tidak diam-diam mati kalau file lupa dikirim ke VPS.
function jalurData(nama) {
  const utama = path.join(__dirname, 'data_menu', nama);
  if (fs.existsSync(utama)) return utama;
  return path.join(__dirname, 'data_default', nama);
}
const FILE_INFO = () => jalurData('info_resto.json');
const FILE_KUIS = () => jalurData('kuis.json');

const cache = new Map(); // path -> { mtime, data }

function bacaJson(file, cadangan) {
  try {
    const mtime = fs.statSync(file).mtimeMs;
    const lama = cache.get(file);
    if (lama && lama.mtime === mtime) return lama.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.set(file, { mtime, data });
    return data;
  } catch (err) {
    console.error(`⚠️  ${path.basename(file)} tidak terbaca: ${err.message}`);
    return cadangan;
  }
}

const INFO_CADANGAN = {
  nama_ai: 'Cimendo',
  nama_resto: 'The Banjoemas Resto & Cafe',
  pajak: { ppn_persen: 10 },
  jam_operasional: [
    { label: 'Minggu - Kamis', hari: [0, 1, 2, 3, 4], buka: '10:00', tutup: '23:00', last_order: '22:30' },
    { label: 'Jumat & Sabtu', hari: [5, 6], buka: '10:00', tutup: '24:00', last_order: '23:30' },
  ],
  menu_margin: [],
  timeout_meja_jam: 3,
  pengingat_qr_menit: 3,
};

function info() { return bacaJson(FILE_INFO(), INFO_CADANGAN); }
function kuis() { return bacaJson(FILE_KUIS(), { soal: [], soal_per_ronde: 5 }); }

// ---------- PAJAK ----------
function ppnPersen() { return Number(info().pajak?.ppn_persen ?? 10); }

// Subtotal (harga menu) -> { subtotal, ppn, grandTotal }. PPN dibulatkan ke rupiah terdekat (457.000 -> 45.700).
function hitungTagihan(subtotal) {
  const s = Number(subtotal) || 0;
  const ppn = Math.round((s * ppnPersen()) / 100);
  return { subtotal: s, ppn, grandTotal: s + ppn };
}

// Harga/selisih menu -> nominal yang benar-benar ditagih/dikembalikan ke customer (sudah + PPN)
function denganPpn(n) { return hitungTagihan(n).grandTotal; }

// ---------- JAM OPERASIONAL ----------
const HARI_PENDEK = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const NAMA_HARI = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

function hariDanMenit(d = new Date()) {
  const hari = HARI_PENDEK[d.toLocaleDateString('en-US', { timeZone: ZONA_BOT, weekday: 'short' })];
  const [h, m] = d.toLocaleTimeString('en-GB', { timeZone: ZONA_BOT, hour12: false, hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  return { hari, menit: (h % 24) * 60 + m };
}

// "24:00" -> 1440 (parseJam menolak jam 24)
function menitDariJam(teks) {
  if (String(teks).trim() === '24:00') return 1440;
  return parseJam(teks);
}

function jadwalHari(hari) {
  return (info().jam_operasional || []).find((j) => j.hari.includes(hari)) || null;
}

const fmtJam = (teks) => String(teks).replace(':', '.');

// Status buka untuk saat ini. bisaPesan = buka dan belum lewat last order.
// BOT_PAKSA_BUKA=1 di .env mematikan pembatasan (untuk uji coba di luar jam).
function statusBuka(d = new Date()) {
  const { hari, menit } = hariDanMenit(d);
  const j = jadwalHari(hari);
  if (!j) return { buka: false, bisaPesan: false, alasan: 'TUTUP', jadwal: null, hari, pesan: 'Hari ini resto tidak beroperasi.' };

  const buka = menitDariJam(j.buka);
  const tutup = menitDariJam(j.tutup);
  const lo = menitDariJam(j.last_order);
  const ringkas = `${fmtJam(j.buka)}-${fmtJam(j.tutup)} (last order ${fmtJam(j.last_order)})`;

  if (process.env.BOT_PAKSA_BUKA === '1') return { buka: true, bisaPesan: true, alasan: null, jadwal: j, hari, pesan: '' };

  if (menit < buka) {
    return { buka: false, bisaPesan: false, alasan: 'BELUM_BUKA', jadwal: j, hari, pesan: `Resto belum buka. Hari ini (${NAMA_HARI[hari]}) buka jam ${fmtJam(j.buka)}, last order ${fmtJam(j.last_order)}.` };
  }
  if (menit >= tutup) {
    return { buka: false, bisaPesan: false, alasan: 'TUTUP', jadwal: j, hari, pesan: `Resto sudah tutup. Hari ini (${NAMA_HARI[hari]}) buka ${ringkas}.` };
  }
  if (menit > lo) {
    return { buka: true, bisaPesan: false, alasan: 'LEWAT_LO', jadwal: j, hari, pesan: `Last order hari ini jam ${fmtJam(j.last_order)}, jadi pesanan baru sudah tidak bisa diterima. Resto tutup jam ${fmtJam(j.tutup)}.` };
  }
  return { buka: true, bisaPesan: true, alasan: null, jadwal: j, hari, pesan: '' };
}

function teksJamOperasional() {
  return (info().jam_operasional || [])
    .map((j) => `${j.label}: ${fmtJam(j.buka)}-${fmtJam(j.tutup)} (last order ${fmtJam(j.last_order)})`)
    .join('\n');
}

function teksLiveMusic() {
  const lm = info().live_music || [];
  if (lm.length === 0) return 'Belum ada jadwal live music.';
  return lm.map((l) => `${l.label}: ${fmtJam(l.mulai)}-${fmtJam(l.selesai)}`).join('\n');
}

// ---------- RESERVASI ----------
// Customer memilih tempat (dibantu Cimendo lewat percakapan, bukan aturan kaku):
//   MEJA    -> booking meja lewat Cimendo, tanpa DP (1 meja = 4-5 pax)
//   CABLAKA -> Ruang Meeting Cablaka lantai 2, TIDAK ada minimum pax, maksimal 30 pax, wajib DP via transfer rekening
//   > 30 pax -> tidak diproses Cimendo; diarahkan ke nomor official restoran (manager yang menangani)
function aturanReservasi() {
  const r = info().reservasi || {};
  return {
    maksCablaka: Number(r.maks_pax_cablaka ?? 30),
    paxPerMejaMin: Number(r.pax_per_meja_min ?? 4),
    paxPerMejaMaks: Number(r.pax_per_meja_maks ?? 5),
  };
}

// jenisPilihan: 'meja' | 'cablaka' | undefined. Hasil: 'HANDOFF' (> 30 pax), 'MEJA', 'CABLAKA', atau null (belum dipilih).
function jenisReservasi(pax, jenisPilihan) {
  if (Number(pax) > aturanReservasi().maksCablaka) return 'HANDOFF';
  if (jenisPilihan === 'cablaka') return 'CABLAKA';
  if (jenisPilihan === 'meja') return 'MEJA';
  return null;
}

// Estimasi jumlah meja yang dibutuhkan: pax / 5 (longgar) sampai pax / 4 (rapat)
function estimasiMeja(pax) {
  const a = aturanReservasi();
  const n = Number(pax) || 0;
  return { min: Math.ceil(n / a.paxPerMejaMaks), maks: Math.ceil(n / a.paxPerMejaMin) };
}

// Nomor official restoran (untuk reservasi > 30 pax) dan rekening DP Cablaka dibaca dari .env.
// Nilai bawaan di bawah DUMMY: ganti lewat .env sebelum dipakai customer sungguhan.
const DUMMY_OFFICIAL = '08xx-xxxx-xxxx (DUMMY, isi RESTO_NOMOR_OFFICIAL di .env)';
function nomorOfficial() {
  return process.env.RESTO_NOMOR_OFFICIAL || DUMMY_OFFICIAL;
}

function rekeningDp() {
  return {
    bank: process.env.BOOKING_DP_BANK || 'Mandiri',
    nomor: process.env.BOOKING_DP_REKENING || '0000000000 (DUMMY, isi BOOKING_DP_REKENING di .env)',
    atasNama: process.env.BOOKING_DP_ATAS_NAMA || 'DUMMY (isi BOOKING_DP_ATAS_NAMA di .env)',
  };
}

// Peringatan sekali di log kalau nilai ENV masih kosong/dummy, supaya tidak terlewat sebelum produksi.
function cekEnvReservasi() {
  const kurang = ['RESTO_NOMOR_OFFICIAL', 'BOOKING_DP_REKENING', 'BOOKING_DP_ATAS_NAMA'].filter((k) => !process.env[k]);
  if (kurang.length) console.warn(`⚠️  .env belum diisi: ${kurang.join(', ')} (reservasi memakai nilai DUMMY).`);
}

function teksRekeningDp(nominal) {
  const r = rekeningDp();
  return [
    `DP ${rp(nominal)} ditransfer ke:`,
    `${r.bank} ${r.nomor}`,
    `a.n. ${r.atasNama}`,
  ].join('\n');
}

// ---------- INFO LENGKAP (dikirim apa adanya ke customer) ----------
function teksRuangVip() {
  const v = info().ruang_vip;
  if (!v) return '';
  return [
    `${v.nama}`,
    `Kapasitas ${v.kapasitas}.`,
    `Gratis pemakaian ${v.gratis_jam} jam dengan minimum order ${rp(v.minimum_spend)}.`,
    v.deposit_catatan || `DP ${rp(v.deposit)} ditransfer ke rekening restoran.`,
    'Fasilitas:',
    ...(v.fasilitas || []).map((f, i) => `${i + 1}. ${f}`),
  ].join('\n');
}

function teksReservasi() {
  const a = aturanReservasi();
  const v = info().ruang_vip || {};
  return [
    'Reservasi bisa lewat Cimendo, ada dua pilihan tempat:',
    `1. Booking meja (1 meja muat ${a.paxPerMejaMin}-${a.paxPerMejaMaks} pax), tanpa DP.`,
    `2. Ruang Meeting Cablaka (lantai 2), tidak ada minimum pax, maksimal ${a.maksCablaka} pax. Pakai DP ${rp(v.deposit ?? 400000)} lewat transfer rekening.`,
    `Lebih dari ${a.maksCablaka} pax ditangani manager, hubungi nomor official restoran ${nomorOfficial()}.`,
    'Cukup sebutkan tanggal, jam, jumlah pax, dan area smoking atau non smoking.',
  ].join('\n');
}

// Reservasi > 30 pax (termasuk booking seluruh resto): Cimendo tidak memproses, diarahkan ke nomor official.
function teksFullBooking() {
  const a = aturanReservasi();
  return `Untuk reservasi lebih dari ${a.maksCablaka} pax (termasuk booking seluruh resto), Cablaka maksimal ${a.maksCablaka} pax jadi ditangani langsung oleh manager. Boleh hubungi nomor official restoran: ${nomorOfficial()}.`;
}

function teksInfoLengkap() {
  const i = info();
  const a = aturanReservasi();
  const bagian = [
    `${i.nama_resto}`,
    `Alamat: ${i.alamat}`,
    `Reservasi: ${i.telepon_reservasi} | Instagram ${i.instagram}`,
    '',
    'Jam buka:',
    teksJamOperasional(),
    'Harga menu belum termasuk PPN 10%, tanpa service charge.',
    '',
    `Kapasitas ${i.kapasitas_seat} seat (1 meja ${a.paxPerMejaMin}-${a.paxPerMejaMaks} pax).`,
    '',
    'Live music:',
    teksLiveMusic(),
    '',
    'Ruang Meeting Cablaka:',
    teksRuangVip(),
    '',
    teksReservasi(),
    '',
    'Pembayaran: waiter yang datang ke meja untuk menagih, bayar di depan atau di belakang sesuai pilihan kamu.',
  ];
  return bagian.join('\n');
}

const namaAi = () => info().nama_ai || 'Cimendo';
const menuMargin = () => info().menu_margin || [];

module.exports = {
  jalurData, info, kuis, ppnPersen, hitungTagihan, denganPpn,
  statusBuka, teksJamOperasional, teksLiveMusic, teksRuangVip, teksFullBooking, teksInfoLengkap, teksReservasi,
  aturanReservasi, jenisReservasi, estimasiMeja, nomorOfficial, rekeningDp, teksRekeningDp, cekEnvReservasi,
  namaAi, menuMargin, NAMA_HARI, fmtJam, menitDariJam, formatJam,
};
