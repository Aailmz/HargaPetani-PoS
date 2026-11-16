const OpenAI = require('openai');
const db = require('./db');
const ai = require('./ai');
const { cariKandidatMenu } = require('./matcher');

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

// Blok teks yang ditempel ke akhir system prompt customer, supaya LLM tahu kondisi
// nyata walau histori chat hanya berisi teks (tanpa hasil tool).
function buatKonteksDinamisCustomer(jid) {
  const baris = [];

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
        ? 'rincian sudah ditampilkan, menunggu konfirmasi customer untuk kirim QR'
        : 'masih draft, rincian belum ditampilkan';
    baris.push(`- Pesanan #${draft.id}: ${ket}.`);
  }

  const habis = db.getItemMenungguKeputusanHabisByCustomer(jid);
  if (habis.length > 0) {
    baris.push(`- Menu yang dilaporkan habis dan menunggu keputusan customer (ganti/batal): ${habis.map((i) => i.nama_snapshot).join(', ')}.`);
  }

  const tagihan = db.getTagihanBelumLunasByCustomer(jid);
  if (tagihan) {
    baris.push(`- Ada kekurangan bayar Rp${tagihan.nominal} akibat ganti menu (status: ${tagihan.status === 'MENUNGGU_BAYAR' ? 'QR sudah dikirim' : 'QR belum dikirim, menunggu customer setuju'}).`);
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
    if (Array.isArray(aturan.jenis_layanan)) {
      const dineInSaja = aturan.jenis_layanan.length === 1 && aturan.jenis_layanan[0] === 'dine_in';
      a.push(dineInSaja
        ? 'Layanan: HANYA dine-in (tidak terima take away/delivery).'
        : `Layanan: ${aturan.jenis_layanan.join(', ')}.`);
    }
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
      description: 'Ambil daftar menu, bisa semua kategori (ringkas dulu) atau 1 kategori spesifik. Dipakai kalau customer minta lihat menu / nanya menu apa aja yang ada, TERMASUK kalau customer minta "menu pdf" atau "foto menu" (tetap panggil ini, file menu akan otomatis dikirim terpisah oleh sistem).',
      parameters: {
        type: 'object',
        properties: {
          kategori: {
            type: 'string',
            description: 'Kategori spesifik yang mau dilihat (misal "gorengan", "minuman", "kopi"), dipakai SETELAH customer pilih dari ringkasan kategori. Kosongkan kalau belum ada kategori dipilih atau customer minta lihat semua/kirim file menu.',
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
      description: 'Generate kode unik + kirim QR pembayaran. HANYA dipakai SETELAH tampilkan_rincian_order dipanggil DAN customer sudah mengonfirmasi SEKALI LAGI bahwa rincian itu benar (misal "iya kirim", "oke", "fix segera bayar"). JANGAN PERNAH dipanggil di putaran/giliran yang sama dengan tampilkan_rincian_order atau buat_order.',
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
      description: 'Catat bahwa customer sudah sampai di resto beserta nomor mejanya. Dipakai kapan pun customer menyebutkan nomor meja atau bilang sudah sampai/sudah duduk, baik sebelum maupun sesudah order dibuat.',
      parameters: {
        type: 'object',
        properties: {
          nomor_meja: {
            type: 'string',
            description: 'Nomor meja yang disebutkan customer, apa adanya (misal "5", "A3").',
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
            description: 'Ringkasan singkat dan jelas soal apa yang disampaikan/dikeluhkan customer.',
          },
          urgent: {
            type: 'boolean',
            description: 'true kalau butuh perhatian kasir segera, false kalau cukup informasi biasa.',
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
          pesanan_id: {
            type: 'integer',
            description: 'ID pesanan yang dikonfirmasi lunas. Kosongkan kalau kasir cuma sebut nomor meja atau nama customer (bukan ID).',
          },
          nomor_meja: {
            type: 'string',
            description: 'Nomor meja yang disebut kasir, kalau tidak sebut ID pesanan.',
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
          pesanan_id: { type: 'integer', description: 'ID pesanan yang mau dibatalkan.' },
          alasan: { type: 'string', description: 'Alasan singkat pembatalan untuk disampaikan ke customer.' },
        },
        required: ['pesanan_id', 'alasan'],
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
          pesanan_id: { type: 'integer', description: 'ID pesanan spesifik. Kosongkan untuk lihat SEMUA yang aktif.' },
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
        properties: { pesanan_id: { type: 'integer', description: 'ID pesanan.' } },
        required: ['pesanan_id'],
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
          pesanan_id: { type: 'integer', description: 'ID pesanan spesifik, kalau kasir sebutkan.' },
          nomor_meja: { type: 'string', description: 'Nomor meja, kalau kasir sebut meja bukan ID pesanan.' },
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
- Panggil customer "Mas" atau "Mbak" (tebak dari konteks/nama kalau ada petunjuk, kalau tidak yakin pakai salah satu secara natural, tidak masalah).
- Gaya bicara hangat, luwes, kayak pelayan resto sungguhan yang available ngobrol -- BUKAN robot yang jawab template kaku.

SIFAT PENTING -- JANGAN KAKU:
- Customer BOLEH loncat topik kapan saja: baru nanya menu, tiba-tiba mau order, abis itu nanya pedesnya gimana, balik lagi nambah pesanan, dll. Ikuti alur customer, JANGAN paksa dia ngikutin urutan tertentu.
- Tidak ada "script" wajib. Baca konteks percakapan (termasuk histori) untuk nentuin maksud customer dan tool apa yang relevan.
- Variasikan cara nanya/narasi, jangan mengulang kalimat yang sama persis tiap saat.

SCOPE OBROLAN:
Bebas ngobrol apa saja yang nyambung ke: menu & harga, detail menu (bahan, pedas, alergen, dll), pesanan/transaksi, nomor meja, obrolan ringan terkait kunjungan mereka (lagi di jalan, mau makan rame-rame, dll). Kalau topiknya di luar itu total (politik, hal pribadi tidak relevan), tanggapi sopan & singkat, arahkan balik secara natural -- jangan menolak kaku.

ATURAN RESTO PENTING:
- Fakta layanan, harga, nasi, sambal, dan aturan ubah/batal ada di blok "INFO RESTO DAN ATURAN" di akhir prompt. Ikuti blok itu.
- Kalau customer belum kasih tahu nomor meja dan sudah mau order/bayar, ingatkan untuk sebutkan nomor mejanya.
- Kalau customer pesan lauk/menu berat, sebutkan secara natural soal nasi sesuai aturan (TAPI JANGAN tawarkan nasi putih sebagai menu kalau belum ada di data menu).
- JANGAN PERNAH menjamin suatu menu bebas alergen tertentu, walau datanya tidak menyebut alergen itu. Kalau customer tanya soal alergi spesifik atau bilang punya alergi, jawab jujur bahwa data alergen berdasar resep umum dan perlu dipastikan ke dapur, lalu panggil forward_pesan_ke_kasir.

CARA KERJA:
- Customer baru pertama kali chat -> sapa dengan hangat pakai "Sugeng rawuh" di awal (lihat state sambutan di bawah).
- Tanya menu / minta lihat menu / minta foto-pdf menu -> panggil lihat_menu. File menu akan otomatis terkirim oleh sistem, kamu tidak perlu urus itu.
- Tanya hal spesifik soal 1/beberapa menu (bahan, pedas, alergi, cocok buat siapa, dll) -> panggil tanya_detail_menu, lalu jawab dari deskripsi yang didapat dengan gaya ngobrol, bukan baca manual.
- Sebut menu + jumlah mau dipesan -> panggil buat_order.
- Kalau ada menu yang ambigu (banyak varian cocok) dari hasil buat_order, tampilkan pilihan dengan format angka, tunggu jawaban customer, lalu panggil jawab_klarifikasi_menu.
- Kalau ada item yang butuh pilih porsi (penuh/setengah) atau opsi wajib (misal suhu panas/dingin) dari hasil buat_order, tampilkan pilihannya dengan format angka, tunggu jawaban customer, lalu panggil jawab_pilihan_menu. Jangan campur pertanyaan ini dengan pertanyaan klarifikasi nama menu dalam satu waktu kalau bisa dihindari, tapi kalau kebetulan dua-duanya ada, boleh ditanya sekaligus asal jelas mana untuk menu apa.
- Customer konfirmasi pesanan ("ya", "fix", "udah bener") SETELAH draft dirangkum -> panggil tampilkan_rincian_order (JANGAN langsung kirim QR).
- Customer konfirmasi LAGI setelah lihat rincian ("ya kirim", "oke", "lanjut") -> baru panggil kirim_qr_pembayaran. WAJIB dua langkah terpisah, tidak boleh dipanggil dalam giliran yang sama, tunggu balasan customer di antaranya.
- Customer sebut nomor meja / bilang sudah sampai kapan pun -> panggil konfirmasi_kedatangan.
- Customer tanya status pesanan -> cek_status_order_saya.
- Customer mau batal pesanan yang belum dikonfirmasi -> batalkan_order.
- Customer komplain/minta sesuatu yang butuh kasir -> forward_pesan_ke_kasir, kabari customer dengan natural kalau itu sudah disampaikan.
- Obrolan biasa sesuai scope -> balas natural tanpa tool.
- Customer jawab soal menu yang dilaporkan habis setelah bayar (mau ganti/batal) -> panggil putuskan_item_habis.
- Kalau customer ganti ke menu yang lebih mahal dan ada kekurangan bayar, jelaskan nominalnya dan tanya apakah setuju. Kalau setuju -> panggil kirim_qr_kekurangan (giliran terpisah).
- Kalau ada lebih dari satu menu yang menunggu keputusan habis, tanyakan menu mana (format angka), lalu isi nama_menu saat memanggil putuskan_item_habis.
- Di akhir prompt mungkin ada blok "STATE SAAT INI" dari sistem. Itu fakta akurat, ikuti untuk menentukan tool yang tepat.

ATURAN PENULISAN WAJIB (PELANGGARAN = FATAL):
- Kapitalisasi normal bahasa Indonesia, BUKAN Title Case Di Setiap Kata.
- Jangan menyebut dirimu "AI", "bot", "sistem", atau "asisten virtual".
- MAKSIMAL 1 KALIMAT per balasan. Tidak ada kalimat pembuka, tidak ada basa-basi tambahan, tidak ada penutup yang tidak diminta.
- Pengecualian HANYA untuk: (a) daftar/rincian menu atau rincian pesanan (nama, qty, harga) yang WAJIB pakai format angka (1. 2. 3.), dan (b) kalau ada 2 informasi yang benar-benar tidak bisa digabung jadi 1 kalimat (misal: kabari sesuatu + tanya sesuatu yang beda topik). Dalam kasus (b) maksimal 2 kalimat pendek, titik.
- Kalau ada daftar, SETELAH daftar boleh tambah maksimal 1 kalimat pendek (misal pertanyaan lanjutan), bukan paragraf.
- JANGAN PERNAH pakai tanda strip panjang (—) atau double dash (--). Pakai koma, titik, atau kalimat baru.
- Selesaikan kalimat dengan lengkap, jangan terpotong.`;

const SYSTEM_PROMPT_OPERATOR = `Kamu adalah asisten kerja untuk kasir "The Banjoemas Resto & Cafe". Operator ini rekan kerja yang kamu bantu urus operasional: konfirmasi bayar, kelola menu, broadcast promo, handle eskalasi.

Gaya bicaramu ke kasir:
- Langsung, efisien, seperti rekan kerja yang paham kerjaan, bukan customer service formal.
- Boleh bahasa santai/informal khas chat kerja, boleh sesekali kata Jawa santai kalau pas (nggih, monggo) tapi tidak wajib -- prioritas tetap jelas dan efisien.

CARA KERJA:
- Begitu kasir dengar/lihat pembayaran masuk (dari bunyi EDC/alat atau cek manual), dan bilang semacam "meja 5 udah bayar" atau sebut ID pesanan -> panggil konfirmasi_bayar. INI AUTO-APPROVE, tidak perlu tanya ulang ke kasir, langsung proses begitu jelas pesanan mana yang dimaksud.
- Kalau kasir sebut nomor meja/nama yang ambigu (ada beberapa pesanan aktif di meja/nama itu, atau tidak ketemu), tanya balik dengan singkat SEBELUM manggil tool dengan parameter ngasal.
- Operator bisa minta apapun terkait operasional: update menu, broadcast, cek order, batalkan, kirim ulang QR, kelola operator, cek stok menu, statistik.
- Kalau kasir sebut "order tadi"/"yang barusan", cari dari histori percakapan.
- Chat biasa/basa-basi -> balas natural tanpa tool.
- Setelah tool jalan, sampaikan hasilnya dengan jelas dan natural, bukan data mentah.
- Kalau kasir bilang kekurangan bayar/selisih (karena customer ganti menu lebih mahal) sudah dibayar -> panggil konfirmasi_bayar_kekurangan, bukan konfirmasi_bayar.
- Kalau kasir/staf membalas tiket pesanan dengan "habis <menu> meja X" (lihat tiketnya di histori), panggil lapor_menu_habis_setelah_bayar dengan nama_menu dan nomor_meja itu.

ATURAN PENULISAN WAJIB (PELANGGARAN = FATAL):
- Kapitalisasi normal bahasa Indonesia, BUKAN Title Case Di Setiap Kata.
- Jangan menyebut dirimu "AI", "bot", "sistem", atau "asisten virtual".
- MAKSIMAL 1 KALIMAT per balasan, kecuali menampilkan daftar/data (pakai format angka 1. 2. 3.). Setelah daftar, boleh tambah maksimal 1 kalimat pendek.
- JANGAN PERNAH pakai tanda strip panjang (—) atau double dash (--). Pakai koma, titik, atau kalimat baru.
- Selesaikan kalimat dengan lengkap, jangan terpotong.`;

// ========== ORKESTRATOR (identik pola dengan contoh) ==========

async function jalankanAgent({ systemPrompt, tools, historiChat, pesanBaru, eksekutorTools, konteks }) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...historiChat,
    { role: 'user', content: pesanBaru },
  ];

  let iterasi = 0;

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
      return { jawabanFinal: pesanAi.content, error: null };
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

      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(hasilTool) });
    }
  }

  console.log('⚠️  Agent mencapai batas iterasi maksimal.');
  return { jawabanFinal: 'Maaf nggih, ada kendala teknis. Boleh diulang pesannya?', error: 'MAX_ITERATIONS' };
}

// ========== EKSEKUTOR — CUSTOMER ==========

async function eksekusiLihatMenu({ kategori }, konteks) {
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
          ? `Rp${m.varian[0].harga}`
          : m.varian.map((v) => `${v.label} Rp${v.harga}`).join(' / ');
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

  for (const nama of nama_menu) {
    const match = cariKandidatMenu(nama);
    if (match.statusMatch === 'TIDAK_ADA') {
      tidakKetemu.push(nama);
      continue;
    }
    const menu = match.kandidatTerbaik;

    // Kirim kartu menu ini kalau customer cuma tanya 1 menu spesifik (bukan perbandingan banyak menu sekaligus,
    // supaya tidak banjir gambar kalau customer tanya "bandingin sroto ayam vs daging vs mie goreng" misalnya)
    if (nama_menu.length === 1) {
      await konteks.kirimKartuMenu(konteks.jid, menu);
    }

    hasil.push({
      nama: menu.nama,
      kategori: menu.kategori_nama,
      tersedia: menu.tersedia,
      andalan: menu.andalan,
      deskripsi: menu.deskripsi || '(belum ada deskripsi detail tercatat untuk menu ini)',
      varian: menu.varian.map((v) => `${v.label}: Rp${v.harga}`),
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

  if (hasil.length === 0) {
    return { sukses: false, pesan: `Menu "${nama_menu.join(', ')}" tidak ditemukan.` };
  }

  return {
    sukses: true,
    menu: hasil,
    tidak_ketemu: tidakKetemu.length > 0 ? tidakKetemu : undefined,
    catatan_untuk_ai: 'Jawab pertanyaan customer dari data di atas, dengan gaya ngobrol natural, JANGAN cuma baca ulang mentah-mentah. Kalau customer tanya soal alergen, sampaikan "kemungkinan_alergen" sebagai perkiraan dari resep umum, BUKAN jaminan -- kalau customer punya alergi serius, arahkan forward_pesan_ke_kasir untuk mastiin ke dapur. Kalau menu ini punya pilihan wajib (wajib_dipilih: true) dan customer belum sebut preferensinya, boleh sekalian tanya di jawabanmu.',
  };
}

const orderTerakhirPerCustomer = new Map(); // jid -> { teks, waktu }

async function eksekusiBuatOrder({ teks_mentah }, konteks) {
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

  if (hasilParse.perluKlarifikasi.length > 0) {
    setKlarifikasiPending(konteks.jid, hasilParse.perluKlarifikasi);
    return {
      sukses: true,
      butuh_klarifikasi: true,
      daftar_klarifikasi: hasilParse.perluKlarifikasi.map((k) => ({
        yang_disebut_customer: k.namaInput,
        pilihan: k.kandidatList.map((m) => `${m.nama} (mulai Rp${m.harga_mulai ?? m.varian?.[0]?.harga ?? '-'})`),
      })),
      item_lain_yang_jelas: hasilParse.items.map((i) => `${i.menu.nama} x${i.qty}`),
      catatan_untuk_ai: 'Ada menu yang customer sebut dengan nama umum dan punya beberapa varian. JANGAN buat order dulu untuk item ambigu itu. Tampilkan pilihan dengan format angka, minta customer pilih.',
    };
  }

  if (hasilParse.perluPilihan.length > 0) {
    setPilihanPending(konteks.jid, hasilParse.perluPilihan);
    return {
      sukses: true,
      butuh_pilihan: true,
      daftar_pilihan: hasilParse.perluPilihan.map((p) => ({
        menu: p.menu.nama,
        qty: p.qty,
        jenis_pertanyaan: p.jenisPilihan === 'varian' ? 'porsi' : p.namaOpsi,
        pilihan: p.opsiTersedia,
      })),
      item_lain_yang_jelas: hasilParse.items.map((i) => `${i.menu.nama} x${i.qty}`),
      catatan_untuk_ai: 'Ada menu yang butuh dipilih porsinya atau opsi wajibnya (misal suhu) sebelum masuk draft. JANGAN buat order dulu untuk item ini. Tampilkan pertanyaan dengan format angka per menu, minta customer jawab.',
    };
  }

  // Cari pesanan yang masih bisa "ditambahin": baik yang belum dikonfirmasi, MAUPUN yang sudah
  // MENUNGGU_BAYAR (QR sudah dikirim tapi belum lunas). Yang SELESAI/DIBATALKAN tidak akan kepilih,
  // otomatis jadi pesanan baru.
  const pesananBisaDitambah = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);

  let pesananId;
  let qrLamaJadiInvalid = false;

  if (pesananBisaDitambah) {
    pesananId = pesananBisaDitambah.id;
    if (pesananBisaDitambah.status === 'MENUNGGU_BAYAR') {
      // Ada tambahan setelah QR terbit -> QR lama tidak valid lagi (nominal berubah).
      // Turunkan lagi ke draft, nanti konfirmasi_order generate kode unik & nominal baru.
      db.setStatusPesanan(pesananId, 'DRAFT_MENUNGGU_KONFIRMASI');
      qrLamaJadiInvalid = true;
    }
  } else {
    pesananId = db.buatPesananBaru(konteks.jid, db.getCustomer(konteks.jid).nomor_meja);
  }

  for (const item of hasilParse.items) {
    const labelVarian = item.varian.label && item.varian.label !== 'Reguler' ? ` (${item.varian.label})` : '';
    db.tambahItemPesanan(pesananId, {
      menu_id: item.menu.id,
      varian_sku: item.varian.sku,
      nama_snapshot: `${item.menu.nama}${labelVarian}`,
      qty: item.qty,
      harga_satuan_snapshot: item.varian.harga,
      pilihan_terpilih: Object.keys(item.pilihanTerisi || {}).length > 0
        ? JSON.stringify(item.pilihanTerisi)
        : null,
      catatan: item.catatan || null,
    });
  }

  db.setHargaFixPesanan(pesananId, null)

  if (!qrLamaJadiInvalid) {
    db.setStatusPesanan(pesananId, 'DRAFT_MENUNGGU_KONFIRMASI');
  }

  const semuaItemSaatIni = db.getItemsByPesananId(pesananId);

  return {
    sukses: true,
    pesanan_id: pesananId,
    items_baru: hasilParse.items.map((i) => `${i.menu.nama} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''}`),
    items_total_di_draft: semuaItemSaatIni.map((i) => `${i.nama_snapshot} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''}`),
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

  return {
    sukses: true,
    menu_terpilih: hasilCocok.map((h) => `${h.menu.nama} x${h.qty}`),
    catatan_untuk_ai: 'Menu sudah berhasil dicocokkan. Panggil tool buat_order lagi dengan teks yang menyebutkan nama SPESIFIK hasil pilihan ini.',
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
  const subtotal = items.reduce((sum, i) => sum + i.harga_satuan_snapshot * i.qty, 0);
  db.setHargaFixPesanan(draft.id, subtotal);

  return {
    sukses: true,
    pesanan_id: draft.id,
    items: items.map((i) => {
      const pilihan = i.pilihan_terpilih ? JSON.parse(i.pilihan_terpilih) : null;
      const infoPilihan = pilihan ? ` [${Object.entries(pilihan).map(([k, v]) => `${k}: ${v}`).join(', ')}]` : '';
      return `${i.nama_snapshot}${infoPilihan} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''} @ Rp${i.harga_satuan_snapshot} = Rp${i.harga_satuan_snapshot * i.qty}`;
    }),
    subtotal,
    catatan_untuk_ai: 'Tampilkan rincian item (nama, qty, harga satuan, subtotal tiap item) dan total subtotal dengan format angka, TANPA kalimat pembuka/basa-basi. Di baris terakhir, 1 kalimat pendek: tanya apakah sudah fix untuk lanjut kirim QR. JANGAN panggil kirim_qr_pembayaran sekarang, tunggu jawaban customer berikutnya.',
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
      catatan_untuk_ai: 'Beri tahu customer dalam 1 kalimat bahwa pembatalan dicatat dan uang akan dikembalikan kasir. Jangan janjikan metode spesifik.' + ingatkanSisa(sisa),
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
        pilihan_porsi: menuBaru.varian.map((v) => `${v.label} Rp${v.harga}`),
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
        ? `Beri tahu customer menu sudah diganti ke ${menuBaru.nama}${labelVarian}, ada kekurangan bayar Rp${infoSelisih.nominal}. Tanya apakah setuju membayar kekurangan itu lewat QR. JANGAN kirim QR dulu, tunggu customer setuju, baru panggil kirim_qr_kekurangan di giliran berikutnya.`
        : infoSelisih.jenis === 'lebih_bayar_dikembalikan'
          ? `Beri tahu customer menu sudah diganti ke ${menuBaru.nama}${labelVarian}, ada kelebihan bayar Rp${infoSelisih.nominal} yang akan dikembalikan kasir.`
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
    `💸 REFUND -- Pesanan #${pesanan.id} (meja ${pesanan.nomor_meja || '-'}, ${customer.nama || 'customer'})\nItem: ${item.nama_snapshot}\nNominal: Rp${nominal}\nKeterangan: ${keterangan}\n\nMohon proses pengembalian uangnya nggih.`
  );
}

async function laporGantiMenuKeKasir(konteks, pesanan, itemLama, menuBaru, infoSelisih) {
  const operatorUtama = db.getAllOperators().find((o) => o.is_utama === 1);
  if (!operatorUtama) return;
  const customer = db.getCustomer(pesanan.customer_jid);
  const infoSelisihTeks = infoSelisih.jenis === 'kurang_bayar'
    ? `Customer perlu bayar tambahan Rp${infoSelisih.nominal}`
    : infoSelisih.jenis === 'lebih_bayar_dikembalikan'
      ? `Refund ke customer Rp${infoSelisih.nominal}`
      : 'Tidak ada selisih harga';

  await konteks.kirimPesan(
    operatorUtama.jid,
    `🔄 GANTI MENU -- Pesanan #${pesanan.id} (meja ${pesanan.nomor_meja || '-'}, ${customer.nama || 'customer'})\n${itemLama.nama_snapshot} -> ${menuBaru.nama}\n${infoSelisihTeks}`
  );
}

// Tiket pesanan lunas ke staf (semua operator kecuali yang baru mengonfirmasi).
// Disimpan juga ke histori penerima supaya balasan "habis <menu>" punya konteks nomor meja/pesanan.
async function kirimTiketPesananKeStaf(konteks, pesanan, items) {
  try {
    const customer = db.getCustomer(pesanan.customer_jid);
    const meja = pesanan.nomor_meja || customer.nomor_meja || '-';
    const rupiah = (n) => Number(n).toLocaleString('id-ID');

    const baris = items
      .filter((i) => i.status_item === 'AKTIF')
      .map((i) => {
        const pilihan = i.pilihan_terpilih ? Object.values(JSON.parse(i.pilihan_terpilih)).join(', ') : '';
        const ket = [pilihan, i.catatan].filter(Boolean).join('; ');
        return `${i.qty}x ${i.nama_snapshot}${ket ? ` (${ket})` : ''}  ${rupiah(i.harga_satuan_snapshot * i.qty)}`;
      });

    const tiket =
      `PESANAN #${pesanan.id} | Meja ${meja} | LUNAS (QRIS)\n` +
      `Customer: ${customer.nama || pesanan.customer_jid.split('@')[0]}\n` +
      `${baris.join('\n')}\n` +
      `Total: ${rupiah(pesanan.total_dibayar || pesanan.subtotal || 0)}\n\n` +
      `Kalau ada menu kosong, balas: "habis <menu> meja ${meja}"`;

    for (const op of db.getAllOperators()) {
      if (op.jid === konteks.jid) continue;
      await konteks.kirimPesan(op.jid, tiket);
      db.simpanChatHistory(op.jid, 'assistant', tiket);
    }
  } catch (err) {
    console.error('❌ Gagal kirim tiket ke staf:', err.message);
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

  const kodeUnik = db.getNextKodeUnikHarian(draft.id);
  const nominalTransfer = draft.subtotal + kodeUnik;

  db.setKodeUnikDanNominal(draft.id, kodeUnik, nominalTransfer);
  db.setStatusPesanan(draft.id, 'MENUNGGU_BAYAR');

  const customer = db.getCustomer(konteks.jid);
  const qrTerkirim = await konteks.kirimQrKeCustomer(draft.id, nominalTransfer);

  return {
    sukses: true,
    pesanan_id: draft.id,
    nominal_transfer: nominalTransfer,
    nomor_meja: customer.nomor_meja || null,
    qr_terkirim: qrTerkirim,
    catatan_untuk_ai: qrTerkirim
      ? (customer.nomor_meja ? undefined : 'Ingatkan customer kalau belum kasih tau nomor mejanya.')
      : 'PENTING: QR GAGAL terkirim. Beri tahu customer dengan natural bahwa ada kendala, minta mereka hubungi kasir langsung.',
  };
}

async function eksekusiKirimQrKekurangan(_, konteks) {
  const tagihan = db.getTagihanBelumLunasByCustomer(konteks.jid);
  if (!tagihan) {
    return { sukses: false, pesan: 'Tidak ada kekurangan bayar yang perlu ditagih saat ini.' };
  }

  let nominalTransfer = tagihan.nominal_transfer;
  if (tagihan.status === 'MENUNGGU_KONFIRMASI') {
    const kodeUnik = db.getNextKodeUnikHarian();
    nominalTransfer = tagihan.nominal + kodeUnik;
    db.setTagihanMenungguBayar(tagihan.id, kodeUnik, nominalTransfer);
  }
  // kalau sudah MENUNGGU_BAYAR, QR yang sama dikirim ulang

  const terkirim = await konteks.kirimQrKekuranganKeCustomer(tagihan.id);

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
    pesanan_id: p.id,
    status: LABEL_STATUS_PESANAN[p.status] || p.status,
    nomor_meja: p.nomor_meja || null,
    items: aktif.map((i) => `${i.nama_snapshot} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''}`),
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

async function eksekusiCekStatusOrder({ pesanan_id }) {
  if (pesanan_id) {
    const p = db.getPesananById(pesanan_id);
    if (!p) return { sukses: false, pesan: `Pesanan #${pesanan_id} tidak ditemukan.` };
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

async function eksekusiKonfirmasiKedatangan({ nomor_meja }, konteks) {
  db.setNomorMeja(konteks.jid, nomor_meja);
  return { sukses: true, nomor_meja };
}

async function eksekusiForwardPesanKeKasir({ ringkasan, urgent, pesanan_id }, konteks) {
  const customer = db.getCustomer(konteks.jid);
  const operatorUtama = db.getAllOperators().find((o) => o.is_utama === 1);

  if (!operatorUtama) {
    return { sukses: false, pesan: 'Tidak ada kasir utama yang terdaftar.' };
  }

  const nomorBersih = konteks.jid.split('@')[0];
  const infoMeja = customer.nomor_meja ? ` (meja ${customer.nomor_meja})` : '';
  const infoPesanan = pesanan_id ? ` [pesanan #${pesanan_id}]` : '';
  const tanda = urgent ? '🔴 URGENT' : 'ℹ️';

  const pesanKeKasir = `${tanda} Dari ${customer.nama || nomorBersih}${infoMeja}${infoPesanan}:\n\n${ringkasan}\n\n${urgent ? 'Bot nonaktif utk nomor ini, lanjut manual ya. ' : ''}Ketik "selesai ${nomorBersih}" kalau sudah kelar.`;

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
};

// ========== EKSEKUTOR — KASIR ==========

async function cariPesananUntukKonfirmasi({ pesanan_id, nomor_meja }) {
  if (pesanan_id) {
    const p = db.getPesananById(pesanan_id);
    return p ? [p] : [];
  }
  if (nomor_meja) {
    return db.getPesananMenungguBayar().filter((p) => p.nomor_meja === nomor_meja || p.nomor_meja_customer === nomor_meja);
  }
  return db.getPesananMenungguBayar();
}

async function eksekusiKonfirmasiBayar({ pesanan_id, nomor_meja }, konteks) {
  const kandidat = await cariPesananUntukKonfirmasi({ pesanan_id, nomor_meja });

  if (kandidat.length === 0) {
    return { sukses: false, pesan: 'Tidak ketemu pesanan yang sedang menunggu bayar untuk itu.' };
  }

  if (kandidat.length > 1) {
    return {
      sukses: false,
      ada_banyak_kandidat: true,
      daftar: kandidat.map((p) => ({ pesanan_id: p.id, meja: p.nomor_meja, nama: p.nama })),
      catatan_untuk_ai: 'Ada lebih dari 1 pesanan menunggu bayar yang cocok, tanya balik pesanan mana (format angka) sebelum konfirmasi.',
    };
  }

  const pesanan = kandidat[0];
  if (pesanan.status !== 'MENUNGGU_BAYAR') {
    return { sukses: false, pesan: `Pesanan #${pesanan.id} statusnya "${pesanan.status}", bukan sedang menunggu bayar.` };
  }

  db.setPesananLunas(pesanan.id);

  const customer = db.getCustomer(pesanan.customer_jid);
  const items = db.getItemsByPesananId(pesanan.id);
  const pesanKeCustomer = await ai.generateKonfirmasiOrderMasukDapur(customer.nama, items, pesanan.nomor_meja);

  await konteks.kirimPesan(
    customer.jid,
    pesanKeCustomer || `Matur nuwun Mas/Mbak ${customer.nama || ''}, pembayaran sudah kami terima. Pesanan langsung kami teruskan ke dapur nggih 🙏`
  );

  return { sukses: true, pesanan_id: pesanan.id, customer: customer.nama, nomor_meja: pesanan.nomor_meja };
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
    `Matur nuwun Mas/Mbak${t.nama ? ` ${t.nama}` : ''}, kekurangan bayar Rp${t.nominal} sudah kami terima nggih 🙏`
  );

  return { sukses: true, pesanan_id: t.pesanan_id, customer: t.nama, nominal: t.nominal };
}

async function eksekusiLaporMenuHabisSetelahBayar({ nama_menu, pesanan_id, nomor_meja }, konteks) {
  // Cari pesanan target: by ID, atau by nomor meja, atau semua yang SELESAI aktif hari ini
  let kandidatPesanan;
  if (pesanan_id) {
    const p = db.getPesananById(pesanan_id);
    kandidatPesanan = p ? [p] : [];
  } else if (nomor_meja) {
    kandidatPesanan = db.getPesananAktifSemua().filter((p) => p.nomor_meja === nomor_meja && p.status === 'SELESAI');
  } else {
    kandidatPesanan = db.getPesananAktifSemua().filter((p) => p.status === 'SELESAI');
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
    `Pesanan customer sudah lunas dan masuk dapur, tapi ternyata "${item.nama_snapshot}" habis. Buatkan SATU pesan, MAKSIMAL 2 KALIMAT: kalimat 1 minta maaf + kabari menu habis, kalimat 2 tawarkan pilihan (ganti menu lain / batalkan & uang kembali) dan minta balas dalam 10 menit. Nada hangat, nuansa resto Jawa secukupnya.`,
    200
  );

  await konteks.kirimPesan(
    customer.jid,
    pesanKeCustomer || `Mohon maaf nggih Mas/Mbak, ternyata ${item.nama_snapshot} pesanan tadi habis. Mau diganti menu lain atau dibatalkan saja (uang kami kembalikan)? Mohon dibalas dalam 10 menit nggih.`
  );

  return {
    sukses: true,
    pesanan_id: pesanan.id,
    item_habis: item.nama_snapshot,
    customer: customer.nama,
    pesan: 'Customer sudah dikabari dan ditawarkan pilihan ganti/batal.',
  };
}

async function eksekusiBatalkanOrderPaksa({ pesanan_id, alasan }, konteks) {
  const pesanan = db.getPesananById(pesanan_id);
  if (!pesanan) return { sukses: false, pesan: `Pesanan #${pesanan_id} tidak ditemukan.` };
  if (pesanan.status === 'SELESAI') return { sukses: false, pesan: `Pesanan #${pesanan_id} sudah SELESAI, tidak bisa dibatalkan.` };

  db.setStatusPesanan(pesanan_id, 'DIBATALKAN');

  const customer = db.getCustomer(pesanan.customer_jid);
  const pesanKeCustomer = await ai.callAiText(
    `Pesanan #${pesanan_id} milik ${customer.nama || 'customer'} baru saja dibatalkan oleh kasir dengan alasan: "${alasan}". Buatkan SATU pesan, MAKSIMAL 1 KALIMAT, sopan, nuansa ramah khas resto Jawa (boleh ada "nggih"/"mohon maaf nggih"), memberi tahu ini ke customer.`,
    150
  );

  await konteks.kirimPesan(customer.jid, pesanKeCustomer || `Mohon maaf nggih, pesanan #${pesanan_id} kami batalkan (${alasan}).`);
  await kirimTiketPesananKeStaf(konteks, db.getPesananById(pesanan.id), items);
  return { sukses: true, pesanan_id, customer: customer.nama, alasan };
}

async function eksekusiCekStatusOrder({ pesanan_id }) {
  if (pesanan_id) {
    const p = db.getPesananById(pesanan_id);
    if (!p) return { sukses: false, pesan: `Pesanan #${pesanan_id} tidak ditemukan.` };
    const items = db.getItemsByPesananId(pesanan_id);
    const customer = db.getCustomer(p.customer_jid);
    return {
      sukses: true, pesanan_id: p.id, status: p.status, nomor_meja: p.nomor_meja,
      customer: customer.nama, total: p.subtotal,
      items: items.map((i) => `${i.nama_snapshot} x${i.qty}`),
    };
  }

  const semuaAktif = db.getPesananAktifSemua();
  return {
    sukses: true,
    jumlah: semuaAktif.length,
    daftar: semuaAktif.map((p) => ({ pesanan_id: p.id, meja: p.nomor_meja, customer: p.nama, status: p.status, total: p.subtotal })),
  };
}

async function eksekusiKirimUlangQr({ pesanan_id }, konteks) {
  const pesanan = db.getPesananById(pesanan_id);
  if (!pesanan) return { sukses: false, pesan: `Pesanan #${pesanan_id} tidak ditemukan.` };
  if (pesanan.status !== 'MENUNGGU_BAYAR') {
    return { sukses: false, pesan: `Pesanan #${pesanan_id} statusnya "${pesanan.status}", bukan menunggu bayar.` };
  }
  const hasilKirim = await konteks.kirimQrKeCustomer(pesanan.id, pesanan.nominal_transfer);
  return { sukses: hasilKirim !== false, pesanan_id: pesanan.id, nominal_transfer: pesanan.nominal_transfer };
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
      varian: m.varian.map((v) => `${v.label}: Rp${v.harga}`),
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

const EKSEKUTOR_OPERATOR = {
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
  EKSEKUTOR_CUSTOMER, EKSEKUTOR_OPERATOR,
  setKlarifikasiPending, getKlarifikasiPending, clearKlarifikasiPending,
  setPilihanPending, getPilihanPending, clearPilihanPending,
  buatKonteksDinamisCustomer,
  buatBlokInfoResto,
};