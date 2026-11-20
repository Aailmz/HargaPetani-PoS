const OpenAI = require('openai');
const db = require('./db');
const { rp, nomorPesanan, menitSekarangBot, parseJam, formatJam, tanggalBot } = require('./format');
const ai = require('./ai');
const { cariKandidatMenu, cariMenuBernamaUmum, normalisasiNama } = require('./matcher');
const atribut = require('./atribut');
const { distance } = require('fastest-levenshtein');
const config = require('./config');
const nota = require('./nota');

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
});

const MODEL = process.env.AI_MODEL;
const MAX_TOOL_ITERATIONS = 5;

// ========== STATE PENDING (disimpan di DB, tahan restart) ==========
function setKlarifikasiPending(jid, data) { db.setPendingState(jid, 'klarifikasi', data); }
function getKlarifikasiPending(jid) { return db.getPendingState(jid, 'klarifikasi'); }
function clearKlarifikasiPending(jid) { db.clearPendingState(jid, 'klarifikasi'); }

function setPilihanPending(jid, data) { db.setPendingState(jid, 'pilihan', data); }
function getPilihanPending(jid) { return db.getPendingState(jid, 'pilihan'); }
function clearPilihanPending(jid) { db.clearPendingState(jid, 'pilihan'); }

// ========== ALUR 3 FASE (berat / camilan / minuman) ==========
// Jalur nyemil: camilan -> minuman -> berat. Jalur berat: berat -> minuman -> camilan.
const URUTAN_JALUR = {
  camilan: ['camilan', 'minuman', 'berat'],
  berat: ['berat', 'minuman', 'camilan'],
};
const LABEL_FASE = { berat: 'makan berat', camilan: 'camilan', minuman: 'minuman' };

// kelompok kategori ('kopi'/'non_kopi') -> fase ('minuman')
function faseDariKategoriId(kategoriId) {
  const kat = db.getKategoriById(kategoriId);
  if (!kat || !kat.kelompok) return null;
  return kat.kelompok === 'kopi' || kat.kelompok === 'non_kopi' ? 'minuman' : kat.kelompok;
}

function faseBerikutnya(alur) {
  if (alur.tutup || !alur.jalur) return null;
  return URUTAN_JALUR[alur.jalur].find((f) => !alur.selesai.includes(f)) || null;
}

async function kirimKartuKelompok(konteks, kelompok) {
  const daftar = db.getKategoriByKelompok(kelompok);
  let terkirim = false;
  const batch = new Set(); // halaman yang dipakai bersama beberapa kategori tidak dikirim dobel dalam satu permintaan
  for (const kat of daftar) {
    const hasil = await konteks.kirimKartuKategori(konteks.jid, kat, batch);
    if (hasil !== 'tidak_ada') terkirim = true;
  }
  return { kategori: daftar.map((k) => k.nama), terkirim };
}

// Tawarkan fase berikutnya. kirimKartu=true hanya saat customer baru pilih jalur (fase pertama);
// fase selanjutnya diupsell dulu tanpa kartu, kartu baru dikirim kalau customer tertarik.
async function tawarkanFaseBerikutnya(konteks, { kirimKartu = false } = {}) {
  const alur = db.getAlur(konteks.jid);
  if (alur.tutup) return {};
  const fase = faseBerikutnya(alur);

  if (!fase) {
    const draft = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
    const adaItem = draft && db.getItemsByPesananId(draft.id).some((i) => i.status_item === 'AKTIF');
    return {
      semua_fase_selesai: true,
      instruksi_alur: adaItem
        ? 'Semua fase (berat, camilan, minuman) sudah ditawarkan dan customer tidak ada tambahan lagi. Panggil tampilkan_rincian_order SEKARANG di giliran ini juga.'
        : 'Semua fase sudah ditawarkan tapi customer belum pesan apa pun. Tanya santai dalam 1 kalimat apakah ada yang mau dipesan.',
    };
  }

  // Fase pertama (customer baru pilih jalur): langsung kirim kartu, karena dia sendiri yang minta.
  if (kirimKartu) {
    const kirim = await kirimKartuKelompok(konteks, fase);
    return {
      fase_ditawarkan: fase,
      kartu_terkirim: kirim.terkirim,
      kategori_fase: kirim.kategori,
      instruksi_alur: `Kartu menu ${LABEL_FASE[fase].toUpperCase()} ${kirim.terkirim ? 'sudah dikirim otomatis, jangan baca ulang harga satu-satu' : `tidak tersedia, sebutkan kategori: ${kirim.kategori.join(', ')}`}. Balas 1 kalimat singkat ajak pilih.`,
    };
  }

  // Fase berikutnya: UPSELL dulu, JANGAN kirim kartu. Kartu baru dikirim (lihat_menu) kalau customer tertarik.
  // Minuman: JANGAN sebut nama menu spesifik. Pertanyaannya "kopi / non-kopi / dua-duanya", jadi
  // menyebut 1 minuman (apalagi non-kopi) sambil nanya itu malah membingungkan.
  if (fase === 'minuman') {
    return {
      fase_ditawarkan: 'minuman',
      instruksi_alur: 'Upsell MINUMAN. Format di bawah ringkasan: 1 kalimat tanya pendek ("Mau lanjut apa nih?") lalu DAFTAR BERNOMOR, satu opsi per baris: "1. Tambah menu lagi", "2. Kopi", "3. Non-kopi", "4. Nggak dulu". JANGAN pakai paragraf dan JANGAN sebut nama minuman tertentu. Customer cukup membalas nomor atau satu kata. Kalau customer jawab "kopi"/"non kopi"/"dua-duanya"/nomornya -> lihat_menu dengan kelompok "kopi" / "non_kopi" / "minuman". Kalau langsung sebut nama minuman -> buat_order. Kalau "tambah menu lagi" -> tanya mau tambah apa. Kalau menolak tawaran ini ("nggak dulu"/"nggak"/"nggak usah") -> lewati_fase. Kalau mengakhiri pesanan ("udah", "itu aja", "cukup", "langsung bayar") -> LANGSUNG tampilkan_rincian_order.',
    };
  }

  return {
    fase_ditawarkan: fase,
    rekomendasi_upsell: rekomendasiUpsell(fase),
    instruksi_alur: `Upsell ${LABEL_FASE[fase].toUpperCase()}. Format di bawah ringkasan: 1 kalimat tanya pendek ("Mau lanjut apa nih?") lalu DAFTAR BERNOMOR, satu opsi per baris: "1. Tambah menu lagi", "2. Sekalian ${LABEL_FASE[fase]} (sebut 1 menu dari rekomendasi_upsell yang lagi enak)", "3. Nggak dulu". JANGAN pakai paragraf dan JANGAN kirim kartu menu dulu. Customer cukup membalas nomor atau satu kata. Kalau pilih 2 tapi belum sebut menu -> lihat_menu kelompok "${fase}". Kalau setuju menu yang direkomendasikan -> buat_order. Kalau menolak tawaran ini ("nggak dulu"/"nggak"/"nggak usah") -> lewati_fase. Kalau mengakhiri pesanan ("udah", "itu aja", "cukup", "langsung bayar") -> LANGSUNG tampilkan_rincian_order.`,
  };
}

// Menu margin tinggi (dari data_menu/info_resto.json) diprioritaskan di upsell dan rekomendasi
const adaMargin = (m) => config.menuMargin().includes(m.id);

// Urutan: menu margin dulu, lalu andalan, lalu sisanya; di dalam tiap golongan diacak supaya tidak monoton
function urutkanPrioritas(menus, { acak = true } = {}) {
  const skor = (m) => (adaMargin(m) ? 0 : m.andalan ? 1 : 2);
  const dasar = acak ? [...menus].sort(() => Math.random() - 0.5) : [...menus];
  return dasar.sort((a, b) => skor(a) - skor(b)); // sort stabil: urutan dalam satu golongan terjaga
}

// 2 menu dari fase itu buat bahan upsell: margin dulu, lalu andalan
function rekomendasiUpsell(fase) {
  const idKat = db.getKategoriByKelompok(fase).map((k) => k.id);
  const tersedia = db.getMenuTersedia().filter((m) => idKat.includes(m.kategori_id));
  const sumber = urutkanPrioritas(tersedia);
  return sumber.slice(0, 2)
    .map((m) => `${m.nama} (${rp(m.varian[0]?.harga ?? '-')}${m.deskripsi ? `, ${String(m.deskripsi).slice(0, 80)}` : ''})`);
}

// Dipanggil setiap ada item masuk draft: tandai fase item itu selesai, tentukan jalur kalau belum.
function catatFaseDariItem(jid, items) {
  const alur = db.getAlur(jid);
  if (alur.tutup) return;
  const faseItem = items.map((i) => faseDariKategoriId(i.menu.kategori_id)).filter(Boolean);
  if (faseItem.length === 0) return;
  // Customer langsung pesan tanpa pilih jalur: tebak dari item pertama (minuman ikut jalur nyemil)
  const jalur = alur.jalur || (faseItem[0] === 'berat' ? 'berat' : 'camilan');
  const selesai = [...new Set([...alur.selesai, ...faseItem])];
  db.setAlur(jid, { jalur, selesai, tutup: false });
}

// Label item untuk teks ke customer/AI: "Iga Bakar x2 [take away] (catatan)"
function labelItem(i) {
  return `${i.nama_snapshot} x${i.qty}${i.tipe === 'TAKE_AWAY' ? ' [take away]' : ''}${i.catatan ? ` (${i.catatan})` : ''}`;
}

// ========== PAGAR JAM, KASIR, DAN PERMINTAAN QR ==========

// Pesanan baru hanya diterima saat buka dan sebelum last order (dicek KODE, bukan AI)
function pagarJam() {
  const s = config.statusBuka();
  if (s.bisaPesan) return null;
  return {
    sukses: false,
    resto_tutup: true,
    alasan: s.alasan,
    pesan: s.pesan,
    catatan_untuk_ai: `Pesanan TIDAK bisa diterima sekarang. Sampaikan ramah dalam 1-2 kalimat: "${s.pesan}" Jangan mencatat pesanan. Info menu, info resto, dan booking tetap boleh dilayani.`,
  };
}

// Kirim ke SEMUA kasir. Mengembalikan [{ jid, id }] (id pesan WA) supaya balasan "reply" bisa dipetakan.
async function kirimKeSemuaKasir(konteks, pesan) {
  const hasil = [];
  for (const op of db.getAllOperators()) {
    try {
      const res = await konteks.kirimPesan(op.jid, pesan);
      db.simpanChatHistory(op.jid, 'assistant', pesan); // supaya balasan kasir punya konteks di histori
      hasil.push({ jid: op.jid, id: res?.key?.id || null });
    } catch (err) {
      console.error(`❌ Gagal kirim ke kasir ${op.jid}:`, err.message);
    }
  }
  return hasil;
}

// Kirim permintaan QR ke semua kasir dan catat id pesannya
async function kirimTiketPermintaanQr(konteks, permintaan, teks) {
  const terkirim = await kirimKeSemuaKasir(konteks, teks);
  for (const t of terkirim) db.simpanTiketKasir(t.id, t.jid, permintaan.id);
  return terkirim.length > 0;
}

const sebutCustomer = (c, jid) => [c.sapaan, c.nama].filter(Boolean).join(' ') || (jid ? jid.split('@')[0] : '-');

// Blok teks yang ditempel ke akhir system prompt customer, supaya LLM tahu kondisi
// nyata walau histori chat hanya berisi teks (tanpa hasil tool).
function buatKonteksDinamisCustomer(jid) {
  const baris = [];
  const alur = db.getAlur(jid); // dipanggil dulu: state kemarin otomatis di-reset sebelum customer dibaca
  const customer = db.getCustomer(jid);

  if (db.getChatHistory(jid, 1).length === 0) {
    baris.push(`- Ini chat PERTAMA customer. Balas SATU pesan sambutan (pengecualian aturan 1 kalimat): "Sugeng rawuh di The Banjoemas Resto & Cafe, Mas/Mbak. Aku ${config.namaAi()}" disambung 1 kalimat hangat, lalu tanya SATU hal sebagai DAFTAR BERNOMOR, satu opsi per baris: "1. Makan berat" dan "2. Nyemil". JANGAN tanya posisi/kedatangan (customer yang chat pertama kali dianggap sudah duduk di resto), JANGAN tanya dine in/take away, JANGAN kirim menu lengkap kalau tidak diminta. Kalau customer langsung memesan, menyebut bagian/kategori, atau bertanya hal lain (info resto, jam buka, booking, menu), sapa 1 kalimat singkat lalu LAYANI itu tanpa menanyakan jalur.`);
  }

  // Tanggal hari ini (untuk booking: "besok", "sabtu depan" harus dihitung dari sini)
  baris.push(`- HARI INI: ${config.NAMA_HARI[config.statusBuka().hari]}, ${tanggalBot()} (zona Jakarta). Hitung "besok", "lusa", "sabtu ini/depan" dari tanggal ini, tahun ${tanggalBot().slice(0, 4)}.`);

  // Jam operasional: dicek kode; AI hanya perlu tahu kondisinya
  const sb = config.statusBuka();
  if (!sb.bisaPesan) {
    baris.push(`- JAM: ${sb.pesan} Pesanan baru TIDAK diterima sekarang (jangan memanggil buat_order/tampilkan_rincian_order/kirim_qr_pembayaran). Jawab info, menu, dan booking tetap boleh.`);
  } else {
    baris.push(`- JAM: resto buka, pesanan diterima sampai last order jam ${config.fmtJam(sb.jadwal.last_order)}, resto tutup jam ${config.fmtJam(sb.jadwal.tutup)}.`);
  }
  if (customer.cara_bayar === 'OPEN_BILL') {
    baris.push('- CARA BAYAR: customer minta OPEN BILL (bayar di akhir). Saat customer menyetujui rincian, panggil kirim_qr_pembayaran seperti biasa, sistem yang membedakan.');
  }
  const openBill = db.getPesananOpenBillByCustomer(jid);
  if (openBill.length > 0) {
    baris.push(`- Customer punya pesanan OPEN BILL (sudah di dapur, belum bayar): ${openBill.map((p) => nomorPesanan(p)).join(', ')}. Kalau customer minta bill / mau bayar / minta tagihan -> panggil minta_bill.`);
  }
  const rat = db.getKunjunganRating(jid);
  if (rat) {
    baris.push(rat.status === 'MENUNGGU_RATING'
      ? '- Bot SUDAH menanyakan rating pelayanan (1 sampai 5) dan menunggu jawaban. Kalau customer menjawab nilai dengan kata (misal "bagus banget", "lima bintang"), panggil catat_rating; kalau tidak jelas angkanya, tanya ulang 1 kalimat "1 sampai 5, berapa nilainya?".'
      : '- Rating customer rendah, bot sudah menanyakan kendalanya dan menunggu cerita customer.');
  }

  // Kedatangan & layanan: default sudah di resto + dine in. Tidak ada yang ditanyakan.
  baris.push(`- Customer ${customer.rencana_datang && customer.rencana_datang !== 'SEKARANG' ? `bilang akan datang jam ${customer.rencana_datang} (pre-order)` : 'sudah di resto'}. Layanan: ${customer.tipe_default === 'TAKE_AWAY' ? 'TAKE AWAY (customer yang memintanya)' : 'DINE IN (default, JANGAN ditanyakan)'}. Take away hanya kalau customer sendiri minta ("bungkus", "take away", "iga-nya dibungkus"): catat per menu di buat_order atau ubah_tipe_item, atau atur_layanan take_away kalau semuanya.`);

  baris.push(customer.nomor_meja
    ? `- Nomor meja customer: ${customer.nomor_meja}.`
    : '- Nomor meja: belum ada (hanya wajib kalau customer sudah di resto, ditanya sebelum QR. Untuk yang datang nanti, ditanya setelah sampai).');
  baris.push(customer.nama
    ? `- Nama customer: ${customer.nama}.`
    : '- Nama customer: BELUM ADA (wajib ditanya sebelum kirim QR, dipakai kasir untuk mencocokkan pembayaran).');
  if (customer.nama) {
    baris.push(customer.sapaan
      ? `- Sapaan customer: ${customer.sapaan} (panggil "${customer.sapaan} ${customer.nama}" atau "${customer.sapaan}").`
      : '- Sapaan BELUM ditanya: setelah nama diketahui, tanya terpisah "Enaknya dipanggil apa?" dengan DAFTAR BERNOMOR ("1. Mas" / "2. Mbak"), lalu simpan lewat simpan_nama (parameter sapaan). Sebelum dijawab panggil customer dengan "Mas/Mbak" atau namanya saja, JANGAN menebak "Mas Budi"/"Mbak Sari".');
  }

  // Pre-order yang sudah lunas dan masih berjadwal
  for (const p of db.getPreOrderAktifByCustomer(jid)) {
    const ket = {
      MENUNGGU: 'menunggu, 30 menit sebelum jam datang bot akan menanyakan apakah tetap datang',
      DITANYA: 'bot SUDAH menanyakan apakah tetap sampai tepat waktu dan menunggu jawaban (ya / tidak jadi / ubah jam -> jadwal_kedatangan)',
      DIKONFIRMASI: 'sudah dikonfirmasi, makanan dimasak',
    }[p.jadwal_status];
    baris.push(`- Pesanan ${nomorPesanan(p)} sudah lunas, untuk datang jam ${p.jam_datang}: ${ket}. Kalau customer bilang tidak jadi datang, panggil jadwal_kedatangan aksi "batal" (uang yang sudah dibayar TIDAK dikembalikan, sampaikan santai dan sopan).`);
  }

  // Alur 3 fase sebagai panduan lembut (urutan tidak mengikat)
  if (alur.tutup) {
    baris.push('- Alur fase SUDAH SELESAI (sudah bayar). Pesanan tambahan diproses biasa tanpa fase: rangkum lalu minta konfirmasi.');
  } else if (!alur.jalur) {
    baris.push('- Customer BELUM pilih jalur. Kalau belum ada pesanan dan customer belum menyebut apa pun, tanya SATU hal dengan DAFTAR BERNOMOR ("1. Makan berat" / "2. Nyemil") lalu panggil pilih_jalur. Kalau customer langsung memesan, menyebut bagian/kategori, atau bertanya hal lain (termasuk rekomendasi), LAYANI itu dulu: jalur ditentukan otomatis dari pilihannya, jangan memaksa memilih jalur. Menu lengkap HANYA kalau customer eksplisit memintanya.');
  } else {
    const fase = faseBerikutnya(alur);
    baris.push('- Alur fase (panduan lembut, tidak mengikat): jalur ' + (alur.jalur === 'berat' ? 'MAKAN BERAT (berat -> minuman -> camilan)' : 'NYEMIL (camilan -> minuman -> berat)') + '; sudah: ' + (alur.selesai.map((f) => LABEL_FASE[f]).join(', ') || '-') + '; ' + (fase ? 'tawaran berikutnya: ' + LABEL_FASE[fase].toUpperCase() + '.' : 'semua bagian sudah ditawarkan/dilihat, lanjut rincian kalau customer selesai.'));
    baris.push('- Customer boleh memesan atau melihat bagian mana pun kapan saja, layani langsung. Menolak tawaran SPESIFIK ("nggak", "nggak dulu", "nggak usah minum") -> lewati_fase (hanya bagian itu dilewati). Ucapan MENGAKHIRI ("udah", "itu aja", "cukup", "langsung bayar", "minta tagihan") -> LANGSUNG tampilkan_rincian_order tanpa menawarkan apa-apa lagi.');
  }

  const klar = getKlarifikasiPending(jid);
  if (klar && klar.length > 0) {
    baris.push(`- Menunggu jawaban customer soal NAMA MENU yang ambigu: ${klar.map((k) => `"${k.namaInput}" (pilihan: ${k.kandidatList.map((m) => m.nama).join(', ')})`).join('; ')}. Kalau customer menjawab ini, panggil jawab_klarifikasi_menu.`);
  }

  const pil = getPilihanPending(jid);
  if (pil && pil.length > 0) {
    baris.push(`- Menunggu jawaban customer soal PORSI/OPSI: ${pil.map((p) => `${p.menu.nama} (${p.jenisPilihan === 'varian' ? 'porsi' : p.namaOpsi}: ${p.opsiTersedia.join(' / ')})`).join('; ')}. Kalau customer menjawab ini, panggil jawab_pilihan_menu.`);
  }

  const draft = db.getDraftAtauMenungguBayarByCustomer(jid);
  if (draft) {
    const ket = draft.status === 'MENUNGGU_BAYAR'
      ? 'QR sudah dikirim, menunggu pembayaran'
      : draft.subtotal
        ? 'rincian SUDAH ditampilkan, menunggu persetujuan customer. Kalau customer setuju (ok, ya, lanjut, kirim) -> WAJIB panggil kirim_qr_pembayaran sekarang; JANGAN panggil tampilkan_rincian_order lagi dan JANGAN meneruskan ke kasir'
        : 'masih draft, rincian belum ditampilkan';
    baris.push(`- Pesanan ${nomorPesanan(draft)}: ${ket}.`);
  }

  const rekomendasi = db.getPendingState(jid, 'rekomendasi');
  if (rekomendasi && rekomendasi.length > 0) {
    baris.push(`- Baru saja merekomendasikan menu: ${rekomendasi.map((n, i) => `${i + 1}. ${n}`).join(', ')}. Kalau customer membalas dengan angka atau nama dari daftar itu, WAJIB langsung panggil buat_order (teks_mentah = nama menunya) di giliran yang SAMA. JANGAN hanya membalas teks "siap/mantap" tanpa memanggil tool, karena pesanannya tidak akan tercatat. Kalau customer membalas hal yang AMBIGU (misal "yg lain deh", "apa aja", "terserah"), JANGAN panggil tool dan JANGAN menyimpulkan menunya cuma segini: TANYA dulu maksudnya dengan DAFTAR BERNOMOR (lihat semua / pilih kategori / rekomendasi lain).`);
  }

  const habis = db.getItemMenungguKeputusanHabisByCustomer(jid);
  if (habis.length > 0) {
    baris.push(`- Menu yang dilaporkan habis dan menunggu keputusan customer (ganti/batal): ${habis.map((i) => i.nama_snapshot).join(', ')}. Begitu customer menjawab ("batalin aja", "ganti X"), WAJIB langsung panggil putuskan_item_habis di giliran yang SAMA. JANGAN balas dulu "maksudnya dibatalkan ya?" tanpa memanggil tool, karena tanpa tool pembatalan dan refund tidak tercatat.`);
  }

  const tagihan = db.getTagihanBelumLunasByCustomer(jid);
  if (tagihan) {
    baris.push(`- Ada kekurangan bayar ${rp(tagihan.nominal)} akibat ganti menu (status: ${tagihan.status === 'MENUNGGU_BAYAR' ? 'QR sudah dikirim' : 'QR belum dikirim, menunggu customer setuju'}).`);
  }

  if (baris.length === 0) return '';
  return `\n\nSTATE SAAT INI (akurat dari sistem, utamakan ini daripada dugaan):\n${baris.join('\n')}`;
}

// Fakta layanan dibaca dari DB (hasil seed.js dari menu.json), jadi kalau pemilik mengubah
// aturan cukup edit menu.json lalu jalankan ulang seed.js, tanpa edit kode.
function buatBlokInfoResto() {
  const resto = db.getInfoResto('restoran');
  const aturan = db.getInfoResto('aturan_layanan');
  const alergen = db.getInfoResto('catatan_alergen');
  if (!resto && !aturan && !alergen) return '';

  const baris = [];

  if (resto) {
    const info = [
      resto.nama && `Nama: ${resto.nama}`,
      resto.alamat && `Alamat: ${resto.alamat}`,
      resto.telepon_reservasi && `Telepon reservasi: ${resto.telepon_reservasi}`,
      resto.instagram && `Instagram: ${resto.instagram}`,
    ].filter(Boolean);
    if (info.length) baris.push(`INFO RESTO (sebut hanya kalau customer tanya):\n- ${info.join('\n- ')}`);
    baris.push(`JAM BUKA:\n${config.teksJamOperasional()}\nLIVE MUSIC:\n${config.teksLiveMusic()}\nKapasitas ${config.info().kapasitas_seat} seat. Ruang VIP (Cablaka) dan booking seluruh resto tersedia. Untuk pertanyaan info resto / jam buka / live music / ruang VIP / booking, panggil tool info_resto (jawabannya lengkap dikirim sistem).`);
  }

  if (aturan) {
    const a = [];
    // Layanan diatur di kode (bukan dari menu.json): dine in + take away tanpa biaya tambahan, tanpa delivery.
    // Pesanan boleh dibuat sebelum datang (pre-order), tiap pesanan punya nomor pesanan harian.
    a.push('Layanan: dine in (DEFAULT, tidak ditanyakan) dan take away (hanya kalau customer yang minta, TANPA biaya kemasan), boleh campur per menu. TIDAK ada delivery. Customer boleh memesan sebelum datang (pre-order), pembayaran QRIS di awal. Uang yang sudah dibayar tidak dikembalikan kalau customer tidak jadi datang. Pengembalian uang (misal menu habis) hanya tunai di kasir.');
    a.push(`Harga menu BELUM termasuk pajak: ditambah PPN ${config.ppnPersen()}%, tanpa service charge, semua menu kena PPN (dine in maupun take away). Rincian selalu menampilkan Subtotal, PPN, Grand Total. JANGAN menyebut PPN/pajak kalau customer tidak menanyakannya (kecuali di rincian).`);
    a.push('Pembayaran: DEFAULT bayar dulu lewat QRIS. QR dibuat kasir per pesanan (nominal persis grand total), jadi setelah customer setuju rincian, QR dikirim begitu kasir selesai membuatnya (beberapa menit). OPEN BILL (bayar di akhir) HANYA kalau customer sendiri memintanya dan makan di tempat (take away dan pre-order tetap bayar dulu): jangan menawarkannya.');
    a.push('Nasi putih Rp10.000 per porsi (menu "Nasi Putih"). Tongseng dan menu lain BELUM termasuk nasi. Penawaran nasi diatur sistem lewat hasil buat_order (tawarkan_nasi).');
    for (const k of ['harga', 'nasi', 'sambal', 'ubah_batal']) {
      if (typeof aturan[k] === 'string') a.push(aturan[k]);
    }
    if (Array.isArray(aturan.alihkan_ke_staf) && aturan.alihkan_ke_staf.length) {
      a.push(`Teruskan ke kasir lewat forward_pesan_ke_kasir untuk: ${aturan.alihkan_ke_staf.join('; ')}.`);
    }
    if (a.length) baris.push(`ATURAN LAYANAN (dari pemilik):\n- ${a.join('\n- ')}`);
  }

  if (Array.isArray(alergen) && alergen.length) {
    baris.push(`CATATAN ALERGEN (dari pemilik):\n- ${alergen.join('\n- ')}`);
  }

  return `\n\nINFO RESTO DAN ATURAN (data resmi dari pemilik, ikuti ini):\n${baris.join('\n\n')}`;
}

// ========== TOOLS — CUSTOMER ==========

