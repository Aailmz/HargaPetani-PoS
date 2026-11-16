// Format rupiah untuk teks yang dibaca customer/kasir: 68000 -> "Rp68.000"
function rp(n) {
  const x = Number(n);
  return Number.isFinite(x) ? `Rp${x.toLocaleString('id-ID')}` : 'Rp-';
}

module.exports = { rp };
