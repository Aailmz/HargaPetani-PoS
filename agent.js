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

// ========== STATE SEMENTARA (in-memory) ==========
// Dipakai saat customer sebut nama menu ambigu (misal "sate" -> sate kambing/ayam/taichan)
const klarifikasiPendingPerCustomer = new Map();

function setKlarifikasiPending(jid, data) {
  klarifikasiPendingPerCustomer.set(jid, data);
}
function getKlarifikasiPending(jid) {
  return klarifikasiPendingPerCustomer.get(jid) || null;
}
function clearKlarifikasiPending(jid) {
  klarifikasiPendingPerCustomer.delete(jid);
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
      name: 'cek_status_order_saya',
      description: 'Lihat status order aktif milik customer ini. Dipakai kalau customer tanya soal status pesanannya, sudah dibayar belum, atau "pesenan saya gimana".',
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
      description: 'Tandai sebuah pesanan sebagai sudah dibayar (lunas) setelah kasir dengar/lihat pembayaran masuk di mesin EDC/QR, lalu otomatis kabari customer bahwa pesanannya diteruskan ke dapur. Dipakai kalau kasir bilang semacam "meja 5 udah bayar" atau sebut nomor pesanan yang sudah lunas.',
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
      name: 'update_menu',
      description: 'Update harga, deskripsi, tambah menu baru, atau tandai menu habis. Dipakai kalau kasir kirim info menu (satu atau banyak sekaligus).',
      parameters: {
        type: 'object',
        properties: {
          teks_mentah: { type: 'string', description: 'Salin ulang teks asli dari kasir soal menu, apa adanya.' },
        },
        required: ['teks_mentah'],
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

CARA KERJA:
- Customer baru pertama kali chat -> sapa dengan hangat pakai "Sugeng rawuh" di awal (lihat state sambutan di bawah).
- Tanya menu / minta lihat menu / minta foto-pdf menu -> panggil lihat_menu. File menu akan otomatis terkirim oleh sistem, kamu tidak perlu urus itu.
- Tanya hal spesifik soal 1/beberapa menu (bahan, pedas, alergi, cocok buat siapa, dll) -> panggil tanya_detail_menu, lalu jawab dari deskripsi yang didapat dengan gaya ngobrol, bukan baca manual.
- Sebut menu + jumlah mau dipesan -> panggil buat_order.
- Kalau ada menu yang ambigu (banyak varian cocok) dari hasil buat_order, tampilkan pilihan dengan format angka, tunggu jawaban customer, lalu panggil jawab_klarifikasi_menu.
- Customer konfirmasi pesanan ("ya", "fix", "udah bener") SETELAH draft dirangkum -> panggil tampilkan_rincian_order (JANGAN langsung kirim QR).
- Customer konfirmasi LAGI setelah lihat rincian ("ya kirim", "oke", "lanjut") -> baru panggil kirim_qr_pembayaran. WAJIB dua langkah terpisah, tidak boleh dipanggil dalam giliran yang sama, tunggu balasan customer di antaranya.
- Customer sebut nomor meja / bilang sudah sampai kapan pun -> panggil konfirmasi_kedatangan.
- Customer tanya status pesanan -> cek_status_order_saya.
- Customer mau batal pesanan yang belum dikonfirmasi -> batalkan_order.
- Customer komplain/minta sesuatu yang butuh kasir -> forward_pesan_ke_kasir, kabari customer dengan natural kalau itu sudah disampaikan.
- Obrolan biasa sesuai scope -> balas natural tanpa tool.

ATURAN PENULISAN WAJIB:
- Kapitalisasi normal bahasa Indonesia, BUKAN Title Case Di Setiap Kata.
- Jangan menyebut dirimu "AI", "bot", "sistem", atau "asisten virtual".
- Singkat, langsung ke poin, maksimal 2-3 kalimat kecuali memang perlu daftar/rincian menu.
- Kalau menyebutkan beberapa pilihan/item, pakai format angka (1. 2. 3.), bukan bullet/strip.
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

ATURAN PENULISAN WAJIB:
- Kapitalisasi normal bahasa Indonesia, BUKAN Title Case Di Setiap Kata.
- Jangan menyebut dirimu "AI", "bot", "sistem", atau "asisten virtual".
- Singkat dan langsung ke poin, maksimal 2 kalimat kecuali perlu daftar.
- Kalau ada beberapa pilihan/item, pakai format angka (1. 2. 3.), bukan bullet/strip.
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
        temperature: 0.8, // sedikit lebih tinggi dari grosir, biar lebih natural/variatif
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

const AMBANG_RINGKAS = 10;

async function eksekusiLihatMenu({ kategori }) {
  const semuaMenu = db.getMenuTersedia();

  if (kategori) {
    const terfilter = semuaMenu.filter((m) => (m.kategori || 'lainnya').toLowerCase() === kategori.toLowerCase());
    if (terfilter.length === 0) {
      return { sukses: false, pesan: `Tidak ada menu dengan kategori "${kategori}".` };
    }
    return {
      sukses: true,
      kategori,
      daftar: terfilter.map((m) => `${m.nama}: Rp${m.harga}`),
      catatan_untuk_ai: 'TETAP beri tahu bahwa file menu lengkap (foto/PDF) sudah/akan dikirim terpisah oleh sistem.',
    };
  }

  if (semuaMenu.length > AMBANG_RINGKAS) {
    const perKategori = {};
    for (const m of semuaMenu) {
      const kat = m.kategori || 'lainnya';
      perKategori[kat] = (perKategori[kat] || 0) + 1;
    }
    return {
      sukses: true,
      ringkas: true,
      kategori: Object.entries(perKategori).map(([nama, jumlah]) => `${nama} (${jumlah} menu)`),
      catatan_untuk_ai: 'Sebutkan kategori apa aja beserta jumlahnya (format angka), tanya mau lihat kategori mana. Beri tahu juga file menu lengkap (foto/PDF) sudah/akan terkirim terpisah. JANGAN sebutkan nama+harga satu-satu di sini.',
    };
  }

  return {
    sukses: true,
    daftar: semuaMenu.map((m) => `${m.nama}: Rp${m.harga}`),
    catatan_untuk_ai: 'Beri tahu juga file menu lengkap (foto/PDF) sudah/akan dikirim terpisah oleh sistem.',
  };
}

async function eksekusiTanyaDetailMenu({ nama_menu }) {
  const hasil = [];
  const tidakKetemu = [];

  for (const nama of nama_menu) {
    const match = cariKandidatMenu(nama);
    if (match.statusMatch === 'TIDAK_ADA') {
      tidakKetemu.push(nama);
      continue;
    }
    const menu = match.kandidatTerbaik;
    hasil.push({
      nama: menu.nama,
      harga: menu.harga,
      kategori: menu.kategori,
      status: menu.status,
      deskripsi: menu.deskripsi || '(belum ada deskripsi detail tercatat untuk menu ini)',
    });
  }

  if (hasil.length === 0) {
    return { sukses: false, pesan: `Menu "${nama_menu.join(', ')}" tidak ditemukan.` };
  }

  return {
    sukses: true,
    menu: hasil,
    tidak_ketemu: tidakKetemu.length > 0 ? tidakKetemu : undefined,
    catatan_untuk_ai: 'Jawab pertanyaan customer dari field deskripsi di atas, dengan gaya ngobrol natural, JANGAN cuma baca ulang deskripsi mentah-mentah. Kalau deskripsi belum ada/kurang lengkap untuk jawab pertanyaan spesifik (misal soal alergen detail), jujur bilang belum yakin dan tawarkan forward_pesan_ke_kasir untuk mastiin ke dapur.',
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

  if (hasilParse.items.length === 0 && hasilParse.tidakDikenali.length === 0 && hasilParse.perluKlarifikasi.length === 0) {
    return { sukses: false, pesan: 'Tidak ada menu yang berhasil dikenali dari pesan ini.' };
  }

  if (hasilParse.perluKlarifikasi.length > 0) {
    setKlarifikasiPending(konteks.jid, hasilParse.perluKlarifikasi);
    return {
      sukses: true,
      butuh_klarifikasi: true,
      daftar_klarifikasi: hasilParse.perluKlarifikasi.map((k) => ({
        yang_disebut_customer: k.namaInput,
        pilihan: k.kandidatList.map((m) => `${m.nama} (Rp${m.harga})`),
      })),
      item_lain_yang_jelas: hasilParse.items.map((i) => `${i.menu.nama} x${i.qty}`),
      catatan_untuk_ai: 'Ada menu yang customer sebut dengan nama umum dan punya beberapa varian. JANGAN buat order dulu untuk item ambigu itu. Tampilkan pilihan dengan format angka, minta customer pilih.',
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
    db.tambahItemPesanan(pesananId, {
      menu_id: item.menu.id,
      nama_snapshot: item.menu.nama,
      qty: item.qty,
      harga_satuan_snapshot: item.menu.harga,
      catatan: item.catatan || null,
    });
  }

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
      ? 'PENTING: pesanan ini sebelumnya sudah dikirimi QR (sedang menunggu bayar), tapi karena ada tambahan item, nominal berubah dan QR lama TIDAK BERLAKU LAGI. Beri tahu customer dengan jelas (jangan sampai dia bayar pakai QR/nominal lama), rangkum SEMUA item di draft saat ini, dan minta konfirmasi ulang ("ya"/"fix") supaya QR baru dengan nominal yang benar dikirim.'
      : 'Pesanan tercatat sebagai draft. Rangkum SEMUA item di draft saat ini (bukan cuma yang baru ditambahkan), tanya apakah sudah fix semua atau mau nambah lagi, minta bilang "ya"/"fix" untuk lanjut ke pembayaran. JANGAN sebutkan total harga dulu di sini (dihitung final pas konfirmasi).',
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

async function eksekusiTampilkanRincianOrder(_, konteks) {
  const draft = db.getDraftAtauMenungguBayarByCustomer(konteks.jid);
  if (!draft) {
    return { sukses: false, pesan: 'Tidak ada draft pesanan yang menunggu konfirmasi saat ini.' };
  }
  if (draft.status === 'MENUNGGU_BAYAR') {
    return {
      sukses: false,
      pesan: 'Pesanan ini sudah di tahap menunggu bayar (QR sudah/pernah dikirim).',
      catatan_untuk_ai: 'Rincian sudah pernah ditampilkan sebelumnya untuk draft ini. Tanya apakah customer mau QR dikirim ulang.',
    };
  }

  const items = db.getItemsByPesananId(draft.id);
  const subtotal = items.reduce((sum, i) => sum + i.harga_satuan_snapshot * i.qty, 0);
  db.setHargaFixPesanan(draft.id, subtotal);

  return {
    sukses: true,
    pesanan_id: draft.id,
    items: items.map((i) => `${i.nama_snapshot} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''} @ Rp${i.harga_satuan_snapshot} = Rp${i.harga_satuan_snapshot * i.qty}`),
    subtotal,
    catatan_untuk_ai: 'Tampilkan rincian item (nama, qty, harga satuan, subtotal tiap item) dan total subtotal ke customer dengan format angka. Tanya apakah sudah fix dan boleh lanjut dikirimkan QR pembayarannya. JANGAN panggil kirim_qr_pembayaran sekarang, tunggu jawaban customer berikutnya.',
  };
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

  const kodeUnik = db.getNextKodeUnikHarian();
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

async function eksekusiCekStatusOrderSaya(_, konteks) {
  const semuaOrder = db.getPesananAktifByCustomer(konteks.jid);
  if (semuaOrder.length === 0) {
    return { sukses: true, ada_order_aktif: false, pesan: 'Tidak ada order aktif saat ini.' };
  }
  return {
    sukses: true,
    ada_order_aktif: true,
    daftar: semuaOrder.map((p) => {
      const items = db.getItemsByPesananId(p.id);
      return {
        pesanan_id: p.id,
        status: p.status,
        total: p.subtotal,
        nomor_meja: p.nomor_meja,
        items: items.map((i) => `${i.nama_snapshot} x${i.qty}`),
      };
    }),
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
  tampilkan_rincian_order: eksekusiTampilkanRincianOrder,
  kirim_qr_pembayaran: eksekusiKirimQrPembayaran,
  batalkan_order: eksekusiBatalkanOrder,
  cek_status_order_saya: eksekusiCekStatusOrderSaya,
  konfirmasi_kedatangan: eksekusiKonfirmasiKedatangan,
  forward_pesan_ke_kasir: eksekusiForwardPesanKeKasir,
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

  db.setStatusPesanan(pesanan.id, 'SELESAI');

  const customer = db.getCustomer(pesanan.customer_jid);
  const items = db.getItemsByPesananId(pesanan.id);
  const pesanKeCustomer = await ai.generateKonfirmasiOrderMasukDapur(customer.nama, items, pesanan.nomor_meja);

  await konteks.kirimPesan(
    customer.jid,
    pesanKeCustomer || `Matur nuwun Mas/Mbak ${customer.nama || ''}, pembayaran sudah kami terima. Pesanan langsung kami teruskan ke dapur nggih 🙏`
  );

  return { sukses: true, pesanan_id: pesanan.id, customer: customer.nama, nomor_meja: pesanan.nomor_meja };
}

async function eksekusiBatalkanOrderPaksa({ pesanan_id, alasan }, konteks) {
  const pesanan = db.getPesananById(pesanan_id);
  if (!pesanan) return { sukses: false, pesan: `Pesanan #${pesanan_id} tidak ditemukan.` };
  if (pesanan.status === 'SELESAI') return { sukses: false, pesan: `Pesanan #${pesanan_id} sudah SELESAI, tidak bisa dibatalkan.` };

  db.setStatusPesanan(pesanan_id, 'DIBATALKAN');

  const customer = db.getCustomer(pesanan.customer_jid);
  const pesanKeCustomer = await ai.callAiText(
    `Pesanan #${pesanan_id} milik ${customer.nama || 'customer'} baru saja dibatalkan oleh kasir dengan alasan: "${alasan}". Buatkan SATU pesan (2-3 kalimat) yang sopan, nuansa ramah khas resto Jawa (boleh ada "nggih"/"mohon maaf nggih"), memberi tahu ini ke customer.`,
    250
  );

  await konteks.kirimPesan(customer.jid, pesanKeCustomer || `Mohon maaf nggih, pesanan #${pesanan_id} kami batalkan (${alasan}).`);

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

async function eksekusiUpdateMenu({ teks_mentah }) {
  const ringkasan = await ai.prosesListMenuOperator(teks_mentah);
  if (ringkasan.totalDiproses === 0) {
    return { sukses: false, pesan: 'Gagal membaca info menu dari teks yang diberikan.' };
  }
  return {
    sukses: true,
    total_diproses: ringkasan.totalDiproses,
    menu_baru: ringkasan.baru,
    menu_diupdate: ringkasan.diupdate,
    menu_habis: ringkasan.habis,
  };
}

async function eksekusiLihatSemuaMenu() {
  const semuaMenu = db.getAllMenu();
  return {
    sukses: true,
    total: semuaMenu.length,
    daftar: semuaMenu.map((m) => ({ nama: m.nama, harga: m.harga, status: m.status })),
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
    omzet_hari_ini: stat.omzet_selesai_hari_ini,
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
  update_menu: eksekusiUpdateMenu,
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
};

module.exports = {
  client, MODEL,
  TOOLS_CUSTOMER, TOOLS_OPERATOR,
  SYSTEM_PROMPT_CUSTOMER, SYSTEM_PROMPT_OPERATOR,
  jalankanAgent,
  EKSEKUTOR_CUSTOMER, EKSEKUTOR_OPERATOR,
  setKlarifikasiPending, getKlarifikasiPending, clearKlarifikasiPending,
};