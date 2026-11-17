const OpenAI = require('openai');
const db = require('./db');
const { rp, nomorPesanan, menitSekarangBot, parseJam, formatJam } = require('./format');
const ai = require('./ai');
const { cariKandidatMenu, cariMenuBernamaUmum, normalisasiNama } = require('./matcher');

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
  for (const kat of daftar) {
    const hasil = await konteks.kirimKartuKategori(konteks.jid, kat);
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
      instruksi_alur: 'Upsell MINUMAN. Format di bawah ringkasan: 1 kalimat tanya pendek ("Mau lanjut apa nih?") lalu DAFTAR BERNOMOR, satu opsi per baris: "1. Tambah menu lagi", "2. Kopi", "3. Non-kopi", "4. Nggak dulu". JANGAN pakai paragraf dan JANGAN sebut nama minuman tertentu. Customer cukup membalas nomor atau satu kata. Kalau customer jawab "kopi"/"non kopi"/"dua-duanya"/nomornya -> lihat_menu dengan kelompok "kopi" / "non_kopi" / "minuman". Kalau langsung sebut nama minuman -> buat_order. Kalau "tambah menu lagi" -> tanya mau tambah apa. Kalau "nggak dulu"/"udah cukup"/"nggak" -> lewati_fase (BUKAN langsung tampilkan_rincian_order).',
    };
  }

  return {
    fase_ditawarkan: fase,
    rekomendasi_upsell: rekomendasiUpsell(fase),
    instruksi_alur: `Upsell ${LABEL_FASE[fase].toUpperCase()}. Format di bawah ringkasan: 1 kalimat tanya pendek ("Mau lanjut apa nih?") lalu DAFTAR BERNOMOR, satu opsi per baris: "1. Tambah menu lagi", "2. Sekalian ${LABEL_FASE[fase]} (sebut 1 menu dari rekomendasi_upsell yang lagi enak)", "3. Nggak dulu". JANGAN pakai paragraf dan JANGAN kirim kartu menu dulu. Customer cukup membalas nomor atau satu kata. Kalau pilih 2 tapi belum sebut menu -> lihat_menu kelompok "${fase}". Kalau setuju menu yang direkomendasikan -> buat_order. Kalau "nggak dulu"/"udah cukup"/"nggak" -> lewati_fase (BUKAN langsung tampilkan_rincian_order).`,
  };
}