const TOOLS_CUSTOMER_SEMUA = [
  {
    type: 'function',
    function: {
      name: 'lihat_menu',
      description: 'Ambil daftar menu: 1 kelompok (makan berat / camilan / kopi / non-kopi / semua minuman), 1 kategori spesifik, atau semua. Dipakai kalau customer minta lihat menu / nanya menu apa aja, TERMASUK minta "menu pdf" atau "foto menu" (kartu dikirim otomatis oleh sistem). Utamakan kelompok supaya customer tidak dibanjiri semua kartu; kosongkan kelompok & kategori HANYA kalau customer eksplisit minta semua menu.',
      parameters: {
        type: 'object',
        properties: {
          kelompok: {
            type: 'string',
            enum: ['berat', 'camilan', 'kopi', 'non_kopi', 'minuman'],
            description: 'Kelompok menu: "berat" (makan berat), "camilan", "kopi", "non_kopi", atau "minuman" (kopi + non-kopi, kalau customer mau dua-duanya).',
          },
          kategori: {
            type: 'string',
            description: 'Kategori spesifik yang mau dilihat (misal "gorengan", "sate"), kalau customer sebut kategori tertentu. Kosongkan kalau pakai kelompok.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tanya_detail_menu',
      description: 'Cari 1 atau beberapa menu spesifik untuk dijawab detailnya (bahan, pedas, alergen, cara penyajian, dll). Dipakai SETIAP KALI customer tanya hal spesifik soal satu/beberapa menu tertentu, apapun pertanyaannya. Setelah dapat hasil tool ini, jawab pertanyaan customer dari deskripsi yang didapat, dengan gaya ngobrol natural.',
      parameters: {
        type: 'object',
        properties: {
          nama_menu: {
            type: 'array',
            items: { type: 'string' },
            description: 'Nama menu yang ditanyakan, bisa lebih dari satu kalau customer tanya perbandingan (misal ["sroto ayam", "sroto daging"]).',
          },
        },
        required: ['nama_menu'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cari_menu_atribut',
      description: 'Cari/saring menu berdasarkan sifatnya: rasa, bahan, bumbu, cara masak, berkuah atau tidak, pedas atau tidak. Dipakai kalau customer tanya "yang nggak pedas apa?", "ada yang manis?", "yang pakai santan?", "yang dibakar/digoreng?", "yang bukan daging sapi?", "yang berkuah?". Isi HANYA filter yang disebut customer. Hasilnya perkiraan dari data umum, sampaikan dengan kata "umumnya/biasanya", bukan jaminan.',
      parameters: {
        type: 'object',
        properties: {
          rasa: { type: 'array', items: { type: 'string' }, description: 'Rasa: manis, gurih, asam, pahit, segar, creamy, rempah.' },
          bahan: { type: 'array', items: { type: 'string' }, description: 'Bahan utama yang HARUS ada, misal ayam, sapi, kambing, tempe, kopi, susu, jagung, mie.' },
          tanpa_bahan: { type: 'array', items: { type: 'string' }, description: 'Bahan yang TIDAK boleh ada, misal ["sapi"] untuk "yang bukan daging sapi", ["susu"].' },
          bumbu: { type: 'array', items: { type: 'string' }, description: 'Bumbu/saus yang HARUS ada: santan, kecap, bumbu_kacang, sambal, rempah.' },
          tanpa_bumbu: { type: 'array', items: { type: 'string' }, description: 'Bumbu yang TIDAK boleh ada, misal ["santan"].' },
          masak: { type: 'array', items: { type: 'string' }, description: 'Cara masak: goreng, bakar, rebus, kukus, tumis, panggang, seduh, blend, peras, campur. Boleh lebih dari satu (salah satunya cocok).' },
          kuah: { type: 'boolean', description: 'true = hanya yang berkuah, false = hanya yang tidak berkuah.' },
          pedas: { type: 'boolean', description: 'true = hanya yang pedas, false = hanya yang TIDAK pedas. Hanya pedas atau tidak, tidak ada tingkatan.' },
          kelompok: { type: 'string', description: 'Batasi ke satu kelompok: berat, camilan, kopi, non_kopi, minuman. Isi kalau konteksnya jelas (misal customer sedang di fase makan berat).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buat_order',
      description: 'Catat pesanan menu dari customer ke draft keranjang. Dipakai kalau customer menyebutkan menu + jumlah yang mau dipesan (boleh sekaligus beberapa, boleh nambah ke draft yang sudah ada sebelumnya kalau belum dikonfirmasi).',
      parameters: {
        type: 'object',
        properties: {
          teks_mentah: {
            type: 'string',
            description: 'Salin ulang teks asli dari customer yang berisi pesanan, apa adanya (termasuk kalau ada catatan khusus seperti "pedesnya dikit" atau "tanpa bawang").',
          },
        },
        required: ['teks_mentah'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jawab_klarifikasi_menu',
      description: 'Proses jawaban customer saat memilih menu spesifik dari beberapa pilihan varian yang ditawarkan sebelumnya (misal customer pilih "yang daging" dari pilihan Sroto Ayam/Sroto Daging). HANYA dipakai kalau sebelumnya ada pertanyaan klarifikasi dari bot.',
      parameters: {
        type: 'object',
        properties: {
          teks_jawaban: {
            type: 'string',
            description: 'Salin ulang teks asli jawaban customer, apa adanya.',
          },
        },
        required: ['teks_jawaban'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jawab_pilihan_menu',
      description: 'Proses jawaban customer saat memilih porsi (penuh/setengah) atau opsi wajib seperti suhu (panas/dingin) untuk menu yang SUDAH JELAS jenisnya tapi butuh detail tambahan sebelum masuk draft. BEDA dengan jawab_klarifikasi_menu (itu untuk nama menu yang ambigu, misal "sate" -> sate apa). HANYA dipakai kalau sebelumnya ada pertanyaan soal porsi/suhu/sambal dari bot.',
      parameters: {
        type: 'object',
        properties: {
          teks_jawaban: {
            type: 'string',
            description: 'Salin ulang teks asli jawaban customer, apa adanya.',
          },
        },
        required: ['teks_jawaban'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'putuskan_item_habis',
      description: 'Proses keputusan customer soal menu yang dilaporkan habis SETELAH pesanan lunas (ganti menu lain, atau batal & refund). HANYA dipakai kalau sebelumnya ada pemberitahuan menu habis dari sistem ke customer ini. Kalau ada lebih dari satu menu yang menunggu keputusan, isi nama_menu dengan menu yang dimaksud.',
      parameters: {
        type: 'object',
        properties: {
          keputusan: {
            type: 'string',
            enum: ['ganti', 'batal'],
            description: '"ganti" kalau customer mau ganti ke menu lain, "batal" kalau mau dibatalkan saja dan uangnya kembali.',
          },
          nama_menu: {
            type: 'string',
            description: 'Nama menu YANG HABIS yang sedang diputuskan. Isi kalau ada lebih dari satu menu menunggu keputusan.',
          },
          menu_pengganti: {
            type: 'string',
            description: 'Nama menu pengganti yang diminta customer. Isi HANYA kalau keputusan=ganti.',
          },
          porsi_pengganti: {
            type: 'string',
            enum: ['penuh', 'setengah'],
            description: 'Porsi menu pengganti, isi kalau menu pengganti punya pilihan porsi dan customer sudah menyebutkannya.',
          },
          catatan_pengganti: {
            type: 'string',
            description: 'Jawaban customer untuk pilihan wajib menu pengganti (misal "dingin"), isi kalau sudah ditanyakan.',
          },
        },
        required: ['keputusan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kirim_qr_kekurangan',
      description: 'Kirim QR untuk kekurangan bayar akibat ganti menu ke menu yang lebih mahal. HANYA dipakai SETELAH customer menyatakan setuju membayar kekurangan itu. JANGAN dipanggil di giliran yang sama dengan putuskan_item_habis.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tampilkan_rincian_order',
      description: 'Hitung & tampilkan rincian lengkap (item, Subtotal, PPN, Grand Total) dari draft order customer, TANPA minta QR. Dipakai kalau customer bilang "ya"/"fix"/"benar"/"udah cukup" setelah draft dirangkum. Kalau dine in/take away belum ditanya, tool ini akan menyuruhmu bertanya dulu (ikuti catatan_untuk_ai). Setelah rincian tampil, TUNGGU customer konfirmasi sekali lagi sebelum kirim_qr_pembayaran.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kirim_qr_pembayaran',
      description: 'Ajukan pembayaran setelah customer menyetujui rincian: kasir otomatis diminta membuat QR (nominal persis Grand Total termasuk PPN) lalu QR diteruskan ke customer begitu kasir selesai (beberapa menit). Kalau customer memilih open bill, pesanan langsung diteruskan ke dapur tanpa QR. Butuh nomor meja DAN nama customer. HANYA dipakai SETELAH tampilkan_rincian_order dipanggil DAN customer sudah mengonfirmasi SEKALI LAGI bahwa rincian itu benar (misal "iya kirim", "oke", "fix segera bayar"). JANGAN PERNAH dipanggil di putaran/giliran yang sama dengan tampilkan_rincian_order atau buat_order.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batalkan_order',
      description: 'Batalkan draft order customer yang masih menunggu konfirmasi (belum bayar). Dipakai kalau customer bilang mau batal/tidak jadi pesan.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hapus_item_order',
      description: 'Hapus satu item spesifik dari draft pesanan customer (bukan batalkan semua). Dipakai kalau customer mau menghapus 1-2 menu saja dari pesanan yang belum dibayar, misal karena menu itu ternyata habis atau customer berubah pikiran.',
      parameters: {
        type: 'object',
        properties: {
          nama_menu: {
            type: 'string',
            description: 'Nama menu yang mau dihapus dari draft, sesuai yang disebut customer.',
          },
        },
        required: ['nama_menu'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cek_status_order_saya',
      description: 'Lihat status order milik customer ini hari ini (termasuk yang sudah lunas dan sedang diproses dapur). Dipakai kalau customer tanya soal status pesanannya, sudah dibayar belum, atau "pesenan saya gimana".',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'konfirmasi_kedatangan',
      description: 'Catat bahwa customer sudah sampai di resto beserta nomor mejanya (dan namanya kalau disebut sekalian). Dipakai kapan pun customer menyebutkan nomor meja atau bilang sudah sampai/sudah duduk, baik sebelum maupun sesudah order dibuat.',
      parameters: {
        type: 'object',
        properties: {
          nomor_meja: {
            type: 'string',
            description: 'Nomor meja yang disebutkan customer, apa adanya (misal "5", "A3").',
          },
          nama: {
            type: 'string',
            description: 'Nama customer kalau disebut bersamaan dengan nomor meja, tanpa sapaan "Mas"/"Mbak". Kosongkan kalau tidak disebut.',
          },
        },
        required: ['nomor_meja'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'forward_pesan_ke_kasir',
      description: 'Teruskan permintaan/komplain/pertanyaan customer yang perlu campur tangan kasir langsung (request tambahan di luar sistem, komplain makanan, hal urgent lain). Tentukan urgent=true kalau butuh respons cepat (makanan lama, salah antar, komplain rasa, minta cancel mendadak), urgent=false kalau sekadar informasi/titipan pesan yang bisa ditunggu.',
      parameters: {
        type: 'object',
        properties: {
          ringkasan: {
            type: 'string',
            description: 'Ringkasan singkat dan jelas soal apa yang disampaikan/dikeluhkan customer. Untuk catatan pesanan (urgent=false) tulis ISI catatannya saja, misal "sate taichan tanpa pedas", tanpa menyebut nomor pesanan atau nama (otomatis ditempel). JANGAN panggil lagi untuk catatan yang sudah pernah dicatat.',
          },
          urgent: {
            type: 'boolean',
            description: 'true kalau butuh perhatian kasir segera (komplain, alergi serius, minta cancel mendadak): dikirim sebagai chat sendiri dan bot berhenti melayani customer ini. false untuk catatan/permintaan biasa terkait pesanan (misal "tanpa pedas", "es-nya dipisah"): otomatis ditempel di info pesanan ke kasir, TIDAK jadi chat terpisah.',
          },
          pesanan_id: {
            type: 'integer',
            description: 'ID pesanan terkait, kalau customer menyebutkannya atau jelas dari histori (order terakhir mereka). Kosongkan kalau tidak jelas.',
          },
        },
        required: ['ringkasan', 'urgent'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ubah_jumlah_item',
      description: 'Ubah jumlah TOTAL menu yang SUDAH ada di draft pesanan. Dipakai kalau customer bilang jumlah akhirnya, misal "2 deh cimplung ubinya", "jadi 3 aja", "yang tadi 2 ya", "kurangi jadi 1". JANGAN pakai buat_order untuk ini, karena buat_order MENAMBAH jumlah (bukan mengganti). Kalau customer bilang "tambah 1 lagi" -> tetap buat_order. Kalau mau 0 / dihapus -> hapus_item_order.',
      parameters: {
        type: 'object',
        properties: {
          nama_menu: { type: 'string', description: 'Nama menu yang jumlahnya diubah, sesuai yang disebut customer.' },
          jumlah: { type: 'integer', description: 'Jumlah TOTAL akhir yang diinginkan (bukan selisih), minimal 1.' },
        },
        required: ['nama_menu', 'jumlah'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pilih_jalur',
      description: 'Catat pilihan customer mau mulai dari makan berat atau nyemil, lalu kirim kartu menu fase pertamanya. Dipakai begitu customer menjawab pertanyaan "makan berat atau nyemil dulu" (atau bilang hal serupa: "laper banget", "mau ngopi santai", dll).',
      parameters: {
        type: 'object',
        properties: {
          jalur: {
            type: 'string',
            enum: ['berat', 'camilan'],
            description: '"berat" kalau mau makan berat/menu utama dulu, "camilan" kalau mau nyemil/ngopi santai dulu.',
          },
        },
        required: ['jalur'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lewati_fase',
      description: 'Customer menolak/skip kelompok menu yang sedang ditawarkan (misal "nggak usah minum", "camilannya skip", "nggak dulu"). Tolakan biasa seperti ini HANYA melewati tawaran yang barusan. Ucapan yang MENGAKHIRI pesanan ("udah", "itu aja", "cukup", "gitu aja") BUKAN untuk tool ini: langsung tampilkan_rincian_order; sistem lalu mengajukan SATU tawaran lagi (fase berikutnya) dan setelah ditolak baru lanjut ke rincian. Isi langsung_bayar=true HANYA kalau customer eksplisit minta langsung bayar / minta jangan ditawarin lagi.',
      parameters: {
        type: 'object',
        properties: {
          langsung_bayar: { type: 'boolean', description: 'true HANYA kalau customer eksplisit bilang "langsung bayar aja" atau "jangan ditawarin lagi". Untuk "nggak", "udah", "itu aja" biasa, JANGAN diisi.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'simpan_nama',
      description: 'Simpan nama dan/atau sapaan customer. Dipakai kapan pun customer menyebutkan namanya (terutama saat ditanya nama sebelum QR), dan saat customer menjawab "dipanggil Mas atau Mbak". Isi hanya yang baru disebut. Kalau nama dan meja disebut bersamaan, cukup konfirmasi_kedatangan dengan parameter nama.',
      parameters: {
        type: 'object',
        properties: {
          nama: { type: 'string', description: 'Nama yang disebut customer, tanpa sapaan (tanpa "Mas"/"Mbak"). Kosongkan kalau hanya menjawab sapaan.' },
          sapaan: { type: 'string', enum: ['Mas', 'Mbak'], description: 'Sapaan pilihan customer. Kosongkan kalau belum dijawab.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hitung_perkiraan_bujet',
      description: 'Hitung perkiraan total (harga menu + PPN) dan per orang untuk kombinasi menu yang sedang dikonsultasikan, TANPA membuat pesanan. Dipakai saat customer tanya bujet/perkiraan biaya/patungan ("kira-kira habis berapa buat 6 orang?"). Isi daftar menu + jumlah dari saran yang kamu berikan. Hasilnya angka resmi dari data harga, jangan dihitung sendiri.',
      parameters: {
        type: 'object',
        properties: {
          item: {
            type: 'array',
            description: 'Daftar menu dan jumlahnya.',
            items: {
              type: 'object',
              properties: {
                nama: { type: 'string', description: 'Nama menu (persis atau mendekati nama resmi).' },
                qty: { type: 'integer', description: 'Jumlah porsi.' },
              },
              required: ['nama', 'qty'],
            },
          },
          jumlah_orang: { type: 'integer', description: 'Jumlah orang untuk hitung per orang (opsional).' },
        },
        required: ['item'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rekomendasi_menu',
      description: 'Ambil menu andalan/favorit yang tersedia. Dipakai kalau customer tanya favorit, rekomendasi, best seller, "enaknya apa", atau "andalannya apa". Tampilkan hasilnya sebagai daftar bernomor + harga, lalu tanya mau yang mana.',
      parameters: {
        type: 'object',
        properties: {
          kelompok: { type: 'string', enum: ['berat', 'camilan', 'minuman'], description: 'Batasi ke satu kelompok kalau customer menyebutnya (misal "minuman apa yang enak"). Kosongkan untuk campuran.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'atur_layanan',
      description: 'Catat kedatangan dan jenis layanan HANYA kalau customer sendiri menyebutnya: dia bilang akan datang jam sekian (kedatangan HH:MM, pre-order), atau minta take away ("bungkus semua", "take away aja" -> tipe take_away; sebagian saja -> campur lalu ubah_tipe_item per menu). Default-nya sudah di resto dan dine in, JANGAN menanyakan keduanya ke customer. Isi hanya yang baru disebut.',
      parameters: {
        type: 'object',
        properties: {
          tipe: {
            type: 'string',
            enum: ['dine_in', 'take_away', 'campur'],
            description: '"dine_in" = semua makan di tempat. "take_away" = SEMUA dibawa pulang. "campur" = sebagian take away (setelah itu tanyakan menu mana yang take away lalu panggil ubah_tipe_item per menu).',
          },
          kedatangan: {
            type: 'string',
            description: '"sekarang" kalau customer sudah di resto / sedang menuju dan akan langsung makan, atau jam kedatangan format 24 jam HH:MM (misal "19:30" untuk "setengah delapan malam"). Pesanan sebelum datang diteruskan ke dapur dan dimasak setelah customer konfirmasi 30 menit sebelum jam itu.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ubah_tipe_item',
      description: 'Ubah satu menu di draft pesanan jadi take away atau dine in, misal "iga-nya take away aja", "yang sate makan sini". Kalau semua menu berubah sekaligus, pakai atur_layanan.',
      parameters: {
        type: 'object',
        properties: {
          nama_menu: { type: 'string', description: 'Nama menu yang diubah.' },
          tipe: { type: 'string', enum: ['dine_in', 'take_away'], description: 'Tipe baru untuk menu itu.' },
        },
        required: ['nama_menu', 'tipe'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'jadwal_kedatangan',
      description: 'Urus jadwal kedatangan pesanan yang sudah dibayar sebelum customer sampai (pre-order). aksi "konfirmasi": customer bilang jadi/tetap sampai tepat waktu (menjawab pertanyaan 30 menit sebelumnya) -> dapur mulai masak. aksi "batal": customer tidak jadi datang (uang TIDAK dikembalikan). aksi "ubah_jam": customer mau datang di jam lain (isi jam_baru). Dipakai setiap customer membahas jam datang / jadi tidaknya datang untuk pesanan yang sudah dibayar.',
      parameters: {
        type: 'object',
        properties: {
          aksi: { type: 'string', enum: ['konfirmasi', 'batal', 'ubah_jam'] },
          jam_baru: { type: 'string', description: 'Jam baru format HH:MM 24 jam. Isi HANYA untuk aksi ubah_jam.' },
        },
        required: ['aksi'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'info_resto',
      description: 'Kirim info resto LENGKAP ke customer (sistem yang mengirim teksnya utuh, kamu cukup menambah 1 kalimat). Dipakai kalau customer tanya info resto, alamat, jam buka/tutup, last order, live music, kapasitas, ruang VIP / ruang meeting, booking seluruh resto, atau "resto ini gimana". topik "semua" untuk info umum lengkap.',
      parameters: {
        type: 'object',
        properties: {
          topik: {
            type: 'string',
            enum: ['semua', 'jam', 'live_music', 'ruang_vip', 'full_booking', 'lokasi'],
            description: '"semua" (default) = info lengkap. Pakai topik spesifik kalau customer hanya menanyakan itu.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ajukan_booking',
      description: 'Ajukan booking Ruang VIP (Meeting Cablaka, 25-30 orang) atau booking seluruh resto (80 seat). Isi hanya yang sudah disebut customer; kalau ada yang kurang, tool memberi tahu apa yang perlu ditanyakan (tanyakan SEMUANYA sekaligus dalam satu pesan). Booking baru diteruskan ke tim dan dikonfirmasi manusia, JANGAN menjanjikan sudah pasti.',
      parameters: {
        type: 'object',
        properties: {
          jenis: { type: 'string', enum: ['ruang_vip', 'full_resto'], description: 'ruang_vip = Ruang Meeting Cablaka; full_resto = booking seluruh resto.' },
          tanggal: { type: 'string', description: 'Tanggal format YYYY-MM-DD (hari ini ada di STATE). Ubah "besok", "sabtu depan", "20 des" jadi format ini.' },
          jam: { type: 'string', description: 'Jam mulai format 24 jam HH:MM.' },
          jumlah_orang: { type: 'integer', description: 'Perkiraan jumlah orang.' },
          nama: { type: 'string', description: 'Nama pemesan (tanpa sapaan).' },
          rokok: { type: 'string', enum: ['smoking', 'non_smoking'], description: 'Khusus ruang VIP: area smoking atau non smoking.' },
          catatan: { type: 'string', description: 'Kebutuhan lain (acara, sound system, dll).' },
        },
        required: ['jenis'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'panggil_waiter',
      description: 'Panggil waiter ke meja customer (diteruskan ke kasir/staf). Dipakai kalau customer minta dipanggilkan waiter, minta bantuan di meja, minta bill secara fisik, minta tambah alat makan, dll. Butuh nomor meja customer; kalau belum ada, tool memberi tahu supaya kamu menanyakannya.',
      parameters: {
        type: 'object',
        properties: {
          keperluan: { type: 'string', description: 'Keperluan singkat dari customer, misal "minta sendok", "mau tanya menu". Kosongkan kalau tidak disebut.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'atur_cara_bayar',
      description: 'Catat cara bayar yang diminta customer. "open_bill" HANYA kalau customer sendiri minta bayar belakangan / bayar di akhir / open bill / "bill aja nanti". "bayar_dulu" kalau dia kembali memilih bayar sekarang. Jangan menawarkan open bill ke customer. Open bill hanya untuk makan di tempat (take away dan pre-order wajib bayar dulu).',
      parameters: {
        type: 'object',
        properties: { cara: { type: 'string', enum: ['open_bill', 'bayar_dulu'] } },
        required: ['cara'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'minta_bill',
      description: 'Customer yang open bill minta tagihan / mau bayar / "bill dong" / "minta bill". Sistem meminta kasir menyiapkan QR bill seluruh pesanannya, lalu QR diteruskan ke customer.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'catat_rating',
      description: 'Catat rating pelayanan 1 sampai 5 dari customer, HANYA kalau bot sudah menanyakan rating (lihat STATE) dan customer menjawabnya dengan kata/kalimat (misal "lima bintang", "bagus banget" = tidak jelas angkanya, jangan ditebak: tanya ulang). Jawaban angka biasa ditangkap sistem otomatis.',
      parameters: {
        type: 'object',
        properties: { nilai: { type: 'integer', description: 'Angka 1 sampai 5 yang JELAS disebut customer.' } },
        required: ['nilai'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mulai_kuis',
      description: 'Mulai kuis Banyumasan (gimmick sambil menunggu pesanan) kalau customer minta main kuis / "kuis dong" / menjawab mau setelah ditawari.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// Alur 3 fase (camilan/minuman/berat) berlaku sebagai PANDUAN LEMBUT: customer tetap bebas memesan dan bertanya kapan saja.
const TOOLS_DIHENTIKAN = new Set([]); // alur 3 fase aktif lagi (fleksibel)
const TOOLS_CUSTOMER = TOOLS_CUSTOMER_SEMUA.filter((t) => !TOOLS_DIHENTIKAN.has(t.function.name));

// ========== TOOLS — KASIR ==========

const TOOLS_OPERATOR = [
  {
    type: 'function',
    function: {
      name: 'konfirmasi_booking',
      description: 'Kasir/staf menerima atau menolak pengajuan booking (ruang VIP atau full resto). Dipakai kalau kasir bilang semacam "booking 3 diterima", "booking 3 ok", "booking 2 ditolak penuh". Menerima booking ruang VIP otomatis meminta deposit.',
      parameters: {
        type: 'object',
        properties: {
          nomor_booking: { type: 'integer', description: 'Nomor booking dari notifikasi "BOOKING #3".' },
          aksi: { type: 'string', enum: ['terima', 'tolak'] },
          alasan: { type: 'string', description: 'Alasan singkat untuk customer kalau ditolak, atau catatan tambahan kalau diterima.' },
        },
        required: ['nomor_booking', 'aksi'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'konfirmasi_deposit_booking',
      description: 'Tandai deposit booking sudah dibayar (kasir bilang "deposit booking 3 sudah masuk"). Booking jadi terkunci dan customer dikabari.',
      parameters: {
        type: 'object',
        properties: { nomor_booking: { type: 'integer', description: 'Nomor booking.' } },
        required: ['nomor_booking'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'konfirmasi_bayar',
      description: 'Tandai sebuah pesanan sebagai sudah dibayar (lunas) setelah kasir dengar/lihat pembayaran masuk di mesin EDC/QR, lalu otomatis kabari customer bahwa pesanannya diteruskan ke dapur. Dipakai kalau kasir bilang semacam "meja 5 udah bayar" atau sebut nomor pesanan yang sudah lunas. BUKAN untuk kekurangan bayar akibat ganti menu (itu pakai konfirmasi_bayar_kekurangan).',
      parameters: {
        type: 'object',
        properties: {
          nomor_pesanan: {
            type: 'integer',
            description: 'Nomor pesanan yang disebut kasir (angka dari notifikasi "Pesanan #007", misal "pesanan 7" -> 7). Utamakan ini kalau kasir menyebut nomor pesanan.',
          },
          pesanan_id: {
            type: 'integer',
            description: 'ID internal pesanan. Biasanya KOSONGKAN, pakai nomor_pesanan atau nomor_meja.',
          },
          nomor_meja: {
            type: 'string',
            description: 'Nomor meja yang disebut kasir, kalau tidak sebut nomor pesanan.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'konfirmasi_bayar_kekurangan',
      description: 'Tandai kekurangan bayar (selisih akibat customer ganti menu ke yang lebih mahal) sebagai sudah dibayar. Dipakai kalau kasir bilang semacam "kekurangan meja 5 udah masuk" atau "selisih meja 5 lunas".',
      parameters: {
        type: 'object',
        properties: {
          pesanan_id: { type: 'integer', description: 'ID pesanan terkait, kalau kasir sebut.' },
          nomor_meja: { type: 'string', description: 'Nomor meja, kalau kasir sebut meja.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batalkan_order_paksa',
      description: 'Batalkan sebuah pesanan atas keputusan kasir (salah input, request customer batal, dll). Customer otomatis dikabari.',
      parameters: {
        type: 'object',
        properties: {
          nomor_pesanan: { type: 'integer', description: 'Nomor pesanan hari ini yang mau dibatalkan (angka dari "Pesanan #007").' },
          alasan: { type: 'string', description: 'Alasan singkat pembatalan untuk disampaikan ke customer.' },
        },
        required: ['nomor_pesanan', 'alasan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cek_status_order',
      description: 'Lihat detail satu pesanan (by ID), atau semua pesanan yang masih aktif/belum selesai.',
      parameters: {
        type: 'object',
        properties: {
          nomor_pesanan: { type: 'integer', description: 'Nomor pesanan hari ini (angka dari "Pesanan #007"). Kosongkan untuk lihat SEMUA yang aktif.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kirim_ulang_qr',
      description: 'Kirim ulang gambar QR pembayaran + info total ke customer untuk pesanan yang masih menunggu bayar.',
      parameters: {
        type: 'object',
        properties: { nomor_pesanan: { type: 'integer', description: 'Nomor pesanan hari ini (angka dari "Pesanan #007").' } },
        required: ['nomor_pesanan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_status_menu',
      description: 'Tandai satu atau beberapa menu jadi habis atau tersedia lagi. Dipakai kalau kasir bilang "HABIS <menu>" / "<menu> habis" atau "ADA <menu>" / "<menu> ready lagi" (boleh sebut banyak menu sekaligus).',
      parameters: {
        type: 'object',
        properties: {
          teks_mentah: { type: 'string', description: 'Salin ulang teks asli dari kasir soal status menu, apa adanya.' },
        },
        required: ['teks_mentah'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lapor_menu_habis_setelah_bayar',
      description: 'Lapor bahwa satu menu ternyata habis UNTUK PESANAN YANG SUDAH LUNAS/di dapur. Beda dengan update_status_menu (itu untuk stok umum). Dipakai kalau kasir bilang semacam "mendoan meja 5 habis" atau sebut pesanan spesifik yang sudah bayar tapi menunya kosong.',
      parameters: {
        type: 'object',
        properties: {
          nama_menu: { type: 'string', description: 'Nama menu yang habis.' },
          nomor_pesanan: { type: 'integer', description: 'Nomor pesanan hari ini (angka dari "Pesanan #007"), kalau kasir menyebut "pesanan 7".' },
          nomor_meja: { type: 'string', description: 'Nomor meja, kalau kasir sebut meja bukan nomor pesanan.' },
        },
        required: ['nama_menu'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lihat_semua_menu',
      description: 'Ambil daftar semua menu beserta harga dan status (tersedia/habis).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'broadcast_promo',
      description: 'Kirim pesan broadcast promosi ke semua customer terdaftar.',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['otomatis', 'menu_spesifik'], description: '"otomatis" kalau kasir tidak sebut menu tertentu, "menu_spesifik" kalau sebut nama menu untuk dipromosikan.' },
          nama_menu: { type: 'string', description: 'Nama menu yang mau dipromosikan. Isi HANYA kalau mode=menu_spesifik.' },
        },
        required: ['mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cari_customer',
      description: 'Cari customer berdasarkan nama atau nomor meja (partial match). Dipakai sebagai langkah AWAL sebelum tool lain yang butuh nomor WA, kalau kasir cuma sebut nama/meja.',
      parameters: {
        type: 'object',
        properties: { kata_kunci: { type: 'string', description: 'Nama atau nomor meja yang dicari.' } },
        required: ['kata_kunci'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lihat_histori_chat_customer',
      description: 'Lihat histori chat customer tertentu.',
      parameters: {
        type: 'object',
        properties: { nomor: { type: 'string', description: 'Nomor WA customer, format angka saja.' } },
        required: ['nomor'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'selesaikan_meja',
      description: 'Tandai meja sudah kelar/kosong (customer sudah pulang). Meja jadi bisa dipakai customer lain, dan alur pesan customer itu di-reset. Dipakai kalau kasir bilang semacam "meja 5 udah kelar", "meja 5 kosong", "meja 5 selesai".',
      parameters: {
        type: 'object',
        properties: {
          nomor_meja: { type: 'string', description: 'Nomor meja yang disebut kasir.' },
          paksa: { type: 'boolean', description: 'true HANYA kalau kasir menegaskan tetap kosongkan walau masih ada pesanan menunggu bayar (pesanan itu akan dibatalkan).' },
        },
        required: ['nomor_meja'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kirim_pesan_ke_customer',
      description: 'Kirim pesan bebas ke customer tertentu atas nama resto. Setelah terkirim, bot otomatis nonaktif untuk customer itu (status eskalasi).',
      parameters: {
        type: 'object',
        properties: {
          nomor: { type: 'string', description: 'Nomor WA customer, format angka saja.' },
          isi_pesan: { type: 'string', description: 'Isi pesan sesuai instruksi kasir, ditulis natural gaya admin resto.' },
        },
        required: ['nomor', 'isi_pesan'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'selesaikan_eskalasi',
      description: 'Balikin status customer dari eskalasi ke bot aktif lagi.',
      parameters: {
        type: 'object',
        properties: { nomor: { type: 'string', description: 'Nomor WA customer, format angka saja.' } },
        required: ['nomor'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lihat_eskalasi_aktif',
      description: 'Lihat daftar customer yang statusnya lagi dieskalasi ke kasir (bot nonaktif utk mereka).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lihat_statistik_harian',
      description: 'Lihat ringkasan statistik hari ini: jumlah order per status, omzet, menu paling laku.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tambah_operator',
      description: 'Tambahkan nomor WA baru sebagai kasir/operator. HANYA operator utama yang bisa.',
      parameters: {
        type: 'object',
        properties: { nomor: { type: 'string', description: 'Nomor WA, format angka saja.' } },
        required: ['nomor'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'hapus_operator',
      description: 'Cabut akses operator dari nomor tertentu. HANYA operator utama, tidak bisa hapus dirinya sendiri.',
      parameters: {
        type: 'object',
        properties: { nomor: { type: 'string', description: 'Nomor WA, format angka saja.' } },
        required: ['nomor'],
      },
    },
  },
];

// ========== SYSTEM PROMPTS ==========

const SYSTEM_PROMPT_CUSTOMER = `Kamu adalah "Cimendo", teman ngobrol dan pelayan digital di The Banjoemas Resto & Cafe (resto khas Banyumas/Jawa Tengah). Nama restonya tetap "The Banjoemas Resto & Cafe", Cimendo adalah namamu. Kamu ramah, cekatan, hangat ke tamu, dan terasa seperti pelayan sungguhan, bukan mesin.

CUSTOMER PLIN-PLAN (SERING TERJADI):
- Customer sering berubah pikiran, muter-muter, balik ke pilihan awal, atau membatalkan lalu memesan lagi ("ga jadi mie, nasgor aja", "eh yang tadi aja deh", "yaudah itu aja", "bentar bentar"). SELALU ikuti pesan TERBARU dan keadaan draft di STATE: ga jadi X -> hapus_item_order; balik ke Y -> buat_order lagi untuk Y; ganti X ke Y -> hapus X lalu buat Y.
- Kalau customer bilang ga jadi untuk menu yang masih jadi pertanyaan ("ga jadi mie", "sate ayamnya ga usah"), panggil hapus_item_order dengan nama menu itu (pertanyaannya ikut dibatalkan). Kalau customer ganti ke hal lain tanpa membatalkan, jangan dihapus diam-diam: saat dia mengakhiri pesanan, sistem akan mengingatkan sekali apakah menu itu jadi dipesan.
- Kalau customer merujuk menu yang tadi dia pesan/sebut ("yang tadi", "yg mie tadi", "balik ke yang awal"), tulis NAMA LENGKAP menu itu (dari riwayat chat atau draft) di teks_mentah buat_order, misal "mie godog 1", JANGAN menyalin kata ambigunya ("mie") karena akan ditanya ulang.
- JANGAN PERNAH membalas "siap / oke / x1 ya" untuk sebuah menu tanpa memanggil tool pencatatnya di giliran yang sama. Kalau tidak yakin maksudnya, tanya satu kalimat pendek.
- "ada apa aja", "jual apa aja", "apa aja yang ada" BUKAN permintaan menu lengkap: tanyakan jalurnya (1. Makan berat 2. Nyemil) atau, kalau jalur sudah dipilih, tawarkan bagian berikutnya. Menu lengkap hanya kalau dia eksplisit bilang "menu" / "buku menu" / "semua menu".

PAHAMI KETIKAN ANEH (PENTING):
- Customer sering mengetik singkat, typo, campur singkatan, atau tidak baku ("cemilan", "camilan", "nyemil", "snack", "nasgor", "es teh pocinya 2", "mau yg manis2"). Pahami maksudnya semaksimal mungkin dan SESUAIKAN diri, jangan kaku, jangan minta customer mengetik ulang dengan format tertentu.
- Sinonim kelompok: camilan = cemilan/camil/snack/nyemil/ngemil/jajan; makan berat = menu utama/berat/makanan berat; minuman = minum/haus/drink. Kalau customer menyebut itu, tetap panggil lihat_menu dengan kelompok yang sesuai.
- Kalau maksudnya MASIH tidak jelas atau tidak ada tool yang cocok, JANGAN menebak dan JANGAN mengabaikan: tanya balik dengan DAFTAR BERNOMOR (maks 4 opsi) yang paling mungkin. Selalu balas sesuatu yang berguna.
- Kalau customer menyebut "nasi" saat membahas lauk (tongseng, sop, iga, dll), artinya Nasi Putih: tulis "nasi putih" di buat_order.

IDENTITAS & NUANSA:
- Namamu Cimendo. Customer boleh menulis "Ci Mendo", "ci mendo", atau "cimendo": semuanya kamu. Kalau ditanya siapa kamu, jawab "Cimendo" saja, jangan menyebut dirimu bot, AI, atau sistem.
- Resto ini kental nuansa Jawa (Banyumasan). Kamu boleh sesekali pakai sapaan/kata khas Jawa secukupnya -- "sugeng rawuh" (selamat datang) di SAPAAN PERTAMA customer baru, lalu sesekali selingi "monggo", "nggih", "matur nuwun" di tempat yang pas. JANGAN dipaksakan di setiap kalimat, cukup jadi bumbu biar kerasa khasnya, selebihnya bahasa Indonesia santai normal.
- Sapaan: kalau "Sapaan customer" sudah tertulis di STATE SAAT INI, pakai itu persis ("Mas Budi" / "Mbak Sari"), JANGAN menebak lagi. Selama sapaan BELUM ada (termasuk pesan sambutan pertama), panggil "Mas/Mbak" (tulis persis begitu, jangan memilih salah satu). Setelah customer menyebut nama, tanya TERPISAH enaknya dipanggil Mas atau Mbak lalu simpan lewat simpan_nama.
- WAJIB pakai tepat 1 emoji di setiap balasan, ditaruh di ujung kalimat terakhir, yang nyambung dengan isi (☕ minuman, 🍢 camilan, 🍛 makan berat, 😊 ramah/ucapan, 🙏 maaf/terima kasih, 😋 upsell menggoda). Cuma 1, jangan lebih. Ini TIDAK melanggar aturan "1 kalimat". Kalau balasan berisi daftar/rincian angka, emojinya taruh di kalimat penutup setelah daftar.
- Gaya bicara hangat, luwes, kayak pelayan resto sungguhan yang available ngobrol -- BUKAN robot yang jawab template kaku.

GAYA CHAT (santai tapi jelas):
- Ngobrol kayak chat sama teman yang kebetulan kerja di resto: pakai kata sehari-hari ("nih", "ya", "aja", "yuk", "deh", "lagi enak"), BUKAN bahasa baku/formal ("silakan", "mohon", "dimohon", "harap", "kami informasikan", "berikut").
- Kalimat pendek dan langsung ke inti. Satu pesan = satu maksud yang gampang dipahami sekali baca.
- JELAS itu nomor satu: kalau customer harus memilih, tulis pilihannya eksplisit pakai "atau" ("mau X, atau Y?"), jangan cuma menyebut satu opsi seolah itu satu-satunya. Hindari kalimat yang bisa dibaca dua arti.
- Tawaran/upsell dibawakan ringan dan menggoda, bukan promosi kaku ("Enaknya ditemani...", "lagi enak nih...").
- Hindari menyebut diri "kami" berulang-ulang. Cukup langsung bilang apa yang terjadi ("Udah masuk ya", bukan "Pesanan Anda telah kami terima").

SIFAT PENTING -- JANGAN KAKU:
- Customer BOLEH loncat topik kapan saja: baru nanya menu, tiba-tiba mau order, abis itu nanya pedesnya gimana, balik lagi nambah pesanan, dll. Ikuti alur customer, JANGAN paksa dia ngikutin urutan tertentu.
- Tidak ada "script" wajib. Baca konteks percakapan (termasuk histori) untuk nentuin maksud customer dan tool apa yang relevan.
- Variasikan cara nanya/narasi, jangan mengulang kalimat yang sama persis tiap saat.

KONSULTASI (KAMU JUGA TEMPAT BERTANYA):
- Cimendo bukan cuma pencatat pesanan. Customer boleh bertanya atau minta saran: mau makan apa buat berapa orang, cocoknya menu apa buat acara/arisan/ulang tahun/meeting/kencan, menu yang tidak pedas atau ramah anak, patungan dan bujet, pilih booking meja atau Cablaka, kapan waktu enak datang, dan sejenisnya. Layani seperti pelayan senior yang paham resto ini, bukan mesin formulir.
- Awam atau sudah paham, ikuti level customer. Customer awam (bingung, "enaknya apa", "baru pertama ke sini", tidak tahu istilah): tanya SATU hal ringan dulu (acara/berapa orang/suka pedas atau tidak), lalu beri 2-3 saran konkret dengan alasan singkat, jangan menyodorkan daftar panjang atau istilah teknis. Customer yang sudah paham (menyebut menu/jumlah/jam/tempat dengan jelas, "langsung aja"): jangan banyak tanya dan jangan menjelaskan hal yang tidak ditanya, langsung kerjakan.
- Jangan mengarang fakta: ukuran/gramasi porsi, tingkat pedas selain ada atau tidak, halal/sertifikasi, dan statistik ("paling laris", "paling sering dipesan") TIDAK ada di data. Pakai kata "andalan" untuk menu andalan, dan untuk porsi bilang belum punya infonya (boleh kasih patokan umum yang jelas bertanda perkiraan).
- Saran menu HARUS dari data (rekomendasi_menu, cari_menu_atribut, tanya_detail_menu, lihat_menu). Bujet atau perkiraan total WAJIB lewat hitung_perkiraan_bujet, jangan menghitung sendiri. Jumlah porsi per orang boleh disarankan kira-kira (misal "biasanya 1 lauk per orang, camilan dibagi"), bilang itu perkiraan.
- Kalau customer menanyakan hal yang TIDAK ada di data (dekorasi, boleh/tidaknya membawa kue atau makanan dari luar, parkir, proyektor khusus, harga paket khusus, dll), jangan mengarang dan jangan menyiratkan boleh atau tidak boleh: bilang jujur belum punya infonya, dan LANGSUNG panggil forward_pesan_ke_kasir (urgent=false) di giliran yang sama supaya tim yang menjawab. Jangan berjanji "nanti aku teruskan" tanpa memanggil tool-nya, dan satu hal cukup diteruskan SEKALI (jangan diteruskan lagi di giliran berikutnya kalau sudah pernah). Fasilitas Cablaka hanya yang tercantum di info resto.
- Cablaka punya minimum order Rp2.000.000 (gratis pemakaian 3 jam). SEBELUM merekomendasikan Cablaka, bandingkan dengan perkiraan belanja customer (hitung_perkiraan_bujet kalau perlu). Kalau perkiraannya jelas di bawah itu, bilang jujur di pesan yang sama dan jadikan meja biasa pilihan utama; Cablaka tetap ditawarkan kalau customer memang mau ruang privat dan sanggup mencapai minimum. JANGAN memaksa customer menambah pesanan hanya demi memenuhi minimum.
- Jangan menawarkan hal di luar data sebagai kepastian (misal "meja biasa tetap bisa begini/begitu"). Yang pasti hanya: jam buka, menu dan harga, fasilitas Cablaka, DP dan minimum order, aturan reservasi.
- Konsultasi boleh lebih panjang dari aturan 1 kalimat (maksimal 4 kalimat pendek atau satu daftar bernomor), tetap santai dan to the point, lalu akhiri dengan satu pertanyaan atau langkah berikutnya.

SCOPE OBROLAN:
Bebas ngobrol apa saja yang nyambung ke: menu & harga, detail menu (bahan, pedas, alergen, dll), konsultasi memilih menu/tempat/acara dan bujet, reservasi, pesanan/transaksi, nomor meja, obrolan ringan terkait kunjungan mereka (lagi di jalan, mau makan rame-rame, dll). Kalau topiknya di luar itu total (politik, hal pribadi tidak relevan), tanggapi sopan & singkat, arahkan balik secara natural -- jangan menolak kaku.

ATURAN RESTO PENTING:
- Fakta layanan, harga, nasi, sambal, dan aturan ubah/batal ada di blok "INFO RESTO DAN ATURAN" di akhir prompt. Ikuti blok itu.
- Nomor meja DAN nama WAJIB ada sebelum QR dikirim. Kalau salah satunya belum ada saat masuk rincian/bayar, tanyakan SEKALIGUS dalam 1 kalimat (misal "Boleh tau nomor meja dan namanya, Mas/Mbak?"). Nama dipakai kasir untuk mencocokkan pembayaran. Kalau meja yang disebut ternyata sedang dipakai orang lain (hasil konfirmasi_kedatangan gagal), minta customer cek ulang nomor mejanya.
- Nasi putih (Rp10.000) ditawarkan lewat hasil buat_order (tawarkan_nasi), lihat bagian ALUR PESAN. Jangan menawarkan nasi di tempat lain.
- JANGAN PERNAH menjamin suatu menu bebas alergen tertentu, walau datanya tidak menyebut alergen itu. Kalau customer tanya soal alergi spesifik atau bilang punya alergi, jawab jujur bahwa data alergen berdasar resep umum dan perlu dipastikan ke dapur, lalu panggil forward_pesan_ke_kasir.

FORMAT PILIHAN (WAJIB):
- Setiap kali customer harus memilih di antara 2 atau lebih opsi (kopi/non-kopi, Mas/Mbak, panas/dingin, varian menu, kategori yang dimaksud, dll), tampilkan sebagai DAFTAR BERNOMOR: 1 kalimat tanya pendek, lalu satu opsi per baris ("1. ...", "2. ..."). JANGAN menaruh pilihan di dalam paragraf, karena sulit dibaca. Tujuannya customer cukup membalas SATU kata atau satu angka.
- Kalau customer membalas dengan angka ("2") atau satu kata, artikan sesuai daftar yang kamu kirim di pesan sebelumnya.
- Balasan customer atas daftar pilihan HARUS memicu tool yang sesuai di giliran yang SAMA (lihat_menu, buat_order, simpan_nama, atur_layanan). JANGAN hanya membalas teks konfirmasi ("siap", "mantap") tanpa memanggil tool, karena pilihannya tidak akan tercatat.
- JAWABAN AMBIGU: kalau maksud customer tidak jelas (misal "yg lain deh", "yang lain", "apa aja", "terserah", "yang itu"), JANGAN langsung memanggil tool dan JANGAN menebak. Tanya dulu dengan DAFTAR BERNOMOR (maks 4 opsi) apa yang dimaksud, baru panggil tool setelah jelas. Contoh setelah rekomendasi, customer bilang "yg lain deh": tanya "Mau lihat yang mana?" 1. Semua menu makan berat (kartu), 2. Pilih kategori (Sate/Goreng/Bakar, Nasi & Mie, ...), 3. Rekomendasi lain. Menu andalan hanya sebagian kecil dari seluruh menu, jangan pernah bilang "cuma ini yang tersedia".
- Kalau customer tanya favorit / rekomendasi / "enaknya apa" -> JAWAB dulu lewat rekomendasi_menu. Tampilkan 3-4 menu sebagai daftar bernomor dengan harga, lalu tanya mau yang mana (cukup balas nomor).

TAKE AWAY, PRE-ORDER, DAN NOMOR PESANAN:
- JANGAN menanyakan posisi/kedatangan dan JANGAN menanyakan dine in atau take away: default-nya sudah di resto dan dine in. Kalau customer sendiri minta take away, catat per menu di buat_order ("iga take away") atau atur_layanan tipe take_away kalau semuanya. Take away TANPA biaya kemasan. Tidak ada delivery.
- Hanya kalau customer sendiri bilang akan datang nanti ("aku dateng jam 7", "pesen buat nanti"), itu pre-order: panggil atur_layanan dengan kedatangan jam HH:MM. Jam datang dikirim format 24 jam HH:MM. Pesanan tetap dibayar dulu lewat QR. Dapur memasak setelah customer mengonfirmasi 30 menit sebelum jam datang (bot yang menanyakan, kamu cuma menjawab lewat jadwal_kedatangan kalau customer membalas). Kalau customer sudah di resto, semuanya langsung diproses seperti biasa.
- Menu tertentu take away/dine in beda dari yang lain -> tulis di buat_order apa adanya (misal "iga bakar 2 take away"), atau ubah_tipe_item untuk menu yang sudah ada di draft.
- Setiap pesanan punya NOMOR PESANAN harian (misal #007). Selalu sebut nomor itu ke customer (field nomor_pesanan), JANGAN pernah menyebut pesanan_id.
- Customer yang pesan sebelum datang: begitu sampai, minta nomor mejanya (konfirmasi_kedatangan), lalu arahkan: cari meja, lapor ke waiter sambil menyebut nomor pesanan.
- Customer bilang tidak jadi datang untuk pesanan yang SUDAH dibayar -> jadwal_kedatangan aksi "batal". Uang yang sudah dibayar TIDAK dikembalikan: sampaikan santai dan sopan, tanpa menyalahkan. Pesanan yang BELUM dibayar dibatalkan lewat batalkan_order.
- Pengembalian uang (misal menu habis setelah bayar) hanya tunai di kasir. Jangan menjanjikan transfer balik.

ALUR PESAN 3 FASE (PANDUAN LEMBUT, BUKAN JALUR KAKU):
- Tujuannya supaya customer tidak dibanjiri semua menu: menu dikirim BERTAHAP per bagian. Menu LENGKAP (semua halaman) HANYA dikirim kalau customer EKSPLISIT memintanya ("menu", "buku menu", "semua menu", "lihat semua"). "Ada apa aja", "yang enak apa", "bingung" BUKAN permintaan menu lengkap: jawab dengan pilihan jalur atau rekomendasi_menu.
- Urutan: jalur NYEMIL = camilan -> minuman -> makan berat. Jalur MAKAN BERAT = makan berat -> minuman -> camilan.
- Awal: setelah menyapa, tanya SATU hal (DAFTAR BERNOMOR): "1. Makan berat" dan "2. Nyemil". Jawaban -> pilih_jalur (gambar menu bagian pertama dikirim otomatis, jangan baca ulang harga). Kalau customer langsung memesan, menyebut bagian/kategori, atau bertanya hal lain, LAYANI itu dan jangan memaksa memilih jalur (jalur ditentukan otomatis dari pilihannya).
- UPSELL WAJIB KONSISTEN: setelah SETIAP pesanan masuk, lanjutkan menawarkan bagian berikutnya yang BELUM dipesan sesuai instruksi_alur dari hasil buat_order, walau customer sebelumnya sudah melihat menu lengkap atau bertanya acak. Berhenti hanya kalau customer menolak tawaran itu atau mengakhiri pesanan. Jangan menggantinya dengan sekadar "Ada lagi?" selama masih ada bagian yang belum ditawarkan.
- Fase berikutnya: UPSELL dulu, JANGAN langsung kirim menu. Tawarkan dengan 1 kalimat menggoda, sebut 1 rekomendasi (dari rekomendasi_upsell, itu menu prioritas). Menu bagian itu baru dikirim (lihat_menu) kalau customer tertarik.
- FLEKSIBEL (PENTING): kapan saja customer boleh pesan apa pun dari bagian mana pun, minta lihat bagian lain, tanya acak, plin-plan, atau loncat. Layani LANGSUNG. Sebuah bagian dianggap selesai HANYA kalau customer sudah memesan dari bagian itu atau menolak tawarannya; MELIHAT menu (termasuk menu lengkap) tidak menghentikan tawaran. JANGAN menolak atau menahan pesanan karena "belum fasenya".
- Customer chat pertama kali dianggap SUDAH duduk di resto dan makan di tempat (dine in). JANGAN menanyakan posisi/kedatangan dan JANGAN menanyakan dine in atau take away. Take away hanya kalau customer sendiri yang minta ("bungkus", "take away", "iga-nya dibungkus").
- SETIAP kali ada menu yang masuk (buat_order), balas dalam SATU pesan: "Pesanan sementara:" + ringkasan SEMUA item di draft (format angka, tanpa harga), lalu pertanyaan/pilihan sesuai catatan_untuk_ai dan instruksi_alur dari hasil tool (daftar bernomor singkat, atau "Ada lagi?" kalau semua bagian sudah ditawarkan).
- Menolak tawaran SPESIFIK ("nggak", "nggak dulu", "nggak usah minum") -> lewati_fase TANPA parameter: hanya bagian itu dilewati, sistem lalu menawarkan bagian berikutnya SEKALI. Ucapan MENGAKHIRI ("udah", "itu aja", "cukup", "gitu aja", "langsung bayar", "minta tagihan", "ga deh udah") -> LANGSUNG tampilkan_rincian_order, tanpa menawarkan apa-apa lagi dan tanpa bertanya "yakin?".
- Jawaban "kopi"/"non kopi"/"dua-duanya" pada tawaran minuman (atau nomornya) itu pilihan KELOMPOK -> lihat_menu dengan kelompok "kopi" / "non_kopi" / "minuman", BUKAN buat_order.
- TAWARAN NASI: kalau hasil buat_order memuat tawarkan_nasi, tambahkan "Tambah nasi putih (Rp10.000)" sebagai pilihan PERTAMA di daftar, SEKALI saja. Customer mau -> buat_order "nasi putih" dengan jumlah sama dengan porsi lauknya (atau sesuai yang dia sebut). Nasi goreng dan mie TIDAK ditawari nasi.
- tampilkan_rincian_order menampilkan item, Subtotal, PPN, Grand Total, lalu (kalau belum ada) tanya nomor meja dan nama sekaligus. Customer menjawab meja dan nama -> konfirmasi_kedatangan (isi nomor_meja dan nama). Customer setuju -> kirim_qr_pembayaran: kasir otomatis diminta membuat QR sebesar Grand Total, dan QR diteruskan ke customer begitu siap (beberapa menit). Jangan bilang "QR sudah dikirim" sebelum QR benar-benar tiba; katakan QR-nya "lagi disiapkan kasir".
- OPEN BILL: HANYA kalau customer sendiri minta bayar belakangan/open bill -> atur_cara_bayar cara "open_bill" (jangan menawarkan). Alur tetap sama sampai kirim_qr_pembayaran; bedanya pesanan langsung ke dapur tanpa QR. Customer boleh menambah pesanan berkali-kali. Saat customer minta bill/mau bayar -> minta_bill. Take away dan pre-order tidak bisa open bill (wajib bayar dulu), sampaikan santai.
- Pesanan tambahan setelah lunas diproses biasa: rangkum lalu minta konfirmasi.
- PPN: harga menu belum termasuk PPN 10%. JANGAN menyebut soal PPN/pajak kecuali customer menanyakannya (rincian sudah menampilkannya otomatis).

INFO RESTO, BOOKING, WAITER, KUIS, RATING:
- Customer tanya info resto / jam buka / last order / live music / kapasitas / ruang VIP / ruang meeting / booking -> panggil info_resto (sistem mengirim teks lengkapnya, jangan diulang), lalu 1 kalimat ajak lanjut (misal mau booking?). Pengecualian aturan 1 kalimat: teks dari tool boleh panjang karena dikirim sistem.
- Booking (ruang VIP / seluruh resto): kumpulkan tanggal, jam, jumlah orang, nama, dan (ruang VIP) smoking/non smoking, lalu ajukan_booking. Tool memberi tahu apa yang kurang; tanyakan semua yang kurang SEKALIGUS. Booking dikonfirmasi tim, jangan menjanjikan pasti. Ruang VIP wajib deposit di awal; QR deposit dikirim setelah tim menerima booking.
- Customer minta dipanggilkan waiter / butuh bantuan di meja -> panggil_waiter (butuh nomor meja; kalau belum ada, tanyakan).
- Kuis Banyumasan: setelah pesanan masuk dapur, sistem menawari kuis. Customer mau main -> mulai_kuis. Selama kuis berjalan, sistem yang memproses jawabannya.
- Rating: setelah meja dikosongkan, sistem menanyakan rating 1-5. Kalau customer menjawab dengan kata dan bukan angka yang jelas, tanya ulang "1 sampai 5, berapa nilainya?" (catat_rating hanya untuk angka yang jelas).
- Jam: resto hanya menerima pesanan saat buka dan sebelum last order (lihat baris JAM di STATE). Di luar itu sampaikan ramah dan jangan mencatat pesanan.

CARA KERJA:
- PILIHAN SPESIFIK MENANG: kalau customer menyebut kategori (misal "minuman tradisional", "gorengan", "sate") atau menu tertentu, itu yang dilayani (kartu kategori / catat pesanan). JANGAN balik bertanya kelompok/kopi-nonkopi lagi. Hanya kata umum seperti "kopi" (3 kategori) atau "minuman" yang menampilkan beberapa halaman.
- Customer menyebut JENIS minuman/makanan tertentu (tradisional, jamu, teh, jus, squash, espresso, flavored coffee, gorengan, sate, dll) -> lihat_menu dengan parameter kategori yang sesuai SAJA, JANGAN ikut memanggil dengan kelompok (kelompok hanya untuk kata umum: camilan, makan berat, kopi, non kopi, minuman). Satu panggilan cukup.
- Tanya menu / minta lihat menu / minta foto-pdf menu -> panggil lihat_menu: "menu" saja = semua halaman (kosongkan parameter); menyebut bagian (camilan, minuman, kopi, makan berat, gorengan, dll) = parameter kelompok/kategori yang sesuai. Selalu kirim lagi kalau diminta lagi.
- Customer menyebut NAMA UMUM yang punya banyak varian ("cimplung", "tongseng", "sate", "sroto", "nasi goreng", "mie") -> kirim nama umum itu apa adanya ke tanya_detail_menu, JANGAN memilih satu varian sendiri; tampilkan SEMUA varian sebagai daftar bernomor dengan harga supaya customer memilih (jawaban seperti "mix" / "yang ayam" lalu -> buat_order dengan nama lengkap menunya).
- Tanya hal spesifik soal 1/beberapa menu (bahan, pedas, alergi, cocok buat siapa, dll) -> panggil tanya_detail_menu, lalu jawab dari deskripsi yang didapat dengan gaya ngobrol, bukan baca manual.
- Customer tanya menu berdasarkan SIFAT ("yang nggak pedas?", "ada yang manis?", "yang pakai santan?", "dibakar atau digoreng?", "yang bukan daging sapi?", "yang berkuah?") -> panggil cari_menu_atribut dengan filter yang disebut saja (isi kelompok kalau konteksnya jelas). Tanya satu menu tertentu soal pedas/bahan/cara masak -> tanya_detail_menu (lihat field atribut). Data atribut itu PERKIRAAN: bilang "umumnya / biasanya", jangan menjamin, apalagi soal alergi (arahkan tanya kasir). Pedas hanya ada/tidak, jangan mengarang tingkat kepedasan. WAJIB memanggil cari_menu_atribut SETIAP kali ada pertanyaan sifat (walau pertanyaan mirip sudah dijawab sebelumnya), jangan menjawab dari ingatan percakapan.
- Sebut menu + jumlah mau dipesan -> panggil buat_order (ini MENAMBAH ke draft).
- Customer mengubah jumlah menu yang SUDAH ada di draft ("2 deh cimplung ubinya", "jadi 3 aja", "yang tadi 2 ya") -> panggil ubah_jumlah_item dengan jumlah TOTAL akhirnya, BUKAN buat_order. "Tambah 1 lagi" -> buat_order.
- Kalau ada menu yang ambigu (banyak varian cocok) dari hasil buat_order, tampilkan pilihan dengan format angka, tunggu jawaban customer, lalu panggil jawab_klarifikasi_menu.
- Kalau ada item yang butuh pilih porsi (penuh/setengah) atau opsi wajib (misal suhu panas/dingin) dari hasil buat_order, tampilkan pilihannya dengan format angka, tunggu jawaban customer, lalu panggil jawab_pilihan_menu. Jangan campur pertanyaan ini dengan pertanyaan klarifikasi nama menu dalam satu waktu kalau bisa dihindari, tapi kalau kebetulan dua-duanya ada, boleh ditanya sekaligus asal jelas mana untuk menu apa.
- Rincian (tampilkan_rincian_order) dan kirim QR (kirim_qr_pembayaran) WAJIB dua giliran terpisah: tampilkan rincian dulu, tunggu customer setuju ("ya", "oke", "kirim"), baru kirim QR.
- Customer sebut nomor meja / bilang sudah sampai kapan pun -> panggil konfirmasi_kedatangan. Kalau sebelumnya sudah setuju kirim QR dan cuma tertahan karena meja, setelah meja tercatat langsung panggil kirim_qr_pembayaran.
- Customer tanya status pesanan -> cek_status_order_saya.
- Customer mau batal pesanan yang belum dikonfirmasi -> batalkan_order.
- Customer komplain/minta sesuatu yang butuh kasir -> forward_pesan_ke_kasir, kabari customer dengan natural kalau itu sudah disampaikan. Catatan/permintaan biasa untuk pesanannya (misal "jangan pedas", "es-nya dipisah", "tanpa bawang") -> forward_pesan_ke_kasir dengan urgent=false: sistem menempelkannya di info pesanan ke kasir (bukan chat terpisah), cukup bilang "udah dicatat di pesanannya". Pakai urgent=true HANYA untuk komplain, alergi serius, atau hal mendesak.
- Obrolan biasa sesuai scope -> balas natural tanpa tool.
- Customer jawab soal menu yang dilaporkan habis setelah bayar (mau ganti/batal) -> panggil putuskan_item_habis.
- Kalau customer ganti ke menu yang lebih mahal dan ada kekurangan bayar, jelaskan nominalnya dan tanya apakah setuju. Kalau setuju -> panggil kirim_qr_kekurangan (giliran terpisah).
- Kalau ada lebih dari satu menu yang menunggu keputusan habis, tanyakan menu mana (format angka), lalu isi nama_menu saat memanggil putuskan_item_habis.
- Di akhir prompt mungkin ada blok "STATE SAAT INI" dari sistem. Itu fakta akurat, ikuti untuk menentukan tool yang tepat.

ATURAN PENULISAN WAJIB (PELANGGARAN = FATAL):
- Kapitalisasi normal bahasa Indonesia, BUKAN Title Case Di Setiap Kata.
- Jangan menyebut dirimu "AI", "bot", "sistem", atau "asisten virtual".
- MAKSIMAL 1 KALIMAT per balasan. Tidak ada kalimat pembuka, tidak ada basa-basi tambahan, tidak ada penutup yang tidak diminta.
- Pengecualian HANYA untuk: (a) daftar/rincian menu atau rincian pesanan (nama, qty, harga) yang WAJIB pakai format angka (1. 2. 3.), (b) kalau ada 2 informasi yang benar-benar tidak bisa digabung jadi 1 kalimat (misal: kabari sesuatu + tanya sesuatu yang beda topik), maksimal 2 kalimat pendek, titik, (c) pesan sambutan pertama ke customer baru, maksimal 3 kalimat dan wajib menyebut nama "The Banjoemas Resto & Cafe", (d) DAFTAR PILIHAN bernomor (1 kalimat tanya + satu opsi per baris), dan (e) KONSULTASI (lihat bagian KONSULTASI): maksimal 4 kalimat pendek.
- Kalau ada daftar, SETELAH daftar boleh tambah maksimal 1 kalimat pendek (misal pertanyaan lanjutan), bukan paragraf.
- JANGAN PERNAH pakai tanda strip panjang (—) atau double dash (--). Pakai koma, titik, atau kalimat baru.
- Selesaikan kalimat dengan lengkap, jangan terpotong.`;

const SYSTEM_PROMPT_OPERATOR = `Kamu adalah asisten kerja untuk kasir "The Banjoemas Resto & Cafe". Operator ini rekan kerja yang kamu bantu urus operasional: konfirmasi bayar, kelola menu, broadcast promo, handle eskalasi.

Gaya bicaramu ke kasir:
- Langsung, efisien, seperti rekan kerja yang paham kerjaan, bukan customer service formal.
- Boleh bahasa santai/informal khas chat kerja, boleh sesekali kata Jawa santai kalau pas (nggih, monggo) tapi tidak wajib -- prioritas tetap jelas dan efisien.

CARA KERJA:
- QR pembayaran sekarang DINAMIS: saat customer setuju rincian, SEMUA kasir menerima pesan "💳 MINTA QR" berisi nomor pesanan, nama, meja (atau jam datang untuk pre-order), isi pesanan, Subtotal, PPN 10%, dan Grand Total. Kasir membuat QRIS di POS, memfoto, lalu mengirim fotonya ke chat ini (idealnya reply pesan MINTA QR, atau tulis "pesanan 7" di caption). Foto itu diteruskan sistem ke customer otomatis (bukan lewat tool). Kalau kasir mengirim foto QR tanpa petunjuk dan ada beberapa permintaan menunggu, sistem yang bertanya balik pesanan mana.
- Pembayaran dicocokkan lewat nomor pesanan/nama itu. Harga menu BELUM termasuk PPN 10%; total yang dibayar customer = Grand Total.
- OPEN BILL: pesanan langsung masuk dapur (tiket bertanda OPEN BILL, belum bayar). Saat customer minta bill, kasir menerima "💳 MINTA QR | BILL" berisi semua pesanan dan total; setelah kasir mengirim foto QR dan customer membayar, kasir bilang "meja 5 udah bayar" -> konfirmasi_bayar (semua pesanan open bill customer itu lunas sekaligus).
- Booking: kasir menerima "📅 BOOKING #n". Kasir membalas "booking 3 diterima/ditolak" -> konfirmasi_booking. Booking ruang VIP yang diterima meminta DP Rp400.000 (minimum spend ruangan Rp2.000.000) lewat alur QR yang sama; kalau kasir bilang "deposit booking 3 sudah masuk" -> konfirmasi_deposit_booking.
- Waiter dipanggil lewat pesan "🔔 PANGGIL WAITER | Meja n", info saja, tidak perlu tool. Setelah 3 jam sejak pesanan pertama, kasir menerima "⏰ Meja n sudah 3 jam, sudah kosong?": kalau sudah kosong, kasir bilang "meja n kosong" -> selesaikan_meja (customer otomatis ditanya rating).
- Kasir merujuk pesanan lewat NOMOR PESANAN harian ("pesanan 7" = #007), isi parameter nomor_pesanan. Jangan pakai pesanan_id (itu ID internal).
- Pesanan pre-order (customer belum sampai) punya jam datang; tiketnya ke staf bertanda BELUM DIMASAK sampai customer konfirmasi, lalu kasir/dapur dapat pesan "MULAI MASAK". Menu take away ditandai [TAKE AWAY] di tiket.
- Pengembalian uang hanya tunai di kasir. Customer yang tidak jadi datang setelah bayar tidak mendapat pengembalian.
- Begitu kasir dengar/lihat pembayaran masuk (dari bunyi EDC/alat atau cek manual), dan bilang semacam "meja 5 udah bayar" atau sebut ID pesanan -> panggil konfirmasi_bayar. INI AUTO-APPROVE, tidak perlu tanya ulang ke kasir, langsung proses begitu jelas pesanan mana yang dimaksud.
- Kalau kasir sebut nomor meja/nama yang ambigu (ada beberapa pesanan aktif di meja/nama itu, atau tidak ketemu), tanya balik dengan singkat SEBELUM manggil tool dengan parameter ngasal.
- Operator bisa minta apapun terkait operasional: update menu, broadcast, cek order, batalkan, kirim ulang QR, kelola operator, cek stok menu, statistik.
- Kalau kasir sebut "order tadi"/"yang barusan", cari dari histori percakapan.
- Chat biasa/basa-basi -> balas natural tanpa tool.
- Setelah tool jalan, sampaikan hasilnya dengan jelas dan natural, bukan data mentah.
- Kalau kasir bilang kekurangan bayar/selisih (karena customer ganti menu lebih mahal) sudah dibayar -> panggil konfirmasi_bayar_kekurangan, bukan konfirmasi_bayar.
- Kalau kasir/staf membalas tiket pesanan dengan "habis <menu> meja X" (lihat tiketnya di histori), panggil lapor_menu_habis_setelah_bayar dengan nama_menu dan nomor_meja itu.
- Kasir bilang meja sudah kelar/kosong/selesai ("meja 5 udah kelar") -> panggil selesaikan_meja. Kalau ditolak karena masih ada pesanan menunggu bayar, sampaikan ke kasir, dan baru panggil ulang dengan paksa=true kalau kasir menegaskan tetap kosongkan.

ATURAN PENULISAN WAJIB (PELANGGARAN = FATAL):
- Kapitalisasi normal bahasa Indonesia, BUKAN Title Case Di Setiap Kata.
- Jangan menyebut dirimu "AI", "bot", "sistem", atau "asisten virtual".
- MAKSIMAL 1 KALIMAT per balasan, kecuali menampilkan daftar/data (pakai format angka 1. 2. 3.). Setelah daftar, boleh tambah maksimal 1 kalimat pendek.
- JANGAN PERNAH pakai tanda strip panjang (—) atau double dash (--). Pakai koma, titik, atau kalimat baru.
- Selesaikan kalimat dengan lengkap, jangan terpotong.`;

// ========== ORKESTRATOR (identik pola dengan contoh) ==========

// Klaim berisiko tinggi yang tidak boleh keluar tanpa tool-nya benar-benar berhasil: customer akan menunggu/membayar.
// Apakah pesan customer menyebut nama/alias menu yang ada (dipakai untuk memastikan klaim "sudah dicatat" memang soal menu)
function pesanMenyebutMenu(pesan) {
  const t = ' ' + normalisasiNama(String(pesan || '')) + ' ';
  if (t.trim().length < 3) return false;
  for (const m of db.getAllMenu()) {
    for (const n of [m.nama, ...(m.alias || [])]) {
      const nn = normalisasiNama(n);
      if (nn.length >= 4 && t.includes(' ' + nn + ' ')) return true;
    }
  }
  return false;
}

const TOOL_PENCATAT_ORDER = ['buat_order', 'hitung_perkiraan_bujet', 'ubah_jumlah_item', 'hapus_item_order', 'ubah_tipe_item', 'jawab_klarifikasi_menu', 'jawab_pilihan_menu', 'tanya_detail_menu', 'lihat_menu', 'cari_menu_atribut', 'rekomendasi_menu', 'cek_status_order_saya', 'forward_pesan_ke_kasir', 'putuskan_item_habis', 'tampilkan_rincian_order', 'batalkan_order', 'atur_layanan'];

const KLAIM_BERISIKO = [
  // Customer menyebut/berubah pikiran soal menu ("eh yang tadi aja deh mie"), AI membalas "siap, Mie Godog x1" tanpa tool: tidak tercatat.
  {
    klaim: 'menu yang disebut customer sudah ditanggapi/dicatat',
    re: { test: (t) => pesanMenyebutMenu(t) && /\b(siap|oke|sip|baik|noted|jadi|beres|ya)\b/i.test(t) },
    tool: TOOL_PENCATAT_ORDER,
    hanyaJika: (pesanUser) => pesanMenyebutMenu(pesanUser) && !/\?/.test(pesanUser),
  },
  {
    klaim: 'QR pembayaran sudah dikirim',
    re: /\bqr\b[^.\n]{0,80}\b(sudah|udah|telah)\b[^.\n]{0,25}\b(terkirim|(di)?kirim(in|kan)?)\b|\b(sudah|udah|telah)\b[^.\n]{0,20}\b(kirim|kirimin|kirimkan)\b[^.\n]{0,20}\bqr\b/i,
    tool: ['kirim_qr_pembayaran', 'kirim_qr_kekurangan', 'kirim_ulang_qr'],
  },
  // Sisi KASIR: kasir mengabari pembayaran masuk, AI membalas "sudah lunas" tapi tidak memanggil konfirmasi_bayar,
  // jadi pesanan tidak benar-benar lunas, customer tidak dikabari, dan tiket tidak sampai ke staf.
  // Hanya berlaku kalau PESAN KASIR memang kabar pembayaran (bukan pertanyaan status seperti "udah bayar belum?").
  {
    klaim: 'pembayaran sudah dikonfirmasi (lunas)',
    re: /\b(sudah|udah|telah)\b[^.\n]{0,30}\blunas\b|\blunas\b[^.\n]{0,30}\b(sudah|udah)\b|\bdikonfirmasi\b|\b(sudah|udah)\b[^.\n]{0,15}\b(diteruskan|dikabari)\b[^.\n]{0,20}\b(dapur|customer)\b/i,
    tool: ['konfirmasi_bayar', 'konfirmasi_bayar_kekurangan'],
    hanyaJika: (pesanUser) => /\b(udah|sudah|telah)\s+(bayar|lunas|masuk)\b|\bbayar(an)?\s+(udah|sudah|masuk)\b/i.test(pesanUser) && !/\?|\bbelum\b/i.test(pesanUser),
  },
  // Kasir bilang meja sudah kelar, AI membalas "sudah dikosongkan" tanpa selesaikan_meja: meja tetap terkunci.
  {
    klaim: 'meja sudah dikosongkan',
    re: /\bmeja\b[^.\n]{0,30}\b(sudah|udah)\b[^.\n]{0,20}\b(dikosongkan|kosong|bisa dipakai)\b/i,
    tool: ['selesaikan_meja'],
    hanyaJika: (pesanUser) => /\bmeja\b[^.\n]{0,25}\b(kelar|kosong|selesai)\b|\b(kelar|kosongkan)\b[^.\n]{0,15}\bmeja\b/i.test(pesanUser) && !/\?/.test(pesanUser),
  },
  // AI menyebut DAFTAR MENU (bernomor) dari ingatan/karangan tanpa tool pencari: nama menu bisa salah ("Iga Kambing Bakar" tidak ada).
  {
    klaim: 'daftar menu',
    re: { test: (t) => jumlahBarisNamaMenu(t) >= 2 },
    tool: ['cari_menu_atribut', 'rekomendasi_menu', 'hitung_perkiraan_bujet', 'lihat_menu', 'tanya_detail_menu', 'buat_order', 'jawab_klarifikasi_menu', 'jawab_pilihan_menu', 'tampilkan_rincian_order', 'cek_status_order_saya', 'ubah_jumlah_item', 'hapus_item_order', 'ubah_tipe_item', 'putuskan_item_habis'],
    kecuali: (t) => /pesanan sementara\s*:|rincian pesanan\b/i.test(t), // ditangani aturan lain
  },
  // AI menulis daftar "Pesanan sementara:" dari ingatan percakapan padahal menu itu tidak pernah masuk draft (buat_order tidak dipanggil).
  {
    klaim: 'daftar pesanan sementara',
    re: /pesanan sementara\s*:/i,
    tool: ['buat_order', 'ubah_jumlah_item', 'hapus_item_order', 'ubah_tipe_item', 'cek_status_order_saya', 'tampilkan_rincian_order', 'cek_status_order'],
  },
  // Rincian ditulis tanpa memanggil tampilkan_rincian_order: harga dan total jadi karangan atau kosong.
  {
    klaim: 'rincian pesanan',
    re: /rincian pesanan\b[^\n]{0,15}:/i,
    tool: ['tampilkan_rincian_order', 'cek_status_order_saya', 'cek_status_order'],
  },
  // Customer menyebut menu, AI membalas "sudah dicatat" tanpa memanggil tool yang menyimpan.
  {
    klaim: 'menu sudah dicatat ke pesanan',
    re: /\b(sudah|udah|telah)\b[^.\n]{0,20}\b(dicatat|tercatat|dimasukkan|ditambahkan|kucatat|kutambah(kan)?)\b|\b(aku|saya)\b[^.\n]{0,15}\b(catat|tambah(kan)?|masukin|masukkan)\b/i,
    tool: ['buat_order', 'ubah_jumlah_item', 'hapus_item_order', 'ubah_tipe_item', 'forward_pesan_ke_kasir', 'jawab_pilihan_menu'],
    hanyaJika: (pesanUser) => pesanMenyebutMenu(pesanUser) && !/\?/.test(pesanUser),
  },
  // Customer bilang batal / tidak jadi datang, AI membalas "pesanan aku batalkan" tanpa tool: status tidak berubah dan staf tidak tahu.
  {
    klaim: 'pesanan sudah dibatalkan',
    re: /\b(sudah|udah)\b[^.\n]{0,25}\b(dibatalkan|dibatalin)\b|\b(aku|saya|kami)\b[^.\n]{0,15}\b(batalkan|batalin)\b|\bdibatalkan\b/i,
    kecuali: (teks) => /\b(tidak|nggak|gak|ga|belum|bukan|enggak)\b[^.\n]{0,20}\b(dibatalkan|dibatalin|batalkan|batalin)\b/i.test(teks),
    tool: ['jadwal_kedatangan', 'batalkan_order', 'batalkan_order_paksa'],
    hanyaJika: (pesanUser) => /\b(ga|gak|nggak|enggak|tidak)\s+jadi\b|\bbatal(in|kan)?\b/i.test(pesanUser) && !/\?/.test(pesanUser),
  },
];

// Berapa baris bernomor ("1. Sroto Ayam, Rp47.000") yang namanya PERSIS nama menu di data
function jumlahBarisNamaMenu(teks) {
  let n = 0;
  for (const m of String(teks || '').matchAll(/^\s*\d+[.)]\s*([^\n,:(\-–]+?)\s*(?:[,:(\-–]|\s+Rp\s?\d|$)/gim)) {
    const nama = m[1].trim();
    if (nama.length < 3 || nama.length > 40) continue;
    const cocok = cariKandidatMenu(nama);
    if (cocok.statusMatch === 'YAKIN' && cocok.skorTerbaik === 1) n++;
  }
  return n;
}

function klaimTanpaBukti(teks, toolBerhasil, pesanUser = '') {
  const t = String(teks || '');
  for (const k of KLAIM_BERISIKO) {
    if (k.hanyaJika && !k.hanyaJika(String(pesanUser || ''))) continue;
    if (k.kecuali && k.kecuali(t)) continue;
    if (k.re.test(t) && !k.tool.some((n) => toolBerhasil.has(n))) return k;
  }
  return null;
}

// ========== ROUTER PILIHAN SPESIFIK (dijalankan KODE sebelum AI) ==========
// Customer yang menyebut kategori secara spesifik ("minuman tradisional", "gorengan", "sate") tidak perlu ditanya
// kelompok/jalur lagi: kartu kategori itu langsung dikirim. Kata pengantar dibuang, sisanya harus PERSIS nama/alias kategori.
const KATA_PENGANTAR = new Set(['mau', 'pesan', 'lihat', 'liat', 'lihatin', 'dong', 'deh', 'aja', 'saja', 'yang', 'menu', 'menunya', 'minta', 'ada', 'apa', 'ya', 'yaa', 'kak', 'mas', 'mba', 'mbak', 'aku', 'saya', 'cari', 'pengen', 'ingin', 'nih', 'min', 'tolong', 'boleh', 'kartu', 'daftar', 'pilih', 'dulu', 'coba', 'tampilkan', 'kasih', 'tunjukin', 'sih', 'donk', 'mulai', 'dari', 'di', 'ke', 'untuk', 'kategori', 'bagian', 'jadi', 'kalau', 'yg']);

function kategoriDariPesan(pesan) {
  const t = atribut.norm(pesan);
  if (!t || /\d/.test(t)) return null;
  const kata = t.split(' ').filter((k) => !KATA_PENGANTAR.has(k));
  if (kata.length === 0 || kata.length > 4) return null;
  const inti = kata.join(' ');
  const menu = cariKandidatMenu(inti);
  if (menu.statusMatch === 'YAKIN' && menu.skorTerbaik === 1) return null; // nama menu persis = memesan, bukan memilih kategori
  return atribut.cariKategoriDariTeks(inti, db.getAllKategori(), { persis: true });
}

// Sinonim kelompok menu. Customer sering mengetik "cemilan", "snack", "nyemil", "minum", dengan typo. Dicocokkan fleksibel
// (persis atau selisih 1-2 huruf), tapi hanya kalau seluruh pesan (setelah kata pengantar dibuang) memang berisi kata itu.
const SINONIM_KELOMPOK = {
  camilan: ['camilan', 'cemilan', 'camil', 'cemil', 'snack', 'snek', 'nyemil', 'ngemil', 'nyamil', 'jajan', 'jajanan', 'kudapan', 'makanan ringan', 'cemal cemil', 'camilannya', 'cemilannya', 'cemilan nya', 'camilan nya'],
  berat: ['makan berat', 'makanan berat', 'menu berat', 'menu utama', 'makanan utama', 'berat', 'main course', 'makan besar', 'beratnya'],
  kopi: ['kopi', 'coffee', 'ngopi', 'kopinya', 'kopi kopian'],
  non_kopi: ['non kopi', 'nonkopi', 'bukan kopi', 'non kopinya'],
  minuman: ['minuman', 'minum', 'drink', 'drinks', 'beverage', 'minumannya', 'minuman nya', 'haus'],
};

function kelompokDariFrasa(frasa) {
  const inti = atribut.norm(frasa);
  if (!inti) return null;
  let terbaik = null;
  for (const [kelompok, daftar] of Object.entries(SINONIM_KELOMPOK)) {
    for (const s of daftar) {
      const batas = s.length <= 4 ? 0 : s.length <= 8 ? 1 : 2; // kata pendek harus persis, supaya tidak salah tangkap
      const jarak = inti === s ? 0 : distance(inti, s);
      if (jarak <= batas && (!terbaik || jarak < terbaik.jarak)) terbaik = { kelompok, jarak };
    }
  }
  return terbaik ? terbaik.kelompok : null;
}

function kelompokDariPesan(pesan) {
  const t = atribut.norm(pesan);
  if (!t || /\d/.test(t)) return null;
  const kata = t.split(' ').filter((k) => !KATA_PENGANTAR.has(k));
  if (kata.length === 0 || kata.length > 3) return null;
  const inti = kata.join(' ');
  const menu = cariKandidatMenu(inti);
  if (menu.statusMatch === 'YAKIN' && menu.skorTerbaik === 1) return null; // nama menu persis = memesan
  return kelompokDariFrasa(inti);
}

// "menu", "minta menu dong", "lihat menu", "buku menu", "ada menu apa aja" = minta SEMUA menu
const KATA_MINTA_MENU = new Set(['mau', 'minta', 'lihat', 'liat', 'lihatin', 'dong', 'deh', 'aja', 'saja', 'menu', 'menunya', 'buku', 'daftar', 'semua', 'full', 'lengkap', 'kirim', 'kirimin', 'kirimkan', 'tolong', 'boleh', 'kak', 'mas', 'mba', 'mbak', 'ya', 'yaa', 'donk', 'pdf', 'foto', 'gambar', 'list', 'apa', 'ada', 'yang', 'dong', 'nya', 'min', 'admin', 'pesan', 'order', 'dulu', 'coba', 'tampilkan', 'kasih', 'tunjukin', 'sih', 'nih']);
function mintaMenuLengkap(pesan) {
  const t = atribut.norm(pesan);
  if (!t || /\d/.test(t)) return false;
  const kata = t.split(' ');
  return kata.length <= 6 && kata.includes('menu') || kata.includes('menunya') ? kata.every((k) => KATA_MINTA_MENU.has(k)) : false;
}

// Hasil: { nama, argumen } untuk tool yang dijalankan kode lebih dulu, atau null.
const KATA_SETUJU_QR = new Set(['ya', 'iya', 'iyaa', 'iy', 'y', 'yup', 'yoi', 'ok', 'oke', 'okay', 'siap', 'sip', 'lanjut', 'gas', 'kirim', 'kirimin', 'boleh', 'mantap', 'yes', 'deh', 'dong', 'aja', 'saja', 'silakan', 'qr', 'qris', 'nya', 'bayar', 'sekarang', 'langsung', 'udah', 'sudah', 'fix', 'benar', 'betul', 'sesuai', 'ke', 'kirimkan']);
const KATA_INTI_SETUJU = new Set(['ya', 'iya', 'iyaa', 'iy', 'y', 'yup', 'yoi', 'ok', 'oke', 'okay', 'siap', 'sip', 'lanjut', 'gas', 'kirim', 'kirimin', 'boleh', 'mantap', 'yes', 'fix', 'benar', 'betul', 'sesuai', 'kirimkan']);

// Customer menyetujui rincian ("ya", "iya, kirim QR-nya", "lanjut") = kirim QR, kalau data wajibnya sudah lengkap.
function pesanMenyetujuiQr(pesan) {
  const kata = atribut.norm(pesan).replace(/\bqr nya\b/g, 'qr').split(' ').filter(Boolean);
  if (kata.length === 0 || kata.length > 6) return false;
  return kata.every((k) => KATA_SETUJU_QR.has(k)) && kata.some((k) => KATA_INTI_SETUJU.has(k));
}

// Jawaban atas pengingat 30 menit ("iya jadi, aku sampai tepat waktu kok") = konfirmasi kedatangan.
function pesanMengonfirmasiKedatangan(pesan) {
  const t = atribut.norm(pesan);
  if (!t || t.length > 80 || /\d/.test(t)) return false;
  if (/\b(tidak|nggak|ngga|enggak|gak|ga|batal|ubah|mundur|maju|telat|terlambat|belum|lambat|jam|pukul|nanti|kemungkinan)\b/.test(t)) return false;
  return /\b(iya|ya|yap|yup|oke|ok|siap|jadi|tetap|gas|sampai|datang)\b/.test(t);
}

function praRouterCustomer(jid, pesan) {
  if (getKlarifikasiPending(jid)?.length || getPilihanPending(jid)?.length) return null; // customer sedang menjawab pertanyaan lain

  // Pengingat pre-order sudah dikirim dan customer menjawab "iya jadi": dapur mulai masak (kode, bukan tebakan AI)
  if (db.getPreOrderAktifByCustomer(jid).some((p) => p.jadwal_status === 'DITANYA') && pesanMengonfirmasiKedatangan(pesan)) {
    return { nama: 'jadwal_kedatangan', argumen: { aksi: 'konfirmasi' } };
  }

  const draft = db.getDraftAtauMenungguBayarByCustomer(jid);
  if (draft && draft.status === 'MENUNGGU_BAYAR') return null;
  if (draft && draft.subtotal) {
    // Tahap rincian: persetujuan + data lengkap = kirim QR. Selain itu teks pendek adalah data diri, serahkan ke AI.
    const lengkap = dataKurangUntukQr(db.getCustomer(jid), draft).kurang.length === 0;
    return lengkap && pesanMenyetujuiQr(pesan) ? { nama: 'kirim_qr_pembayaran', argumen: {} } : null;
  }
  // "nasi" saat sedang memesan lauk = nasi putih (ditangani AI), bukan minta kategori Nasi & Mie
  if (/^(nasi|nasinya)$/.test(atribut.norm(pesan)) && draft && db.getItemsByPesananId(draft.id).some((i) => i.status_item === 'AKTIF')) return null;
  const idKategori = kategoriDariPesan(pesan);
  if (idKategori) return { nama: 'lihat_menu', argumen: { kategori: idKategori } };
  const kelompok = kelompokDariPesan(pesan);
  if (kelompok) return { nama: 'lihat_menu', argumen: { kelompok } };
  if (mintaMenuLengkap(pesan)) return { nama: 'lihat_menu', argumen: {} };
  return null;
}

// Customer menyebut kategori/menu tertentu = jalur ditentukan dari situ (minuman ikut jalur nyemil, seperti pesanan langsung).
function tetapkanJalurDariKategori(jid, kategoriId) {
  const alur = db.getAlur(jid);
  if (alur.tutup || alur.jalur) return;
  const fase = faseDariKategoriId(kategoriId);
  if (!fase) return;
  db.setAlur(jid, { jalur: fase === 'berat' ? 'berat' : 'camilan', selesai: alur.selesai, tutup: false });
}

async function jalankanAgent({ systemPrompt, tools, historiChat, pesanBaru, eksekutorTools, konteks }) {
  if (konteks) konteks.pesanTerakhir = pesanBaru; // dipakai tool yang harus memastikan jawaban benar-benar datang dari customer
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historiChat,
    { role: 'user', content: pesanBaru },
  ];

  let iterasi = 0;
  let koreksi = 0;
  const toolBerhasil = new Set(); // nama tool yang berhasil dipanggil di giliran ini

  // Pilihan spesifik customer dijalankan kode lebih dulu, hasilnya disisipkan seolah AI sendiri yang memanggil tool
  const pra = konteks?.jid && eksekutorTools === EKSEKUTOR_CUSTOMER ? praRouterCustomer(konteks.jid, pesanBaru) : null;
  if (pra) {
    const idPra = 'pra_' + Date.now();
    console.log(`🧭 Router kode memanggil tool: ${pra.nama}(${JSON.stringify(pra.argumen)})`);
    let hasilPra;
    try { hasilPra = await eksekutorTools[pra.nama](pra.argumen, konteks); } catch (err) { hasilPra = { error: 'Gagal eksekusi: ' + err.message }; }
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: idPra, type: 'function', function: { name: pra.nama, arguments: JSON.stringify(pra.argumen) } }] });
    messages.push({ role: 'tool', tool_call_id: idPra, content: JSON.stringify(hasilPra) });
    if (hasilPra && hasilPra.sukses !== false && !hasilPra.error) toolBerhasil.add(pra.nama);
  }

  while (iterasi < MAX_TOOL_ITERATIONS) {
    iterasi++;

    let completion;
    try {
      completion = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.6, // diturunkan supaya lebih patuh ke instruksi panjang-pendek, masih cukup variatif
      });
    } catch (err) {
      console.error('❌ Agent API error:', err.message);
      return { jawabanFinal: null, error: err.message };
    }

    const pesanAi = completion.choices[0].message;
    messages.push(pesanAi);

    if (!pesanAi.tool_calls || pesanAi.tool_calls.length === 0) {
      // Pengaman: AI kadang MENGARANG hasil ("QR sudah dikirim") tanpa memanggil tool-nya. Beri satu kesempatan koreksi.
      const klaim = koreksi < 1 ? klaimTanpaBukti(pesanAi.content, toolBerhasil, pesanBaru) : null;
      if (klaim) {
        koreksi++;
        console.log(`⚠️  AI mengklaim "${klaim.klaim}" tanpa memanggil ${klaim.tool.join('/')}, diminta koreksi.`);
        messages.push({
          role: 'user',
          content: `[KOREKSI SISTEM] Balasanmu menyebut ${klaim.klaim}, tapi tool ${klaim.tool.join(' / ')} belum berhasil dipanggil di giliran ini, jadi itu belum terjadi. Jangan mengarang. Panggil tool yang sesuai SEKARANG; kalau syaratnya belum terpenuhi (misal data kurang), jelaskan apa yang kurang dan tanyakan ke customer.`,
        });
        continue;
      }
      return { jawabanFinal: pesanAi.content, error: null, toolBerhasil: [...toolBerhasil] };
    }

    for (const toolCall of pesanAi.tool_calls) {
      const namaFungsi = toolCall.function.name;
      let argumen;
      try {
        argumen = JSON.parse(toolCall.function.arguments);
      } catch {
        argumen = {};
      }

      console.log(`🔧 Agent manggil tool: ${namaFungsi}(${JSON.stringify(argumen)})`);

      let hasilTool;
      try {
        const fungsiEksekutor = eksekutorTools[namaFungsi];
        hasilTool = fungsiEksekutor
          ? await fungsiEksekutor(argumen, konteks)
          : { error: `Tool ${namaFungsi} tidak dikenali.` };
      } catch (err) {
        console.error(`❌ Error eksekusi tool ${namaFungsi}:`, err.message);
        hasilTool = { error: `Gagal eksekusi: ${err.message}` };
      }

      if (hasilTool && hasilTool.sukses !== false && !hasilTool.error) toolBerhasil.add(namaFungsi);
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(hasilTool) });
    }
  }

  console.log('⚠️  Agent mencapai batas iterasi maksimal.');
  return { jawabanFinal: 'Maaf ya, lagi ada kendala teknis. Boleh diulang pesannya?', error: 'MAX_ITERATIONS' };
}

// ========== EKSEKUTOR — CUSTOMER ==========

async function eksekusiLihatMenu(args, konteks) {
  let { kategori, kelompok } = args || {};
  // "kopi" mencakup 3 kategori, "non kopi" banyak: itu KELOMPOK, bukan satu kategori
  const kataKategori = kategori ? atribut.norm(kategori) : '';
  // Kata kelompok dikenali fleksibel ("cemilan", "snack", "nyemil", typo ringan), tapi nama kategori asli (misal "gorengan") tetap menang
  const adaKategoriAsli = kategori && db.getAllKategori().some((k) => atribut.norm(k.nama) === kataKategori || k.id === kataKategori);
  const kelompokDariKata = adaKategoriAsli ? null : kelompokDariFrasa(kataKategori);
  if (kelompokDariKata && !kelompok) { kelompok = kelompokDariKata; kategori = undefined; }
  // ---------- Kasus 0: 1 kelompok (berat / camilan / kopi / non_kopi / minuman) ----------
  if (kelompok && !kategori) {
    const daftarKat = db.getKategoriByKelompok(kelompok);
    if (daftarKat.length === 0) {
      return { sukses: false, pesan: `Tidak ada kategori untuk kelompok "${kelompok}".` };
    }
    const idKat = daftarKat.map((k) => k.id);
    tetapkanJalurDariKategori(konteks.jid, idKat[0]);
    const kirim = await kirimKartuKelompok(konteks, kelompok);
    const habis = db.getAllMenu().filter((m) => idKat.includes(m.kategori_id) && !m.tersedia).map((m) => m.nama);
    const daftarMenu = db.getMenuTersedia().filter((m) => idKat.includes(m.kategori_id));

    return {
      sukses: true,
      kelompok,
      kategori: kirim.kategori,
      daftar: kirim.terkirim ? undefined : daftarMenu.map((m) => `${m.nama}${m.andalan ? ' ⭐' : ''}: ${rp(m.varian[0]?.harga ?? '-')}`),
      kartu_terkirim: kirim.terkirim,
      info_menu_habis: habis.length > 0
        ? `Menu di kelompok ini yang hari ini HABIS (kartu gambar masih menampilkannya): ${habis.join(', ')}. Sebutkan singkat.`
        : undefined,
      catatan_untuk_ai: kirim.terkirim
        ? 'Gambar menu bagian ini sudah dikirim. Balas 1 kalimat singkat saja (misal "Nih, mau pesan yang mana?"), jangan baca ulang harga atau nama menu.'
        : 'Gambar kartu tidak tersedia, sebutkan daftar menu & harga dengan format angka.',
    };
  }

  // ---------- Kasus 1: customer sudah pilih kategori spesifik ----------
  if (kategori) {
    const semuaKategori = db.getAllKategori();
    const katCocok = semuaKategori.find(
      (k) => k.nama.toLowerCase() === kategori.toLowerCase() || k.id.toLowerCase() === kategori.toLowerCase()
    ) || semuaKategori.find((k) => k.nama.toLowerCase().includes(kategori.toLowerCase()))
      || semuaKategori.find((k) => k.id === atribut.cariKategoriDariTeks(kategori, semuaKategori, { persis: true }));

    if (!katCocok) {
      return { sukses: false, pesan: `Tidak ada kategori "${kategori}".` };
    }

    const menuDiKategori = db.getMenuTersedia().filter((m) => m.kategori_id === katCocok.id);
    if (menuDiKategori.length === 0) {
      return { sukses: false, pesan: `Belum ada menu tersedia di kategori "${katCocok.nama}" saat ini.` };
    }

    const habisDiKategori = db.getAllMenu()
      .filter((m) => m.kategori_id === katCocok.id && !m.tersedia)
      .map((m) => m.nama);

    tetapkanJalurDariKategori(konteks.jid, katCocok.id);
    const hasilKirim = await konteks.kirimKartuKategori(konteks.jid, katCocok);

    return {
      sukses: true,
      kategori: katCocok.nama,
      daftar: menuDiKategori.map((m) => {
        const hargaTampil = m.varian.length === 1
          ? `${rp(m.varian[0].harga)}`
          : m.varian.map((v) => `${v.label} ${rp(v.harga)}`).join(' / ');
        return `${m.nama}${m.andalan ? ' ⭐' : ''}: ${hargaTampil}`;
      }),
      kartu_terkirim: hasilKirim !== 'tidak_ada',
      info_menu_habis: habisDiKategori.length > 0
        ? `Menu di kategori ini yang hari ini HABIS (tidak bisa dipesan, tapi kartu gambar masih menampilkannya): ${habisDiKategori.join(', ')}. Sebutkan ini singkat ke customer.`
        : undefined,
      catatan_untuk_ai: hasilKirim !== 'tidak_ada'
        ? 'Kartu kategori sudah/sedang dikirim terpisah oleh sistem, cukup sebutkan itu secara singkat, tidak perlu baca ulang semua harga satu-satu karena sudah ada di gambar.'
        : 'Gambar kartu kategori tidak tersedia, jadi sebutkan daftar menu & harga di atas dengan format angka.',
    };
  }

  // ---------- Kasus 2: lihat semua menu / minta "menu pdf" / "foto menu" ----------
  const hasilKirim = await konteks.kirimSemuaKartuKategori(konteks.jid);
  const semuaKategori = db.getAllKategori();
  const semuaHabis = db.getAllMenu().filter((m) => !m.tersedia).map((m) => m.nama);

  return {
    sukses: true,
    ringkas: true,
    kategori: semuaKategori.map((k) => k.nama),
    kartu_terkirim: hasilKirim,
    info_menu_habis: semuaHabis.length > 0
      ? `Menu yang hari ini HABIS (tidak bisa dipesan, tapi kartu gambar masih menampilkannya): ${semuaHabis.join(', ')}. Sebutkan ini singkat ke customer.`
      : undefined,
    catatan_untuk_ai: hasilKirim
      ? 'Buku menu lengkap (semua halaman) sudah dikirim sebagai gambar. Balas 1 kalimat pendek saja (misal "Nih menunya, mau pesan yang mana?"). JANGAN mendaftar kategori atau menu, karena sudah ada di gambar.'
      : 'Gambar menu tidak tersedia. Sebutkan singkat bagian menu yang ada (gorengan, sate, kopi, dll) dan tanya mau lihat yang mana.',
  };
}

async function eksekusiCariMenuAtribut(args, konteks) {
  const { kelompok } = args || {};
  let daftar = db.getMenuTersedia();
  if (kelompok) {
    const idKat = db.getKategoriByKelompok(kelompok).map((k) => k.id);
    if (idKat.length === 0) return { sukses: false, pesan: `Kelompok "${kelompok}" tidak dikenal (pakai: berat, camilan, kopi, non_kopi, minuman).` };
    daftar = daftar.filter((m) => idKat.includes(m.kategori_id));
  }
  const ada = ['rasa', 'bahan', 'tanpa_bahan', 'bumbu', 'tanpa_bumbu', 'masak'].some((k) => Array.isArray(args?.[k]) && args[k].length)
    || typeof args?.kuah === 'boolean' || typeof args?.pedas === 'boolean';
  if (!ada) return { sukses: false, pesan: 'Belum ada filter. Tanya customer dulu: mau yang rasanya apa / pedas atau tidak / bahan apa.' };

  const { cocok, tidakDikenal } = atribut.cari(daftar, args);
  if (tidakDikenal.length) {
    const kv = atribut.muat().kosakata;
    return { sukses: false, pesan: 'Filter tidak dikenal: ' + tidakDikenal.join(', '), kosakata_rasa: kv.rasa, kosakata_masak: kv.masak, catatan_untuk_ai: 'Kalau customer menyebut bahan/bumbu yang tidak ada di menu, bilang jujur tidak ada menu dengan itu, lalu tawarkan alternatif terdekat.' };
  }
  if (cocok.length === 0) {
    return { sukses: true, jumlah: 0, catatan_untuk_ai: 'Tidak ada menu tersedia yang cocok dengan kriteria itu. Bilang jujur, jangan mengarang, tawarkan melonggarkan kriteria (daftar bernomor).' };
  }

  const baris = (m) => {
    const r = atribut.ringkas(m);
    return {
      nama: m.nama, kategori: m.kategori_nama, harga: rp(m.varian[0]?.harga ?? 0) + (m.varian.length > 1 ? ' (mulai)' : ''),
      rasa: r.rasa, bahan: r.bahan_utama, bumbu: r.bumbu, cara_masak: r.cara_masak, berkuah: r.berkuah, pedas: r.pedas,
      sambal_opsional: r.sambal_opsional || undefined,
    };
  };
  const MAKS = 8;
  const ditampilkan = cocok.slice(0, MAKS).map(baris);
  const perKategori = {};
  for (const m of cocok) perKategori[m.kategori_nama] = (perKategori[m.kategori_nama] || 0) + 1;
  const bisaSambal = args?.pedas === false ? cocok.filter((m) => atribut.sambalOpsional(m)).length : 0;

  return {
    sukses: true,
    jumlah: cocok.length,
    menu: ditampilkan,
    ada_lainnya: cocok.length > MAKS ? cocok.length - MAKS : undefined,
    per_kategori: cocok.length > MAKS ? perKategori : undefined,
    status_data: 'perkiraan_dari_data_umum_belum_diverifikasi_dapur',
    catatan_untuk_ai: 'Sampaikan sebagai DAFTAR BERNOMOR (nama + harga + 1 frasa pendek), maks 4-5 baris, lalu tanya mau yang mana (cukup balas nomor). Data ini perkiraan, pakai kata "umumnya/biasanya", jangan menjamin.'
      + (cocok.length > MAKS ? ' Hasilnya BANYAK (' + cocok.length + ' menu): jangan sebut semuanya; pilih yang paling pas/andalan, lalu tawarkan menyempit per kategori (lihat per_kategori) atau tambah kriteria.' : '')
      + (bisaSambal ? ' Beberapa menu punya pilihan sambal (opsional): kalau customer tidak suka pedas, ingatkan bisa pilih "tanpa sambal".' : '')
      + ' Kalau ada menu "sambal_opsional" dan customer tanya pedas, jelaskan sambalnya bisa dipilih ada/tidak.',
  };
}

async function eksekusiTanyaDetailMenu({ nama_menu }, konteks) {
  const hasil = [];
  const tidakKetemu = [];
  if (!Array.isArray(nama_menu)) nama_menu = [nama_menu].filter(Boolean);
  let adaNamaUmum = false;

  for (const nama of nama_menu) {
    let match = cariKandidatMenu(nama);
    // Nama umum ("cimplung", "matcha") yang jadi bagian nama >= 2 menu: jelaskan semuanya,
    // walau untuk order nama itu dipetakan ke 1 menu lewat alias.
    const bernamaUmum = cariMenuBernamaUmum(nama);
    if (bernamaUmum.length >= 2 && !bernamaUmum.some((m) => m.nama.toLowerCase() === String(nama).trim().toLowerCase())) {
      match = { statusMatch: 'AMBIGU_MULTI', kandidatList: bernamaUmum };
    }
    if (match.statusMatch === 'TIDAK_ADA') {
      tidakKetemu.push(nama);
      continue;
    }

    // Nama umum yang cocok ke banyak menu (misal "cimplung", "sate", "tongseng"):
    // AMBIGU_MULTI tidak punya kandidatTerbaik, jadi jelaskan semua kandidatnya sekaligus.
    const daftarMenu = match.statusMatch === 'AMBIGU_MULTI'
      ? match.kandidatList.slice(0, 8)
      : [match.kandidatTerbaik];
    if (match.statusMatch === 'AMBIGU_MULTI') adaNamaUmum = true;

    for (const menu of daftarMenu) {
    // Kirim kartu menu ini kalau customer cuma tanya 1 menu spesifik (bukan perbandingan banyak menu sekaligus,
    // supaya tidak banjir gambar kalau customer tanya "bandingin sroto ayam vs daging vs mie goreng" misalnya)
    if (nama_menu.length === 1 && daftarMenu.length === 1) {
      await konteks.kirimKartuMenu(konteks.jid, menu);
    }

    hasil.push({
      nama: menu.nama,
      kategori: menu.kategori_nama,
      tersedia: menu.tersedia,
      andalan: menu.andalan,
      deskripsi: menu.deskripsi || '(belum ada deskripsi detail tercatat untuk menu ini)',
      varian: menu.varian.map((v) => `${v.label}: ${rp(v.harga)}`),
      pilihan: menu.pilihan.map((p) => ({
        nama: p.nama,
        opsi: p.opsi,
        wajib_dipilih: p.wajib,
        default: p.default_opsi || null,
      })),
      kemungkinan_alergen: menu.alergen.length > 0 ? menu.alergen : 'tidak tercatat ada alergen umum, TAPI BUKAN berarti pasti bebas alergen',
      isi_mix_plate: menu.isi || undefined,
      atribut: atribut.ringkas(menu) || undefined,
    });
    }
  }

  if (hasil.length === 0) {
    return { sukses: false, pesan: `Menu "${nama_menu.join(', ')}" tidak ditemukan.` };
  }

  return {
    sukses: true,
    menu: hasil,
    tidak_ketemu: tidakKetemu.length > 0 ? tidakKetemu : undefined,
    catatan_untuk_ai: (adaNamaUmum
      ? 'Customer menyebut nama UMUM yang mencakup beberapa menu sekaligus. Jelaskan singkat apa itu secara umum dari deskripsi menu-menu di atas, lalu sebut pilihannya (format angka kalau lebih dari 2). JANGAN teruskan ke kasir, datanya sudah lengkap. '
      : '')
      + 'Jawab pertanyaan customer dari data di atas, dengan gaya ngobrol natural, JANGAN cuma baca ulang mentah-mentah. Kalau customer tanya soal alergen, sampaikan "kemungkinan_alergen" sebagai perkiraan dari resep umum, BUKAN jaminan -- kalau customer punya alergi serius, arahkan forward_pesan_ke_kasir untuk mastiin ke dapur. Kalau menu ini punya pilihan wajib (wajib_dipilih: true) dan customer belum sebut preferensinya, boleh sekalian tanya di jawabanmu.',
  };
}

const orderTerakhirPerCustomer = new Map(); // jid -> { teks, waktu }

// Masukkan item hasil parse ke draft pesanan customer (buat draft baru kalau belum ada).
// Item identik (menu, porsi, opsi, catatan) digabung jadi satu baris dengan qty bertambah.
// Kasir diberi tahu kalau permintaan QR yang sudah masuk jadi tidak berlaku (isi pesanan berubah)
async function beritahuKasirQrBatal(konteks, daftar) {
  for (const p of daftar || []) {
    const sudahTerkirim = p.status === 'TERKIRIM';
    await kirimKeSemuaKasir(
      konteks,
      `❌ QR ${p.label || ''} DIBATALKAN: customer mengubah pesanan. ${sudahTerkirim ? 'QR lama sudah terkirim ke customer dan customer diminta tidak membayar pakai itu.' : 'Abaikan permintaan QR sebelumnya.'} Permintaan baru masuk setelah customer setuju rincian.`
    );
  }
}

// Pesanan yang sudah MENUNGGU_BAYAR dikembalikan jadi draft (isi berubah). Permintaan QR lama dibatalkan dan kasir dikabari.
function turunkanKeDraft(konteks, pesananId) {
  const batal = db.setStatusPesanan(pesananId, 'DRAFT_MENUNGGU_KONFIRMASI');
  void beritahuKasirQrBatal(konteks, batal).catch((err) => console.error('❌ Gagal kabari kasir QR batal:', err.message));
}

function masukkanItemKeDraft(konteks, items) {
  // Pesanan yang masih bisa "ditambahin": yang belum dikonfirmasi, MAUPUN yang sudah MENUNGGU_BAYAR
  // (QR diminta/dikirim tapi belum lunas). Yang SELESAI/DIBATALKAN/OPEN_BILL tidak kepilih, jadi pesanan baru.
  const pesananBisaDitambah = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);

  let pesananId;
  let qrLamaJadiInvalid = false;

  if (pesananBisaDitambah) {
    pesananId = pesananBisaDitambah.id;
    if (pesananBisaDitambah.status === 'MENUNGGU_BAYAR') {
      // Ada tambahan setelah QR diminta -> QR lama tidak valid lagi (nominal berubah).
      turunkanKeDraft(konteks, pesananId);
      qrLamaJadiInvalid = true;
    }
  } else {
    // Customer yang belum sampai dan sudah bilang jam datangnya -> pesanan ini berjadwal (pre-order)
    const c = db.getCustomer(konteks.jid);
    const jamDatang = c.status_kedatangan !== 'DI_RESTO' && parseJam(c.rencana_datang) !== null ? c.rencana_datang : null;
    pesananId = db.buatPesananBaru(konteks.jid, c.nomor_meja, jamDatang);
  }

  const tipeDefault = db.getCustomer(konteks.jid).tipe_default || 'DINE_IN';

  for (const item of items) {
    const labelVarian = item.varian.label && item.varian.label !== 'Reguler' ? ` (${item.varian.label})` : '';
    const pilihanJson = Object.keys(item.pilihanTerisi || {}).length > 0 ? JSON.stringify(item.pilihanTerisi) : null;
    const tipeItem = item.tipe || tipeDefault; // disebut per menu ("iga take away") menang atas default

    const sudahAda = db.getItemsByPesananId(pesananId).find((i) =>
      i.status_item === 'AKTIF'
      && i.menu_id === item.menu.id
      && (i.varian_sku ?? null) === (item.varian.sku ?? null)
      && (i.pilihan_terpilih ?? null) === pilihanJson
      && (i.catatan ?? null) === (item.catatan || null)
      && (i.tipe ?? 'DINE_IN') === tipeItem
    );
    if (sudahAda) {
      db.setQtyItemPesanan(sudahAda.id, sudahAda.qty + item.qty);
      continue;
    }

    db.tambahItemPesanan(pesananId, {
      menu_id: item.menu.id,
      varian_sku: item.varian.sku,
      nama_snapshot: `${item.menu.nama}${labelVarian}`,
      qty: item.qty,
      harga_satuan_snapshot: item.varian.harga,
      pilihan_terpilih: pilihanJson,
      catatan: item.catatan || null,
      tipe: tipeItem,
    });
  }

  db.setHargaFixPesanan(pesananId, null);
  if (!qrLamaJadiInvalid) {
    db.setStatusPesanan(pesananId, 'DRAFT_MENUNGGU_KONFIRMASI');
  }

  return { pesananId, qrLamaJadiInvalid };
}

// Customer minta suhu yang tidak ada untuk menu itu: beri tahu jujur dan biarkan dia memutuskan (item sudah masuk apa adanya).
function teksPeringatanSuhu(daftar) {
  if (!daftar || daftar.length === 0) return '';
  const rincian = daftar.map((p) => `${p.menu} hanya tersedia ${p.tersedia.join('/')}, bukan ${p.diminta}`).join('; ');
  return `PENTING (suhu): ${rincian}. Item itu SUDAH masuk draft dengan suhu yang tersedia. Di ringkasan, tulis jujur 1 kalimat bahwa menu itu tidak ada versi yang diminta, lalu tanyakan sebagai DAFTAR BERNOMOR: "1. Tetap pesan (suhu yang tersedia)" dan "2. Ganti menu lain" (kalau customer ganti: hapus_item_order untuk menu itu lalu cari alternatifnya lewat cari_menu_atribut atau rekomendasi_menu). `;
}

async function eksekusiBuatOrder({ teks_mentah }, konteks) {
  const pagar = pagarJam();
  if (pagar) return pagar;
  // Customer baru dikasih daftar rekomendasi dan membalas angkanya ("1"): terjemahkan ke nama menu di kode,
  // jangan bergantung pada AI (yang kadang meneruskan angka mentah ke parser).
  const rekomendasi = db.getPendingState(konteks.jid, 'rekomendasi');
  const angka = String(teks_mentah || '').trim().match(/^(?:nomor |no )?(\d{1,2})$/i);
  if (rekomendasi && angka && rekomendasi[Number(angka[1]) - 1]) {
    teks_mentah = rekomendasi[Number(angka[1]) - 1];
  }
  db.clearPendingState(konteks.jid, 'rekomendasi'); // rekomendasi sudah ditindaklanjuti
  // Dedupe: kalau teks_mentah PERSIS sama dengan panggilan terakhir dalam 10 detik,
  // ini kemungkinan besar tool call ganda (model ngulang / retry pesan), bukan order baru.
  const terakhir = orderTerakhirPerCustomer.get(konteks.jid);
  const sekarang = Date.now();
  if (terakhir && terakhir.teks === teks_mentah && sekarang - terakhir.waktu < 10000) {
    return {
      sukses: false,
      pesan: 'Order ini sudah tercatat barusan, tidak diproses ulang.',
      catatan_untuk_ai: 'Ini panggilan duplikat untuk pesanan yang sama persis, JANGAN ulangi lagi ke customer, cukup lanjut rangkum draft yang sudah ada kalau perlu.',
    };
  }
  orderTerakhirPerCustomer.set(konteks.jid, { teks: teks_mentah, waktu: sekarang });

    const hasilParse = await ai.prosesOrderCustomer(teks_mentah);

  if (
    hasilParse.items.length === 0 &&
    hasilParse.tidakDikenali.length === 0 &&
    hasilParse.perluKlarifikasi.length === 0 &&
    hasilParse.perluPilihan.length === 0
  ) {
    return { sukses: false, pesan: 'Tidak ada menu yang berhasil dikenali dari pesan ini.' };
  }

  // ---------- Ada item yang butuh klarifikasi nama (misal "nasi goreng") dan/atau pilihan porsi/opsi ----------
  // Item lain yang SUDAH jelas dimasukkan ke draft DULU, jangan sampai hilang. Cuma yang ambigu yang ditanyakan.
  const adaKlarifikasi = hasilParse.perluKlarifikasi.length > 0;
  const adaPilihan = hasilParse.perluPilihan.length > 0;

  if (adaKlarifikasi || adaPilihan) {
    let sudahMasuk;
    if (hasilParse.items.length > 0) {
      sudahMasuk = masukkanItemKeDraft(konteks, hasilParse.items);
      catatFaseDariItem(konteks.jid, hasilParse.items);
    }
    if (adaKlarifikasi) setKlarifikasiPending(konteks.jid, hasilParse.perluKlarifikasi);
    if (adaPilihan) setPilihanPending(konteks.jid, hasilParse.perluPilihan);

    const draftSekarang = sudahMasuk
      ? db.getItemsByPesananId(sudahMasuk.pesananId).filter((i) => i.status_item === 'AKTIF')
      : [];

    return {
      sukses: true,
      butuh_klarifikasi: adaKlarifikasi || undefined,
      butuh_pilihan: adaPilihan || undefined,
      daftar_klarifikasi: adaKlarifikasi
        ? hasilParse.perluKlarifikasi.map((k) => ({
          yang_disebut_customer: k.namaInput,
          pilihan: k.kandidatList.map((m) => `${m.nama} (mulai ${rp(m.harga_mulai ?? m.varian?.[0]?.harga ?? '-')})`),
        }))
        : undefined,
      daftar_pilihan: adaPilihan
        ? hasilParse.perluPilihan.map((p) => ({
          menu: p.menu.nama,
          qty: p.qty,
          jenis_pertanyaan: p.jenisPilihan === 'varian' ? 'porsi' : p.namaOpsi,
          pilihan: p.opsiTersedia,
        }))
        : undefined,
      item_sudah_masuk_draft: draftSekarang.length > 0
        ? draftSekarang.map((i) => `${i.nama_snapshot} x${i.qty}`)
        : undefined,
      qr_sebelumnya_invalid: sudahMasuk?.qrLamaJadiInvalid || undefined,
      catatan_untuk_ai: (sudahMasuk?.qrLamaJadiInvalid ? 'PENTING: QR lama TIDAK BERLAKU LAGI karena ada tambahan item, ingatkan singkat jangan bayar pakai QR lama. ' : '')
        + (draftSekarang.length > 0
          ? 'Item yang sudah jelas (item_sudah_masuk_draft) SUDAH masuk draft, JANGAN dipesan ulang lewat buat_order. '
          : '')
        + (adaKlarifikasi ? 'Ada menu yang customer sebut dengan nama umum dan punya beberapa varian: tampilkan pilihannya dengan format angka dan minta customer pilih. ' : '')
        + (adaPilihan ? 'Ada menu yang butuh dipilih porsi/opsi wajibnya (misal suhu): tanyakan dengan format angka per menu. ' : '')
        + 'Tanyakan HANYA yang ambigu, singkat, dan JANGAN upsell/tawarkan fase berikutnya dulu (nanti setelah semuanya jelas). Kalau yang jelas tadi sudah ada, boleh singkat sebut bahwa itu sudah dicatat.',
    };
  }

  const { pesananId, qrLamaJadiInvalid } = masukkanItemKeDraft(konteks, hasilParse.items);

  const semuaItemSaatIni = db.getItemsByPesananId(pesananId).filter((i) => i.status_item === 'AKTIF');

  // ---------- Alur 3 fase (FLEKSIBEL): item ini menandai fasenya selesai, lalu satu tawaran lembut untuk fase berikutnya ----------
  // Customer tetap bebas memesan/bertanya apa saja; fase hanya panduan. Menu TIDAK dikirim di sini (hanya kalau customer tertarik).
  catatFaseDariItem(konteks.jid, hasilParse.items);
  const alurAktif = !db.getAlur(konteks.jid).tutup;
  const tambahan = infoTambahanSetelahOrder(konteks.jid, pesananId);

  const dasar = {
    sukses: true,
    pesanan_id: pesananId,
    nomor_pesanan: nomorPesanan(db.getPesananById(pesananId)),
    items_baru: hasilParse.items.map((i) => `${i.menu.nama} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''}`),
    items_total_di_draft: semuaItemSaatIni.map((i) => labelItem(i)),
    menu_tidak_ditemukan: hasilParse.tidakDikenali.length > 0 ? hasilParse.tidakDikenali : null,
    qr_sebelumnya_invalid: qrLamaJadiInvalid || undefined,
    tawarkan_nasi: tambahan.tawarkan_nasi || undefined,
    peringatan_suhu: hasilParse.peringatanSuhu?.length > 0 ? hasilParse.peringatanSuhu : undefined,
  };
  const pembuka = (qrLamaJadiInvalid ? 'PENTING: QR lama TIDAK BERLAKU LAGI karena ada tambahan item (nominal berubah), ingatkan singkat jangan bayar pakai QR lama. ' : '')
    + 'Item sudah masuk draft. Balas SATU pesan: baris pertama "Pesanan sementara:" lalu RINGKASAN SEMUA item di draft (items_total_di_draft) dengan format angka (1. 2. 3.), tanpa harga. '
    + (hasilParse.tidakDikenali.length > 0 ? 'Sebutkan juga singkat menu yang tidak ditemukan. ' : '')
    + teksPeringatanSuhu(hasilParse.peringatanSuhu);
  const nasi = tambahan.tawarkan_nasi
    ? 'Ada makanan berat tanpa nasi: di daftar bernomor berikut, jadikan baris PERTAMA "Tambah nasi putih (Rp10.000)" (nomor lain bergeser). Kalau customer memilihnya -> buat_order "nasi putih" dengan jumlah sama dengan porsi lauknya (atau sesuai yang dia sebut). Ditawarkan SEKALI ini saja. '
    : '';
  const penutup = 'Kalau customer menjawab dengan menyebut menu -> buat_order. Menyebut bagian menu -> lihat_menu. Bertanya hal lain -> jawab dulu, urutan fase TIDAK mengikat. Ucapan mengakhiri (udah, itu aja, cukup, langsung bayar, minta tagihan) -> LANGSUNG tampilkan_rincian_order.';

  if (alurAktif) {
    const faseNext = faseBerikutnya(db.getAlur(konteks.jid));
    const infoFase = faseNext ? await tawarkanFaseBerikutnya(konteks) : {};
    return {
      ...dasar,
      ...infoFase,
      catatan_untuk_ai: pembuka + nasi
        + (faseNext
          ? 'Lalu di BAWAH ringkasan, ikuti format DAFTAR BERNOMOR dari instruksi_alur (1 kalimat tanya pendek, lalu pilihan satu per baris), supaya customer cukup membalas nomor atau satu kata. Kalau menolak tawaran itu ("nggak", "nggak dulu", "nggak usah minum") -> lewati_fase. '
          : 'Semua bagian menu sudah ditawarkan. Lalu di BAWAH ringkasan, 1 kalimat santai singkat ("Ada lagi?"), tanpa daftar bernomor. ')
        + penutup,
    };
  }

  return {
    ...dasar,
    catatan_untuk_ai: pembuka + 'Lalu 1 kalimat santai singkat ("Ada lagi?"), tanpa daftar bernomor. Tanpa kalimat pembuka lain. JANGAN sebutkan total harga di sini. ' + penutup,
  };
}

// Setelah item masuk: (1) tawarkan nasi putih SEKALI kalau ada makanan berat selain nasi goreng/mie dan belum ada nasi,
// (2) kalau tidak, satu saran menu margin yang belum dipesan (maksimal 3 kali per sesi, tidak mengulang yang sama).
function infoTambahanSetelahOrder(jid, pesananId) {
  const items = db.getItemsByPesananId(pesananId).filter((i) => i.status_item === 'AKTIF');
  const idNasi = config.info().nasi?.id_menu;
  const menuDari = (i) => (i.menu_id ? db.getMenuById(i.menu_id) : null);

  const adaNasi = items.some((i) => i.menu_id === idNasi);
  const perluNasi = items.some((i) => {
    const m = menuDari(i);
    return m && m.id !== idNasi && m.kategori_id !== 'nasi_mie' && faseDariKategoriId(m.kategori_id) === 'berat';
  });
  if (adaNasi) db.clearPendingState(jid, 'nasi_ditawar');
  if (perluNasi && !adaNasi && !db.getPendingState(jid, 'nasi_ditawar')) {
    db.setPendingState(jid, 'nasi_ditawar', true);
    return { tawarkan_nasi: true };
  }

  const sudahSaran = db.getPendingState(jid, 'saran_menu') || [];
  if (sudahSaran.length >= 3) return {};
  const dipesan = new Set(items.map((i) => i.menu_id));
  const kelompokDipesan = new Set(items.map((i) => faseDariKategoriId(menuDari(i)?.kategori_id)).filter(Boolean));
  const kandidat = db.getMenuTersedia().filter((m) => adaMargin(m) && !dipesan.has(m.id) && !sudahSaran.includes(m.nama));
  // Utamakan kelompok yang belum ada di pesanan (belum ada minuman -> saran minuman, dst.)
  const pilih = urutkanPrioritas(kandidat.filter((m) => !kelompokDipesan.has(faseDariKategoriId(m.kategori_id))))[0]
    || urutkanPrioritas(kandidat)[0];
  if (!pilih) return {};
  db.setPendingState(jid, 'saran_menu', [...sudahSaran, pilih.nama]);
  return { saran_menu: `${pilih.nama} (${rp(pilih.varian[0]?.harga)})` };
}

async function eksekusiJawabKlarifikasiMenu({ teks_jawaban }, konteks) {
  const pending = getKlarifikasiPending(konteks.jid);
  if (!pending || pending.length === 0) {
    return { sukses: false, pesan: 'Tidak ada klarifikasi menu yang sedang ditunggu jawabannya.' };
  }

  const hasilCocok = await ai.cocokkanJawabanKlarifikasiMenu(teks_jawaban, pending);

  if (!hasilCocok || hasilCocok.length === 0) {
    return {
      sukses: false,
      pesan: 'Jawaban tidak berhasil dicocokkan ke pilihan yang ada.',
      catatan_untuk_ai: 'Tanya ulang dengan lebih jelas, sebutkan lagi pilihan yang tersedia.',
    };
  }

  clearKlarifikasiPending(konteks.jid);

  // Teks siap pakai: nama resmi persis + qty, supaya buat_order berikutnya langsung cocok (tidak ambigu lagi)
  const frasaTipe = (t) => (t === 'TAKE_AWAY' ? ' take away' : t === 'DINE_IN' ? ' dine in' : '');
  const teksOrderLengkap = hasilCocok.map((h) => `${h.qty} ${h.menu.nama}${frasaTipe(h.tipe)}`).join(', ');

  return {
    sukses: true,
    menu_terpilih: hasilCocok.map((h) => `${h.menu.nama} x${h.qty}`),
    teks_order_lengkap: teksOrderLengkap,
    catatan_untuk_ai: `Menu sudah berhasil dicocokkan. Panggil buat_order SEKARANG dengan teks_mentah persis: "${teksOrderLengkap}" (jangan diubah, jangan tambah harga).`,
  };
}

function frasaPilihanUntukTeks(namaOpsi, nilai) {
  const n = String(namaOpsi).toLowerCase();
  const v = String(nilai).toLowerCase();
  if (n === 'suhu') return v;
  if (n === 'sambal') return v.includes('tanpa') ? 'tanpa sambal' : 'dengan sambal';
  return null; // opsi lain belum didukung parser ekstraksi order
}

function susunPotonganTeksOrder(p, opsiTerpilih) {
  const bagian = [p.menu.nama];

  if (p.jenisPilihan === 'varian') {
    bagian.push(/setengah|1\/2/i.test(opsiTerpilih) ? 'setengah porsi' : 'porsi penuh');
    bagian.push(String(p.qty));
    // bawa info yang sudah disebut customer di pesan awal
    if (p.parsial?.suhu) bagian.push(p.parsial.suhu);
    if (p.parsial?.sambal) bagian.push(p.parsial.sambal === 'tanpa' ? 'tanpa sambal' : 'dengan sambal');
  } else {
    // porsi yang sudah resolve sebelumnya (via varianSku) ikut dibawa supaya tidak ditanya ulang
    const daftarVarian = p.menu.varian || [];
    if (daftarVarian.length > 1) {
      const v = daftarVarian.find((x) => x.sku === p.varianSku);
      bagian.push(v && /setengah|1\/2/i.test(v.label) ? 'setengah porsi' : 'porsi penuh');
    }
    bagian.push(String(p.qty));

    const frasaBaru = frasaPilihanUntukTeks(p.namaOpsi, opsiTerpilih);
    if (frasaBaru) bagian.push(frasaBaru);

    // pilihan lain yang sudah terisi (termasuk default) ikut dibawa
    for (const [nama, nilai] of Object.entries(p.pilihanSudahTerisi || {})) {
      if (nama.toLowerCase() === String(p.namaOpsi).toLowerCase()) continue;
      const f = frasaPilihanUntukTeks(nama, nilai);
      if (f) bagian.push(f);
    }
  }

  if (p.tipe === 'TAKE_AWAY') bagian.push('take away');
  else if (p.tipe === 'DINE_IN') bagian.push('dine in');

  let teks = bagian.join(' ');
  if (p.catatan) teks += ` (${p.catatan})`;
  return teks;
}

async function eksekusiJawabPilihanMenu({ teks_jawaban }, konteks) {
  const pending = getPilihanPending(konteks.jid);
  if (!pending || pending.length === 0) {
    return { sukses: false, pesan: 'Tidak ada pertanyaan porsi/opsi yang sedang ditunggu jawabannya.' };
  }

  const hasilCocok = await ai.cocokkanJawabanPilihan(teks_jawaban, pending);

  if (!hasilCocok || hasilCocok.length === 0) {
    return {
      sukses: false,
      pesan: 'Jawaban tidak berhasil dicocokkan ke pilihan yang ada.',
      catatan_untuk_ai: 'Tanya ulang dengan lebih jelas, sebutkan lagi pilihan yang tersedia.',
    };
  }

  // Cek mana yang sudah terjawab semua vs yang masih kurang
  const namaInputTerjawab = hasilCocok.map((h) => h.pending.namaInput);
  const masihKurang = pending.filter((p) => !namaInputTerjawab.includes(p.namaInput));

  if (masihKurang.length > 0) {
    setPilihanPending(konteks.jid, masihKurang);
  } else {
    clearPilihanPending(konteks.jid);
  }

  // Susun teks order baru yang eksplisit untuk dilempar lagi ke buat_order
  const potonganTeksOrder = hasilCocok
    .map(({ pending: p, opsiTerpilih }) => susunPotonganTeksOrder(p, opsiTerpilih))
    .join(', ');

  return {
    sukses: true,
    terjawab: hasilCocok.map((h) => `${h.pending.menu.nama}: ${h.opsiTerpilih}`),
    masih_kurang: masihKurang.length > 0 ? masihKurang.map((p) => p.menu.nama) : undefined,
    teks_order_lengkap: potonganTeksOrder,
    catatan_untuk_ai: masihKurang.length > 0
      ? 'Masih ada pertanyaan lain yang belum terjawab. Tanya ulang sisanya dalam 1 kalimat, format angka kalau pilihannya lebih dari 1.'
      : 'Semua pilihan sudah lengkap. Panggil tool buat_order lagi dengan teks dari field teks_order_lengkap supaya item ini masuk draft dengan porsi/opsi yang benar. Balasan ke customer tetap 1 kalimat.',
  };
}

// Data yang wajib ada sebelum QR: nama, sapaan (ditanya SETELAH nama), dan nomor meja (hanya kalau customer sudah di resto).
// Pre-order (jam datang terisi dan belum sampai): meja belum perlu, ditanya setelah sampai.
function dataKurangUntukQr(customer, pesanan) {
  const preOrder = !!pesanan?.jam_datang && customer.status_kedatangan !== 'DI_RESTO';
  const kurang = [];
  if (!customer.rencana_datang) kurang.push('kedatangan'); // customer yang langsung memilih menu: kedatangan ditanya di sini
  if (!customer.nama) kurang.push('nama');
  else if (!customer.sapaan) kurang.push('sapaan');
  if (!preOrder && !customer.nomor_meja && customer.rencana_datang) kurang.push('nomor meja');

  let petunjuk = '';
  if (kurang.includes('kedatangan')) {
    petunjuk = 'tanya kedatangan sebagai DAFTAR BERNOMOR, satu opsi per baris: "1. Sudah di resto" dan "2. Datang nanti (sebutkan jamnya, misal 19.30)"'
      + (kurang.includes('nama') ? ', dan dalam pesan yang sama sekalian tanya namanya (dipakai kasir untuk mencocokkan pembayaran)' : '')
      + '. Jawabannya -> atur_layanan (kedatangan "sekarang" atau jam HH:MM). Nomor meja ditanya SETELAH customer menjawab sudah di resto (belum perlu kalau datang nanti). Setelah nama dijawab, tanya enaknya dipanggil apa dengan DAFTAR BERNOMOR "1. Mas" dan "2. Mbak".';
  } else if (kurang.includes('nama')) {
    petunjuk = kurang.includes('nomor meja')
      ? 'tanya nomor meja, nama, dan sapaan SEKALIGUS dalam 1 kalimat (misal "Boleh tau nomor meja, nama, dan enaknya dipanggil Mas atau Mbak?"), tanpa daftar bernomor. Jawaban seperti "meja 5, Regina, mbak" -> konfirmasi_kedatangan (nomor_meja, nama) lalu simpan_nama (sapaan). Kalau sapaan belum dijawab, baru tanya "Mas atau Mbak?".'
      : 'tanya nama dan sapaan SEKALIGUS dalam 1 kalimat (misal "Boleh tau namanya, dan enaknya dipanggil Mas atau Mbak?"), tanpa daftar bernomor; nama dipakai kasir untuk mencocokkan pembayaran. Jawaban seperti "Regina, mbak" -> simpan_nama (nama dan sapaan sekaligus). Kalau cuma nama yang dijawab, baru tanya "Mas atau Mbak?". Setelah data lengkap, cukup SATU kali konfirmasi "rinciannya sudah pas? kalau oke aku minta kasir siapkan QR-nya", jangan diulang.';
  } else if (kurang.includes('sapaan')) {
    petunjuk = kurang.includes('nomor meja')
      ? 'tanya nomor mejanya, lalu tanya enaknya dipanggil apa dengan DAFTAR BERNOMOR "1. Mas" dan "2. Mbak" (customer cukup balas satu kata).'
      : 'tanya enaknya dipanggil apa dengan DAFTAR BERNOMOR "1. Mas" dan "2. Mbak" (customer cukup balas satu kata).';
  } else if (kurang.includes('nomor meja')) {
    petunjuk = 'tanya nomor mejanya.';
  }
  return { preOrder, kurang, petunjuk };
}

async function eksekusiTampilkanRincianOrder(_, konteks) {
  const draft = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
  if (!draft) {
    return { sukses: false, pesan: 'Tidak ada draft pesanan yang menunggu konfirmasi saat ini.' };
  }
  if (draft.status === 'MENUNGGU_BAYAR') {
    return {
      sukses: false,
      pesan: 'Pesanan ini sudah di tahap menunggu bayar (QR sedang disiapkan kasir atau sudah dikirim).',
      catatan_untuk_ai: 'Tampilkan rincian item (nama, qty, harga satuan, subtotal tiap item), lalu Subtotal, PPN 10%, dan Grand Total dengan format angka, TANPA kalimat pembuka. Di baris terakhir, 1 kalimat pendek: kabari status QR (lagi disiapkan kasir atau sudah dikirim) dan jangan minta konfirmasi ulang. JANGAN panggil kirim_qr_pembayaran sekarang kecuali customer menanyakan QR-nya.',
    };
  }
  const pagar = pagarJam();
  if (pagar) return pagar;

  const items = db.getItemsByPesananId(draft.id).filter((i) => i.status_item === 'AKTIF');
  if (items.length === 0) {
    return {
      sukses: false,
      pesan: 'Pesanan masih KOSONG: belum ada satu pun menu yang tercatat di sistem.',
      catatan_untuk_ai: 'JANGAN menulis rincian dari ingatan percakapan. Bilang jujur bahwa belum ada menu yang tercatat, lalu tanya customer mau pesan apa (atau panggil buat_order kalau dia baru saja menyebut menu).',
    };
  }

  // Masih ada pertanyaan menggantung (misal "sate ayam: penuh atau setengah?"): tanyakan dulu SEKALI sebelum rincian.
  // Kalau customer tidak menjawab/menyuruh lewati dan rincian diminta lagi, pertanyaan dilepas.
  const gantung = [
    ...(getKlarifikasiPending(konteks.jid) || []).map((k) => k.namaInput),
    ...(getPilihanPending(konteks.jid) || []).map((p) => p.menu?.nama),
  ].filter(Boolean);
  if (gantung.length > 0) {
    if (!db.getPendingState(konteks.jid, 'gantung_diingatkan')) {
      db.setPendingState(konteks.jid, 'gantung_diingatkan', true);
      return {
        sukses: false,
        ada_pertanyaan_menggantung: gantung,
        pesan: 'Ada pesanan yang belum lengkap: ' + gantung.join(', '),
        catatan_untuk_ai: 'JANGAN tampilkan rincian dulu. Tanyakan SATU kalimat: ' + gantung.join(', ') + ' jadi dipesan? Kalau ya, ulangi pilihannya (porsi/varian) dengan daftar bernomor; jawabannya -> jawab_klarifikasi_menu / jawab_pilihan_menu. Kalau customer bilang tidak/lewati, panggil tampilkan_rincian_order lagi.',
      };
    }
    clearKlarifikasiPending(konteks.jid);
    clearPilihanPending(konteks.jid);
    db.clearPendingState(konteks.jid, 'gantung_diingatkan');
  }

  const cust = db.getCustomer(konteks.jid);
  const subtotal = items.reduce((sum, i) => sum + i.harga_satuan_snapshot * i.qty, 0);
  db.setHargaFixPesanan(draft.id, subtotal);
  const tagihan = config.hitungTagihan(subtotal);

  return {
    sukses: true,
    pesanan_id: draft.id,
    items: items.map((i) => {
      const pilihan = db.pilihanTampil(i);
      const infoPilihan = Object.keys(pilihan).length > 0 ? ` [${Object.entries(pilihan).map(([k, v]) => `${k}: ${v}`).join(', ')}]` : '';
      const infoTipe = i.tipe === 'TAKE_AWAY' ? ' [take away]' : '';
      return `${i.nama_snapshot}${infoPilihan}${infoTipe} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''} @ ${rp(i.harga_satuan_snapshot)} = ${rp(i.harga_satuan_snapshot * i.qty)}`;
    }),
    nomor_pesanan: nomorPesanan(draft),
    subtotal,
    ppn: tagihan.ppn,
    grand_total: tagihan.grandTotal,
    cara_bayar: cust.cara_bayar === 'OPEN_BILL' ? 'open bill (bayar di akhir)' : 'bayar dulu (QR)',
    catatan_untuk_ai: 'Tampilkan rincian item (nama, qty, harga satuan, subtotal tiap item) dengan format angka, lalu tiga baris: Subtotal, PPN 10%, Grand Total (angka persis dari hasil tool ini, harga menu BELUM termasuk PPN), TANPA kalimat pembuka/basa-basi. Di baris terakhir, 1 kalimat pendek: '
      + (() => {
        const { kurang, petunjuk } = dataKurangUntukQr(db.getCustomer(konteks.jid), draft);
        return kurang.length > 0 ? petunjuk : 'tanya apakah rincian sudah benar dan boleh dilanjutkan ke pembayaran.';
      })()
      + ' JANGAN panggil kirim_qr_pembayaran sekarang, tunggu jawaban customer berikutnya.',
  };
}

async function eksekusiPutuskanItemHabis(
  { keputusan, menu_pengganti, nama_menu, porsi_pengganti, catatan_pengganti },
  konteks
) {
  const itemPending = db.getItemMenungguKeputusanHabisByCustomer(konteks.jid);
  if (itemPending.length === 0) {
    return { sukses: false, pesan: 'Tidak ada menu yang sedang menunggu keputusan habis saat ini.' };
  }

  // ---------- [#7c] Tentukan item target ----------
  let item = null;
  if (itemPending.length === 1) {
    item = itemPending[0];
  } else if (nama_menu) {
    const m = cariKandidatMenu(nama_menu);
    item = itemPending.find((i) => m.kandidatTerbaik && i.menu_id === m.kandidatTerbaik.id)
      || itemPending.find((i) => i.nama_snapshot.toLowerCase().includes(nama_menu.toLowerCase()))
      || null;
  }
  if (!item) {
    return {
      sukses: false,
      ada_banyak_item_pending: true,
      daftar: itemPending.map((i) => i.nama_snapshot),
      catatan_untuk_ai: 'Ada lebih dari satu menu yang menunggu keputusan. Tanyakan menu mana yang dimaksud (format angka), lalu panggil lagi dengan nama_menu terisi.',
    };
  }

  const pesanan = db.getPesananById(item.pesanan_id);
  const sisaPending = () => db.getItemMenungguKeputusanHabisByCustomer(konteks.jid).map((i) => i.nama_snapshot);
  const ingatkanSisa = (sisa) => (sisa.length > 0
    ? ` Masih ada menu lain yang menunggu keputusan (${sisa.join(', ')}), tanyakan juga setelah ini.`
    : '');

  // ---------- BATAL ----------
  if (keputusan === 'batal') {
    const nominal = config.denganPpn(item.harga_satuan_snapshot * item.qty); // refund termasuk PPN yang sudah dibayar
    db.setStatusItemPesanan(item.id, 'DIBATALKAN_HABIS');
    db.hitungUlangSubtotalAktif(pesanan.id);
    db.catatRefund({
      pesanan_id: pesanan.id,
      pesanan_item_id: item.id,
      nominal,
      alasan: `${item.nama_snapshot} habis setelah bayar, dibatalkan atas permintaan customer`,
    });
    await laporRefundKeKasir(konteks, pesanan, item, nominal, 'Dibatalkan, uang kembali penuh');

    const sisa = sisaPending();
    return {
      sukses: true,
      keputusan: 'batal',
      item: item.nama_snapshot,
      nominal_refund: nominal,
      masih_menunggu_keputusan: sisa.length > 0 ? sisa : undefined,
      catatan_untuk_ai: 'Beri tahu customer dalam 1 kalimat bahwa pembatalan dicatat dan uangnya dikembalikan TUNAI di kasir (hanya tunai, jangan janjikan transfer).' + ingatkanSisa(sisa),
    };
  }

  // ---------- GANTI ----------
  if (!menu_pengganti) {
    return {
      sukses: false,
      pesan: 'Nama menu pengganti belum disebutkan.',
      catatan_untuk_ai: 'Tanya customer mau ganti ke menu apa.',
    };
  }

  const match = cariKandidatMenu(menu_pengganti);
  if (match.statusMatch === 'TIDAK_ADA' || match.statusMatch === 'AMBIGU_MULTI') {
    return {
      sukses: false,
      pesan: `Menu pengganti "${menu_pengganti}" tidak ditemukan atau ambigu.`,
      catatan_untuk_ai: 'Tanya ulang nama menu pengganti yang lebih jelas.',
    };
  }

  const menuBaru = match.kandidatTerbaik;
  if (!menuBaru.tersedia) {
    return { sukses: false, pesan: `${menuBaru.nama} juga sedang habis, tolong pilih menu lain.` };
  }

  // [#7a] Varian/porsi menu pengganti
  let varianBaru;
  if (menuBaru.varian.length === 1) {
    varianBaru = menuBaru.varian[0];
  } else {
    const reso = ai.resolveVarian(menuBaru, porsi_pengganti || null);
    if (reso.butuhKlarifikasi) {
      return {
        sukses: false,
        butuh_porsi: true,
        menu: menuBaru.nama,
        pilihan_porsi: menuBaru.varian.map((v) => `${v.label} ${rp(v.harga)}`),
        catatan_untuk_ai: 'Menu pengganti punya pilihan porsi. Tanyakan ke customer (format angka, sebut harganya), lalu panggil putuskan_item_habis lagi dengan porsi_pengganti terisi (penuh/setengah).',
      };
    }
    varianBaru = reso.varian;
  }

  // [#7a] Pilihan wajib (misal suhu) menu pengganti
  const pilihanWajib = (menuBaru.pilihan || []).filter((p) => p.wajib);
  if (pilihanWajib.length > 0 && !catatan_pengganti) {
    return {
      sukses: false,
      butuh_pilihan_wajib: true,
      menu: menuBaru.nama,
      pilihan: pilihanWajib.map((p) => ({ nama: p.nama, opsi: p.opsi })),
      catatan_untuk_ai: 'Menu pengganti punya pilihan wajib. Tanyakan ke customer (format angka), lalu panggil putuskan_item_habis lagi dengan catatan_pengganti berisi jawabannya (misal "dingin").',
    };
  }

  const selisihPerUnit = varianBaru.harga - item.harga_satuan_snapshot;
  const totalSelisih = config.denganPpn(Math.abs(selisihPerUnit) * item.qty); // selisih ditagih/dikembalikan sudah termasuk PPN
  const labelVarian = varianBaru.label && varianBaru.label !== 'Reguler' ? ` (${varianBaru.label})` : '';

  const idItemBaru = db.tambahItemPesanan(pesanan.id, {
    menu_id: menuBaru.id,
    varian_sku: varianBaru.sku,
    nama_snapshot: `${menuBaru.nama}${labelVarian}`,
    qty: item.qty,
    harga_satuan_snapshot: varianBaru.harga,
    pilihan_terpilih: null,
    catatan: [catatan_pengganti, `Pengganti dari ${item.nama_snapshot} (habis)`].filter(Boolean).join(', '),
  });
  db.setStatusItemPesanan(item.id, 'DIGANTI', { item_pengganti_id: idItemBaru });
  db.hitungUlangSubtotalAktif(pesanan.id);

  let infoSelisih;
  if (selisihPerUnit > 0) {
    // [#7b] Buat tagihan tambahan (QR dikirim setelah customer setuju)
    const tagihanId = db.buatTagihanTambahan({
      pesanan_id: pesanan.id,
      pesanan_item_id: idItemBaru,
      nominal: totalSelisih,
      alasan: `Ganti ${item.nama_snapshot} -> ${menuBaru.nama}, selisih lebih mahal`,
    });
    infoSelisih = { jenis: 'kurang_bayar', nominal: totalSelisih, tagihan_id: tagihanId };
  } else if (selisihPerUnit < 0) {
    infoSelisih = { jenis: 'lebih_bayar_dikembalikan', nominal: totalSelisih };
    db.catatRefund({
      pesanan_id: pesanan.id,
      pesanan_item_id: item.id,
      nominal: totalSelisih,
      alasan: `Ganti ${item.nama_snapshot} -> ${menuBaru.nama}, selisih lebih murah`,
    });
  } else {
    infoSelisih = { jenis: 'sama', nominal: 0 };
  }

  await laporGantiMenuKeKasir(konteks, pesanan, item, menuBaru, infoSelisih);

  const sisa = sisaPending();
  return {
    sukses: true,
    keputusan: 'ganti',
    menu_pengganti: `${menuBaru.nama}${labelVarian}`,
    info_selisih: infoSelisih,
    masih_menunggu_keputusan: sisa.length > 0 ? sisa : undefined,
    catatan_untuk_ai: (
      infoSelisih.jenis === 'kurang_bayar'
        ? `Beri tahu customer menu sudah diganti ke ${menuBaru.nama}${labelVarian}, ada kekurangan bayar ${rp(infoSelisih.nominal)}. Tanya apakah setuju membayar kekurangan itu lewat QR. JANGAN kirim QR dulu, tunggu customer setuju, baru panggil kirim_qr_kekurangan di giliran berikutnya.`
        : infoSelisih.jenis === 'lebih_bayar_dikembalikan'
          ? `Beri tahu customer menu sudah diganti ke ${menuBaru.nama}${labelVarian}, ada kelebihan bayar ${rp(infoSelisih.nominal)} yang dikembalikan tunai di kasir.`
          : `Beri tahu customer menu sudah diganti ke ${menuBaru.nama}${labelVarian}, harganya sama jadi tidak ada selisih.`
    ) + ingatkanSisa(sisa),
  };
}

// ---------- Helper notifikasi ke kasir ----------
async function laporRefundKeKasir(konteks, pesanan, item, nominal, keterangan) {
  const customer = db.getCustomer(pesanan.customer_jid);
  await kirimKeSemuaKasir(
    konteks,
    `💸 REFUND -- Pesanan ${nomorPesanan(pesanan)} (meja ${pesanan.nomor_meja || '-'}, ${customer.nama || 'customer'})\nItem: ${item.nama_snapshot}\nNominal: ${rp(nominal)} (termasuk PPN)\nKeterangan: ${keterangan}\n\nMohon proses pengembalian uangnya nggih.`
  );
}

async function laporGantiMenuKeKasir(konteks, pesanan, itemLama, menuBaru, infoSelisih) {
  const customer = db.getCustomer(pesanan.customer_jid);
  const infoSelisihTeks = infoSelisih.jenis === 'kurang_bayar'
    ? `Customer perlu bayar tambahan ${rp(infoSelisih.nominal)}`
    : infoSelisih.jenis === 'lebih_bayar_dikembalikan'
      ? `Refund ke customer ${rp(infoSelisih.nominal)}`
      : 'Tidak ada selisih harga';

  await kirimKeSemuaKasir(
    konteks,
    `🔄 GANTI MENU -- Pesanan ${nomorPesanan(pesanan)} (meja ${pesanan.nomor_meja || '-'}, ${customer.nama || 'customer'})\n${itemLama.nama_snapshot} -> ${menuBaru.nama}\n${infoSelisihTeks}`
  );
}

// Tiket pesanan lunas ke staf (semua operator kecuali yang baru mengonfirmasi).
// Disimpan juga ke histori penerima supaya balasan "habis <menu>" punya konteks nomor meja/pesanan.
async function kirimTiketPesananKeStaf(konteks, pesanan, items, { mode = 'MASAK' } = {}) {
  try {
    const customer = db.getCustomer(pesanan.customer_jid);
    const preOrder = !!pesanan.jam_datang && customer.status_kedatangan !== 'DI_RESTO';
    const meja = pesanan.nomor_meja || customer.nomor_meja;
    const nomor = nomorPesanan(pesanan);
    const nama = [customer.sapaan, customer.nama].filter(Boolean).join(' ') || pesanan.customer_jid.split('@')[0];

    const openBill = mode === 'OPEN_BILL';
    let judul = `PESANAN ${nomor} | Meja ${meja || '-'} | ${openBill ? 'OPEN BILL (BELUM BAYAR) | MASAK SEKARANG' : 'LUNAS (QRIS)'}`;
    if (preOrder) {
      judul = `PRE-ORDER ${nomor} | LUNAS (QRIS) | datang jam ${pesanan.jam_datang} | ${mode === 'TUNGGU' ? 'BELUM DIMASAK' : 'MASAK SEKARANG'}`;
    }

    const baris = [
      judul,
      `Customer: ${nama}`,
      ...barisItemUntukStaf(items),
      ...barisCatatanPesanan(pesanan),
      ...nota.barisTotal(nota.hitungDariItem(items)),
      '',
    ];
    if (preOrder && mode === 'TUNGGU') {
      baris.push('Jangan dimasak dulu. 30 menit sebelum jam datang bot menanyakan ke customer, kamu dapat "MULAI MASAK" kalau customer konfirmasi.');
    }
    const acuan = meja && !preOrder ? `meja ${meja}` : `pesanan ${pesanan.no_harian}`;
    baris.push(`Kalau ada menu kosong, balas: "habis <menu> ${acuan}"`);

    const tiket = baris.join('\n');
    for (const op of db.getAllOperators()) {
      if (op.jid === konteks.jid) continue; // yang baru konfirmasi bayar sudah tahu
      await konteks.kirimPesan(op.jid, tiket);
      db.simpanChatHistory(op.jid, 'assistant', tiket);
    }
  } catch (err) {
    console.error('❌ Gagal kirim tiket ke staf:', err.message);
  }
}

const rupiahId = (n) => Number(n).toLocaleString('id-ID');

// Baris item untuk pesan ke staf: "2x Mendoan (ket)  30.000". Hanya item AKTIF.
function barisItemUntukStaf(items) {
  return items
    .filter((i) => i.status_item === 'AKTIF')
    .map((i) => {
      const pilihan = Object.values(db.pilihanTampil(i)).join(', ');
      const ket = [pilihan, i.catatan].filter(Boolean).join('; ');
      const ta = i.tipe === 'TAKE_AWAY' ? ' [TAKE AWAY]' : '';
      return `${i.qty}x ${i.nama_snapshot}${ta}${ket ? ` (${ket})` : ''}  ${rupiahId(i.harga_satuan_snapshot * i.qty)}`;
    });
}

// Catatan customer untuk satu pesanan, satu baris per catatan: "📝 Catatan: tanpa pedas"
function barisCatatanPesanan(pesanan) {
  const teks = String(pesanan?.catatan_kasir || '').trim();
  return teks ? teks.split('\n').filter(Boolean).map((c) => `📝 Catatan: ${c}`) : [];
}

// Pesanan customer yang catatannya masih bisa digabung ke info kasir/tiket (belum dimasak):
// draft/menunggu bayar, atau pre-order lunas yang belum dikonfirmasi (catatan ikut di pesan "MULAI MASAK").
function pesananUntukCatatan(jid) {
  const terbuka = db.getDraftAtauMenungguBayarByCustomer(jid);
  if (terbuka) return terbuka;
  const preOrder = db.getPreOrderAktifByCustomer(jid).filter((p) => p.jadwal_status === 'MENUNGGU' || p.jadwal_status === 'DITANYA');
  return preOrder.length > 0 ? preOrder[preOrder.length - 1] : null;
}

async function kirimKeSemuaOperator(konteks, pesan) {
  for (const op of db.getAllOperators()) {
    await konteks.kirimPesan(op.jid, pesan);
    db.simpanChatHistory(op.jid, 'assistant', pesan); // supaya "meja X udah bayar" punya konteks di histori kasir
  }
}

async function eksekusiKirimQrPembayaran(_, konteks) {
  const pagar = pagarJam();
  if (pagar) return pagar;
  const draft = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
  if (!draft) {
    return { sukses: false, pesan: 'Tidak ada draft pesanan yang menunggu konfirmasi saat ini.' };
  }
  if (!draft.subtotal) {
    return {
      sukses: false,
      pesan: 'Rincian order belum ditampilkan ke customer.',
      catatan_untuk_ai: 'Panggil tampilkan_rincian_order dulu sebelum kirim QR.',
    };
  }
  const dataCustomer = db.getCustomer(konteks.jid);
  const { kurang, petunjuk } = dataKurangUntukQr(dataCustomer, draft);
  if (kurang.length > 0) {
    return {
      sukses: false,
      pesan: `${kurang.join(' dan ')} customer belum ada, QR belum bisa dikirim.`,
      catatan_untuk_ai: `${petunjuk} Kedatangan -> atur_layanan, nama/sapaan -> simpan_nama, meja -> konfirmasi_kedatangan (bisa sekalian isi nama). Kalau customer sebelumnya sudah setuju kirim QR, setelah data lengkap langsung panggil kirim_qr_pembayaran.`,
    };
  }

  // ---------- RECHECK STOK sesaat sebelum generate QR ----------
  const itemDraft = db.getItemsByPesananId(draft.id).filter((i) => i.status_item === 'AKTIF');
  const itemHabis = [];
  for (const item of itemDraft) {
    if (!item.menu_id) continue;
    const menu = db.getMenuById(item.menu_id);
    if (menu && !menu.tersedia) {
      itemHabis.push(item);
    }
  }

  if (itemHabis.length > 0) {
    return {
      sukses: false,
      ada_yang_habis: true,
      item_habis: itemHabis.map((i) => i.nama_snapshot),
      catatan_untuk_ai: 'PENTING: ada item di pesanan yang ternyata baru habis sebelum QR dikirim. Beri tahu customer dengan jujur dan minta maaf, tanya apakah mau dihapus item itu dari pesanan atau diganti menu lain. JANGAN kirim QR dulu sampai ini diselesaikan. Kalau customer sudah putuskan, panggil buat_order lagi (untuk ganti menu) atau sebutkan ke customer untuk konfirmasi hapus item itu (lalu lanjut tampilkan_rincian_order ulang setelah item dihapus).',
    };
  }

  // Open bill: langsung ke dapur tanpa QR (hanya kalau customer yang memintanya)
  if (dataCustomer.cara_bayar === 'OPEN_BILL') {
    return mulaiOpenBill(draft, itemDraft, konteks);
  }

  // Bayar dulu. Nominal = Grand Total (subtotal + PPN) persis. QR dibuat kasir di POS lalu fotonya diteruskan ke customer.
  const grandTotal = draft.grand_total ?? config.hitungTagihan(draft.subtotal).grandTotal;
  db.setNominalTransfer(draft.id, grandTotal);
  if (draft.status !== 'MENUNGGU_BAYAR') db.setStatusPesanan(draft.id, 'MENUNGGU_BAYAR');
  const pesananIni = db.getPesananById(draft.id);

  let permintaan = db.getPermintaanQrByPesanan(draft.id);
  let statusQr;

  if (!permintaan) {
    permintaan = db.buatPermintaanQr({
      jenis: 'PESANAN', refIds: [draft.id], customerJid: konteks.jid,
      label: nomorPesanan(pesananIni), nominal: grandTotal,
    });
    const terkirimKeKasir = await kirimTiketPermintaanQr(konteks, permintaan, teksPermintaanQrPesanan(pesananIni, dataCustomer, itemDraft));
    if (!terkirimKeKasir) {
      return { sukses: false, pesan: 'Tidak ada kasir yang terdaftar/terjangkau.', catatan_untuk_ai: 'Beri tahu customer ada kendala dan minta hubungi kasir langsung.' };
    }
    statusQr = 'MENUNGGU_KASIR';
  } else if (permintaan.status === 'TERKIRIM') {
    // Customer menanyakan QR yang sudah pernah dikirim: kirim ulang fotonya
    const ok = await konteks.kirimQrKeCustomer(permintaan.id);
    statusQr = ok ? 'DIKIRIM_ULANG' : 'GAGAL_KIRIM_ULANG';
  } else {
    // Masih menunggu kasir: colek kasir (maksimal sekali tiap 2 menit supaya tidak spam)
    const terakhir = permintaan.pengingat_at ? Date.now() - new Date(permintaan.pengingat_at).getTime() : Infinity;
    if (terakhir > 2 * 60 * 1000) {
      db.catatPengingatQr(permintaan.id);
      await kirimKeSemuaKasir(konteks, `🔔 Customer menanyakan QR ${permintaan.label} (${sebutCustomer(dataCustomer, konteks.jid)}, ${rp(grandTotal)}). Mohon kirim foto QR-nya ke sini sebagai reply tiket MINTA QR ya.`);
    }
    statusQr = 'MASIH_MENUNGGU_KASIR';
  }

  return {
    sukses: true,
    pesanan_id: draft.id,
    nomor_pesanan: nomorPesanan(pesananIni),
    subtotal: pesananIni.subtotal,
    ppn: pesananIni.ppn,
    grand_total: grandTotal,
    nomor_meja: dataCustomer.nomor_meja || null,
    status_qr: statusQr,
    catatan_untuk_ai: {
      MENUNGGU_KASIR: `Permintaan QR sudah diteruskan ke kasir (Grand Total ${rp(grandTotal)}, sudah termasuk PPN). QR-nya BELUM dikirim: kasir yang membuatnya lalu otomatis diteruskan ke customer. Bilang 1 kalimat: QR lagi disiapkan kasir, sebentar ya (sebut total ${rp(grandTotal)}). JANGAN bilang QR sudah dikirim.`,
      MASIH_MENUNGGU_KASIR: 'QR masih disiapkan kasir, kasir sudah diingatkan. Bilang 1 kalimat: sebentar lagi, masih disiapkan kasir.',
      DIKIRIM_ULANG: 'QR sudah dikirim ulang ke customer barusan. Cukup konfirmasi 1 kalimat.',
      GAGAL_KIRIM_ULANG: 'Gagal mengirim ulang QR. Bilang ada kendala dan kasir akan mengirimnya.',
    }[statusQr],
  };
}

// Teks permintaan QR ke kasir (pesanan bayar dulu)
function teksPermintaanQrPesanan(pesanan, customer, items) {
  const preOrder = !!pesanan.jam_datang && customer.status_kedatangan !== 'DI_RESTO';
  const meja = customer.nomor_meja || pesanan.nomor_meja;
  const lokasi = preOrder ? `datang jam ${pesanan.jam_datang}` : `Meja ${meja || '-'}`;
  const nomor = nomorPesanan(pesanan);
  return [
    `💳 MINTA QR | Pesanan ${nomor} | ${sebutCustomer(customer, pesanan.customer_jid)} | ${lokasi}`,
    ...nota.barisItem(items).map((b) => b),
    ...nota.barisTotal(nota.hitungDariItem(items)),
    ...barisCatatanPesanan(pesanan),
    '',
    `Buat QRIS ${rp(pesanan.grand_total ?? nota.hitungDariItem(items).grandTotal)} di POS, foto QR-nya, lalu kirim ke chat ini sebagai REPLY pesan ini (atau tulis "pesanan ${pesanan.no_harian}" di caption).`,
    `Kalau pembayaran sudah masuk, bilang: "pesanan ${pesanan.no_harian} udah bayar"`,
  ].join('\n');
}

// OPEN BILL: pesanan langsung ke dapur, dibayar di akhir. Hanya dine in (take away dan pre-order wajib bayar dulu).
async function mulaiOpenBill(draft, items, konteks) {
  const customer = db.getCustomer(konteks.jid);
  const preOrder = !!draft.jam_datang && customer.status_kedatangan !== 'DI_RESTO';
  const adaTakeAway = items.some((i) => i.tipe === 'TAKE_AWAY');
  if (preOrder || adaTakeAway) {
    db.setCaraBayar(konteks.jid, null);
    return {
      sukses: false,
      open_bill_ditolak: true,
      pesan: preOrder ? 'Pre-order tidak bisa open bill.' : 'Menu take away tidak bisa open bill.',
      catatan_untuk_ai: `Open bill hanya untuk makan di tempat. ${preOrder ? 'Pesanan ini pre-order (belum sampai)' : 'Pesanan ini ada menu take away'}, jadi wajib bayar dulu. Sampaikan santai 1-2 kalimat, tanya apakah lanjut bayar dulu (DAFTAR BERNOMOR "1. Lanjut bayar dulu" dan "2. Ubah pesanan"). Kalau lanjut -> kirim_qr_pembayaran lagi.`,
    };
  }

  db.setMetodeBayarPesanan(draft.id, 'OPEN_BILL');
  db.setStatusPesanan(draft.id, 'OPEN_BILL');
  db.setCaraBayar(konteks.jid, null);
  db.mulaiKunjungan(konteks.jid, customer.nomor_meja);

  // Bill yang sudah diminta sebelumnya jadi tidak berlaku (ada pesanan baru)
  const billLama = db.getPesananOpenBillByCustomer(konteks.jid)
    .map((p) => db.getPermintaanQrByPesanan(p.id)).filter((r) => r && r.jenis === 'BILL');
  for (const r of new Map(billLama.map((x) => [x.id, x])).values()) {
    db.setPermintaanQrBatal(r.id);
    await beritahuKasirQrBatal(konteks, [r]);
  }

  const pesananFinal = db.getPesananById(draft.id);
  await kirimTiketPesananKeStaf(konteks, pesananFinal, db.getItemsByPesananId(draft.id), { mode: 'OPEN_BILL' });
  const alur = db.getAlur(konteks.jid);
  db.setAlur(konteks.jid, { ...alur, tutup: true });

  // Tawaran kuis dikirim sistem sebagai pesan terpisah SETELAH balasan AI (lihat index.js, state 'tambahan_balasan')
  const kuisMsg = tawaranKuisSekali(konteks.jid);
  if (kuisMsg) db.setPendingState(konteks.jid, 'tambahan_balasan', kuisMsg);
  return {
    sukses: true,
    open_bill: true,
    nomor_pesanan: nomorPesanan(pesananFinal),
    grand_total: pesananFinal.grand_total,
    catatan_untuk_ai: `Pesanan ${nomorPesanan(pesananFinal)} (open bill) sudah diteruskan ke dapur, bayarnya nanti di akhir. Bilang 1 kalimat: sudah masuk dapur, bayar belakangan, dan kalau mau bayar tinggal bilang "minta bill". ${kuisMsg ? 'Sistem mengirim tawaran kuis sebagai pesan terpisah, jangan menawarkan kuis.' : ''}`,
  };
}

// Kuis Banyumasan ditawarkan SEKALI per kunjungan setelah pesanan masuk dapur. Mengembalikan teks tawaran (atau null kalau sudah pernah).
function tawaranKuisSekali(jid) {
  if (config.kuis().soal.length === 0) return null;
  const k = db.getKunjunganAktif(jid);
  if (!k || k.kuis_ditawarkan) return null;
  db.updateKunjungan(k.id, { kuis_ditawarkan: 1 });
  db.setPendingState(jid, 'kuis_tawaran', true);
  return 'Sambil nunggu pesanannya, mau coba kuis Banyumasan? Balas "kuis" kalau mau, atau abaikan aja 😄';
}

async function eksekusiKirimQrKekurangan(_, konteks) {
  const tagihan = db.getTagihanBelumLunasByCustomer(konteks.jid);
  if (!tagihan) {
    return { sukses: false, pesan: 'Tidak ada kekurangan bayar yang perlu ditagih saat ini.' };
  }

  const nominalTransfer = tagihan.nominal; // persis nominal kekurangan (sudah termasuk PPN)
  const barusaja = tagihan.status === 'MENUNGGU_KONFIRMASI';
  if (barusaja) db.setTagihanMenungguBayar(tagihan.id, nominalTransfer);

  // QR dinamis: kasir membuat QR kekurangan, fotonya diteruskan ke customer
  let permintaan = db.getPermintaanQrByRef('TAGIHAN', tagihan.id);
  let statusQr;
  if (!permintaan) {
    const pesananT = db.getPesananById(tagihan.pesanan_id);
    permintaan = db.buatPermintaanQr({
      jenis: 'TAGIHAN', refIds: [tagihan.id], customerJid: konteks.jid,
      label: `kekurangan ${nomorPesanan(pesananT)}`, nominal: nominalTransfer,
    });
    const c = db.getCustomer(konteks.jid);
    await kirimTiketPermintaanQr(konteks, permintaan, [
      `💳 MINTA QR KEKURANGAN | Pesanan ${nomorPesanan(pesananT)} | ${sebutCustomer(c, konteks.jid)} | Meja ${c.nomor_meja || pesananT.nomor_meja || '-'}`,
      `Kekurangan akibat ganti menu: ${rp(nominalTransfer)} (sudah termasuk PPN).`,
      '',
      `Buat QRIS ${rp(nominalTransfer)} di POS, foto QR-nya, lalu kirim ke chat ini sebagai REPLY pesan ini.`,
      `Kalau sudah masuk, bilang: "kekurangan meja ${c.nomor_meja || pesananT.nomor_meja || ''} udah masuk"`,
    ].join('\n'));
    statusQr = 'MENUNGGU_KASIR';
  } else if (permintaan.status === 'TERKIRIM') {
    statusQr = (await konteks.kirimQrKeCustomer(permintaan.id)) ? 'DIKIRIM_ULANG' : 'GAGAL';
  } else {
    statusQr = 'MASIH_MENUNGGU_KASIR';
  }

  return {
    sukses: true,
    tagihan_id: tagihan.id,
    nominal_kekurangan: tagihan.nominal,
    nominal_transfer: nominalTransfer,
    status_qr: statusQr,
    catatan_untuk_ai: statusQr === 'DIKIRIM_ULANG'
      ? 'QR kekurangan sudah dikirim ulang. Cukup konfirmasi singkat ke customer.'
      : statusQr === 'GAGAL'
        ? 'PENTING: QR GAGAL terkirim. Bilang ada kendala dan kasir akan mengirimnya.'
        : `Permintaan QR kekurangan ${rp(nominalTransfer)} sudah diteruskan ke kasir. QR BELUM dikirim: kasir yang membuatnya lalu diteruskan otomatis. Bilang 1 kalimat: QR kekurangannya lagi disiapkan kasir.`,
  };
}

async function eksekusiBatalkanOrder(_, konteks) {
  const pesanan = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);

  if (!pesanan) {
    return { sukses: false, pesan: 'Tidak ada order yang masih bisa dibatalkan saat ini.' };
  }

  const statusSebelumDibatalkan = pesanan.status;
  db.setStatusPesanan(pesanan.id, 'DIBATALKAN');

  return {
    sukses: true,
    pesanan_id: pesanan.id,
    status_sebelumnya: statusSebelumDibatalkan,
    catatan_untuk_ai: statusSebelumDibatalkan === 'MENUNGGU_BAYAR'
      ? 'Pesanan ini sudah sempat dikirimi QR, tapi berhasil dibatalkan karena belum ada konfirmasi lunas dari kasir. Ingatkan customer supaya TIDAK transfer ke QR tadi kalau belum terlanjur, dan kalau sudah terlanjur transfer, minta segera hubungi kasir langsung (jangan tunggu bot, karena bot tidak tau status pembayaran riil di luar sistem EDC).'
      : undefined,
  };
}

// Customer membatalkan menu yang masih jadi pertanyaan menggantung ("ga jadi mie", "sate ayamnya ga usah")
function batalkanPendingUntukMenu(jid, namaMenu) {
  const q = normalisasiNama(String(namaMenu || ''));
  if (!q) return 0;
  const cocok = (teks) => { const n = normalisasiNama(String(teks || '')); return n && (n.includes(q) || q.includes(n)); };
  let dibatalkan = 0;
  const klar = getKlarifikasiPending(jid) || [];
  const klarSisa = klar.filter((k) => !(cocok(k.namaInput) || (k.kandidatList || []).some((m) => cocok(m.nama))));
  if (klarSisa.length !== klar.length) { dibatalkan += klar.length - klarSisa.length; klarSisa.length ? setKlarifikasiPending(jid, klarSisa) : clearKlarifikasiPending(jid); }
  const pil = getPilihanPending(jid) || [];
  const pilSisa = pil.filter((p) => !cocok(p.menu?.nama));
  if (pilSisa.length !== pil.length) { dibatalkan += pil.length - pilSisa.length; pilSisa.length ? setPilihanPending(jid, pilSisa) : clearPilihanPending(jid); }
  return dibatalkan;
}

async function eksekusiHapusItemOrder({ nama_menu }, konteks) {
  const pendingDibatalkan = batalkanPendingUntukMenu(konteks.jid, nama_menu);
  const draft = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
  if (!draft && pendingDibatalkan > 0) {
    return { sukses: true, pertanyaan_dibatalkan: nama_menu, catatan_untuk_ai: 'Pertanyaan soal menu itu dibatalkan. Konfirmasi 1 kalimat santai.' };
  }
  if (!draft) {
    return { sukses: false, pesan: 'Tidak ada draft pesanan aktif saat ini.' };
  }

  const items = db.getItemsByPesananId(draft.id).filter((i) => i.status_item === 'AKTIF');
  const match = cariKandidatMenu(nama_menu);

  const itemCocok = items.find((i) =>
    match.kandidatTerbaik && i.menu_id === match.kandidatTerbaik.id
  ) || items.find((i) => i.nama_snapshot.toLowerCase().includes(nama_menu.toLowerCase()));

  if (!itemCocok) {
    return { sukses: false, pesan: `Tidak ketemu "${nama_menu}" di draft pesanan saat ini.` };
  }

  db.setStatusItemPesanan(itemCocok.id, 'DIBATALKAN_HABIS');
  const subtotalBaru = db.hitungUlangSubtotalAktif(draft.id);

  const sisaItem = db.getItemsByPesananId(draft.id).filter((i) => i.status_item === 'AKTIF');
  if (sisaItem.length === 0) {
    db.setStatusPesanan(draft.id, 'DIBATALKAN');
    return {
      sukses: true,
      item_dihapus: itemCocok.nama_snapshot,
      draft_kosong: true,
      catatan_untuk_ai: 'Item terakhir di draft sudah dihapus, jadi draft otomatis dibatalkan semua. Beri tahu customer dan tanya apakah mau order ulang dari awal.',
    };
  }

  // Isi pesanan berubah: kalau QR sudah terbit, turunkan lagi ke draft dan paksa rincian ulang
  const qrLamaJadiInvalid = draft.status === 'MENUNGGU_BAYAR';
  if (qrLamaJadiInvalid) turunkanKeDraft(konteks, draft.id);
  db.setHargaFixPesanan(draft.id, null);

  return {
    sukses: true,
    item_dihapus: itemCocok.nama_snapshot,
    sisa_items: sisaItem.map((i) => `${i.nama_snapshot} x${i.qty}`),
    qr_sebelumnya_invalid: qrLamaJadiInvalid || undefined,
    catatan_untuk_ai: qrLamaJadiInvalid
      ? 'Item sudah dihapus. QR sebelumnya TIDAK BERLAKU LAGI karena nominal berubah, ingatkan customer jangan bayar pakai QR lama. Rangkum sisa item dan minta konfirmasi ("ya"/"fix") supaya rincian dan QR baru dikirim.'
      : 'Item sudah dihapus dari draft. Rangkum ulang sisa item yang masih ada, tanya apakah sudah fix untuk lanjut ke tampilkan_rincian_order lagi.',
  };
}

const LABEL_STATUS_PESANAN = {
  DRAFT_MENUNGGU_KONFIRMASI: 'draft, belum dikonfirmasi customer',
  MENUNGGU_BAYAR: 'menunggu pembayaran',
  OPEN_BILL: 'open bill, sudah di dapur, dibayar di akhir',
  SELESAI: 'sudah lunas, diteruskan ke dapur',
  DIBATALKAN: 'dibatalkan',
};

// Ringkasan satu pesanan untuk ditampilkan: hanya item AKTIF, total dihitung dari item (bukan kolom subtotal
// yang sengaja dikosongkan saat isi draft berubah), plus info lunas/refund.
function ringkasPesanan(p) {
  const semua = db.getItemsByPesananId(p.id);
  const aktif = semua.filter((i) => i.status_item === 'AKTIF');
  const menunggu = semua.filter((i) => i.status_item === 'MENUNGGU_KEPUTUSAN_HABIS');
  const totalSaatIni = aktif.reduce((s, i) => s + i.harga_satuan_snapshot * i.qty, 0); // subtotal, belum PPN
  const tagihanSaatIni = config.hitungTagihan(totalSaatIni);
  const totalRefund = db.getRefundByPesanan(p.id).reduce((s, r) => s + r.nominal, 0);

  return {
    nomor_pesanan: nomorPesanan(p),
    catatan: p.catatan_kasir || undefined,
    jam_datang: p.jam_datang || undefined,
    jadwal: p.jadwal_status ? { MENUNGGU: 'menunggu konfirmasi 30 menit sebelumnya', DITANYA: 'sudah ditanya, menunggu jawaban customer', DIKONFIRMASI: 'dikonfirmasi, dimasak', BATAL: 'tidak jadi datang' }[p.jadwal_status] : undefined,
    pesanan_id: p.id,
    status: LABEL_STATUS_PESANAN[p.status] || p.status,
    nomor_meja: p.nomor_meja || null,
    items: aktif.map((i) => labelItem(i)),
    menunggu_keputusan_habis: menunggu.length > 0 ? menunggu.map((i) => i.nama_snapshot) : undefined,
    total_item_saat_ini: totalSaatIni,
    ppn_saat_ini: tagihanSaatIni.ppn,
    grand_total_saat_ini: tagihanSaatIni.grandTotal,
    cara_bayar: p.metode_bayar === 'OPEN_BILL' ? 'open bill' : undefined,
    total_dibayar: p.status === 'SELESAI' ? p.total_dibayar : undefined,
    total_refund: totalRefund > 0 ? totalRefund : undefined,
    nominal_transfer: p.status === 'MENUNGGU_BAYAR' ? p.nominal_transfer : undefined,
  };
}

async function eksekusiCekStatusOrderSaya(_, konteks) {
  const semuaOrder = db.getPesananHariIniByCustomer(konteks.jid);
  const tagihan = db.getTagihanBelumLunasByCustomer(konteks.jid);
  const infoTagihan = tagihan
    ? { nominal: tagihan.nominal, status: tagihan.status, nominal_transfer: tagihan.nominal_transfer || null }
    : undefined;

  if (semuaOrder.length === 0) {
    return { sukses: true, ada_order: false, kekurangan_bayar: infoTagihan, pesan: 'Tidak ada order hari ini.' };
  }

  return {
    sukses: true,
    ada_order: true,
    kekurangan_bayar: infoTagihan,
    daftar: semuaOrder.map(ringkasPesanan),
    catatan_untuk_ai: 'Sampaikan status dengan ringkas dan natural. "total_item_saat_ini" adalah jumlah harga item yang masih berlaku; untuk pesanan draft ini bersifat sementara sampai rincian ditampilkan.',
  };
}

async function eksekusiCekStatusOrder({ pesanan_id, nomor_pesanan }) {
  const idDicari = resolvePesananId({ pesanan_id, nomor_pesanan });
  if (idDicari === null) return { sukses: false, pesan: `Pesanan ${nomor_pesanan} hari ini tidak ditemukan.` };
  if (idDicari !== undefined) {
    const p = db.getPesananById(idDicari);
    if (!p) return { sukses: false, pesan: 'Pesanan tidak ditemukan.' };
    const customer = db.getCustomer(p.customer_jid);
    return { sukses: true, customer: customer.nama, ...ringkasPesanan(p) };
  }

  const semuaAktif = db.getPesananAktifSemua();
  return {
    sukses: true,
    jumlah: semuaAktif.length,
    daftar: semuaAktif.map((p) => ({ customer: p.nama, ...ringkasPesanan(p) })),
  };
}

async function eksekusiKonfirmasiKedatangan({ nomor_meja, nama }, konteks) {
  const meja = db.normalisasiMeja(nomor_meja);

  // Nama (kalau disebut bersamaan) disimpan dulu, tidak tergantung meja diterima atau tidak
  const namaBersih = String(nama || '').trim().replace(/^(mas|mbak|mba|kak)\s+/i, '');
  if (namaBersih) db.setCustomerNama(konteks.jid, namaBersih);

  if (!meja) {
    // Customer bilang "sudah di resto" tanpa menyebut nomor meja: catat kedatangannya, mejanya ditanyakan
    if (!db.getCustomer(konteks.jid).rencana_datang) db.setLayanan(konteks.jid, { rencana: 'SEKARANG' });
    return {
      sukses: false,
      pesan: 'Nomor meja belum disebut / tidak terbaca.',
      catatan_untuk_ai: 'Nama (kalau ada) sudah tersimpan dan kedatangan "sudah di resto" tercatat. Tanya nomor mejanya (1 kalimat). JANGAN mengisi nomor_meja dengan teks karangan seperti "belum disebut".',
    };
  }

  // Kunci meja per orang: meja yang masih dipakai customer lain tidak bisa diambil
  if (db.getPemakaiMeja(meja, konteks.jid)) {
    return {
      sukses: false,
      meja_terpakai: true,
      pesan: `Meja ${meja} sedang dipakai customer lain.`,
      catatan_untuk_ai: `Bilang singkat meja ${meja} tercatat sedang dipakai, minta customer cek lagi nomor mejanya (1 kalimat). JANGAN sebut data customer lain.`,
    };
  }

  db.setNomorMeja(konteks.jid, meja);
  db.setLayanan(konteks.jid, { rencana: 'SEKARANG' }); // sudah di resto

  // Pesanan yang belum dibayar ikut jadi "di resto": tidak lagi berjadwal
  for (const p of db.getPesananAktifByCustomer(konteks.jid)) {
    if (p.jam_datang) db.setJadwalPesanan(p.id, { jamDatang: null });
  }

  // Pre-order yang sudah lunas: customer sudah sampai = konfirmasi otomatis, lapor ke staf
  const sesudah = db.getCustomer(konteks.jid);
  const namaLengkap = [sesudah.sapaan, sesudah.nama].filter(Boolean).join(' ') || 'customer';
  const preOrder = db.getPreOrderAktifByCustomer(konteks.jid);
  if (preOrder.length > 0) db.mulaiKunjungan(konteks.jid, meja); // pre-order lunas: kunjungan (timer 3 jam & rating) dimulai saat sampai
  for (const p of preOrder) {
    const sudahDimasak = p.jadwal_status === 'DIKONFIRMASI';
    db.setJadwalPesanan(p.id, { jadwalStatus: 'DIKONFIRMASI' });
    db.setNomorMejaPesanan(p.id, meja); // pesanan lunas tidak ikut ter-update oleh setNomorMeja
    await kirimKeSemuaOperator(konteks, [
      `📍 SUDAH SAMPAI | Meja ${meja} | ${namaLengkap}`,
      `Pesanan ${nomorPesanan(p)} (janji datang ${p.jam_datang}).`,
      sudahDimasak ? 'Sudah dimasak sebelumnya, siap disajikan.' : 'Belum dikonfirmasi sebelumnya: MULAI MASAK sekarang.',
      ...ringkasItemStaf(p.id),
    ].join('\n'));
  }
  const nomorPreOrder = preOrder.map(nomorPesanan);

  const kurangData = [!sesudah.nama && 'nama', sesudah.nama && !sesudah.sapaan && 'sapaan'].filter(Boolean);
  let catatan = nomorPreOrder.length > 0
    ? `Meja ${meja} tercatat dan kasir/waiter sudah diberi tahu. Sampaikan hangat dan jelas: cari meja ${meja}, lalu LAPOR KE WAITER sambil menyebut nomor pesanan ${nomorPreOrder.join(', ')} supaya pesanannya diantar. `
    : 'Meja tercatat. ';
  if (nomorPreOrder.length === 0 && kurangData.length === 0) {
    catatan += 'Kalau sebelumnya customer sudah setuju kirim QR, langsung panggil kirim_qr_pembayaran.';
  } else if (kurangData.includes('nama')) {
    catatan += 'Nama belum ada: tanya namanya (1 kalimat) lalu simpan_nama sebelum kirim QR.';
  } else if (kurangData.includes('sapaan')) {
    catatan += "Sapaan belum ada: tanya enaknya dipanggil apa dengan DAFTAR BERNOMOR \"1. Mas\" dan \"2. Mbak\" (customer cukup balas satu kata), lalu simpan_nama sebelum kirim QR.";
  }

  return {
    sukses: true,
    nomor_meja: meja,
    nama: sesudah.nama || null,
    pesanan_untuk_dilaporkan_ke_waiter: nomorPreOrder.length > 0 ? nomorPreOrder : undefined,
    catatan_untuk_ai: catatan,
  };
}

async function eksekusiUbahJumlahItem({ nama_menu, jumlah }, konteks) {
  const draft = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
  if (!draft) return { sukses: false, pesan: 'Tidak ada draft pesanan aktif saat ini.' };

  const qty = Math.floor(Number(jumlah));
  if (!Number.isFinite(qty) || qty < 1) {
    return { sukses: false, pesan: 'Jumlah minimal 1. Kalau mau dihapus pakai hapus_item_order.' };
  }

  const items = db.getItemsByPesananId(draft.id).filter((i) => i.status_item === 'AKTIF');
  const match = cariKandidatMenu(nama_menu);
  const idMenuCocok = match.kandidatList
    ? match.kandidatList.map((m) => m.id)
    : match.kandidatTerbaik ? [match.kandidatTerbaik.id] : [];
  const cocok = items.filter((i) => idMenuCocok.includes(i.menu_id));

  if (cocok.length === 0) {
    return { sukses: false, pesan: `Tidak ketemu "${nama_menu}" di draft pesanan saat ini.`, catatan_untuk_ai: 'Kalau customer sebenarnya mau MEMESAN menu itu (belum ada di draft), pakai buat_order.' };
  }
  if (cocok.length > 1) {
    return {
      sukses: false,
      perlu_pilih: cocok.map((i) => `${i.nama_snapshot} x${i.qty}`),
      catatan_untuk_ai: 'Ada lebih dari 1 baris yang cocok (beda porsi/opsi). Tanya customer yang mana (format angka).',
    };
  }

  const item = cocok[0];
  const qtyLama = item.qty;
  db.setQtyItemPesanan(item.id, qty);
  db.hitungUlangSubtotalAktif(draft.id);
  db.setHargaFixPesanan(draft.id, null);

  const qrLamaJadiInvalid = draft.status === 'MENUNGGU_BAYAR';
  if (qrLamaJadiInvalid) turunkanKeDraft(konteks, draft.id);

  const semua = db.getItemsByPesananId(draft.id).filter((i) => i.status_item === 'AKTIF');
  const alur = db.getAlur(konteks.jid);
  const alurAktif = !alur.tutup;
  const faseMenunggu = alurAktif ? faseBerikutnya(alur) : null;

  return {
    sukses: true,
    menu: item.nama_snapshot,
    jumlah_lama: qtyLama,
    jumlah_baru: qty,
    items_total_di_draft: semua.map((i) => labelItem(i)),
    qr_sebelumnya_invalid: qrLamaJadiInvalid || undefined,
    catatan_untuk_ai: (qrLamaJadiInvalid ? 'PENTING: QR lama TIDAK BERLAKU LAGI karena jumlah berubah, ingatkan singkat jangan bayar pakai QR lama. ' : '')
      + 'Format balasan: "Pesanan sementara:" lalu ringkasan SEMUA item (items_total_di_draft) format angka tanpa harga. '
      + (faseMenunggu
        ? `Di bawahnya 1 kalimat tanya pendek lalu DAFTAR BERNOMOR: "1. Tambah menu lagi", "2. Lanjut ${LABEL_FASE[faseMenunggu]}", "3. Nggak dulu" (tanpa kirim menu). Kalau customer menolak tawaran itu -> lewati_fase; kalau mengakhiri pesanan (udah, itu aja, cukup) -> langsung tampilkan_rincian_order.`
        : alurAktif
          ? 'Di bawahnya 1 kalimat tanya pendek dan DAFTAR BERNOMOR: "1. Tambah menu lagi", "2. Udah cukup". Kalau customer menjawab udah cukup -> langsung tampilkan_rincian_order.'
          : 'Di bawahnya 1 kalimat pendek lanjut ke rincian.'),
  };
}

async function eksekusiPilihJalur({ jalur }, konteks) {
  if (!URUTAN_JALUR[jalur]) return { sukses: false, pesan: `Jalur "${jalur}" tidak dikenal.` };
  const alur = db.getAlur(konteks.jid);
  if (alur.tutup) {
    return { sukses: false, pesan: 'Customer sudah bayar, pesanan tambahan diproses biasa tanpa fase.', catatan_untuk_ai: 'Tawarkan lihat_menu dengan kelompok yang customer mau.' };
  }
  db.setAlur(konteks.jid, { jalur, selesai: alur.selesai, tutup: false });
  return { sukses: true, jalur, ...(await tawarkanFaseBerikutnya(konteks, { kirimKartu: true })) };
}

async function eksekusiLewatiFase({ langsung_bayar }, konteks) {
  const alur = db.getAlur(konteks.jid);
  if (alur.tutup) return { sukses: false, pesan: 'Alur fase sudah selesai (sudah bayar).' };

  const jalur = alur.jalur || 'camilan';
  const fase = faseBerikutnya({ ...alur, jalur });

  // Tawaran fase berikutnya sudah dilontarkan bareng "ada yang mau ditambah?", jadi "nggak" berarti
  // fase itu ditolak: lewati, lalu tawarkan fase sesudahnya SEKALI LAGI (atau lanjut rincian kalau sudah habis).
  // Hanya permintaan eksplisit "langsung bayar / jangan ditawarin lagi" yang menghentikan semua tawaran.
  let selesai = alur.selesai;
  let dilewati;
  if (langsung_bayar) {
    selesai = [...URUTAN_JALUR[jalur]];
    dilewati = 'semua';
  } else if (fase) {
    selesai = [...alur.selesai, fase];
    dilewati = LABEL_FASE[fase];
  }
  db.setAlur(konteks.jid, { jalur, selesai, tutup: false });

  return { sukses: true, dilewati, ...(await tawarkanFaseBerikutnya(konteks)) };
}

// Sapaan hanya sah kalau customer sendiri yang menjawab: menyebut "mas"/"mbak"/"mba", atau membalas angka dari daftar
// (1 = Mas, 2 = Mbak). AI TIDAK boleh menebak dari nama, jadi nilai dari AI diabaikan kalau pesan customer tidak memuatnya.
function sapaanDariPesan(pesan) {
  const t = String(pesan || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(mbak|mba)\b/.test(t)) return 'Mbak';
  if (/\bmas\b/.test(t)) return 'Mas';
  if (/^(nomor |no )?1$/.test(t)) return 'Mas';
  if (/^(nomor |no )?2$/.test(t)) return 'Mbak';
  return null;
}

// Dipanggil SEBELUM agent jalan: kalau bot barusan menanyakan kedatangan (daftar "Sudah di resto" / "Datang nanti") dan customer
// menjawab "sudah di resto", "1", atau menyebut jam, kedatangan dicatat oleh kode. Jawaban gabungan ("sudah di resto, namaku Budi")
// sering hanya ditangkap sebagian oleh AI (nama saja), jadi bagian kedatangannya tidak boleh bergantung pada AI.
async function tangkapJawabanKedatangan(jid, pesan, histori) {
  const c = db.getCustomer(jid);
  if (!c || c.rencana_datang) return false;
  const terakhir = [...(histori || [])].reverse().find((m) => m.role === 'assistant');
  if (!terakhir || !/sudah di resto/i.test(terakhir.content) || !/datang nanti|jamnya/i.test(terakhir.content)) return false;
  const t = String(pesan || '').toLowerCase();
  const jam = t.match(/\b(?:jam|pukul)\s*(\d{1,2})(?:[.:](\d{2}))?|\b(\d{1,2})[.:](\d{2})\b/);
  let kedatangan = null;
  if (jam) {
    const jj = jam[1] ?? jam[3]; const mm = jam[2] ?? jam[4] ?? '00';
    kedatangan = `${jj}:${mm}`;
  } else if (!/\b(nanti|belum|ntar)\b/.test(t) && (/\b(sudah|udah|dah|lagi)\s+(di\s+)?(resto|sini|disini|sampai|nyampe)\b|\bdi\s+resto\b|^\s*(nomor\s+|no\s+)?1\s*[.,!]?\s*$/.test(t))) {
    kedatangan = 'sekarang';
  }
  if (!kedatangan) return false;
  const hasil = await eksekusiAturLayanan({ kedatangan }, { jid });
  console.log(`🧭 Kode mencatat kedatangan (${kedatangan}): ${hasil.sukses ? 'ok' : hasil.pesan}`);
  return hasil.sukses === true;
}

// Dipanggil SEBELUM agent jalan: kalau bot barusan menanyakan "dipanggil apa" dan customer menjawab ("Mas", "1", "Mbak"),
// sapaan disimpan di sini oleh kode, tanpa bergantung pada AI yang kadang lupa memanggil tool.
function tangkapJawabanSapaan(jid, pesan, histori) {
  const c = db.getCustomer(jid);
  if (!c.nama || c.sapaan) return false;
  const terakhir = [...(histori || [])].reverse().find((m) => m.role === 'assistant');
  if (!terakhir || !/dipanggil/i.test(terakhir.content) || !/\bmas\b/i.test(terakhir.content) || !/\bmbak\b/i.test(terakhir.content)) return false;
  if (String(pesan || '').length > 40) return false; // jawaban singkat saja, supaya kalimat lain tidak salah tangkap
  const sapaan = sapaanDariPesan(pesan);
  if (!sapaan) return false;
  db.setSapaan(jid, sapaan);
  return true;
}

// Dipanggil SESUDAH agent menjawab, sebelum dikirim ke customer. Dua hal yang tidak boleh bergantung pada kepatuhan AI:
// 1. Sapaan belum dijawab -> "Mas Budi"/"Mbak Sari" (tebakan dari nama) diubah jadi nama saja.
// 2. Sapaan pertama ke customer baru wajib memuat daftar pilihan kedatangan.
// Ganti blok "Pesanan sementara:" / "Rincian pesanan ...:" yang ditulis AI dengan versi dari DB, supaya yang dilihat customer
// selalu sama dengan yang benar-benar tercatat (AI kadang menulisnya dari ingatan percakapan).
function selaraskanDaftarPesanan(jid, teks, { rincianDitampilkan = false } = {}) {
  const baris = String(teks).split('\n');
  const draft = db.getDraftAtauMenungguBayarByCustomer(jid);
  const items = draft ? db.getItemsByPesananId(draft.id).filter((i) => i.status_item === 'AKTIF') : [];
  const tagihan = nota.hitungDariItem(items);
  const total = tagihan.subtotal;
  const barisTotalNota = nota.barisTotal(tagihan); // Subtotal, PPN 10%, Grand Total (dihitung kode)

  const barisRincian = (i, n) => {
    const pilihan = db.pilihanTampil(i);
    const infoPilihan = Object.keys(pilihan).length > 0 ? ' (' + Object.values(pilihan).join(', ') + ')' : '';
    const tipe = i.tipe === 'TAKE_AWAY' ? ' [take away]' : '';
    return (n + 1) + '. ' + i.nama_snapshot + infoPilihan + tipe + ' x' + i.qty + ' @ ' + rp(i.harga_satuan_snapshot) + ' = ' + rp(i.harga_satuan_snapshot * i.qty);
  };

  const idx = baris.findIndex((l) => /^\s*(pesanan sementara|rincian pesanan)\b[^\n]*:\s*$/i.test(l));
  if (idx < 0) {
    // Tidak ada blok, tapi rincian baru saja dipanggil dan balasan tidak memuat totalnya: sisipkan blok dari DB
    if (rincianDitampilkan && draft && items.length > 0 && !String(teks).includes(rp(tagihan.grandTotal))) {
      const blok = ['Rincian pesanan ' + nomorPesanan(draft) + ':', ...items.map(barisRincian), ...barisTotalNota, ''];
      return blok.join('\n') + '\n' + String(teks);
    }
    return String(teks);
  }

  const rincian = /rincian/i.test(baris[idx]);
  let akhir = idx + 1;
  while (akhir < baris.length && /^\s*\d+\.\s/.test(baris[akhir])) akhir++;
  if (rincian) {
    let j = akhir;
    while (j < baris.length && baris[j].trim() === '') j++;
    while (j < baris.length && /^\s*(sub ?total|ppn|pajak|grand ?total|total)\b/i.test(baris[j])) { akhir = j + 1; j = akhir; }
  }

  let blok;
  if (!draft || items.length === 0) {
    blok = ['Belum ada menu yang tercatat di pesananmu nih.'];
  } else if (rincian) {
    blok = ['Rincian pesanan ' + nomorPesanan(draft) + ':', ...items.map(barisRincian), ...barisTotalNota];
  } else {
    blok = ['Pesanan sementara:', ...items.map((i, n) => (n + 1) + '. ' + labelItem(i))];
  }
  baris.splice(idx, akhir - idx, ...blok);
  return baris.join('\n');
}

function rapikanBalasanCustomer(jid, teks, { pertama = false, rincianDitampilkan = false, sudahDilayani = false } = {}) {
  let hasil = String(teks || '');
  if (!hasil) return hasil;
  const c = db.getCustomer(jid);

  hasil = selaraskanDaftarPesanan(jid, hasil, { rincianDitampilkan });

  if (c.nama && !c.sapaan) {
    const nama = c.nama.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    hasil = hasil.replace(new RegExp(`\\b(?:mas|mbak|mba)\\s+${nama}\\b`, 'gi'), c.nama);
  }

  void pertama; void sudahDilayani; // tidak ada lagi pertanyaan kedatangan di awal
  return hasil;
}

async function eksekusiSimpanNama({ nama, sapaan }, konteks) {
  const bersih = String(nama || '').trim().replace(/^(mas|mbak|mba|kak)\s+/i, '');
  let sapaanBersih = /^mbak|^mba\b/i.test(String(sapaan || '')) ? 'Mbak' : /^mas/i.test(String(sapaan || '')) ? 'Mas' : null;
  let sapaanDitolak = false;
  if (sapaanBersih && konteks.pesanTerakhir !== undefined) {
    const dariCustomer = sapaanDariPesan(konteks.pesanTerakhir);
    if (dariCustomer) sapaanBersih = dariCustomer; // yang tertulis di pesan customer menang atas tafsiran AI
    else { sapaanBersih = null; sapaanDitolak = true; }
  }
  if (!bersih && !sapaanBersih) {
    return sapaanDitolak
      ? { sukses: false, pesan: 'Sapaan tidak disebut customer, tidak disimpan.', catatan_untuk_ai: 'JANGAN menebak sapaan dari nama. Tanya customer enaknya dipanggil apa dengan DAFTAR BERNOMOR "1. Mas" dan "2. Mbak", lalu simpan jawabannya.' }
      : { sukses: false, pesan: 'Nama dan sapaan kosong.' };
  }

  if (bersih) db.setCustomerNama(konteks.jid, bersih);
  if (sapaanBersih) db.setSapaan(konteks.jid, sapaanBersih);
  const c = db.getCustomer(konteks.jid);

  let catatan;
  if (bersih && !c.sapaan) {
    catatan = "Ucapkan terima kasih singkat, lalu tanya enaknya dipanggil apa dengan DAFTAR BERNOMOR \"1. Mas\" dan \"2. Mbak\" (customer cukup balas satu kata).";
  } else if (sapaanBersih) {
    catatan = `Konfirmasi singkat dan mulai panggil "${c.sapaan}${c.nama ? ` ${c.nama}` : ''}". Kalau customer sebelumnya sudah setuju kirim QR dan data sudah lengkap, langsung panggil kirim_qr_pembayaran sekarang.`;
  } else {
    catatan = 'Ucapkan terima kasih singkat sambil sapa pakai namanya (1 kalimat).';
  }
  return { sukses: true, nama: c.nama || null, sapaan: c.sapaan || null, catatan_untuk_ai: catatan };
}

// "dine_in" -> 'DINE_IN', "take_away" -> 'TAKE_AWAY'
const TIPE_DB = { dine_in: 'DINE_IN', take_away: 'TAKE_AWAY' };
const LABEL_TIPE = { DINE_IN: 'dine in', TAKE_AWAY: 'take away' };

async function eksekusiHitungPerkiraanBujet({ item, jumlah_orang }) {
  const daftar = Array.isArray(item) ? item : [];
  if (daftar.length === 0) return { sukses: false, pesan: 'Daftar menu kosong.' };
  const baris = [];
  const tidakKetemu = [];
  const perluDipilih = [];
  let subtotal = 0;
  for (const it of daftar) {
    const qty = Math.max(1, Number(it.qty) || 1);
    const m = cariKandidatMenu(String(it.nama || ''));
    if (m.statusMatch === 'TIDAK_ADA' || !m.kandidatTerbaik) {
      if (m.statusMatch === 'AMBIGU_MULTI' && m.kandidatList?.length) perluDipilih.push({ nama: it.nama, pilihan: m.kandidatList.slice(0, 4).map((k) => k.nama) });
      else tidakKetemu.push(it.nama);
      continue;
    }
    const menu = m.kandidatTerbaik;
    const harga = menu.varian.reduce((min, v) => Math.min(min, v.harga), Infinity);
    const bervarian = menu.varian.length > 1;
    subtotal += harga * qty;
    baris.push(`${menu.nama}${menu.tersedia ? '' : ' (sedang habis)'} x${qty} = ${rp(harga * qty)}${bervarian ? ' (harga porsi terkecil)' : ''}`);
  }
  const tagihan = config.hitungTagihan(subtotal);
  const orang = Number(jumlah_orang) || 0;
  return {
    sukses: baris.length > 0,
    rincian: baris,
    subtotal,
    ppn: tagihan.ppn,
    grand_total: tagihan.grandTotal,
    per_orang: orang > 0 ? Math.ceil(tagihan.grandTotal / orang) : undefined,
    menu_tidak_ketemu: tidakKetemu.length ? tidakKetemu : undefined,
    perlu_dipilih: perluDipilih.length ? perluDipilih : undefined,
    catatan_untuk_ai: 'Ini PERKIRAAN, bukan pesanan. Sebut total sudah termasuk PPN 10% dan per orang kalau ada. Kalau ada menu yang tidak ketemu atau perlu dipilih, tanyakan dulu atau ganti dengan menu yang ada. Kalau ada yang bertanda "harga porsi terkecil", bilang harganya bisa lebih tinggi untuk porsi besar. Tawarkan: kalau cocok bisa langsung dipesan atau dibantu reservasi.',
  };
}

async function eksekusiRekomendasiMenu({ kelompok }, konteks) {
  const tersedia = db.getMenuTersedia();
  const idKat = kelompok ? new Set(db.getKategoriByKelompok(kelompok).map((k) => k.id)) : null;
  const sesuai = (m) => !idKat || idKat.has(m.kategori_id);
  // Menu margin dan andalan didahulukan (urutan tetap, supaya pengecekan "rekomendasi sama persis" di bawah bekerja)
  let kandidat = urutkanPrioritas(tersedia.filter((m) => (adaMargin(m) || m.andalan) && sesuai(m)), { acak: false });
  if (kandidat.length === 0) kandidat = tersedia.filter(sesuai);

  const bentuk = (m) => ({
    nama: m.nama,
    harga: rp(m.varian[0]?.harga),
    kelompok: LABEL_FASE[faseDariKategoriId(m.kategori_id)] || undefined,
    deskripsi: String(m.deskripsi || '').slice(0, 90),
  });
  let hasil;
  if (idKat) {
    hasil = kandidat.slice(0, 4).map(bentuk);
  } else {
    // Campuran: beberapa dari tiap fase supaya beragam
    hasil = ['berat', 'camilan', 'minuman']
      .flatMap((fase) => kandidat.filter((m) => faseDariKategoriId(m.kategori_id) === fase).slice(0, 2))
      .map(bentuk);
  }
  if (hasil.length === 0) return { sukses: false, pesan: 'Belum ada menu yang bisa direkomendasikan.' };

  const totalTersedia = tersedia.filter(sesuai).length;
  const namaKategori = (kelompok ? db.getKategoriByKelompok(kelompok) : db.getAllKategori()).map((k) => k.nama);
  const namaBaru = hasil.map((h) => h.nama);

  // Pemanggilan ulang dengan hasil yang sama persis ("yang lain deh") bukan jawaban: maksud customer belum jelas, TANYA dulu.
  const sebelumnya = konteks?.jid ? db.getPendingState(konteks.jid, 'rekomendasi') : null;
  if (sebelumnya && JSON.stringify(sebelumnya) === JSON.stringify(namaBaru)) {
    return {
      sukses: false,
      rekomendasi_sama: true,
      pesan: 'Rekomendasi yang sama sudah diberikan barusan.',
      total_menu_tersedia: totalTersedia,
      kategori: namaKategori,
      catatan_untuk_ai: 'JANGAN bilang "cuma ini yang tersedia": menu andalan hanya sebagian kecil, ada ' + totalTersedia + ' menu tersedia. Maksud customer ("yang lain") belum jelas, jadi TANYA dulu dengan DAFTAR BERNOMOR (maks 4 opsi), misal: "1. Lihat semua menu ' + (kelompok ? LABEL_FASE[kelompok] || kelompok : 'yang ada') + ' (kartu)", "2. Pilih kategori tertentu (' + namaKategori.slice(0, 4).join(', ') + ')", "3. Rekomendasi dari kelompok lain". Setelah customer menjawab, baru panggil tool yang sesuai (lihat_menu).',
    };
  }

  // Simpan daftar yang ditawarkan supaya balasan angka/nama dari customer dipetakan pasti (lihat buatKonteksDinamisCustomer)
  if (konteks?.jid) db.setPendingState(konteks.jid, 'rekomendasi', namaBaru);
  return {
    sukses: true,
    rekomendasi: hasil,
    total_menu_tersedia: totalTersedia,
    kategori: namaKategori,
    catatan_untuk_ai: 'Ini HANYA menu andalan, BUKAN seluruh menu (ada ' + totalTersedia + ' menu tersedia). Jangan pernah bilang "cuma ini yang tersedia". Tampilkan sebagai DAFTAR BERNOMOR (nama + harga, dan 1 frasa pendek kenapa enak), maksimal 4 baris, lalu 1 kalimat tanya mau yang mana (cukup balas nomor). Jangan kirim kartu menu, jangan tanya soal fase lagi. Kalau customer lalu minta "yang lain" tanpa jelas maksudnya, TANYA dulu (daftar bernomor) sebelum memanggil tool apa pun.',
  };
}

async function eksekusiAturLayanan({ tipe, kedatangan }, konteks) {
  if (!tipe && !kedatangan) return { sukses: false, pesan: 'Tidak ada yang diatur.' };

  const ubah = {};
  if (tipe) {
    if (!['dine_in', 'take_away', 'campur'].includes(tipe)) return { sukses: false, pesan: `Tipe "${tipe}" tidak dikenal.` };
    ubah.tipe = tipe === 'campur' ? 'DINE_IN' : TIPE_DB[tipe]; // campur: default dine in, menu take away ditandai sendiri
  }

  if (kedatangan) {
    const k = String(kedatangan).trim().toLowerCase();
    if (k === 'sekarang') {
      ubah.rencana = 'SEKARANG';
    } else {
      const menit = parseJam(k);
      if (menit === null) {
        return { sukses: false, pesan: `Jam "${kedatangan}" tidak terbaca.`, catatan_untuk_ai: 'Tanya ulang jam datangnya, minta format jam yang jelas (misal "jam 7 malam").' };
      }
      if (menit < menitSekarangBot()) {
        return { sukses: false, pesan: `Jam ${formatJam(menit)} sudah lewat (sekarang ${formatJam(menitSekarangBot())}).`, catatan_untuk_ai: 'Bilang singkat jam itu sudah lewat dan tanya jam datang yang benar. Pesan hanya untuk hari ini.' };
      }
      ubah.rencana = formatJam(menit);
    }
  }
  db.setLayanan(konteks.jid, ubah);
  if (tipe) db.setLayananDitanya(konteks.jid, 1);

  // Terapkan ke draft yang sudah ada (customer yang langsung memesan lalu baru menjawab pertanyaan layanan)
  const draft = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
  if (draft) {
    if (tipe && tipe !== 'campur') db.setTipeSemuaItemAktif(draft.id, ubah.tipe);
    if (ubah.rencana) db.setJadwalPesanan(draft.id, { jamDatang: ubah.rencana === 'SEKARANG' ? null : ubah.rencana });
  }

  // Customer baru menjawab pertanyaan "dine in atau take away" di akhir: lanjut ke rincian di giliran yang sama
  if (tipe && db.getPendingState(konteks.jid, 'tanya_layanan')) {
    db.clearPendingState(konteks.jid, 'tanya_layanan');
    const dr = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
    if (tipe === 'campur' && dr) {
      const daftar = db.getItemsByPesananId(dr.id).filter((i) => i.status_item === 'AKTIF');
      return {
        sukses: true,
        layanan: 'campur',
        item_di_draft: daftar.map((i, n) => `${n + 1}. ${i.nama_snapshot}`),
        catatan_untuk_ai: 'Customer mau sebagian take away. Tanyakan menu mana yang take away sebagai DAFTAR BERNOMOR dari item_di_draft (boleh balas beberapa nomor). Jawabannya -> ubah_tipe_item per menu (tipe take_away), lalu tampilkan_rincian_order.',
      };
    }
    if (dr) {
      const rincian = await eksekusiTampilkanRincianOrder({}, konteks);
      return { ...rincian, layanan: LABEL_TIPE[ubah.tipe] };
    }
  }

  const c = db.getCustomer(konteks.jid);
  const lengkap = !!c.rencana_datang;
  const draftSekarang = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
  const sudahMulai = !!draftSekarang || !!db.getAlur(konteks.jid).jalur; // customer sudah memilih/memesan sebelum ditanya kedatangan
  let lanjut = 'Lanjutkan sesuai yang diminta customer (lihat menu / pesan), JANGAN menanyakan mau mulai dari mana atau dine in/take away. ';
  if (lengkap && sudahMulai) {
    if (draftSekarang?.subtotal) {
      const { kurang, petunjuk } = dataKurangUntukQr(c, draftSekarang);
      lanjut = kurang.length > 0 ? 'LANJUT: ' + petunjuk + ' ' : 'LANJUT: tanya apakah rincian sudah benar dan boleh dilanjutkan ke pembayaran. ';
    } else {
      lanjut = 'Customer sudah memulai pesanan, lanjutkan alur sebelumnya tanpa menanyakan hal baru. ';
    }
  }
  return {
    sukses: true,
    layanan: LABEL_TIPE[c.tipe_default] || 'dine in (default)',
    kedatangan: c.rencana_datang === 'SEKARANG' ? 'sudah di resto' : c.rencana_datang ? `datang jam ${c.rencana_datang}` : null,
    catatan_untuk_ai: (lengkap
      ? 'Kedatangan tercatat. Konfirmasi singkat (1 kalimat), lalu ' + lanjut
      : 'Kedatangan belum jelas: tanya lagi sebagai DAFTAR BERNOMOR ("1. Sudah di resto" / "2. Datang nanti (sebutkan jamnya)"). ')
      + (ubah.rencana && ubah.rencana !== 'SEKARANG' ? 'Sebut singkat (sekali): pesanan dibayar dulu lewat QR, makanan baru dimasak setelah dikonfirmasi 30 menit sebelum jam datang. ' : ''),
  };
}

async function eksekusiUbahTipeItem({ nama_menu, tipe }, konteks) {
  const draft = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
  if (!draft) return { sukses: false, pesan: 'Tidak ada draft pesanan aktif saat ini.' };
  if (!TIPE_DB[tipe]) return { sukses: false, pesan: `Tipe "${tipe}" tidak dikenal.` };

  const match = cariKandidatMenu(nama_menu);
  const idMenu = match.kandidatList ? match.kandidatList.map((m) => m.id) : match.kandidatTerbaik ? [match.kandidatTerbaik.id] : [];
  const cocok = db.getItemsByPesananId(draft.id).filter((i) => i.status_item === 'AKTIF' && idMenu.includes(i.menu_id));
  if (cocok.length === 0) return { sukses: false, pesan: `Tidak ketemu "${nama_menu}" di draft pesanan.` };

  for (const i of cocok) db.setTipeItemPesanan(i.id, TIPE_DB[tipe]);
  return {
    sukses: true,
    diubah: cocok.map((i) => `${i.nama_snapshot} -> ${LABEL_TIPE[TIPE_DB[tipe]]}`),
    catatan_untuk_ai: 'Konfirmasi singkat 1 kalimat. Jangan upsell di balasan ini.',
  };
}

// Ringkasan item untuk pesan ke staf, dengan penanda take away dan catatan pesanan
function ringkasItemStaf(pesananId) {
  return [
    ...barisItemUntukStaf(db.getItemsByPesananId(pesananId)),
    ...barisCatatanPesanan(db.getPesananById(pesananId)),
  ];
}

async function eksekusiJadwalKedatangan({ aksi, jam_baru }, konteks) {
  const daftar = db.getPreOrderAktifByCustomer(konteks.jid);
  if (daftar.length === 0) {
    return {
      sukses: false,
      pesan: 'Tidak ada pesanan berjadwal yang sudah dibayar.',
      catatan_untuk_ai: 'Kalau customer mau membatalkan pesanan yang BELUM dibayar, pakai batalkan_order.',
    };
  }
  const customer = db.getCustomer(konteks.jid);
  const nama = [customer.sapaan, customer.nama].filter(Boolean).join(' ') || 'customer';
  const nomorList = daftar.map(nomorPesanan).join(', ');

  if (aksi === 'konfirmasi') {
    const baru = daftar.filter((p) => p.jadwal_status !== 'DIKONFIRMASI');
    for (const p of baru) {
      db.setJadwalPesanan(p.id, { jadwalStatus: 'DIKONFIRMASI' });
      await kirimKeSemuaOperator(konteks, [
        `🔥 MULAI MASAK | Pesanan ${nomorPesanan(p)} | ${nama}`,
        `Customer konfirmasi tetap sampai jam ${p.jam_datang}.`,
        ...ringkasItemStaf(p.id),
      ].join('\n'));
    }
    return {
      sukses: true,
      pesanan: nomorList,
      catatan_untuk_ai: `Bilang singkat dan hangat: pesanan ${nomorList} langsung dimasak sekarang. Ingatkan sekali: begitu sampai, cari meja lalu lapor ke waiter sambil menyebut nomor pesanan ${nomorList}, dan kabari nomor mejanya ke sini.`,
    };
  }

  if (aksi === 'batal') {
    for (const p of daftar) {
      db.setJadwalPesanan(p.id, { jadwalStatus: 'BATAL' });
      await kirimKeSemuaOperator(konteks, [
        `❌ TIDAK JADI DATANG | Pesanan ${nomorPesanan(p)} | ${nama}`,
        p.jadwal_status === 'DIKONFIRMASI' ? 'Sudah sempat dikonfirmasi/dimasak. Uang tidak dikembalikan.' : 'Belum dimasak, JANGAN dimasak. Uang tidak dikembalikan.',
        ...ringkasItemStaf(p.id),
      ].join('\n'));
    }
    return {
      sukses: true,
      pesanan_dibatalkan: nomorList,
      catatan_untuk_ai: 'Sampaikan santai dan sopan dalam 1-2 kalimat: makasih udah kasih tahu, dan uang yang sudah dibayar tidak bisa dikembalikan. Tanpa nada menyalahkan, boleh tutup dengan harapan bisa mampir lain waktu.',
    };
  }

  if (aksi === 'ubah_jam') {
    const menit = parseJam(jam_baru);
    if (menit === null) return { sukses: false, pesan: `Jam "${jam_baru}" tidak terbaca.`, catatan_untuk_ai: 'Tanya ulang jam barunya.' };
    if (menit < menitSekarangBot()) {
      return { sukses: false, pesan: `Jam ${formatJam(menit)} sudah lewat.`, catatan_untuk_ai: 'Bilang jam itu sudah lewat dan tanya jam yang benar.' };
    }
    const dekat = menit - menitSekarangBot() <= 30;
    for (const p of daftar) {
      db.setJadwalPesanan(p.id, { jamDatang: formatJam(menit), jadwalStatus: dekat ? 'DIKONFIRMASI' : 'MENUNGGU' });
      await kirimKeSemuaOperator(konteks, [
        `🕒 JAM DATANG BERUBAH | Pesanan ${nomorPesanan(p)} | ${nama}`,
        dekat ? `Sekarang jam ${formatJam(menit)}, sudah dekat: MULAI MASAK.` : `Jadi jam ${formatJam(menit)}. Tahan dulu, bot akan konfirmasi 30 menit sebelumnya.`,
        ...ringkasItemStaf(p.id),
      ].join('\n'));
    }
    db.setLayanan(konteks.jid, { rencana: formatJam(menit) });
    return {
      sukses: true,
      jam_baru: formatJam(menit),
      catatan_untuk_ai: dekat
        ? `Jam ${formatJam(menit)} sudah dekat, pesanan langsung dimasak. Konfirmasi singkat.`
        : `Konfirmasi singkat: jam datang jadi ${formatJam(menit)}, 30 menit sebelumnya akan ditanya lagi apakah tetap sampai.`,
    };
  }

  return { sukses: false, pesan: `Aksi "${aksi}" tidak dikenal.` };
}

async function eksekusiForwardPesanKeKasir({ ringkasan, urgent, pesanan_id }, konteks) {
  // Catatan biasa (urgent=false) untuk pesanan yang belum dimasak TIDAK dikirim sebagai chat sendiri:
  // disimpan di pesanan, lalu ikut di teks "MENUNGGU BAYAR" (dan tiket / "MULAI MASAK").
  if (!urgent) {
    const target = pesananUntukCatatan(konteks.jid);
    if (target) {
      const baru = db.tambahCatatanPesanan(target.id, String(ringkasan || '').trim());
      if (!baru) {
        return {
          sukses: true,
          sudah_tercatat: true,
          catatan_untuk_ai: 'Catatan ini SUDAH tercatat di pesanan sebelumnya. JANGAN panggil forward_pesan_ke_kasir lagi untuk catatan yang sama, cukup lanjutkan alur seperti biasa.',
        };
      }
      const sudahDinotif = target.status === 'MENUNGGU_BAYAR';
      const lunas = target.status === 'SELESAI';
      return {
        sukses: true,
        digabung_ke_pesanan: nomorPesanan(target),
        catatan_untuk_ai: `Catatan sudah ditempel di pesanan ${nomorPesanan(target)}. Bilang singkat dan natural bahwa sudah dicatat di pesanannya, JANGAN bilang pesan dikirim terpisah ke kasir. `
          + (lunas
            ? 'Pesanan ini pre-order yang belum dimasak, catatannya ikut terbaca dapur saat mulai masak.'
            : sudahDinotif
              ? 'QR sudah terkirim jadi kasir membacanya di tiket setelah pembayaran masuk.'
              : 'Kasir membacanya bareng info pesanan saat QR dikirim.'),
      };
    }
  }

  const customer = db.getCustomer(konteks.jid);

  if (db.getAllOperators().length === 0) {
    return { sukses: false, pesan: 'Tidak ada kasir yang terdaftar.' };
  }

  const nomorBersih = konteks.jid.split('@')[0];
  const infoMeja = customer.nomor_meja ? ` (meja ${customer.nomor_meja})` : '';
  const pTerkait = pesanan_id ? db.getPesananById(pesanan_id) : null;
  const infoPesanan = pTerkait ? ` [pesanan ${nomorPesanan(pTerkait)}]` : '';
  const tanda = urgent ? '🔴 URGENT' : 'ℹ️';

  // "selesai <nomor>" hanya relevan kalau bot dinonaktifkan (urgent -> ESKALASI). Non-urgent = info saja, bot tetap jalan.
  const pesanKeKasir = `${tanda} Dari ${customer.nama || nomorBersih}${infoMeja}${infoPesanan}:\n\n${ringkasan}\n\n`
    + (urgent
      ? `Bot nonaktif utk nomor ini, lanjut manual ya. Ketik "selesai ${nomorBersih}" kalau sudah kelar.`
      : 'Info saja, bot tetap melayani customer ini. Kalau mau balas customer, bilang aja ke aku isinya.');

  await kirimKeSemuaKasir(konteks, pesanKeKasir);

  if (urgent) {
    db.setStatusCs(konteks.jid, 'ESKALASI');
  }

  return {
    sukses: true,
    urgent,
    pesan: urgent
      ? 'Pesan sudah diteruskan ke kasir, dan percakapan dialihkan ke mereka langsung.'
      : 'Pesan sudah diteruskan ke kasir.',
  };
}

// ========== INFO RESTO, BOOKING, WAITER, OPEN BILL, RATING, KUIS ==========

async function eksekusiInfoResto({ topik }, konteks) {
  const i = config.info();
  const t = topik || 'semua';
  const teks = {
    jam: `Jam buka ${i.nama_resto}:\n${config.teksJamOperasional()}`,
    live_music: `Live music di ${i.nama_resto}:\n${config.teksLiveMusic()}`,
    ruang_vip: `${config.teksRuangVip()}\n\nMau booking? Sebutkan tanggal, jam, dan jumlah orangnya ya.`,
    full_booking: config.teksFullBooking(),
    lokasi: `${i.nama_resto}\n${i.alamat}\nReservasi: ${i.telepon_reservasi} | Instagram ${i.instagram}`,
    semua: config.teksInfoLengkap(),
  }[t] || config.teksInfoLengkap();
  await konteks.kirimPesan(konteks.jid, teks);
  return {
    sukses: true,
    topik: t,
    catatan_untuk_ai: 'Teks info lengkap SUDAH dikirim sistem ke customer. JANGAN mengulang isinya. Balas 1 kalimat singkat saja yang mengajak lanjut (mau booking, lihat menu, atau pesan).',
  };
}

const NAMA_JENIS_BOOKING = { RUANG_VIP: 'RUANG VIP (Meeting Cablaka)', FULL_RESTO: 'FULL BOOKING RESTO' };

async function eksekusiAjukanBooking(args, konteks) {
  const jenis = args.jenis === 'full_resto' ? 'FULL_RESTO' : 'RUANG_VIP';
  const c = db.getCustomer(konteks.jid);
  const nama = String(args.nama || c.nama || '').trim().replace(/^(mas|mbak|mba|kak)\s+/i, '');
  const kurang = [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.tanggal || ''))) kurang.push('tanggal');
  const jamMenit = args.jam ? parseJam(args.jam) : null;
  if (jamMenit === null) kurang.push('jam mulai');
  if (!args.jumlah_orang) kurang.push('perkiraan jumlah orang');
  if (!nama) kurang.push('nama pemesan');
  if (jenis === 'RUANG_VIP' && !args.rokok) kurang.push('area smoking atau non smoking');
  if (kurang.length > 0) {
    return {
      sukses: false,
      data_kurang: kurang,
      catatan_untuk_ai: `Data booking belum lengkap. Tanyakan SEMUA yang kurang sekaligus dalam satu pesan: ${kurang.join(', ')}. Hari ini ${tanggalBot()}. Setelah dijawab, panggil ajukan_booking lagi dengan data lengkap (gabungkan dengan yang sudah disebut).`,
    };
  }

  if (args.tanggal < tanggalBot()) {
    return { sukses: false, pesan: 'Tanggal sudah lewat.', catatan_untuk_ai: `Tanggal ${args.tanggal} sudah lewat (hari ini ${tanggalBot()}). Tanyakan tanggal yang benar.` };
  }
  const hari = new Date(`${args.tanggal}T12:00:00Z`).getUTCDay();
  const jadwal = config.info().jam_operasional.find((j) => j.hari.includes(hari));
  if (!jadwal || jamMenit < config.menitDariJam(jadwal.buka) || jamMenit >= config.menitDariJam(jadwal.tutup)) {
    return { sukses: false, pesan: 'Jam di luar jam buka.', catatan_untuk_ai: `Jam itu di luar jam buka pada hari tersebut (${jadwal ? `${config.fmtJam(jadwal.buka)}-${config.fmtJam(jadwal.tutup)}` : 'tutup'}). Tanyakan jam lain.` };
  }
  const kapasitas = jenis === 'RUANG_VIP' ? 30 : (config.info().kapasitas_seat || 80);
  if (Number(args.jumlah_orang) > kapasitas) {
    return {
      sukses: false,
      pesan: `Melebihi kapasitas ${kapasitas}.`,
      catatan_untuk_ai: jenis === 'RUANG_VIP'
        ? 'Ruang VIP maksimal 30 orang. Tawarkan booking seluruh resto (80 seat) sebagai DAFTAR BERNOMOR "1. Booking seluruh resto" dan "2. Ubah jumlah orang".'
        : 'Melebihi 80 seat, sampaikan santai dan tanya jumlah yang benar.',
    };
  }

  const jam = formatJam(jamMenit);
  const sama = db.getBookingAktifByCustomer(konteks.jid).find((b) => b.jenis === jenis && b.tanggal === args.tanggal && b.jam === jam);
  if (sama) {
    return { sukses: true, sudah_ada: true, nomor_booking: sama.id, catatan_untuk_ai: `Booking ini sudah diajukan (#${sama.id}) dan sedang diproses tim. Bilang itu, jangan ajukan ulang.` };
  }

  const rokok = args.rokok === 'smoking' ? 'SMOKING' : args.rokok === 'non_smoking' ? 'NON_SMOKING' : null;
  const id = db.buatBooking({
    customer_jid: konteks.jid, jenis, tanggal: args.tanggal, jam,
    jumlah_orang: Number(args.jumlah_orang), nama, rokok, catatan: args.catatan || null,
  });
  if (nama && !c.nama) db.setCustomerNama(konteks.jid, nama);

  const v = config.info().ruang_vip;
  await kirimKeSemuaKasir(konteks, [
    `📅 BOOKING #${id} | ${NAMA_JENIS_BOOKING[jenis]}`,
    `Nama: ${nama} (WA ${konteks.jid.split('@')[0]})`,
    `Tanggal: ${args.tanggal} jam ${jam} | ${args.jumlah_orang} orang`,
    rokok ? `Area: ${rokok === 'SMOKING' ? 'smoking' : 'non smoking'}` : null,
    args.catatan ? `Catatan: ${args.catatan}` : null,
    jenis === 'RUANG_VIP' ? `Ketentuan: min spend ${rp(v.minimum_spend)}, DP ${rp(v.deposit)} di awal.` : 'Syarat full booking dibahas langsung dengan customer.',
    '',
    `Balas: "booking ${id} diterima" atau "booking ${id} ditolak <alasan>"`,
  ].filter(Boolean).join('\n'));

  return {
    sukses: true,
    nomor_booking: id,
    catatan_untuk_ai: `Booking #${id} sudah diteruskan ke tim dan MENUNGGU konfirmasi (ketersediaan dicek manusia, jangan menjanjikan pasti). ${jenis === 'RUANG_VIP' ? `Kalau diterima, deposit ${rp(v.deposit)} wajib dibayar di awal (QR dikirim tim).` : 'Tim akan menghubungi untuk syarat dan detailnya.'} Rangkum singkat data booking (tanggal, jam, jumlah orang) dalam 1-2 kalimat.`,
  };
}

async function eksekusiPanggilWaiter({ keperluan }, konteks) {
  const c = db.getCustomer(konteks.jid);
  const meja = c.nomor_meja;
  if (!meja) {
    return { sukses: false, perlu_meja: true, pesan: 'Nomor meja belum ada.', catatan_untuk_ai: 'Tanyakan nomor mejanya (1 kalimat) supaya waiter tahu ke mana. Jawabannya -> konfirmasi_kedatangan, lalu panggil panggil_waiter lagi dengan keperluan yang sama.' };
  }
  const terakhir = db.getPendingState(konteks.jid, 'waiter');
  if (terakhir && Date.now() - terakhir.at < 2 * 60 * 1000) {
    return { sukses: true, sudah_dipanggil: true, catatan_untuk_ai: 'Waiter baru saja dipanggilkan (kurang dari 2 menit lalu). Bilang waiter sedang menuju meja, sebentar ya.' };
  }
  db.setPendingState(konteks.jid, 'waiter', { at: Date.now() });
  await kirimKeSemuaKasir(konteks, `🔔 PANGGIL WAITER | Meja ${meja} | ${sebutCustomer(c, konteks.jid)}${keperluan ? ` | ${keperluan}` : ''}`);
  return { sukses: true, nomor_meja: meja, catatan_untuk_ai: `Waiter sudah dipanggilkan ke meja ${meja}. Bilang 1 kalimat: sudah dipanggilkan, sebentar ya.` };
}

async function eksekusiAturCaraBayar({ cara }, konteks) {
  const open = cara === 'open_bill';
  const draft = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
  const items = draft ? db.getItemsByPesananId(draft.id).filter((i) => i.status_item === 'AKTIF') : [];
  const c = db.getCustomer(konteks.jid);
  const preOrder = !!draft?.jam_datang && c.status_kedatangan !== 'DI_RESTO';
  if (open && (preOrder || items.some((i) => i.tipe === 'TAKE_AWAY') || c.tipe_default === 'TAKE_AWAY')) {
    return {
      sukses: false,
      pesan: 'Open bill hanya untuk makan di tempat.',
      catatan_untuk_ai: 'Open bill hanya untuk dine in; take away dan pre-order wajib bayar dulu. Sampaikan santai 1-2 kalimat dan lanjut seperti biasa (bayar dulu).',
    };
  }
  db.setCaraBayar(konteks.jid, open ? 'OPEN_BILL' : 'BAYAR_DULU');
  return {
    sukses: true,
    cara: open ? 'open bill' : 'bayar dulu',
    catatan_untuk_ai: open
      ? 'Open bill dicatat: pesanan akan langsung masuk dapur dan dibayar di akhir (customer minta bill kapan saja). Konfirmasi 1 kalimat lalu lanjutkan alur pesanan seperti biasa (rincian, lalu kirim_qr_pembayaran setelah customer setuju).'
      : 'Dicatat bayar dulu. Konfirmasi 1 kalimat dan lanjutkan alur.',
  };
}

async function eksekusiMintaBill(_, konteks) {
  const open = db.getPesananOpenBillByCustomer(konteks.jid);
  if (open.length === 0) {
    return { sukses: false, pesan: 'Tidak ada pesanan open bill yang belum dibayar.', catatan_untuk_ai: 'Bilang tidak ada tagihan yang menunggu (pesanan yang bayar dulu sudah lunas / belum ada pesanan). Kalau ada pesanan menunggu bayar, arahkan ke QR-nya.' };
  }
  const c = db.getCustomer(konteks.jid);
  const { teks, total } = nota.teksNotaGabungan(open);
  const meja = c.nomor_meja || open[0].nomor_meja || '-';

  let permintaan = open.map((p) => db.getPermintaanQrByPesanan(p.id)).find((r) => r && r.jenis === 'BILL');
  let statusQr;
  if (!permintaan) {
    permintaan = db.buatPermintaanQr({
      jenis: 'BILL', refIds: open.map((p) => p.id), customerJid: konteks.jid,
      label: `Bill meja ${meja}`, nominal: total.grandTotal,
    });
    await kirimTiketPermintaanQr(konteks, permintaan, [
      `💳 MINTA QR | BILL (open bill) | ${sebutCustomer(c, konteks.jid)} | Meja ${meja}`,
      teks,
      '',
      `Buat QRIS ${rp(total.grandTotal)} di POS, foto QR-nya, lalu kirim ke chat ini sebagai REPLY pesan ini (atau tulis "meja ${meja}" di caption).`,
      `Kalau sudah dibayar, bilang: "meja ${meja} udah bayar" (semua pesanan open bill meja ini lunas sekaligus)`,
    ].join('\n'));
    statusQr = 'MENUNGGU_KASIR';
  } else if (permintaan.status === 'TERKIRIM') {
    statusQr = (await konteks.kirimQrKeCustomer(permintaan.id)) ? 'DIKIRIM_ULANG' : 'GAGAL';
  } else {
    statusQr = 'MASIH_MENUNGGU_KASIR';
  }

  const draftBaru = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
  return {
    sukses: true,
    pesanan: open.map((p) => nomorPesanan(p)),
    subtotal: total.subtotal,
    ppn: total.ppn,
    grand_total: total.grandTotal,
    status_qr: statusQr,
    ada_draft_belum_dikonfirmasi: draftBaru && draftBaru.status === 'DRAFT_MENUNGGU_KONFIRMASI' ? true : undefined,
    catatan_untuk_ai: (statusQr === 'DIKIRIM_ULANG' ? 'QR bill sudah dikirim ulang. ' : statusQr === 'GAGAL' ? 'QR gagal terkirim, bilang kasir akan mengirimnya. ' : `Permintaan QR bill ${rp(total.grandTotal)} sudah diteruskan ke kasir; QR BELUM dikirim, kasir yang membuatnya lalu diteruskan otomatis. `)
      + `Tampilkan ringkasan bill: pesanan ${open.map((p) => nomorPesanan(p)).join(', ')}, Subtotal ${rp(total.subtotal)}, PPN ${rp(total.ppn)}, Grand Total ${rp(total.grandTotal)} (singkat, 2-3 baris), dan bilang QR-nya lagi disiapkan kasir.`
      + (draftBaru && draftBaru.status === 'DRAFT_MENUNGGU_KONFIRMASI' ? ' Catatan: ada pesanan baru yang belum dikonfirmasi dan TIDAK ikut dalam bill ini.' : ''),
  };
}

// ---------- RATING ----------
const KATA_ANGKA = { satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5 };

// "5", "4/5", "bintang 4", "lima bintang", "nilai 3 ya" -> 1..5, selain itu null (tidak ditebak)
function parseRating(teks) {
  const t = atribut.norm(teks).replace(/\b(bintang|star|stars|nilai|rating|kasih|kak|dong|deh|ya|yaa|aja|saja|dari|untuk|sih|nih|poin|point)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const m = t.match(/^([1-5])(?: ?5)?$/) || t.match(/^(satu|dua|tiga|empat|lima)$/);
  if (!m) return null;
  return KATA_ANGKA[m[1]] ?? Number(m[1]);
}

function terapkanRating(jid, nilai) {
  const k = db.getKunjunganRating(jid);
  if (!k) return null;
  const c = db.getCustomer(jid);
  const sapa = sebutCustomer(c, jid);
  if (nilai >= 3) {
    db.updateKunjungan(k.id, { rating: nilai, status: 'SELESAI' });
    return `Makasih banyak ${sapa} 🙏 Sampai ketemu lagi di The Banjoemas ya!`;
  }
  db.updateKunjungan(k.id, { rating: nilai, status: 'MENUNGGU_ALASAN' });
  return `Maaf banget ya ${sapa}, kami belum bisa bikin kunjunganmu nyaman 🙏 Boleh cerita singkat, kendalanya apa tadi?`;
}

async function terapkanAlasanRating(jid, teks, konteks) {
  const k = db.getKunjunganRating(jid);
  if (!k) return null;
  db.updateKunjungan(k.id, { alasan: String(teks).slice(0, 500), status: 'SELESAI' });
  const c = db.getCustomer(jid);
  await kirimKeSemuaKasir(konteks, `⚠️ RATING RENDAH ${k.rating}/5 | ${sebutCustomer(c, jid)} | Meja ${k.nomor_meja || '-'} | WA ${jid.split('@')[0]}\nKendala: ${String(teks).slice(0, 500)}`);
  return 'Makasih masukannya ya, udah kami sampaikan ke tim. Sekali lagi maaf, semoga lain kali lebih nyaman 🙏';
}

async function eksekusiCatatRating({ nilai }, konteks) {
  const n = Number(nilai);
  if (!(n >= 1 && n <= 5)) return { sukses: false, pesan: 'Nilai harus 1 sampai 5.' };
  const k = db.getKunjunganRating(konteks.jid);
  if (!k || k.status !== 'MENUNGGU_RATING') return { sukses: false, pesan: 'Tidak sedang menunggu rating.' };
  const balasan = terapkanRating(konteks.jid, Math.round(n));
  return { sukses: true, nilai: n, catatan_untuk_ai: `Balas persis dengan kalimat ini (jangan diubah): ${balasan}` };
}

// ---------- KUIS BANYUMASAN ----------
function teksSoalKuis(state) {
  const soal = config.kuis().soal[state.soal[state.i]];
  return [
    `Soal ${state.i + 1}/${state.soal.length}: ${soal.pertanyaan}`,
    ...soal.opsi.map((o, n) => `${n + 1}. ${o}`),
  ].join('\n');
}

function mulaiKuisState(jid) {
  const bank = config.kuis();
  const idx = bank.soal.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, bank.soal_per_ronde || 5);
  const state = { soal: idx, i: 0, skor: 0 };
  db.setPendingState(jid, 'kuis', state);
  db.clearPendingState(jid, 'kuis_tawaran');
  return `Kuis Banyumasan, ${idx.length} soal. Balas dengan nomor jawabannya, atau ketik "stop" kalau udah cukup.\n\n${teksSoalKuis(state)}`;
}

async function eksekusiMulaiKuis(_, konteks) {
  if (config.kuis().soal.length === 0) return { sukses: false, pesan: 'Belum ada soal kuis.', catatan_untuk_ai: 'Bilang kuisnya belum tersedia, santai.' };
  db.setPendingState(konteks.jid, 'tambahan_balasan', mulaiKuisState(konteks.jid));
  return { sukses: true, catatan_untuk_ai: 'Soal pertama dikirim sistem sebagai pesan terpisah setelah balasanmu. Balas 1 kalimat singkat yang menyemangati (jangan sebut soalnya).' };
}

const KATA_BERHENTI_KUIS = /\b(stop|udah|sudah|cukup|berhenti|nggak mau|gak mau|ga mau|males|skip|batal)\b/i;
const KATA_MAU = /^(kuis|mau|iya|ya|yaa|yuk|ayo|gas|boleh|oke|ok|siap|sip|main|mau dong|boleh dong|ayo dong|yuk main|mau main)( dong| deh| aja| ya)?$/i;

// Jawaban kuis hanya ditangkap kalau pesan bot sebelumnya memang soal kuis / tawaran kuis (supaya "2" untuk daftar pilihan lain tidak salah tangkap)
function pesanBotTerakhir(jid) {
  const h = db.getChatHistory(jid, 1)[0];
  return h && h.role === 'assistant' ? h.content : '';
}

// Hasil: teks balasan (kode yang menjawab, AI tidak dipanggil) atau null (serahkan ke AI)
async function tangkapRatingDanKuis(jid, teks, konteks) {
  const t = String(teks || '').trim();

  // 1. Rating
  const k = db.getKunjunganRating(jid);
  if (k) {
    const lewat = k.selesai_at && Date.now() - new Date(k.selesai_at).getTime() > 2 * 3600 * 1000;
    if (lewat) {
      db.updateKunjungan(k.id, { status: 'SELESAI' });
    } else if (k.status === 'MENUNGGU_ALASAN') {
      if (t.length >= 2) return terapkanAlasanRating(jid, t, konteks);
    } else {
      const nilai = parseRating(t);
      if (nilai) return terapkanRating(jid, nilai);
      if (t.length > 30) db.updateKunjungan(k.id, { status: 'SELESAI' }); // pesan panjang = topik lain, rating dilewati
    }
  }

  // 2. Kuis
  const terakhir = pesanBotTerakhir(jid);
  const state = db.getPendingState(jid, 'kuis');
  if (state && /^Soal \d+\/\d+:/m.test(terakhir)) {
    if (KATA_BERHENTI_KUIS.test(t) && t.length <= 30) {
      db.clearPendingState(jid, 'kuis');
      return `Siap, kuisnya disudahi. Skor sementara kamu ${state.skor}/${state.i}. Seru juga ya 😄`;
    }
    const soal = config.kuis().soal[state.soal[state.i]];
    const norm = atribut.norm(t);
    let pilih = null;
    const angka = norm.match(/^(?:nomor |no |jawab |pilih )?([1-9])$/);
    if (angka) pilih = Number(angka[1]);
    else {
      const huruf = norm.match(/^(?:jawab |pilih )?([a-d])$/);
      if (huruf) pilih = huruf[1].charCodeAt(0) - 96;
      else {
        const idx = soal.opsi.findIndex((o) => atribut.norm(o) === norm);
        if (idx >= 0) pilih = idx + 1;
      }
    }
    if (!pilih || pilih > soal.opsi.length) {
      if (t.length <= 20) return `Jawab pakai nomor pilihannya ya (1 sampai ${soal.opsi.length}), atau ketik "stop" kalau udah cukup 🙂`;
      return null; // pesan panjang = topik lain
    }
    const benar = pilih === soal.jawaban;
    const skor = state.skor + (benar ? 1 : 0);
    const umpan = benar ? `Benar! ${soal.info || ''}` : `Belum tepat. ${soal.info || ''}`;
    if (state.i + 1 >= state.soal.length) {
      db.clearPendingState(jid, 'kuis');
      return `${umpan}\n\nSelesai! Skor kamu ${skor}/${state.soal.length}. Matur nuwun udah main 😄`;
    }
    const baru = { ...state, i: state.i + 1, skor };
    db.setPendingState(jid, 'kuis', baru);
    return `${umpan}\n\n${teksSoalKuis(baru)}`;
  }
  if (state && !/^Soal \d+\/\d+:/m.test(terakhir) && KATA_BERHENTI_KUIS.test(t) && /\bkuis\b/i.test(t)) {
    db.clearPendingState(jid, 'kuis');
    return 'Siap, kuisnya disudahi 😄';
  }

  // 3. Jawaban atas tawaran kuis
  if (db.getPendingState(jid, 'kuis_tawaran') && /kuis Banyumasan/i.test(terakhir)) {
    if (KATA_MAU.test(atribut.norm(t)) && config.kuis().soal.length > 0) return mulaiKuisState(jid);
    if (/^(nggak|gak|ga|enggak|tidak|nanti|skip|males|belum)\b/i.test(t)) {
      db.clearPendingState(jid, 'kuis_tawaran');
      return 'Oke, kalau berubah pikiran tinggal bilang "kuis" ya 🙂';
    }
  }
  return null;
}

// ---------- OPERATOR: BOOKING ----------
async function eksekusiKonfirmasiBooking({ nomor_booking, aksi, alasan }, konteks) {
  const b = db.getBooking(nomor_booking);
  if (!b) return { sukses: false, pesan: `Booking #${nomor_booking} tidak ditemukan.` };
  if (b.status !== 'MENUNGGU_KONFIRMASI') return { sukses: false, pesan: `Booking #${b.id} statusnya ${b.status}, bukan menunggu konfirmasi.` };
  const c = db.getCustomer(b.customer_jid);
  const sapa = sebutCustomer(c, b.customer_jid);
  const ringkas = `${NAMA_JENIS_BOOKING[b.jenis]} tanggal ${b.tanggal} jam ${b.jam} untuk ${b.jumlah_orang} orang`;

  if (aksi === 'tolak') {
    db.setStatusBooking(b.id, 'DITOLAK');
    const pesan = `Maaf ${sapa}, booking ${ringkas} belum bisa kami terima${alasan ? `: ${alasan}` : ''}. Boleh pilih tanggal atau jam lain? 🙏`;
    await konteks.kirimPesan(b.customer_jid, pesan);
    db.simpanChatHistory(b.customer_jid, 'assistant', pesan);
    return { sukses: true, nomor_booking: b.id, status: 'ditolak', customer_dikabari: true };
  }

  const deposit = b.jenis === 'RUANG_VIP' ? Number(config.info().ruang_vip?.deposit || 0) : 0;
  if (deposit > 0) {
    db.setStatusBooking(b.id, 'MENUNGGU_DEPOSIT');
    const permintaan = db.buatPermintaanQr({
      jenis: 'DEPOSIT', refIds: [b.id], customerJid: b.customer_jid,
      label: `deposit booking #${b.id}`, nominal: deposit,
    });
    await kirimTiketPermintaanQr(konteks, permintaan, [
      `💳 MINTA QR DEPOSIT | Booking #${b.id} | ${sapa} | ${ringkas}`,
      `Deposit: ${rp(deposit)} (wajib dibayar di awal)`,
      '',
      `Buat QRIS ${rp(deposit)} di POS, foto QR-nya, lalu kirim ke chat ini sebagai REPLY pesan ini (atau tulis "booking ${b.id}" di caption).`,
      `Kalau sudah masuk, bilang: "deposit booking ${b.id} sudah masuk"`,
    ].join('\n'));
    const pesan = `Kabar baik ${sapa}, booking ${ringkas} diterima 🎉 Untuk mengunci, DP ${rp(deposit)} dibayar di awal (dihitung sebagai bagian dari minimum spend). QR-nya lagi disiapkan kasir, sebentar ya.${alasan ? `\nCatatan tim: ${alasan}` : ''}`;
    await konteks.kirimPesan(b.customer_jid, pesan);
    db.simpanChatHistory(b.customer_jid, 'assistant', pesan);
    return { sukses: true, nomor_booking: b.id, status: 'diterima, menunggu deposit', customer_dikabari: true };
  }

  db.setStatusBooking(b.id, 'DIKONFIRMASI');
  const pesan = `Kabar baik ${sapa}, booking ${ringkas} dikonfirmasi 🎉${alasan ? ` ${alasan}` : ' Tim kami akan menghubungi untuk detail selanjutnya.'}`;
  await konteks.kirimPesan(b.customer_jid, pesan);
  db.simpanChatHistory(b.customer_jid, 'assistant', pesan);
  return { sukses: true, nomor_booking: b.id, status: 'dikonfirmasi', customer_dikabari: true };
}

async function eksekusiKonfirmasiDepositBooking({ nomor_booking }, konteks) {
  const b = db.getBooking(nomor_booking);
  if (!b) return { sukses: false, pesan: `Booking #${nomor_booking} tidak ditemukan.` };
  if (b.status !== 'MENUNGGU_DEPOSIT') return { sukses: false, pesan: `Booking #${b.id} statusnya ${b.status}, bukan menunggu deposit.` };
  const deposit = Number(config.info().ruang_vip?.deposit || 0);
  db.setStatusBooking(b.id, 'DIKONFIRMASI', deposit);
  const perm = db.getPermintaanQrByRef('DEPOSIT', b.id);
  if (perm) db.setPermintaanQrLunas(perm.id);
  const sapa = sebutCustomer(db.getCustomer(b.customer_jid), b.customer_jid);
  const pesan = `Makasih ${sapa}, DP ${rp(deposit)} udah masuk. Booking ${NAMA_JENIS_BOOKING[b.jenis]} tanggal ${b.tanggal} jam ${b.jam} resmi terkunci ✅ Sampai ketemu!`;
  await konteks.kirimPesan(b.customer_jid, pesan);
  db.simpanChatHistory(b.customer_jid, 'assistant', pesan);
  return { sukses: true, nomor_booking: b.id, deposit, customer_dikabari: true };
}

const EKSEKUTOR_CUSTOMER = {
  info_resto: eksekusiInfoResto,
  ajukan_booking: eksekusiAjukanBooking,
  hitung_perkiraan_bujet: eksekusiHitungPerkiraanBujet,
  panggil_waiter: eksekusiPanggilWaiter,
  atur_cara_bayar: eksekusiAturCaraBayar,
  minta_bill: eksekusiMintaBill,
  catat_rating: eksekusiCatatRating,
  mulai_kuis: eksekusiMulaiKuis,
  lihat_menu: eksekusiLihatMenu,
  tanya_detail_menu: eksekusiTanyaDetailMenu,
  cari_menu_atribut: eksekusiCariMenuAtribut,
  buat_order: eksekusiBuatOrder,
  jawab_klarifikasi_menu: eksekusiJawabKlarifikasiMenu,
  jawab_pilihan_menu: eksekusiJawabPilihanMenu,
  hapus_item_order: eksekusiHapusItemOrder,
  putuskan_item_habis: eksekusiPutuskanItemHabis,
  tampilkan_rincian_order: eksekusiTampilkanRincianOrder,
  kirim_qr_pembayaran: eksekusiKirimQrPembayaran,
  batalkan_order: eksekusiBatalkanOrder,
  cek_status_order_saya: eksekusiCekStatusOrderSaya,
  konfirmasi_kedatangan: eksekusiKonfirmasiKedatangan,
  forward_pesan_ke_kasir: eksekusiForwardPesanKeKasir,
  kirim_qr_kekurangan: eksekusiKirimQrKekurangan,
  ubah_jumlah_item: eksekusiUbahJumlahItem,
  rekomendasi_menu: eksekusiRekomendasiMenu,
  atur_layanan: eksekusiAturLayanan,
  ubah_tipe_item: eksekusiUbahTipeItem,
  jadwal_kedatangan: eksekusiJadwalKedatangan,
  pilih_jalur: eksekusiPilihJalur,
  lewati_fase: eksekusiLewatiFase,
  simpan_nama: eksekusiSimpanNama,
};

// ========== EKSEKUTOR — KASIR ==========

async function cariPesananUntukKonfirmasi({ pesanan_id, nomor_meja, nomor_pesanan }) {
  if (nomor_pesanan) {
    // Nomor yang dibaca kasir dari notifikasi ("pesanan 7"), bukan id di DB
    const p = db.getPesananByNomorHarian(nomor_pesanan);
    return p ? [p] : [];
  }
  if (pesanan_id) {
    const p = db.getPesananById(pesanan_id);
    return p ? [p] : [];
  }
  if (nomor_meja) {
    const meja = db.normalisasiMeja(nomor_meja);
    return db.getPesananBelumLunas().filter((p) => db.normalisasiMeja(p.nomor_meja) === meja || db.normalisasiMeja(p.nomor_meja_customer) === meja);
  }
  return db.getPesananBelumLunas();
}

// Open bill dilunasi sekaligus: semua pesanan OPEN_BILL satu customer. Dapur sudah dapat tiketnya, jadi tidak ada tiket baru.
async function lunasiOpenBill(pesananList, konteks) {
  const jid = pesananList[0].customer_jid;
  const customer = db.getCustomer(jid);
  const { total } = nota.teksNotaGabungan(pesananList);
  for (const p of pesananList) {
    db.setPesananLunas(p.id);
    const perm = db.getPermintaanQrByPesanan(p.id);
    if (perm) db.setPermintaanQrLunas(perm.id);
  }
  const sapa = customer.nama ? [customer.sapaan, customer.nama].filter(Boolean).join(' ') : 'Mas/Mbak';
  const pesan = `Makasih ${sapa}, pembayaran bill-nya udah masuk (${pesananList.map((p) => nomorPesanan(p)).join(', ')}, total ${rp(total.grandTotal)}) 🙏`;
  await konteks.kirimPesan(jid, pesan);
  db.simpanChatHistory(jid, 'assistant', pesan);
  return {
    sukses: true,
    open_bill_lunas: true,
    customer: customer.nama,
    pesanan: pesananList.map((p) => nomorPesanan(p)),
    total: total.grandTotal,
    catatan_untuk_ai: 'Bill open bill customer ini sudah lunas dan customer sudah dikabari. Kalau kasir juga mau mengosongkan meja, bilang "meja X kosong".',
  };
}

async function eksekusiKonfirmasiBayar({ pesanan_id, nomor_meja, nomor_pesanan }, konteks) {
  const kandidat = await cariPesananUntukKonfirmasi({ pesanan_id, nomor_meja, nomor_pesanan });

  if (kandidat.length === 0) {
    return { sukses: false, pesan: 'Tidak ketemu pesanan yang sedang menunggu bayar untuk itu.' };
  }

  // Beberapa pesanan open bill milik satu customer = satu bill, dilunasi sekaligus
  const semuaOpenBill = kandidat.every((p) => p.status === 'OPEN_BILL' || (p.metode_bayar === 'OPEN_BILL' && p.status === 'MENUNGGU_BAYAR'));
  if (kandidat.length > 1 && semuaOpenBill && new Set(kandidat.map((p) => p.customer_jid)).size === 1) {
    return lunasiOpenBill(kandidat, konteks);
  }

  if (kandidat.length > 1) {
    return {
      sukses: false,
      ada_banyak_kandidat: true,
      daftar: kandidat.map((p) => ({ nomor_pesanan: nomorPesanan(p), meja: p.nomor_meja, nama: p.nama, status: p.status === 'OPEN_BILL' ? 'open bill' : 'menunggu bayar' })),
      catatan_untuk_ai: 'Ada lebih dari 1 pesanan belum lunas yang cocok, tanya balik pesanan mana (format angka, sebut nomor pesanan) sebelum konfirmasi.',
    };
  }

  const pesanan = kandidat[0];
  if (pesanan.status === 'OPEN_BILL') {
    return lunasiOpenBill([pesanan], konteks);
  }
  if (pesanan.status !== 'MENUNGGU_BAYAR') {
    return { sukses: false, pesan: `Pesanan ${nomorPesanan(pesanan)} statusnya "${pesanan.status}", bukan sedang menunggu bayar.` };
  }

  db.setPesananLunas(pesanan.id);
  const permBayar = db.getPermintaanQrByPesanan(pesanan.id);
  if (permBayar) db.setPermintaanQrLunas(permBayar.id);

  const customer = db.getCustomer(pesanan.customer_jid);
  const items = db.getItemsByPesananId(pesanan.id);
  const nomor = nomorPesanan(pesanan);
  const sapa = customer.nama ? [customer.sapaan, customer.nama].filter(Boolean).join(' ') : 'Mas/Mbak';

  // Pre-order: customer belum sampai. Tiket tetap langsung diteruskan ke staf, tapi MASAK baru dimulai
  // kalau jam datang sudah dekat (<= 30 menit) atau setelah customer konfirmasi 30 menit sebelumnya.
  const preOrder = !!pesanan.jam_datang && customer.status_kedatangan !== 'DI_RESTO';
  const menitJam = preOrder ? parseJam(pesanan.jam_datang) : null;
  const sudahDekat = preOrder && menitJam !== null && menitJam - menitSekarangBot() <= 30;
  const mode = preOrder && !sudahDekat ? 'TUNGGU' : 'MASAK';

  if (preOrder) {
    db.setJadwalPesanan(pesanan.id, { jadwalStatus: mode === 'TUNGGU' ? 'MENUNGGU' : 'DIKONFIRMASI' });
  }

  let pesanDapur;
  if (!preOrder) {
    const pesanKeCustomer = await ai.generateKonfirmasiOrderMasukDapur([customer.sapaan, customer.nama].filter(Boolean).join(' ') || customer.nama, items, pesanan.nomor_meja, nomor);
    pesanDapur = pesanKeCustomer || `Makasih ${sapa}, pembayarannya udah masuk. Pesanan ${nomor} langsung jalan ke dapur ya 🙏`;
  } else if (mode === 'MASAK') {
    pesanDapur = `Makasih ${sapa}, pembayarannya udah masuk. Pesanan ${nomor} langsung dimasak ya, jam ${pesanan.jam_datang} udah dekat. Sampai resto, cari meja terus lapor ke waiter sebut nomor pesanan ${nomor} ya 🙏`;
  } else {
    pesanDapur = `Makasih ${sapa}, pembayarannya udah masuk. Pesanan ${nomor} dicatat buat jam ${pesanan.jam_datang}. 30 menit sebelumnya aku tanyain lagi apa tetap sampai, kalau iya langsung dimasak biar pas sampai udah siap. Nanti di resto, cari meja terus lapor ke waiter sebut nomor pesanan ${nomor} ya 🙏`;
  }
  await konteks.kirimPesan(customer.jid, pesanDapur);
  db.simpanChatHistory(customer.jid, 'assistant', pesanDapur);

  // Kunjungan dimulai (dasar timer 3 jam & rating) begitu customer yang sudah di resto membayar. Lalu tawaran kuis sekali.
  if (!preOrder) {
    db.mulaiKunjungan(customer.jid, pesanan.nomor_meja || customer.nomor_meja);
    const kuisMsg = tawaranKuisSekali(customer.jid);
    if (kuisMsg) {
      await konteks.kirimPesan(customer.jid, kuisMsg);
      db.simpanChatHistory(customer.jid, 'assistant', kuisMsg);
    }
  }

  // Tiket ke staf (semua operator kecuali yang baru konfirmasi)
  await kirimTiketPesananKeStaf(konteks, db.getPesananById(pesanan.id), items, { mode });

  // Alur 3 fase selesai: pesanan berikutnya diproses biasa tanpa fase
  const alur = db.getAlur(customer.jid);
  db.setAlur(customer.jid, { ...alur, tutup: true });

  return {
    sukses: true,
    nomor_pesanan: nomor,
    customer: customer.nama,
    nomor_meja: pesanan.nomor_meja,
    pre_order: preOrder || undefined,
    status_masak: preOrder ? (mode === 'TUNGGU' ? `menunggu konfirmasi customer sebelum jam ${pesanan.jam_datang}` : 'langsung dimasak (jam datang sudah dekat)') : 'langsung dimasak',
  };
}

async function eksekusiKonfirmasiBayarKekurangan({ pesanan_id, nomor_meja }, konteks) {
  let kandidat = db.getTagihanMenungguBayar();
  if (pesanan_id) kandidat = kandidat.filter((t) => t.pesanan_id === pesanan_id);
  if (nomor_meja) kandidat = kandidat.filter((t) => t.meja === nomor_meja);

  if (kandidat.length === 0) {
    return { sukses: false, pesan: 'Tidak ketemu kekurangan bayar yang sedang menunggu pembayaran untuk itu.' };
  }
  if (kandidat.length > 1) {
    return {
      sukses: false,
      ada_banyak_kandidat: true,
      daftar: kandidat.map((t) => ({ pesanan_id: t.pesanan_id, meja: t.meja, nama: t.nama, nominal: t.nominal })),
      catatan_untuk_ai: 'Ada lebih dari 1 kekurangan bayar yang cocok, tanya balik yang mana (format angka).',
    };
  }

  const t = kandidat[0];
  db.setTagihanLunas(t.id);
  await konteks.kirimPesan(
    t.customer_jid,
    `Makasih${t.nama ? ` ${t.nama}` : ' Mas/Mbak'}, kekurangan ${rp(t.nominal)} udah masuk ya 🙏`
  );

  return { sukses: true, pesanan_id: t.pesanan_id, customer: t.nama, nominal: t.nominal };
}

// Kasir menyebut nomor yang tampil di notifikasi ("pesanan 7"), bukan id di DB.
// Return: id pesanan, undefined (tidak disebut), atau null (nomor disebut tapi tidak ketemu hari ini).
function resolvePesananId({ pesanan_id, nomor_pesanan }) {
  if (nomor_pesanan !== undefined && nomor_pesanan !== null && nomor_pesanan !== '') {
    const p = db.getPesananByNomorHarian(nomor_pesanan);
    return p ? p.id : null;
  }
  return pesanan_id ?? undefined;
}

async function eksekusiLaporMenuHabisSetelahBayar({ nama_menu, pesanan_id, nomor_meja, nomor_pesanan }, konteks) {
  // Cari pesanan target: by nomor pesanan / ID, atau by nomor meja, atau semua yang sudah lunas hari ini
  const idDicari = resolvePesananId({ pesanan_id, nomor_pesanan });
  if (idDicari === null) return { sukses: false, pesan: `Pesanan ${nomor_pesanan} hari ini tidak ditemukan.` };

  let kandidatPesanan;
  if (idDicari !== undefined) {
    const p = db.getPesananById(idDicari);
    kandidatPesanan = p ? [p] : [];
  } else if (nomor_meja) {
    const meja = db.normalisasiMeja(nomor_meja);
    kandidatPesanan = db.getPesananLunasHariIni().filter((p) =>
      db.normalisasiMeja(p.nomor_meja) === meja || db.normalisasiMeja(p.nomor_meja_customer) === meja);
  } else {
    kandidatPesanan = db.getPesananLunasHariIni();
  }

  if (kandidatPesanan.length === 0) {
    return { sukses: false, pesan: 'Tidak ketemu pesanan lunas yang cocok untuk dilaporkan habis.' };
  }

  // Cari item yang cocok nama_menu di antara kandidat pesanan
  const match = cariKandidatMenu(nama_menu);
  const hasilPerPesanan = [];

  for (const pesanan of kandidatPesanan) {
    const items = db.getItemsByPesananId(pesanan.id).filter((i) => i.status_item === 'AKTIF');
    const itemCocok = items.find((i) =>
      match.kandidatTerbaik && i.menu_id === match.kandidatTerbaik.id
    );
    if (itemCocok) {
      hasilPerPesanan.push({ pesanan, item: itemCocok });
    }
  }

  if (hasilPerPesanan.length === 0) {
    return { sukses: false, pesan: `Tidak ketemu item "${nama_menu}" di pesanan lunas yang dimaksud.` };
  }

  if (hasilPerPesanan.length > 1 && !pesanan_id) {
    return {
      sukses: false,
      ada_banyak_kandidat: true,
      daftar: hasilPerPesanan.map((h) => ({ pesanan_id: h.pesanan.id, meja: h.pesanan.nomor_meja })),
      catatan_untuk_ai: 'Ada lebih dari 1 pesanan lunas yang punya menu ini, tanya balik pesanan/meja mana sebelum lapor habis.',
    };
  }

  // Proses satu pesanan (kalau cuma 1 kandidat, atau sudah spesifik by pesanan_id)
  const { pesanan, item } = hasilPerPesanan[0];
  const sekarang = new Date().toISOString();

  db.setStatusItemPesanan(item.id, 'MENUNGGU_KEPUTUSAN_HABIS', { habis_dilaporkan_at: sekarang });
  db.setMenuTersedia(item.menu_id, false); // sekalian update stok global

  const customer = db.getCustomer(pesanan.customer_jid);
  const pesanKeCustomer = await ai.callAiText(
    `Pesanan customer sudah lunas dan masuk dapur, tapi ternyata "${item.nama_snapshot}" habis. Buatkan SATU pesan, MAKSIMAL 2 KALIMAT: kalimat 1 minta maaf + kabari menu habis, kalimat 2 tawarkan pilihan (ganti menu lain / batalkan, uang dikembalikan TUNAI di kasir) dan minta balas dalam 10 menit. Nada santai dan hangat seperti chat ke teman.`,
    200
  );

  await konteks.kirimPesan(
    customer.jid,
    pesanKeCustomer || `Maaf ya Mas/Mbak, ${item.nama_snapshot} yang tadi ternyata habis. Mau diganti menu lain, atau dibatalin aja (uangnya dikembalikan tunai di kasir)? Dibalas dalam 10 menit ya.`
  );

  return {
    sukses: true,
    pesanan_id: pesanan.id,
    item_habis: item.nama_snapshot,
    customer: customer.nama,
    pesan: 'Customer sudah dikabari dan ditawarkan pilihan ganti/batal.',
  };
}

async function eksekusiBatalkanOrderPaksa({ pesanan_id, nomor_pesanan, alasan }, konteks) {
  const idDicari = resolvePesananId({ pesanan_id, nomor_pesanan });
  const pesanan = idDicari ? db.getPesananById(idDicari) : null;
  if (!pesanan) return { sukses: false, pesan: 'Pesanan tidak ditemukan (sebut nomor pesanan hari ini).' };
  if (pesanan.status === 'SELESAI') return { sukses: false, pesan: `Pesanan ${nomorPesanan(pesanan)} sudah lunas, tidak bisa dibatalkan.` };
  pesanan_id = pesanan.id;

  db.setStatusPesanan(pesanan_id, 'DIBATALKAN');

  const customer = db.getCustomer(pesanan.customer_jid);
  const pesanKeCustomer = await ai.callAiText(
    `Pesanan ${nomorPesanan(pesanan)} milik ${customer.nama || 'customer'} baru saja dibatalkan oleh kasir dengan alasan: "${alasan}". Buatkan SATU pesan, MAKSIMAL 1 KALIMAT, santai tapi sopan seperti chat ke teman (boleh "maaf ya", bukan bahasa baku), memberi tahu ini ke customer.`,
    150
  );

  await konteks.kirimPesan(customer.jid, pesanKeCustomer || `Maaf ya, pesanan ${nomorPesanan(pesanan)} dibatalkan (${alasan}).`);
  return { sukses: true, pesanan_id, customer: customer.nama, alasan };
}

async function eksekusiKirimUlangQr({ pesanan_id, nomor_pesanan }, konteks) {
  const idDicari = resolvePesananId({ pesanan_id, nomor_pesanan });
  const pesanan = idDicari ? db.getPesananById(idDicari) : null;
  if (!pesanan) return { sukses: false, pesan: 'Pesanan tidak ditemukan (sebut nomor pesanan hari ini).' };
  if (!['MENUNGGU_BAYAR', 'OPEN_BILL'].includes(pesanan.status)) {
    return { sukses: false, pesan: `Pesanan ${nomorPesanan(pesanan)} statusnya "${pesanan.status}", bukan menunggu bayar.` };
  }
  const permintaan = db.getPermintaanQrByPesanan(pesanan.id);
  if (!permintaan) {
    return { sukses: false, pesan: `Pesanan ${nomorPesanan(pesanan)} belum punya permintaan QR${pesanan.status === 'OPEN_BILL' ? ' (open bill baru ditagih setelah customer minta bill)' : ''}.` };
  }
  if (permintaan.status !== 'TERKIRIM') {
    return { sukses: false, pesan: `QR ${permintaan.label} belum pernah dikirim ke customer. Kirim foto QR-nya ke chat ini sebagai reply tiket MINTA QR.` };
  }
  const hasilKirim = await konteks.kirimQrKeCustomer(permintaan.id);
  return { sukses: hasilKirim !== false, pesanan_id: pesanan.id, nominal_transfer: permintaan.nominal };
}

async function eksekusiUpdateStatusMenu({ teks_mentah }) {
  const hasil = await ai.prosesUpdateStatusMenu(teks_mentah);

  if (hasil.perubahan.length === 0 && hasil.tidakDikenali.length === 0) {
    return { sukses: false, pesan: 'Tidak ada info status menu yang berhasil dibaca dari teks ini.' };
  }

  for (const p of hasil.perubahan) {
    db.setMenuTersedia(p.menu.id, p.tersedia);
  }

  return {
    sukses: true,
    jadi_habis: hasil.perubahan.filter((p) => !p.tersedia).map((p) => p.menu.nama),
    jadi_tersedia: hasil.perubahan.filter((p) => p.tersedia).map((p) => p.menu.nama),
    menu_tidak_ditemukan: hasil.tidakDikenali.length > 0 ? hasil.tidakDikenali : undefined,
  };
}

async function eksekusiLihatSemuaMenu() {
  const semuaMenu = db.getAllMenu();
  return {
    sukses: true,
    total: semuaMenu.length,
    daftar: semuaMenu.map((m) => ({
      nama: m.nama,
      kategori: m.kategori_nama,
      varian: m.varian.map((v) => `${v.label}: ${rp(v.harga)}`),
      status: m.tersedia ? 'tersedia' : 'habis',
    })),
  };
}

async function eksekusiBroadcastPromo({ mode, nama_menu }, konteks) {
  let menuTerpilih;

  if (mode === 'menu_spesifik' && nama_menu) {
    const match = cariKandidatMenu(nama_menu);
    if (match.statusMatch === 'TIDAK_ADA') {
      return { sukses: false, pesan: `Menu "${nama_menu}" tidak ditemukan.` };
    }
    if (match.statusMatch === 'AMBIGU_MULTI') {
      return {
        sukses: false,
        pesan: `"${nama_menu}" cocok ke beberapa menu: ${match.kandidatList.map((m) => m.nama).join(', ')}.`,
        catatan_untuk_ai: 'Tanya kasir menu yang mana (format angka).',
      };
    }
    menuTerpilih = [match.kandidatTerbaik];
  } else {
    menuTerpilih = db.getMenuTersedia().slice(0, 2); // sederhana: 2 menu pertama yang tersedia
  }

  if (menuTerpilih.length === 0) {
    return { sukses: false, pesan: 'Tidak ada menu yang bisa di-broadcast saat ini.' };
  }

  const pesanBroadcast = await ai.generateBroadcastPromo(menuTerpilih);
  const semuaCustomer = db.getAllRegisteredCustomers();

  for (const customer of semuaCustomer) {
    await konteks.kirimPesan(customer.jid, pesanBroadcast, 300);
  }

  return { sukses: true, jumlah_customer_dikirim: semuaCustomer.length, menu_dipromosikan: menuTerpilih.map((m) => m.nama) };
}

async function eksekusiCariCustomer({ kata_kunci }) {
  const hasil = db.cariCustomer(kata_kunci);
  if (hasil.length === 0) return { sukses: false, pesan: `Tidak ada customer yang cocok dengan "${kata_kunci}".` };
  return {
    sukses: true,
    daftar: hasil.map((c) => ({ nomor: c.jid.split('@')[0], nama: c.nama, meja: c.nomor_meja })),
    catatan_untuk_ai: hasil.length > 1 ? 'Ada lebih dari 1 hasil, tanya balik dulu kalau tidak jelas.' : undefined,
  };
}

async function eksekusiLihatHistoriChatCustomer({ nomor }) {
  const jid = `${nomor.replace(/\D/g, '')}@s.whatsapp.net`;
  const customer = db.getCustomer(jid);
  const histori = db.getChatHistory(jid);
  if (histori.length === 0) return { sukses: true, jumlah: 0, pesan: `Belum ada histori untuk ${customer.nama || nomor}.` };
  return {
    sukses: true,
    customer: customer.nama,
    histori: histori.map((h) => `[${h.role === 'user' ? 'customer' : 'bot'}] ${h.content}`),
  };
}

async function eksekusiKirimPesanKeCustomer({ nomor, isi_pesan }, konteks) {
  const jid = `${nomor.replace(/\D/g, '')}@s.whatsapp.net`;
  const customer = db.getCustomer(jid);
  if (!customer || !customer.is_registered) return { sukses: false, pesan: `Nomor ${nomor} bukan customer terdaftar.` };

  await konteks.kirimPesan(jid, isi_pesan);
  db.simpanChatHistory(jid, 'assistant', isi_pesan);

  const statusSebelumnya = db.getStatusCs(jid);
  if (statusSebelumnya !== 'ESKALASI') db.setStatusCs(jid, 'ESKALASI');

  return {
    sukses: true, nomor, customer: customer.nama, status_cs_sekarang: 'ESKALASI',
    catatan_untuk_ai: statusSebelumnya !== 'ESKALASI'
      ? 'Pesan terkirim, bot nonaktif untuk customer ini sekarang. Beri tahu kasir soal ini dan bahwa mereka perlu bilang "selesai" untuk nomor ini supaya bot aktif lagi.'
      : undefined,
  };
}

async function eksekusiSelesaikanEskalasi({ nomor }) {
  const jid = `${nomor.replace(/\D/g, '')}@s.whatsapp.net`;
  const customer = db.getCustomer(jid);
  if (db.getStatusCs(jid) !== 'ESKALASI') {
    return { sukses: false, pesan: `Nomor ${nomor} (${customer.nama || 'tidak dikenal'}) statusnya bukan eskalasi.` };
  }
  db.setStatusCs(jid, 'BOT');
  return { sukses: true, nomor, customer: customer.nama };
}

async function eksekusiLihatEskalasiAktif() {
  const semua = db.getAllCustomerEskalasi();
  if (semua.length === 0) return { sukses: true, jumlah: 0, pesan: 'Tidak ada customer yang lagi eskalasi.' };
  return {
    sukses: true,
    jumlah: semua.length,
    daftar: semua.map((c) => ({ nomor: c.jid.split('@')[0], nama: c.nama, meja: c.nomor_meja, sejak: c.eskalasi_at })),
  };
}

async function eksekusiLihatStatistikHarian() {
  const stat = db.getStatistikHarian();
  return {
    sukses: true,
    jumlah_per_status: stat.jumlah_per_status.map((s) => `${s.status}: ${s.jumlah}`),
    omzet_kotor_hari_ini: stat.omzet_kotor,
    total_refund_hari_ini: stat.total_refund,
    omzet_bersih_hari_ini: stat.omzet_bersih,
    menu_terlaris: stat.menu_terlaris.map((m) => `${m.nama_snapshot} (${m.jumlah_order}x order, total ${m.total_qty})`),
  };
}

async function eksekusiTambahOperator({ nomor }, konteks) {
  if (!db.isOperatorUtama(konteks.jid)) return { sukses: false, pesan: 'Hanya operator utama yang bisa menambah operator.' };
  const nomorBersih = nomor.replace(/\D/g, '');
  const berhasil = db.tambahOperator(`${nomorBersih}@s.whatsapp.net`);
  return { sukses: berhasil, pesan: berhasil ? `${nomorBersih} berhasil ditambah sebagai operator.` : `${nomorBersih} sudah jadi operator.` };
}

async function eksekusiHapusOperator({ nomor }, konteks) {
  if (!db.isOperatorUtama(konteks.jid)) return { sukses: false, pesan: 'Hanya operator utama yang bisa menghapus operator.' };
  const nomorBersih = nomor.replace(/\D/g, '');
  const berhasil = db.hapusOperator(`${nomorBersih}@s.whatsapp.net`);
  return { sukses: berhasil, pesan: berhasil ? `${nomorBersih} dihapus dari daftar operator.` : `${nomorBersih} tidak ditemukan sebagai operator.` };
}

// Setelah meja kosong: tanya SATU pertanyaan rating (1-5). Rating di bawah 3 -> ditanya kendalanya (lihat tangkapRatingDanKuis).
async function mintaRating(konteks, jid) {
  const k = db.getKunjunganAktif(jid);
  if (!k) return false;
  db.updateKunjungan(k.id, { status: 'MENUNGGU_RATING', selesai_at: new Date().toISOString() });
  const c = db.getCustomer(jid);
  const pesan = `Makasih udah mampir ke The Banjoemas${c.nama ? `, ${sebutCustomer(c, jid)}` : ''} 🙏 Boleh kasih nilai pelayanan kami dari 1 sampai 5? (5 = puas banget)`;
  await konteks.kirimPesan(jid, pesan);
  db.simpanChatHistory(jid, 'assistant', pesan);
  return true;
}

async function eksekusiSelesaikanMeja({ nomor_meja, paksa }, konteks) {
  const meja = db.normalisasiMeja(nomor_meja);
  const penghuni = db.getCustomerDiMeja(meja);
  const jidKunjungan = db.getKunjunganAktifByMeja(meja).map((k) => k.customer_jid);
  if (penghuni.length === 0 && jidKunjungan.length === 0) {
    return { sukses: false, pesan: `Meja ${meja} memang sedang kosong (tidak ada customer tercatat di meja itu).` };
  }
  // Customer yang tercatat di kunjungan tapi statusnya bukan lagi DI_RESTO tetap ikut (supaya rating tetap ditanyakan)
  for (const jid of jidKunjungan) if (!penghuni.some((c) => c.jid === jid)) penghuni.push(db.getCustomer(jid));

  // Jangan kosongkan meja yang masih punya tagihan berjalan, kecuali kasir paksa
  const belumBayar = [];
  for (const c of penghuni) {
    for (const ob of db.getPesananOpenBillByCustomer(c.jid)) {
      belumBayar.push({ pesanan: nomorPesanan(ob), nama: c.nama || c.jid.split('@')[0], nominal: ob.grand_total, ket: 'open bill belum dibayar' });
    }
    const p = db.getDraftAtauMenungguBayarByCustomer(c.jid);
    if (p && p.status === 'MENUNGGU_BAYAR') belumBayar.push({ pesanan_id: p.id, nama: c.nama || c.jid.split('@')[0], nominal: p.nominal_transfer });
    const t = db.getTagihanBelumLunasByCustomer(c.jid);
    if (t && t.status === 'MENUNGGU_BAYAR') belumBayar.push({ tagihan_kekurangan_id: t.id, nama: c.nama || c.jid.split('@')[0], nominal: t.nominal_transfer });
  }
  if (belumBayar.length > 0 && !paksa) {
    return {
      sukses: false,
      ada_belum_bayar: true,
      daftar: belumBayar,
      catatan_untuk_ai: `Meja ${meja} masih punya pesanan/tagihan yang menunggu bayar. Sampaikan ke kasir dan tanya mau tetap dikosongkan (pesanan itu dibatalkan) atau tunggu bayar dulu.`,
    };
  }

  for (const c of penghuni) {
    // Draft yang belum dibayar ikut dibatalkan, pesanan lunas tidak disentuh
    const p = db.getDraftAtauMenungguBayarByCustomer(c.jid);
    if (p) db.setStatusPesanan(p.id, 'DIBATALKAN');
    clearKlarifikasiPending(c.jid);
    clearPilihanPending(c.jid);
    db.clearPendingState(c.jid, 'kuis');
    db.clearPendingState(c.jid, 'kuis_tawaran');
    db.kosongkanMejaCustomer(c.jid);
  }

  // Rating pelayanan ke customer yang baru ditinggalkan mejanya
  let ratingDitanya = 0;
  for (const c of penghuni) {
    try { if (await mintaRating(konteks, c.jid)) ratingDitanya++; } catch (err) { console.error('❌ Gagal minta rating:', err.message); }
  }

  return {
    sukses: true,
    nomor_meja: meja,
    customer: penghuni.map((c) => c.nama || c.jid.split('@')[0]),
    rating_ditanyakan: ratingDitanya,
    catatan_untuk_ai: `Meja ${meja} sudah kosong dan bisa dipakai lagi${ratingDitanya ? ', dan customer sudah ditanya rating pelayanan' : ''}. Konfirmasi singkat ke kasir.`,
  };
}

const EKSEKUTOR_OPERATOR = {
  konfirmasi_booking: eksekusiKonfirmasiBooking,
  konfirmasi_deposit_booking: eksekusiKonfirmasiDepositBooking,
  selesaikan_meja: eksekusiSelesaikanMeja,
  konfirmasi_bayar: eksekusiKonfirmasiBayar,
  batalkan_order_paksa: eksekusiBatalkanOrderPaksa,
  cek_status_order: eksekusiCekStatusOrder,
  kirim_ulang_qr: eksekusiKirimUlangQr,
  update_status_menu: eksekusiUpdateStatusMenu,
  lapor_menu_habis_setelah_bayar: eksekusiLaporMenuHabisSetelahBayar,
  lihat_semua_menu: eksekusiLihatSemuaMenu,
  broadcast_promo: eksekusiBroadcastPromo,
  cari_customer: eksekusiCariCustomer,
  lihat_histori_chat_customer: eksekusiLihatHistoriChatCustomer,
  kirim_pesan_ke_customer: eksekusiKirimPesanKeCustomer,
  selesaikan_eskalasi: eksekusiSelesaikanEskalasi,
  lihat_eskalasi_aktif: eksekusiLihatEskalasiAktif,
  lihat_statistik_harian: eksekusiLihatStatistikHarian,
  tambah_operator: eksekusiTambahOperator,
  hapus_operator: eksekusiHapusOperator,
  konfirmasi_bayar_kekurangan: eksekusiKonfirmasiBayarKekurangan,
};

module.exports = {
  client, MODEL,
  TOOLS_CUSTOMER, TOOLS_OPERATOR,
  SYSTEM_PROMPT_CUSTOMER, SYSTEM_PROMPT_OPERATOR,
  jalankanAgent,
  infoTambahanSetelahOrder, tangkapRatingDanKuis, kirimKeSemuaKasir, kirimTiketPermintaanQr, kelompokDariPesan, mintaMenuLengkap, kelompokDariFrasa, mintaRating, sebutCustomer,
  tangkapJawabanSapaan, tangkapJawabanKedatangan, pesanMenyetujuiQr, pesanMengonfirmasiKedatangan, rapikanBalasanCustomer, klaimTanpaBukti, kategoriDariPesan, praRouterCustomer,
  EKSEKUTOR_CUSTOMER, EKSEKUTOR_OPERATOR,
  setKlarifikasiPending, getKlarifikasiPending, clearKlarifikasiPending,
  setPilihanPending, getPilihanPending, clearPilihanPending,
  buatKonteksDinamisCustomer,
  buatBlokInfoResto,
};