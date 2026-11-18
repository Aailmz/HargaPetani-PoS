// Format nota ala struk kasir: item, Subtotal, PPN, Grand Total. Dipakai di rincian ke customer,
// tiket ke kasir, dan caption QR, supaya angkanya selalu sama (dihitung kode, bukan ditulis AI).
const db = require('./db');
const config = require('./config');
const { rp, nomorPesanan } = require('./format');

const aktif = (items) => items.filter((i) => i.status_item === 'AKTIF');

function keteranganItem(i) {
  const pilihan = Object.values(db.pilihanTampil(i)).join(', ');
  return [pilihan, i.catatan].filter(Boolean).join('; ');
}

// "1. Iga Bakar [take away] x1 = Rp155.000"
function barisItem(items, { dengan_harga_satuan = false } = {}) {
  return aktif(items).map((i, n) => {
    const ket = keteranganItem(i);
    const ta = i.tipe === 'TAKE_AWAY' ? ' [take away]' : '';
    const satuan = dengan_harga_satuan && i.qty > 1 ? ` @ ${rp(i.harga_satuan_snapshot)}` : '';
    return `${n + 1}. ${i.nama_snapshot}${ket ? ` (${ket})` : ''}${ta} x${i.qty}${satuan} = ${rp(i.harga_satuan_snapshot * i.qty)}`;
  });
}

// Subtotal dihitung dari item yang masih AKTIF, bukan dari kolom (kolom bisa kosong saat isi draft berubah)
function hitungDariItem(items) {
  const subtotal = aktif(items).reduce((s, i) => s + i.harga_satuan_snapshot * i.qty, 0);
  return config.hitungTagihan(subtotal);
}

function barisTotal(t) {
  return [
    `Subtotal: ${rp(t.subtotal)}`,
    `PPN ${config.ppnPersen()}%: ${rp(t.ppn)}`,
    `Grand Total: ${rp(t.grandTotal)}`,
  ];
}

// Nota satu pesanan
function teksNota(pesanan, items, { judul } = {}) {
  const t = hitungDariItem(items);
  return [judul ?? `Rincian pesanan ${nomorPesanan(pesanan)}:`, ...barisItem(items), ...barisTotal(t)].join('\n');
}

// Nota gabungan beberapa pesanan (bill open bill): tiap pesanan satu blok, total di akhir
function teksNotaGabungan(daftarPesanan) {
  let subtotalSemua = 0;
  const blok = [];
  for (const p of daftarPesanan) {
    const items = db.getItemsByPesananId(p.id);
    const t = hitungDariItem(items);
    subtotalSemua += t.subtotal;
    blok.push(`Pesanan ${nomorPesanan(p)}:`, ...barisItem(items));
  }
  const total = config.hitungTagihan(subtotalSemua);
  return { teks: [...blok, ...barisTotal(total)].join('\n'), total };
}

module.exports = { barisItem, hitungDariItem, barisTotal, teksNota, teksNotaGabungan, keteranganItem };