// 2 menu dari fase itu buat bahan upsell: andalan dulu, diacak biar tidak monoton
function rekomendasiUpsell(fase) {
  const idKat = db.getKategoriByKelompok(fase).map((k) => k.id);
  const tersedia = db.getMenuTersedia().filter((m) => idKat.includes(m.kategori_id));
  const andalan = tersedia.filter((m) => m.andalan);
  const sumber = [...(andalan.length >= 2 ? andalan : tersedia)].sort(() => Math.random() - 0.5);
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

// Blok teks yang ditempel ke akhir system prompt customer, supaya LLM tahu kondisi
// nyata walau histori chat hanya berisi teks (tanpa hasil tool).
function buatKonteksDinamisCustomer(jid) {
  const baris = [];
  const alur = db.getAlur(jid); // dipanggil dulu: state kemarin otomatis di-reset sebelum customer dibaca
  const customer = db.getCustomer(jid);

  if (db.getChatHistory(jid, 1).length === 0) {
    baris.push('- Ini chat PERTAMA customer. Balas SATU pesan sambutan (pengecualian aturan 1 kalimat) dengan format: "Sugeng rawuh di The Banjoemas Resto & Cafe, Mas/Mbak" disambung 1 kalimat hangat soal resto khas Banyumas; lalu 1 kalimat tanya kedatangan; lalu pilihannya sebagai DAFTAR BERNOMOR, satu opsi per baris: "1. Sudah di resto" dan "2. Datang nanti (sebutkan jamnya, misal 19.30)". JANGAN tanya dine in/take away (default dine in, customer akan minta sendiri kalau mau take away). Jangan kirim menu dulu dan jangan tanya makan berat/nyemil dulu. Kalau customer langsung memesan menu, sapa singkat lalu proses pesanannya.');
  }

  // Layanan & rencana kedatangan (ditanya di awal)
  if (!customer.rencana_datang) {
    baris.push('- ONBOARDING: kedatangan belum ditanya/dijawab. Tanyakan sebagai DAFTAR BERNOMOR ("1. Sudah di resto" / "2. Datang nanti (sebutkan jamnya)"). Jawaban -> panggil atur_layanan dengan kedatangan ("sekarang" atau jam format 24 jam HH:MM, misal "19:30"). JANGAN tanya dine in/take away (default dine in; customer yang mau take away akan minta sendiri). Selama kedatangan belum dijawab, JANGAN tanya makan berat/nyemil dulu. Kalau customer sudah langsung memesan, tetap catat pesanannya lalu tanyakan kedatangannya.');
  } else {
    baris.push(`- Rencana kedatangan: ${customer.rencana_datang === 'SEKARANG' ? 'sudah di resto' : `datang jam ${customer.rencana_datang}`}. Layanan default: ${customer.tipe_default === 'TAKE_AWAY' ? 'TAKE AWAY' : 'DINE IN'} (menu yang disebut beda, misal "iga take away", ditandai sendiri per menu).`);
  }

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

  if (alur.tutup) {
    baris.push('- Alur fase SUDAH SELESAI (sudah bayar). Pesanan tambahan diproses biasa tanpa fase: rangkum lalu minta konfirmasi.');
  } else if (!alur.jalur) {
    baris.push('- Customer BELUM pilih jalur. Kalau belum ada pesanan, tanya mau mulai dari mana dengan DAFTAR BERNOMOR ("1. Makan berat" / "2. Nyemil"). Begitu dijawab, panggil pilih_jalur. Kalau customer malah tanya favorit/rekomendasi, JAWAB dulu lewat rekomendasi_menu (jangan balik menanyakan jalur).');
  } else {
    const fase = faseBerikutnya(alur);
    baris.push(`- Alur fase: jalur ${alur.jalur === 'berat' ? 'MAKAN BERAT (berat -> minuman -> camilan)' : 'NYEMIL (camilan -> minuman -> berat)'}; sudah: ${alur.selesai.map((f) => LABEL_FASE[f]).join(', ') || '-'}; ${fase ? `fase berikutnya: ${LABEL_FASE[fase].toUpperCase()}.` : 'semua fase sudah lewat, lanjut rincian & bayar.'}`);
    baris.push(fase
      ? '- Kalau customer menolak tawaran/pertanyaan tambahan ("nggak", "udah", "udah cukup", "nggak dulu", "nggak usah minum"), WAJIB panggil lewati_fase, JANGAN langsung tampilkan_rincian_order: sistem yang menentukan kapan rincian (setelah satu tawaran lagi). Hanya "langsung bayar aja" yang boleh langsung rincian (lewati_fase dengan langsung_bayar=true).'
      : '- Kalau customer bilang tidak ada tambahan lagi, panggil lewati_fase (sistem lanjut ke rincian).');
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
  }

  if (aturan) {
    const a = [];
    // Layanan diatur di kode (bukan dari menu.json): dine in + take away tanpa biaya tambahan, tanpa delivery.
    // Pesanan boleh dibuat sebelum datang (pre-order), tiap pesanan punya nomor pesanan harian.
    a.push('Layanan: dine in (default) dan take away (hanya kalau customer minta, TANPA biaya tambahan), boleh campur per menu. Jangan menawarkan/menanyakan take away. TIDAK ada delivery. Customer boleh memesan sebelum datang, pembayaran QRIS di awal. Uang yang sudah dibayar tidak dikembalikan kalau customer tidak jadi datang. Pengembalian uang (misal menu habis) hanya tunai di kasir.');
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

const TOOLS_CUSTOMER = [
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
      description: 'Hitung & tampilkan rincian lengkap (item, harga satuan, subtotal) dari draft order customer, TANPA kirim QR. Dipakai kalau customer bilang "ya"/"fix"/"benar" pertama kali setelah draft dirangkum. Setelah ini, TUNGGU customer konfirmasi sekali lagi sebelum kirim QR.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kirim_qr_pembayaran',
      description: 'Kirim QR pembayaran (nominal persis sesuai total, tanpa kode unik) dan otomatis memberi tahu kasir meja/nama/pesanan/nominalnya. Butuh nomor meja DAN nama customer. HANYA dipakai SETELAH tampilkan_rincian_order dipanggil DAN customer sudah mengonfirmasi SEKALI LAGI bahwa rincian itu benar (misal "iya kirim", "oke", "fix segera bayar"). JANGAN PERNAH dipanggil di putaran/giliran yang sama dengan tampilkan_rincian_order atau buat_order.',
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
      description: 'Customer menolak/skip kelompok menu yang sedang ditawarkan (misal "nggak usah minum", "camilannya skip", "itu aja"). Tolakan biasa seperti ini HANYA melewati tawaran yang barusan; sistem lalu mengajukan SATU tawaran lagi (fase berikutnya) dan setelah ditolak baru lanjut ke rincian. Isi langsung_bayar=true HANYA kalau customer eksplisit minta langsung bayar / minta jangan ditawarin lagi.',
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
      description: 'Catat rencana kedatangan customer (sudah di resto / datang jam berapa), dan jenis layanan HANYA kalau customer sendiri minta take away. Dipakai saat customer menjawab pertanyaan kedatangan, atau kapan pun dia mengubahnya. Jangan pernah menanyakan dine in/take away: default-nya dine in. Isi hanya yang baru dijawab.',
      parameters: {
        type: 'object',
        properties: {
          tipe: {
            type: 'string',
            enum: ['dine_in', 'take_away'],
            description: '"take_away" HANYA kalau customer minta SEMUA pesanannya dibawa pulang. "dine_in" kalau dia mengubah kembali jadi makan di tempat. Kalau cuma sebagian menu take away, jangan isi ini: tulis di buat_order per menu (misal "iga take away").',
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
];

// ========== TOOLS — KASIR ==========

const TOOLS_OPERATOR = [
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

const SYSTEM_PROMPT_CUSTOMER = `Kamu adalah "The Banjoemas" -- bukan bot, tapi terasa seperti pelayan/admin The Banjoemas Resto & Cafe (resto khas Banyumas/Jawa Tengah) yang ramah, cekatan, dan hangat ke tamu.

IDENTITAS & NUANSA:
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

SCOPE OBROLAN:
Bebas ngobrol apa saja yang nyambung ke: menu & harga, detail menu (bahan, pedas, alergen, dll), pesanan/transaksi, nomor meja, obrolan ringan terkait kunjungan mereka (lagi di jalan, mau makan rame-rame, dll). Kalau topiknya di luar itu total (politik, hal pribadi tidak relevan), tanggapi sopan & singkat, arahkan balik secara natural -- jangan menolak kaku.

ATURAN RESTO PENTING:
- Fakta layanan, harga, nasi, sambal, dan aturan ubah/batal ada di blok "INFO RESTO DAN ATURAN" di akhir prompt. Ikuti blok itu.
- Nomor meja DAN nama WAJIB ada sebelum QR dikirim. Kalau salah satunya belum ada saat masuk rincian/bayar, tanyakan SEKALIGUS dalam 1 kalimat (misal "Boleh tau nomor meja dan namanya, Mas/Mbak?"). Nama dipakai kasir untuk mencocokkan pembayaran. Kalau meja yang disebut ternyata sedang dipakai orang lain (hasil konfirmasi_kedatangan gagal), minta customer cek ulang nomor mejanya.
- Kalau customer pesan lauk/menu berat, sebutkan secara natural soal nasi sesuai aturan (TAPI JANGAN tawarkan nasi putih sebagai menu kalau belum ada di data menu).
- JANGAN PERNAH menjamin suatu menu bebas alergen tertentu, walau datanya tidak menyebut alergen itu. Kalau customer tanya soal alergi spesifik atau bilang punya alergi, jawab jujur bahwa data alergen berdasar resep umum dan perlu dipastikan ke dapur, lalu panggil forward_pesan_ke_kasir.

FORMAT PILIHAN (WAJIB):
- Setiap kali customer harus memilih di antara 2 atau lebih opsi (kedatangan, makan berat/nyemil, kopi/non-kopi, tambah/lanjut, Mas/Mbak, panas/dingin, varian menu, dll), tampilkan sebagai DAFTAR BERNOMOR: 1 kalimat tanya pendek, lalu satu opsi per baris ("1. ...", "2. ..."). JANGAN menaruh pilihan di dalam paragraf, karena sulit dibaca. Tujuannya customer cukup membalas SATU kata atau satu angka.
- Kalau customer membalas dengan angka ("2") atau satu kata, artikan sesuai daftar yang kamu kirim di pesan sebelumnya.
- Balasan customer atas daftar pilihan HARUS memicu tool yang sesuai di giliran yang SAMA (pilih_jalur, lihat_menu, buat_order, simpan_nama, atur_layanan, lewati_fase). JANGAN hanya membalas teks konfirmasi ("siap", "mantap") tanpa memanggil tool, karena pilihannya tidak akan tercatat.
- JAWABAN AMBIGU: kalau maksud customer tidak jelas (misal "yg lain deh", "yang lain", "apa aja", "terserah", "yang itu"), JANGAN langsung memanggil tool dan JANGAN menebak. Tanya dulu dengan DAFTAR BERNOMOR (maks 4 opsi) apa yang dimaksud, baru panggil tool setelah jelas. Contoh setelah rekomendasi, customer bilang "yg lain deh": tanya "Mau lihat yang mana?" 1. Semua menu makan berat (kartu), 2. Pilih kategori (Sate/Goreng/Bakar, Nasi & Mie, ...), 3. Rekomendasi lain. Menu andalan hanya sebagian kecil dari seluruh menu, jangan pernah bilang "cuma ini yang tersedia".
- Kalau customer tanya favorit / rekomendasi / "enaknya apa" -> JAWAB dulu lewat rekomendasi_menu (jangan balik bertanya soal fase). Tampilkan 3-4 menu sebagai daftar bernomor dengan harga, lalu tanya mau yang mana (cukup balas nomor).

TAKE AWAY, PRE-ORDER, DAN NOMOR PESANAN:
- Di awal tanya SATU hal saja: sudah di resto atau mau datang jam berapa (sebagai daftar bernomor). Jawaban -> atur_layanan. JANGAN tanya dine in atau take away: default-nya dine in. Kalau customer sendiri minta take away, catat per menu di buat_order ("iga take away") atau atur_layanan tipe take_away kalau semuanya. Take away TANPA biaya tambahan. Tidak ada delivery.
- Customer boleh pesan SEBELUM datang (pre-order). Jam datang dikirim format 24 jam HH:MM. Pesanan tetap dibayar dulu lewat QR. Dapur memasak setelah customer mengonfirmasi 30 menit sebelum jam datang (bot yang menanyakan, kamu cuma menjawab lewat jadwal_kedatangan kalau customer membalas). Kalau customer sudah di resto, semuanya langsung diproses seperti biasa.
- Menu tertentu take away/dine in beda dari yang lain -> tulis di buat_order apa adanya (misal "iga bakar 2 take away"), atau ubah_tipe_item untuk menu yang sudah ada di draft.
- Setiap pesanan punya NOMOR PESANAN harian (misal #007). Selalu sebut nomor itu ke customer (field nomor_pesanan), JANGAN pernah menyebut pesanan_id.
- Customer yang pesan sebelum datang: begitu sampai, minta nomor mejanya (konfirmasi_kedatangan), lalu arahkan: cari meja, lapor ke waiter sambil menyebut nomor pesanan.
- Customer bilang tidak jadi datang untuk pesanan yang SUDAH dibayar -> jadwal_kedatangan aksi "batal". Uang yang sudah dibayar TIDAK dikembalikan: sampaikan santai dan sopan, tanpa menyalahkan. Pesanan yang BELUM dibayar dibatalkan lewat batalkan_order.
- Pengembalian uang (misal menu habis setelah bayar) hanya tunai di kasir. Jangan menjanjikan transfer balik.

ALUR PESAN 3 FASE (supaya customer tidak dibanjiri semua menu):
- Urutan di awal: kedatangan dulu (atur_layanan), BARU tanya mau mulai dari makan berat atau nyemil (daftar bernomor). Jawaban customer -> pilih_jalur.
- Jalur NYEMIL: camilan -> minuman -> makan berat. Jalur MAKAN BERAT: makan berat -> minuman -> camilan.
- Fase pertama (setelah pilih_jalur): kartu menunya langsung dikirim otomatis, jangan baca ulang harga satu-satu.
- Fase berikutnya: KUNCINYA UPSELLING. JANGAN langsung kirim menu. Tawarkan dulu dengan 1 kalimat yang menggoda, sebut 1 rekomendasi (dari rekomendasi_upsell) yang cocok dengan pesanannya. Kalau customer tertarik -> baru lihat_menu dengan kelompok fase itu. Kalau dia langsung setuju menu rekomendasinya -> buat_order.
- SETIAP kali ada menu yang masuk, balas dalam SATU pesan: "Pesanan sementara:" + ringkasan SEMUA item di draft (format angka, tanpa harga), lalu di bawahnya 1 kalimat tanya pendek ("Mau lanjut apa nih?") dan DAFTAR BERNOMOR pilihan, satu per baris, sesuai instruksi_alur (tambah menu lagi / lanjut ke fase berikutnya / udah cukup). JANGAN kirim kartu menu dulu, baru dikirim (lihat_menu) kalau customer tertarik.
- Customer menambah menu -> buat_order (ulangi format di atas). Customer menolak (nggak/udah/nggak usah) -> lewati_fase, sistem lanjut menawarkan fase sesudahnya.
- JANGAN tanya "sudah?" atau "fix?". "Ada yang mau ditambah?" HANYA dipakai tepat setelah ada menu yang masuk.
- Customer nolak tawaran ("nggak", "udah", "itu aja", "nggak usah minum") -> lewati_fase TANPA parameter. Itu tolakan biasa: sistem akan mengajukan SATU tawaran lagi lalu berhenti, jadi jangan dianggap customer minta berhenti. Hanya kalau customer eksplisit bilang "langsung bayar aja" / "jangan ditawarin lagi" -> lewati_fase dengan langsung_bayar=true.
- Fase minuman: pilihan kopi / non-kopi ditawarkan sebagai bagian dari daftar bernomor (lihat instruksi_alur). Jawaban "kopi"/"non kopi"/"dua-duanya" (atau nomornya) itu pilihan KELOMPOK -> lihat_menu dengan kelompok "kopi" / "non_kopi" / "minuman", BUKAN buat_order.
- FLEKSIBEL: customer boleh pesan apa saja kapan saja, loncat kelompok, minta lihat kelompok lain (lihat_menu dengan kelompok), atau langsung pesan tanpa pilih jalur. Jangan pernah menolak pesanan karena "belum fasenya".
- Setelah semua fase lewat -> tampilkan_rincian_order (rincian + tanya nomor meja dan nama sekaligus kalau belum ada / tanya boleh kirim QR). Customer menjawab meja dan nama -> konfirmasi_kedatangan (isi nomor_meja dan nama). Customer setuju -> kirim_qr_pembayaran (kasir otomatis diberi tahu meja, nama, pesanan, nominal). Bayar SEKALI di akhir, nominal persis sesuai total, tanpa kode unik.
- Pesanan tambahan setelah lunas diproses biasa tanpa fase.

CARA KERJA:
- Tanya menu / minta lihat menu / minta foto-pdf menu -> panggil lihat_menu (utamakan kelompok fase saat ini, semua kartu hanya kalau customer eksplisit minta semua menu).
- Tanya hal spesifik soal 1/beberapa menu (bahan, pedas, alergi, cocok buat siapa, dll) -> panggil tanya_detail_menu, lalu jawab dari deskripsi yang didapat dengan gaya ngobrol, bukan baca manual.
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
- Pengecualian HANYA untuk: (a) daftar/rincian menu atau rincian pesanan (nama, qty, harga) yang WAJIB pakai format angka (1. 2. 3.), (b) kalau ada 2 informasi yang benar-benar tidak bisa digabung jadi 1 kalimat (misal: kabari sesuatu + tanya sesuatu yang beda topik), maksimal 2 kalimat pendek, titik, (c) pesan sambutan pertama ke customer baru, maksimal 3 kalimat dan wajib menyebut nama "The Banjoemas Resto & Cafe", dan (d) DAFTAR PILIHAN bernomor (1 kalimat tanya + satu opsi per baris).
- Kalau ada daftar, SETELAH daftar boleh tambah maksimal 1 kalimat pendek (misal pertanyaan lanjutan), bukan paragraf.
- JANGAN PERNAH pakai tanda strip panjang (—) atau double dash (--). Pakai koma, titik, atau kalimat baru.
- Selesaikan kalimat dengan lengkap, jangan terpotong.`;

const SYSTEM_PROMPT_OPERATOR = `Kamu adalah asisten kerja untuk kasir "The Banjoemas Resto & Cafe". Operator ini rekan kerja yang kamu bantu urus operasional: konfirmasi bayar, kelola menu, broadcast promo, handle eskalasi.

Gaya bicaramu ke kasir:
- Langsung, efisien, seperti rekan kerja yang paham kerjaan, bukan customer service formal.
- Boleh bahasa santai/informal khas chat kerja, boleh sesekali kata Jawa santai kalau pas (nggih, monggo) tapi tidak wajib -- prioritas tetap jelas dan efisien.

CARA KERJA:
- Saat customer sudah dikirimi QR, kasir otomatis menerima pesan "💳 MENUNGGU BAYAR" berisi nomor pesanan, nama, meja (atau jam datang untuk pre-order), isi pesanan, dan total (tanpa kode unik, nominal persis sesuai total). Pembayaran dicocokkan lewat nomor pesanan/nama itu.
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

const KLAIM_BERISIKO = [
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

function klaimTanpaBukti(teks, toolBerhasil, pesanUser = '') {
  const t = String(teks || '');
  for (const k of KLAIM_BERISIKO) {
    if (k.hanyaJika && !k.hanyaJika(String(pesanUser || ''))) continue;
    if (k.kecuali && k.kecuali(t)) continue;
    if (k.re.test(t) && !k.tool.some((n) => toolBerhasil.has(n))) return k;
  }
  return null;
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

async function eksekusiLihatMenu({ kategori, kelompok }, konteks) {
  // ---------- Kasus 0: 1 kelompok (berat / camilan / kopi / non_kopi / minuman) ----------
  if (kelompok && !kategori) {
    const daftarKat = db.getKategoriByKelompok(kelompok);
    if (daftarKat.length === 0) {
      return { sukses: false, pesan: `Tidak ada kategori untuk kelompok "${kelompok}".` };
    }
    const idKat = daftarKat.map((k) => k.id);
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
        ? 'Kartu menu kelompok ini sudah dikirim terpisah. Balas 1 kalimat singkat ajak pilih, jangan baca ulang harga.'
        : 'Gambar kartu tidak tersedia, sebutkan daftar menu & harga dengan format angka.',
    };
  }

  // ---------- Kasus 1: customer sudah pilih kategori spesifik ----------
  if (kategori) {
    const semuaKategori = db.getAllKategori();
    const katCocok = semuaKategori.find(
      (k) => k.nama.toLowerCase() === kategori.toLowerCase() || k.id.toLowerCase() === kategori.toLowerCase()
    ) || semuaKategori.find((k) => k.nama.toLowerCase().includes(kategori.toLowerCase()));

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
      ? 'Kartu semua kategori sudah/sedang dikirim terpisah oleh sistem. Sebutkan kategori apa aja secara singkat (format angka), tanya mau lihat/pesan dari kategori mana. JANGAN sebutkan nama+harga satu-satu di sini karena sudah ada di gambar kartu.'
      : 'Gambar kartu tidak tersedia. Sebutkan kategori apa aja (format angka), tanya mau lihat kategori mana.',
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
function masukkanItemKeDraft(konteks, items) {
  // Pesanan yang masih bisa "ditambahin": yang belum dikonfirmasi, MAUPUN yang sudah MENUNGGU_BAYAR
  // (QR sudah dikirim tapi belum lunas). Yang SELESAI/DIBATALKAN tidak kepilih, jadi pesanan baru.
  const pesananBisaDitambah = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);

  let pesananId;
  let qrLamaJadiInvalid = false;

  if (pesananBisaDitambah) {
    pesananId = pesananBisaDitambah.id;
    if (pesananBisaDitambah.status === 'MENUNGGU_BAYAR') {
      // Ada tambahan setelah QR terbit -> QR lama tidak valid lagi (nominal berubah).
      db.setStatusPesanan(pesananId, 'DRAFT_MENUNGGU_KONFIRMASI');
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

async function eksekusiBuatOrder({ teks_mentah }, konteks) {
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

  // ---------- Alur 3 fase: tandai fase item ini selesai, lalu tawarkan fase berikutnya ----------
  catatFaseDariItem(konteks.jid, hasilParse.items);
  const alurAktif = !db.getAlur(konteks.jid).tutup;

  if (alurAktif) {
    // Setelah item masuk: SATU pesan berisi ringkasan + "ada yang mau ditambah?" + upsell fase berikutnya.
    // Kartu menu fase berikutnya TIDAK dikirim, baru dikirim kalau customer tertarik.
    const faseNext = faseBerikutnya(db.getAlur(konteks.jid));
    const infoFase = faseNext ? await tawarkanFaseBerikutnya(konteks) : {};
    return {
      sukses: true,
      pesanan_id: pesananId,
      nomor_pesanan: nomorPesanan(db.getPesananById(pesananId)),
      items_baru: hasilParse.items.map((i) => `${i.menu.nama} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''}`),
      items_total_di_draft: semuaItemSaatIni.map((i) => labelItem(i)),
      menu_tidak_ditemukan: hasilParse.tidakDikenali.length > 0 ? hasilParse.tidakDikenali : null,
      qr_sebelumnya_invalid: qrLamaJadiInvalid || undefined,
      ...infoFase,
      catatan_untuk_ai: (qrLamaJadiInvalid ? 'PENTING: QR lama TIDAK BERLAKU LAGI karena ada tambahan item, ingatkan singkat jangan bayar pakai QR lama. ' : '')
        + 'Item sudah masuk draft. Format balasan: baris pertama "Pesanan sementara:" lalu RINGKASAN SEMUA item di draft (items_total_di_draft) dengan format angka (1. 2. 3.), tanpa harga. '
        + (hasilParse.tidakDikenali.length > 0 ? 'Sebutkan juga singkat menu yang tidak ditemukan. ' : '')
        + (faseNext
          ? 'Lalu di BAWAH ringkasan, ikuti format DAFTAR BERNOMOR dari instruksi_alur (1 kalimat tanya pendek, lalu pilihan satu per baris), JANGAN dalam paragraf, supaya customer cukup membalas nomor atau satu kata. Kalau customer menyebut menu -> buat_order. Kalau menjawab kelompok/tertarik -> lihat_menu. Kalau menolak (nggak/udah cukup) -> lewati_fase.'
          : 'Semua fase sudah ditawarkan. Lalu di BAWAH ringkasan, 1 kalimat tanya pendek ("Mau lanjut apa nih?") dan DAFTAR BERNOMOR: "1. Tambah menu lagi" dan "2. Udah cukup". Kalau customer menjawab udah cukup/tidak -> panggil lewati_fase (lanjut ke rincian). Kalau menyebut menu lagi -> buat_order.'),
    };
  }

  return {
    sukses: true,
    pesanan_id: pesananId,
    nomor_pesanan: nomorPesanan(db.getPesananById(pesananId)),
    items_baru: hasilParse.items.map((i) => `${i.menu.nama} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''}`),
    items_total_di_draft: semuaItemSaatIni.map((i) => labelItem(i)),
    menu_tidak_ditemukan: hasilParse.tidakDikenali.length > 0 ? hasilParse.tidakDikenali : null,
    qr_sebelumnya_invalid: qrLamaJadiInvalid || undefined,
    catatan_untuk_ai: qrLamaJadiInvalid
      ? 'PENTING: QR lama TIDAK BERLAKU LAGI karena ada tambahan item (nominal berubah). Rangkum SEMUA item di draft saat ini dengan format angka, lalu di 1 kalimat terakhir: ingatkan jangan bayar pakai QR lama dan minta konfirmasi ulang ("ya"/"fix"). Tanpa kalimat pembuka.'
      : 'Pesanan tercatat sebagai draft. Rangkum SEMUA item di draft saat ini (format angka, bukan cuma yang baru ditambahkan), lalu 1 kalimat terakhir: tanya sudah fix atau mau nambah lagi. Tanpa kalimat pembuka. JANGAN sebutkan total harga dulu di sini (dihitung final pas konfirmasi).',
  };
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
  if (!customer.nama) kurang.push('nama');
  else if (!customer.sapaan) kurang.push('sapaan');
  if (!preOrder && !customer.nomor_meja) kurang.push('nomor meja');

  let petunjuk = '';
  if (kurang.includes('nama')) {
    petunjuk = kurang.includes('nomor meja')
      ? 'tanya nomor meja dan nama sekaligus (1 kalimat). Setelah nama dijawab, tanya enaknya dipanggil apa dengan DAFTAR BERNOMOR "1. Mas" dan "2. Mbak" (customer cukup balas satu kata).'
      : 'tanya namanya (1 kalimat), dipakai kasir untuk mencocokkan pembayaran. Setelah nama dijawab, tanya enaknya dipanggil apa dengan DAFTAR BERNOMOR "1. Mas" dan "2. Mbak" (customer cukup balas satu kata).';
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
      pesan: 'Pesanan ini sudah di tahap menunggu bayar (QR sudah/pernah dikirim).',
      catatan_untuk_ai: 'Tampilkan rincian item (nama, qty, harga satuan, subtotal tiap item) dan total subtotal dengan format angka, TANPA kalimat pembuka.'
      + (db.getInfoResto('aturan_layanan')?.harga ? ` Setelah daftar, sisipkan singkat: ${db.getInfoResto('aturan_layanan').harga}` : '')
      + ' Di baris terakhir, 1 kalimat pendek saja: tanya apakah sudah fix untuk lanjut kirim QR. JANGAN panggil kirim_qr_pembayaran sekarang, tunggu jawaban customer berikutnya.',
    };
  }

  const items = db.getItemsByPesananId(draft.id).filter((i) => i.status_item === 'AKTIF');
  if (items.length === 0) {
    return {
      sukses: false,
      pesan: 'Pesanan masih KOSONG: belum ada satu pun menu yang tercatat di sistem.',
      catatan_untuk_ai: 'JANGAN menulis rincian dari ingatan percakapan. Bilang jujur bahwa belum ada menu yang tercatat, lalu tanya customer mau pesan apa (atau panggil buat_order kalau dia baru saja menyebut menu).',
    };
  }
  const subtotal = items.reduce((sum, i) => sum + i.harga_satuan_snapshot * i.qty, 0);
  db.setHargaFixPesanan(draft.id, subtotal);

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
    catatan_untuk_ai: 'Tampilkan rincian item (nama, qty, harga satuan, subtotal tiap item) dan total subtotal dengan format angka, TANPA kalimat pembuka/basa-basi. Di baris terakhir, 1 kalimat pendek: '
      + (() => {
        const { kurang, petunjuk } = dataKurangUntukQr(db.getCustomer(konteks.jid), draft);
        return kurang.length > 0 ? petunjuk : 'tanya boleh langsung dikirim QR pembayarannya.';
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
    const nominal = item.harga_satuan_snapshot * item.qty;
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
  const totalSelisih = Math.abs(selisihPerUnit) * item.qty;
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
  const operatorUtama = db.getAllOperators().find((o) => o.is_utama === 1);
  if (!operatorUtama) return;
  const customer = db.getCustomer(pesanan.customer_jid);
  await konteks.kirimPesan(
    operatorUtama.jid,
    `💸 REFUND -- Pesanan ${nomorPesanan(pesanan)} (meja ${pesanan.nomor_meja || '-'}, ${customer.nama || 'customer'})\nItem: ${item.nama_snapshot}\nNominal: ${rp(nominal)}\nKeterangan: ${keterangan}\n\nMohon proses pengembalian uangnya nggih.`
  );
}

async function laporGantiMenuKeKasir(konteks, pesanan, itemLama, menuBaru, infoSelisih) {
  const operatorUtama = db.getAllOperators().find((o) => o.is_utama === 1);
  if (!operatorUtama) return;
  const customer = db.getCustomer(pesanan.customer_jid);
  const infoSelisihTeks = infoSelisih.jenis === 'kurang_bayar'
    ? `Customer perlu bayar tambahan ${rp(infoSelisih.nominal)}`
    : infoSelisih.jenis === 'lebih_bayar_dikembalikan'
      ? `Refund ke customer ${rp(infoSelisih.nominal)}`
      : 'Tidak ada selisih harga';

  await konteks.kirimPesan(
    operatorUtama.jid,
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

    let judul = `PESANAN ${nomor} | Meja ${meja || '-'} | LUNAS (QRIS)`;
    if (preOrder) {
      judul = `PRE-ORDER ${nomor} | LUNAS (QRIS) | datang jam ${pesanan.jam_datang} | ${mode === 'TUNGGU' ? 'BELUM DIMASAK' : 'MASAK SEKARANG'}`;
    }

    const baris = [
      judul,
      `Customer: ${nama}`,
      ...barisItemUntukStaf(items),
      ...barisCatatanPesanan(pesanan),
      `Total: ${rupiahId(pesanan.total_dibayar || pesanan.subtotal || 0)}`,
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

// Meja masuk status menunggu bayar: kasir langsung tahu meja, nama, isi pesanan, dan nominal yang harus masuk.
async function kirimInfoMenungguBayarKeKasir(konteks, pesanan, nominal) {
  try {
    const customer = db.getCustomer(pesanan.customer_jid);
    const preOrder = !!pesanan.jam_datang && customer.status_kedatangan !== 'DI_RESTO';
    const meja = customer.nomor_meja || pesanan.nomor_meja;
    const nama = [customer.sapaan, customer.nama].filter(Boolean).join(' ') || '-';
    const lokasi = preOrder ? `datang jam ${pesanan.jam_datang}` : `Meja ${meja || '-'}`;
    const cara = meja
      ? `"pesanan ${pesanan.no_harian} udah bayar" (atau "meja ${meja} udah bayar")`
      : `"pesanan ${pesanan.no_harian} udah bayar"`;
    const pesan = [
      `💳 MENUNGGU BAYAR | Pesanan ${nomorPesanan(pesanan)} | ${nama} | ${lokasi}`,
      ...barisItemUntukStaf(db.getItemsByPesananId(pesanan.id)),
      ...barisCatatanPesanan(pesanan),
      `Total: ${rp(nominal)}`,
      '',
      `Kalau pembayaran sudah masuk, bilang: ${cara}`,
    ].join('\n');
    await kirimKeSemuaOperator(konteks, pesan);
  } catch (err) {
    console.error('❌ Gagal kirim info menunggu bayar ke kasir:', err.message);
  }
}

async function kirimInfoKekuranganKeKasir(konteks, tagihan, nominal) {
  try {
    const pesanan = db.getPesananById(tagihan.pesanan_id);
    const customer = db.getCustomer(pesanan.customer_jid);
    const meja = customer.nomor_meja || pesanan.nomor_meja || '-';
    const pesan = [
      `💳 KEKURANGAN BAYAR | Meja ${meja} | ${customer.nama || '-'}`,
      `Pesanan ${nomorPesanan(pesanan)}, kekurangan akibat ganti menu: ${rp(nominal)}`,
      '',
      `Kalau sudah masuk, bilang: "kekurangan meja ${meja} udah masuk"`,
    ].join('\n');
    await kirimKeSemuaOperator(konteks, pesan);
  } catch (err) {
    console.error('❌ Gagal kirim info kekurangan ke kasir:', err.message);
  }
}

async function eksekusiKirimQrPembayaran(_, konteks) {
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
      catatan_untuk_ai: `${petunjuk} Nama/sapaan -> simpan_nama, meja -> konfirmasi_kedatangan (bisa sekalian isi nama). Kalau customer sebelumnya sudah setuju kirim QR, setelah data lengkap langsung panggil kirim_qr_pembayaran.`,
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

  // Nominal bayar = subtotal persis, tanpa kode unik. Kasir mencocokkan lewat info meja + nama.
  const nominalTransfer = draft.subtotal;
  const barusajaMenungguBayar = draft.status !== 'MENUNGGU_BAYAR'; // kirim ulang QR tidak perlu lapor kasir lagi

  db.setNominalTransfer(draft.id, nominalTransfer);
  db.setStatusPesanan(draft.id, 'MENUNGGU_BAYAR');

  const customer = db.getCustomer(konteks.jid);
  const qrTerkirim = await konteks.kirimQrKeCustomer(draft.id, nominalTransfer);

  if (barusajaMenungguBayar) {
    await kirimInfoMenungguBayarKeKasir(konteks, db.getPesananById(draft.id), nominalTransfer);
  }

  return {
    sukses: true,
    pesanan_id: draft.id,
    nomor_pesanan: nomorPesanan(db.getPesananById(draft.id)),
    nominal_transfer: nominalTransfer,
    nomor_meja: customer.nomor_meja || null,
    qr_terkirim: qrTerkirim,
    catatan_untuk_ai: qrTerkirim
      ? 'QR sudah dikirim beserta totalnya. Cukup konfirmasi singkat ke customer, kasir sudah diberi tahu.'
      : 'PENTING: QR GAGAL terkirim. Beri tahu customer dengan natural bahwa ada kendala, minta mereka hubungi kasir langsung.',
  };
}

async function eksekusiKirimQrKekurangan(_, konteks) {
  const tagihan = db.getTagihanBelumLunasByCustomer(konteks.jid);
  if (!tagihan) {
    return { sukses: false, pesan: 'Tidak ada kekurangan bayar yang perlu ditagih saat ini.' };
  }

  const nominalTransfer = tagihan.nominal; // persis nominal kekurangan, tanpa kode unik
  const barusaja = tagihan.status === 'MENUNGGU_KONFIRMASI';
  if (barusaja) db.setTagihanMenungguBayar(tagihan.id, nominalTransfer);
  // kalau sudah MENUNGGU_BAYAR, QR yang sama dikirim ulang

  const terkirim = await konteks.kirimQrKekuranganKeCustomer(tagihan.id);
  if (barusaja) await kirimInfoKekuranganKeKasir(konteks, tagihan, nominalTransfer);

  return {
    sukses: true,
    tagihan_id: tagihan.id,
    nominal_kekurangan: tagihan.nominal,
    nominal_transfer: nominalTransfer,
    qr_terkirim: terkirim,
    catatan_untuk_ai: terkirim
      ? 'QR kekurangan sudah dikirim terpisah beserta nominalnya. Cukup konfirmasi singkat ke customer.'
      : 'PENTING: QR GAGAL terkirim. Beri tahu customer dengan natural bahwa ada kendala, minta mereka hubungi kasir langsung.',
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

async function eksekusiHapusItemOrder({ nama_menu }, konteks) {
  const draft = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
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
  if (qrLamaJadiInvalid) db.setStatusPesanan(draft.id, 'DRAFT_MENUNGGU_KONFIRMASI');
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
  SELESAI: 'sudah lunas, diteruskan ke dapur',
  DIBATALKAN: 'dibatalkan',
};

// Ringkasan satu pesanan untuk ditampilkan: hanya item AKTIF, total dihitung dari item (bukan kolom subtotal
// yang sengaja dikosongkan saat isi draft berubah), plus info lunas/refund.
function ringkasPesanan(p) {
  const semua = db.getItemsByPesananId(p.id);
  const aktif = semua.filter((i) => i.status_item === 'AKTIF');
  const menunggu = semua.filter((i) => i.status_item === 'MENUNGGU_KEPUTUSAN_HABIS');
  const totalSaatIni = aktif.reduce((s, i) => s + i.harga_satuan_snapshot * i.qty, 0);
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
  if (!meja) return { sukses: false, pesan: 'Nomor meja tidak terbaca.' };

  // Nama (kalau disebut bersamaan) disimpan dulu, tidak tergantung meja diterima atau tidak
  const namaBersih = String(nama || '').trim().replace(/^(mas|mbak|mba|kak)\s+/i, '');
  if (namaBersih) db.setCustomerNama(konteks.jid, namaBersih);

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
  if (qrLamaJadiInvalid) db.setStatusPesanan(draft.id, 'DRAFT_MENUNGGU_KONFIRMASI');

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
        ? `Di bawahnya 1 kalimat tanya pendek lalu DAFTAR BERNOMOR: "1. Tambah menu lagi", "2. Lanjut ${LABEL_FASE[faseMenunggu]}", "3. Nggak dulu" (tanpa kirim menu). Kalau customer menolak/udah cukup -> lewati_fase.`
        : alurAktif
          ? 'Di bawahnya 1 kalimat tanya pendek dan DAFTAR BERNOMOR: "1. Tambah menu lagi", "2. Udah cukup". Kalau customer menjawab udah cukup -> lewati_fase.'
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
  const total = items.reduce((sum, i) => sum + i.harga_satuan_snapshot * i.qty, 0);

  const barisRincian = (i, n) => {
    const pilihan = db.pilihanTampil(i);
    const infoPilihan = Object.keys(pilihan).length > 0 ? ' (' + Object.values(pilihan).join(', ') + ')' : '';
    const tipe = i.tipe === 'TAKE_AWAY' ? ' [take away]' : '';
    return (n + 1) + '. ' + i.nama_snapshot + infoPilihan + tipe + ' x' + i.qty + ' @ ' + rp(i.harga_satuan_snapshot) + ' = ' + rp(i.harga_satuan_snapshot * i.qty);
  };

  const idx = baris.findIndex((l) => /^\s*(pesanan sementara|rincian pesanan)\b[^\n]*:\s*$/i.test(l));
  if (idx < 0) {
    // Tidak ada blok, tapi rincian baru saja dipanggil dan balasan tidak memuat totalnya: sisipkan blok dari DB
    if (rincianDitampilkan && draft && items.length > 0 && !String(teks).includes(rp(total))) {
      const blok = ['Rincian pesanan ' + nomorPesanan(draft) + ':', ...items.map(barisRincian), 'Total: ' + rp(total), ''];
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
    while (j < baris.length && /^\s*(sub)?total\b/i.test(baris[j])) { akhir = j + 1; j = akhir; }
  }

  let blok;
  if (!draft || items.length === 0) {
    blok = ['Belum ada menu yang tercatat di pesananmu nih.'];
  } else if (rincian) {
    blok = ['Rincian pesanan ' + nomorPesanan(draft) + ':', ...items.map(barisRincian), 'Total: ' + rp(total)];
  } else {
    blok = ['Pesanan sementara:', ...items.map((i, n) => (n + 1) + '. ' + labelItem(i))];
  }
  baris.splice(idx, akhir - idx, ...blok);
  return baris.join('\n');
}

function rapikanBalasanCustomer(jid, teks, { pertama = false, rincianDitampilkan = false } = {}) {
  let hasil = String(teks || '');
  if (!hasil) return hasil;
  const c = db.getCustomer(jid);

  hasil = selaraskanDaftarPesanan(jid, hasil, { rincianDitampilkan });

  if (c.nama && !c.sapaan) {
    const nama = c.nama.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    hasil = hasil.replace(new RegExp(`\\b(?:mas|mbak|mba)\\s+${nama}\\b`, 'gi'), c.nama);
  }

  if (pertama && !c.rencana_datang && !db.getDraftAtauMenungguBayarByCustomer(jid) && !/^\s*2\.\s/m.test(hasil)) {
    hasil = `${hasil.trimEnd()}\n1. Sudah di resto\n2. Datang nanti (sebutkan jamnya, misal 19.30)`;
  }
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

async function eksekusiRekomendasiMenu({ kelompok }, konteks) {
  const tersedia = db.getMenuTersedia();
  const idKat = kelompok ? new Set(db.getKategoriByKelompok(kelompok).map((k) => k.id)) : null;
  const sesuai = (m) => !idKat || idKat.has(m.kategori_id);
  let kandidat = tersedia.filter((m) => m.andalan && sesuai(m));
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

  // Terapkan ke draft yang sudah ada (customer yang langsung memesan lalu baru menjawab pertanyaan layanan)
  const draft = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
  if (draft) {
    if (tipe && tipe !== 'campur') db.setTipeSemuaItemAktif(draft.id, ubah.tipe);
    if (ubah.rencana) db.setJadwalPesanan(draft.id, { jamDatang: ubah.rencana === 'SEKARANG' ? null : ubah.rencana });
  }

  const c = db.getCustomer(konteks.jid);
  const lengkap = !!c.rencana_datang;
  return {
    sukses: true,
    layanan: LABEL_TIPE[c.tipe_default] || 'dine in (default)',
    kedatangan: c.rencana_datang === 'SEKARANG' ? 'sudah di resto' : c.rencana_datang ? `datang jam ${c.rencana_datang}` : null,
    catatan_untuk_ai: (lengkap
      ? 'Kedatangan tercatat. Konfirmasi singkat (1 kalimat), lalu LANJUT tanya mau mulai dari mana sebagai DAFTAR BERNOMOR: "1. Makan berat" dan "2. Nyemil". JANGAN tanya dine in/take away. '
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
  const operatorUtama = db.getAllOperators().find((o) => o.is_utama === 1);

  if (!operatorUtama) {
    return { sukses: false, pesan: 'Tidak ada kasir utama yang terdaftar.' };
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

  await konteks.kirimPesan(operatorUtama.jid, pesanKeKasir);

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

const EKSEKUTOR_CUSTOMER = {
  lihat_menu: eksekusiLihatMenu,
  tanya_detail_menu: eksekusiTanyaDetailMenu,
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
    return db.getPesananMenungguBayar().filter((p) => db.normalisasiMeja(p.nomor_meja) === meja || db.normalisasiMeja(p.nomor_meja_customer) === meja);
  }
  return db.getPesananMenungguBayar();
}

async function eksekusiKonfirmasiBayar({ pesanan_id, nomor_meja, nomor_pesanan }, konteks) {
  const kandidat = await cariPesananUntukKonfirmasi({ pesanan_id, nomor_meja, nomor_pesanan });

  if (kandidat.length === 0) {
    return { sukses: false, pesan: 'Tidak ketemu pesanan yang sedang menunggu bayar untuk itu.' };
  }

  if (kandidat.length > 1) {
    return {
      sukses: false,
      ada_banyak_kandidat: true,
      daftar: kandidat.map((p) => ({ nomor_pesanan: nomorPesanan(p), meja: p.nomor_meja, nama: p.nama })),
      catatan_untuk_ai: 'Ada lebih dari 1 pesanan menunggu bayar yang cocok, tanya balik pesanan mana (format angka, sebut nomor pesanan) sebelum konfirmasi.',
    };
  }

  const pesanan = kandidat[0];
  if (pesanan.status !== 'MENUNGGU_BAYAR') {
    return { sukses: false, pesan: `Pesanan ${nomorPesanan(pesanan)} statusnya "${pesanan.status}", bukan sedang menunggu bayar.` };
  }

  db.setPesananLunas(pesanan.id);

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
  if (pesanan.status !== 'MENUNGGU_BAYAR') {
    return { sukses: false, pesan: `Pesanan ${nomorPesanan(pesanan)} statusnya "${pesanan.status}", bukan menunggu bayar.` };
  }
  const nominal = pesanan.nominal_transfer || pesanan.subtotal;
  const hasilKirim = await konteks.kirimQrKeCustomer(pesanan.id, nominal);
  return { sukses: hasilKirim !== false, pesanan_id: pesanan.id, nominal_transfer: nominal };
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

async function eksekusiSelesaikanMeja({ nomor_meja, paksa }) {
  const meja = db.normalisasiMeja(nomor_meja);
  const penghuni = db.getCustomerDiMeja(meja);
  if (penghuni.length === 0) {
    return { sukses: false, pesan: `Meja ${meja} memang sedang kosong (tidak ada customer tercatat di meja itu).` };
  }

  // Jangan kosongkan meja yang masih punya tagihan berjalan, kecuali kasir paksa
  const belumBayar = [];
  for (const c of penghuni) {
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
    db.kosongkanMejaCustomer(c.jid);
  }

  return {
    sukses: true,
    nomor_meja: meja,
    customer: penghuni.map((c) => c.nama || c.jid.split('@')[0]),
    catatan_untuk_ai: `Meja ${meja} sudah kosong dan bisa dipakai lagi. Konfirmasi singkat ke kasir.`,
  };
}

const EKSEKUTOR_OPERATOR = {
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
  tangkapJawabanSapaan, rapikanBalasanCustomer, klaimTanpaBukti,
  EKSEKUTOR_CUSTOMER, EKSEKUTOR_OPERATOR,
  setKlarifikasiPending, getKlarifikasiPending, clearKlarifikasiPending,
  setPilihanPending, getPilihanPending, clearPilihanPending,
  buatKonteksDinamisCustomer,
  buatBlokInfoResto,
};