// Format rupiah untuk teks yang dibaca customer/kasir: 68000 -> "Rp68.000"
function rp(n) {
  const x = Number(n);
  return Number.isFinite(x) ? `Rp${x.toLocaleString('id-ID')}` : 'Rp-';
}

// Zona waktu bot (bukan zona server VPS): dipakai untuk reset nomor pesanan harian dan jadwal kedatangan.
const ZONA_BOT = process.env.BOT_TIMEZONE || 'Asia/Jakarta';

// "2026-11-16" di zona bot
function tanggalBot(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: ZONA_BOT });
}

// Menit sejak tengah malam di zona bot
function menitSekarangBot(d = new Date()) {
  const [h, m] = d
    .toLocaleTimeString('en-GB', { timeZone: ZONA_BOT, hour12: false, hour: '2-digit', minute: '2-digit' })
    .split(':')
    .map(Number);
  return (h % 24) * 60 + m;
}

// "19:30" / "19.30" / "7:05" -> menit sejak tengah malam, atau null kalau bukan jam valid
function parseJam(teks) {
  const m = String(teks ?? '').trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mnt = Number(m[2]);
  if (h > 23 || mnt > 59) return null;
  return h * 60 + mnt;
}

// menit -> "19:30"
function formatJam(menit) {
  const h = String(Math.floor(menit / 60)).padStart(2, '0');
  const m = String(menit % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// Nomor pesanan yang ditampilkan ke customer/kasir: "#007" (reset tiap hari, beda dari ID di DB)
function nomorPesanan(p) {
  if (!p) return '#-';
  return `#${String(p.no_harian ?? p.id).padStart(3, '0')}`;
}

module.exports = { rp, ZONA_BOT, tanggalBot, menitSekarangBot, parseJam, formatJam, nomorPesanan };
