const OpenAI = require('openai');
require('dotenv').config();

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
  timeout: 30 * 1000,
  maxRetries: 2,
});

const MODEL = process.env.AI_MODEL;

const SYSTEM_PROMPT = `Kamu adalah "The Banjoemas" -- bukan bot, tapi terasa seperti pelayan/admin The Banjoemas Resto & Cafe (resto khas Banyumas/Jawa Tengah) yang ramah dan hangat ke tamu.

Gaya bicaramu:
- Hangat, ramah, natural seperti pelayan resto beneran -- bukan gaya robot/formal kaku.
- Resto ini kental nuansa Jawa (Banyumasan). Boleh sesekali selingi kata khas Jawa secukupnya ("monggo", "nggih", "matur nuwun", "sugeng rawuh" kalau memang konteksnya sapaan pembuka) tapi JANGAN dipaksakan di setiap kalimat -- cukup bumbu, selebihnya bahasa Indonesia santai.
- Akhiri pesan dengan tepat 1 emoji yang pas (🙏 😊 ☕ 🍛), jangan lebih.
- Gaya chat santai tapi jelas, kayak ngobrol sama teman: pakai kata sehari-hari ("ya", "nih", "aja", "udah"), bukan bahasa baku/formal ("mohon", "silakan", "telah kami terima"). Kalimat pendek, langsung ke inti.
- Panggil customer "Mas" atau "Mbak".
- SANGAT singkat: ikuti PERSIS jumlah kalimat yang diminta di instruksi spesifik pada prompt (biasanya 1 kalimat). Jangan tambah kalimat di luar yang diminta.

ATURAN PENULISAN WAJIB (PELANGGARAN = FATAL):
- Tulis dengan kapitalisasi normal bahasa Indonesia: hanya huruf pertama kalimat dan nama diri yang kapital. DILARANG menulis Setiap Kata Diawali Huruf Besar.
- JANGAN PERNAH menyebut dirimu "bot", "sistem", "AI", "asisten virtual", atau sejenisnya.
- Jangan mengulang/menggemakan ucapan dari pesan sebelumnya yang tidak diminta.
- Hasilkan HANYA pesan sesuai instruksi spesifik di prompt, tidak lebih, tidak nambah salam/penutup yang tidak diminta.
- Selesaikan kalimat dengan lengkap, jangan terpotong di tengah.`;

async function callAiText(userPrompt, maxTokens = 350, extraOptions = {}) {
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.8,
      ...extraOptions,
    });
    const result = completion.choices[0]?.message?.content?.trim();
    if (!result) {
      console.log('⚠️  AI balas kosong.');
      return null;
    }
    return result;
  } catch (err) {
    console.error('❌ AI API error:', err.message);
    return null;
  }
}

async function callAiJson(systemPromptJson, userPrompt, maxTokens = 500) {
  try {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPromptJson },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
    });
    const result = completion.choices[0]?.message?.content?.trim();
    if (!result) return null;
    const cleaned = result.replace(/```json|```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('❌ AI JSON parse error:', err.message);
    return null;
  }
}

const { cariKandidatMenu } = require('./matcher');
const { upsertMenu } = require('./db');
const { rp } = require('./format');

/**
 * Tahap 1: AI ekstrak list menu mentah dari kasir jadi array terstruktur.
 */
async function ekstrakListMenuMentah(pesanMentah) {
  const systemJson = `Kamu adalah parser teks list menu resto. Jawab HANYA dengan JSON valid array, tanpa markdown fence, tanpa teks tambahan.`;

  const userPrompt = `Berikut pesan dari kasir berisi info menu (gaya penulisan bebas, bisa typo, variasi tanda baca):

"""
${pesanMentah}
"""

ATURAN EKSTRAKSI:
- Abaikan baris yang cuma judul kategori tanpa harga (contoh: "*minuman*", "Gorengan:").
- Untuk tiap baris menu, pisahkan nama menu, harga, dan deskripsi (kalau disebutkan, misal "pedesnya bisa diatur" atau "pakai santan").
- Kalau ada tanda menu HABIS/KOSONG eksplisit (misal "habis", "kosong", "-", "**"), set "habis": true, "harga" boleh null.
- Kalau ada angka jelas (misal 33000, 47k -> 47000) itu harganya, "habis": false.
- Rapikan nama menu: Kapital di awal kata (Title Case) HANYA untuk field "nama" ini (pengecualian dari aturan teks biasa), buang spasi berlebih dan tanda baca nyasar.
- Deteksi kategori dari konteks header terakhir sebelum baris itu (contoh: semua menu di bawah header "gorengan" sampai header berikutnya, kategorinya "gorengan"). Kalau tidak ada header jelas, kategori boleh null.
- "deskripsi" diisi HANYA kalau kasir benar-benar menyebutkan detail (bahan, level pedas, catatan alergen, dll) di teksnya. Kalau tidak ada, null.

Balas dengan JSON array, format tiap elemen:
{"nama": "...", "kategori": "..." atau null, "deskripsi": "..." atau null, "harga": angka atau null, "habis": true/false}`;

  const hasil = await callAiJson(systemJson, userPrompt, 8000);
  if (!hasil || !Array.isArray(hasil)) {
    console.log('⚠️  Gagal ekstrak list menu, AI tidak balas array valid.');
    return [];
  }
  return hasil;
}

/**
 * Tahap 2: untuk kasus AMBIGU dari matcher, tanya AI apakah ini menu baru
 * atau sebenarnya salah satu menu existing.
 */
async function putuskanMenuAmbigu(namaInput, kandidatTerbaik, kandidatKedua) {
  const daftarKandidat = [kandidatTerbaik, kandidatKedua]
    .filter(Boolean)
    .map((m) => m.nama)
    .join(', ');

  const prompt = `Kasir sebuah resto menyebut nama menu: "${namaInput}"

Di database sudah ada menu-menu mirip ini: ${daftarKandidat}

Apakah "${namaInput}" ini sebenarnya SAMA dengan salah satu menu di database (cuma beda penulisan/typo), atau ini menu BARU yang beda jenis?

Balas HANYA dengan salah satu:
- Kalau sama dengan salah satu, balas persis nama menu dari database itu (copy exact).
- Kalau menu baru, balas: BARU`;

  const hasil = await callAiText(prompt, 100, { temperature: 0.1 });
  if (!hasil) return 'BARU';
  return hasil.trim();
}

async function cocokkanJawabanKlarifikasiMenu(jawabanCustomer, daftarPending) {
  const konteksPending = daftarPending.map((p, idx) =>
    `${idx + 1}. Customer sebut "${p.namaInput}" (qty: ${p.qty}), pilihannya: ${p.kandidatList.map((m) => m.nama).join(', ')}`
  ).join('\n');

  const systemJson = `Kamu mencocokkan jawaban customer ke pilihan menu yang sudah ditawarkan. Jawab HANYA JSON array, tanpa markdown fence.`;

  const userPrompt = `Sebelumnya customer ditanya mau pilih yang mana dari beberapa varian menu:
${konteksPending}

Customer menjawab: "${jawabanCustomer}"

Cocokkan jawaban ini ke menu spesifik yang dimaksud untuk TIAP pertanyaan di atas (kalau jawabannya cuma cover sebagian, itu tidak masalah, balas yang berhasil dicocokkan aja).

Balas JSON array, tiap elemen: {"namaInputAsli": "...", "namaMenuTerpilih": "...", "qty": angka}
"namaMenuTerpilih" harus PERSIS sama dengan salah satu nama di daftar pilihan.`;

  const hasil = await callAiJson(systemJson, userPrompt, 500);
  if (!hasil || !Array.isArray(hasil)) return [];

  return hasil.map((h) => {
    const pending = daftarPending.find((p) => p.namaInput === h.namaInputAsli);
    const menu = pending?.kandidatList.find((m) => m.nama === h.namaMenuTerpilih);
    return menu ? { menu, qty: h.qty || pending.qty } : null;
  }).filter(Boolean);
}

async function cocokkanJawabanPilihan(jawabanCustomer, daftarPending) {
  const konteksPending = daftarPending.map((p, idx) => {
    if (p.jenisPilihan === 'varian') {
      return `${idx + 1}. Untuk "${p.namaInput}" (qty: ${p.qty}), pilih porsi: ${p.opsiTersedia.join(', ')}`;
    }
    return `${idx + 1}. Untuk "${p.namaInput}" (qty: ${p.qty}), pilih ${p.namaOpsi}: ${p.opsiTersedia.join(', ')}`;
  }).join('\n');

  const systemJson = `Kamu mencocokkan jawaban customer ke pilihan yang sudah ditawarkan (porsi/suhu/sambal/dll). Jawab HANYA JSON array, tanpa markdown fence.`;

  const userPrompt = `Sebelumnya customer ditanya mau pilih yang mana:
${konteksPending}

Customer menjawab: "${jawabanCustomer}"

Cocokkan jawaban ini ke pilihan spesifik untuk TIAP pertanyaan di atas (kalau cuma cover sebagian, tidak masalah, balas yang berhasil dicocokkan aja).

Balas JSON array, tiap elemen: {"namaInputAsli": "...", "opsiTerpilih": "..."}
"opsiTerpilih" harus PERSIS sama dengan salah satu opsi yang ditawarkan untuk pertanyaan itu.`;

  const hasil = await callAiJson(systemJson, userPrompt, 500);
  if (!hasil || !Array.isArray(hasil)) return [];

  return hasil.map((h) => {
    const pending = daftarPending.find((p) => p.namaInput === h.namaInputAsli);
    if (!pending) return null;
    const opsiValid = pending.opsiTersedia.find((o) => o === h.opsiTerpilih);
    return opsiValid ? { pending, opsiTerpilih: opsiValid } : null;
  }).filter(Boolean);
}

/**
 * Parse teks kasir soal status menu (HABIS/ADA) jadi daftar perubahan status.
 */
async function ekstrakStatusMenuMentah(pesanMentah) {
  const systemJson = `Kamu adalah parser teks status stok menu resto dari kasir. Jawab HANYA dengan JSON valid array, tanpa markdown fence.`;

  const userPrompt = `Kasir menulis pesan ini soal status menu:

"""
${pesanMentah}
"""

Untuk SETIAP menu yang disebut, tentukan apakah kasir bilang menu itu HABIS (tidak tersedia) atau ADA/READY lagi (tersedia). Pola umum: "HABIS <menu>", "<menu> habis/kosong", "ADA <menu>", "<menu> ready/udah ada lagi".

Balas JSON array, format tiap elemen:
{"nama": "...", "tersedia": true/false}`;

  const hasil = await callAiJson(systemJson, userPrompt, 800);
  if (!hasil || !Array.isArray(hasil)) return [];
  return hasil;
}

async function prosesUpdateStatusMenu(pesanMentah) {
  const itemMentah = await ekstrakStatusMenuMentah(pesanMentah);

  const hasil = { perubahan: [], tidakDikenali: [] };

  for (const item of itemMentah) {
    if (!item.nama) continue;

    const match = cariKandidatMenu(item.nama);
    if (match.statusMatch === 'TIDAK_ADA' || match.statusMatch === 'AMBIGU_MULTI') {
      hasil.tidakDikenali.push(item.nama);
      continue;
    }

    const menu = match.kandidatTerbaik;
    hasil.perubahan.push({ menu, tersedia: !!item.tersedia });
  }

  return hasil;
}

/**
 * Parse pesan order customer jadi array {nama, qty, catatan}.
 */
async function ekstrakOrderCustomer(pesanCustomer) {
  const systemJson = `Kamu adalah parser teks pesanan makanan/minuman resto dari pelanggan. Jawab HANYA dengan JSON valid array, tanpa markdown fence.`;

  const userPrompt = `Pelanggan menulis pesan order ini:

"${pesanCustomer}"

Ekstrak semua menu yang disebutkan beserta jumlahnya. Kalau tidak disebutkan jumlah, asumsikan 1.

Selain itu, deteksi juga indikasi berikut KALAU disebutkan eksplisit oleh pelanggan (jangan menebak-nebak kalau tidak disebut):
- "porsi": kalau pelanggan sebut "setengah porsi"/"1/2 porsi"/"porsi kecil" -> "setengah". Kalau sebut "porsi penuh"/"porsi besar"/"porsi normal" -> "penuh". Kalau tidak disebut sama sekali -> null.
- "suhu": kalau pelanggan sebut "panas"/"hangat" -> "panas". Kalau sebut "dingin"/"es"/"ice" -> "dingin". Kalau tidak disebut -> null.
- "sambal": kalau pelanggan sebut "tanpa sambal"/"gak pake sambal"/"no sambal" -> "tanpa". Kalau sebut "pakai sambal"/"dengan sambal" -> "dengan". Kalau tidak disebut -> null.
- "catatan": catatan bebas lain di luar 3 hal di atas (misal "pedesnya dikit", "tanpa bawang", "less sugar"). Kalau tidak ada -> null.

Abaikan kata-kata basa-basi seperti "dong", "ya", "mau pesan", dll -- fokus cuma nama menu + jumlah + indikasi di atas.

Kalau pesan ini sama sekali TIDAK berisi order menu (misal cuma chat biasa/pertanyaan/sapaan), balas array kosong [].

Balas JSON array, format tiap elemen:
{"nama": "...", "qty": angka, "porsi": "setengah"/"penuh"/null, "suhu": "panas"/"dingin"/null, "sambal": "dengan"/"tanpa"/null, "catatan": "..." atau null}`;

  const hasil = await callAiJson(systemJson, userPrompt, 1200);
  if (!hasil || !Array.isArray(hasil)) return [];
  return hasil;
}

/**
 * Proses order customer, match tiap item ke menu di DB.
 * Return: { items: [...], tidakDikenali: [...], perluKlarifikasi: [...] }
 */
async function prosesOrderCustomer(pesanCustomer) {
  const itemMentah = await ekstrakOrderCustomer(pesanCustomer);

  const hasil = { items: [], tidakDikenali: [], perluKlarifikasi: [], perluPilihan: [] };

  for (const item of itemMentah) {
    if (!item.nama) continue;

    const matchResult = cariKandidatMenu(item.nama);

    if (matchResult.statusMatch === 'AMBIGU_MULTI') {
      hasil.perluKlarifikasi.push({
        namaInput: item.nama,
        qty: item.qty || 1,
        catatan: item.catatan || null,
        kandidatList: matchResult.kandidatList,
      });
      continue;
    }

    // Dua kandidat sama-sama kuat (misal "ubi" -> Ubi Goreng / Cimplung Ubi): itu ambigu beneran, bukan typo.
    // Tanya customer, jangan biarkan AI menebak.
    if (matchResult.statusMatch === 'AMBIGU' && matchResult.kandidatKedua && matchResult.skorKedua >= 0.8) {
      hasil.perluKlarifikasi.push({
        namaInput: item.nama,
        qty: item.qty || 1,
        catatan: item.catatan || null,
        kandidatList: [matchResult.kandidatTerbaik, matchResult.kandidatKedua],
      });
      continue;
    }

    let menuFinal = null;

    if (matchResult.statusMatch === 'YAKIN') {
      menuFinal = matchResult.kandidatTerbaik;
    } else if (matchResult.statusMatch === 'AMBIGU') {
      const keputusan = await putuskanMenuAmbigu(item.nama, matchResult.kandidatTerbaik, matchResult.kandidatKedua);
      if (keputusan !== 'BARU') {
        menuFinal = [matchResult.kandidatTerbaik, matchResult.kandidatKedua]
          .find((m) => m && m.nama === keputusan) || matchResult.kandidatTerbaik;
      }
    }

    if (!menuFinal) {
      hasil.tidakDikenali.push(item.nama);
      continue;
    }

    // ---------- RESOLVE VARIAN ----------
    const resolusiVarian = resolveVarian(menuFinal, item.porsi);
    if (resolusiVarian.butuhKlarifikasi) {
      hasil.perluPilihan.push({
        menu: menuFinal,
        namaInput: item.nama,
        qty: item.qty || 1,
        jenisPilihan: 'varian',
        opsiTersedia: resolusiVarian.opsiTersedia, // label-label varian, misal ["1 porsi", "1/2 porsi"]
        catatan: item.catatan || null,
        parsial: { suhu: item.suhu, sambal: item.sambal }, // dibawa supaya tidak hilang pas user jawab
      });
      continue;
    }
    const varianTerpilih = resolusiVarian.varian;

    // ---------- CEK PILIHAN WAJIB (Suhu, dll) ----------
    const pilihanTerisi = {};
    let adaPilihanWajibKosong = false;
    let pilihanWajibKosong = null;

    for (const p of menuFinal.pilihan || []) {
      const nilaiDariInput = cocokkanNilaiPilihan(p, { suhu: item.suhu, sambal: item.sambal });
      if (nilaiDariInput) {
        pilihanTerisi[p.nama] = nilaiDariInput;
      } else if (p.wajib) {
        adaPilihanWajibKosong = true;
        pilihanWajibKosong = p;
        break;
      } else if (p.default_opsi) {
        pilihanTerisi[p.nama] = p.default_opsi; // pakai default kalau tidak wajib & tidak disebut
      }
    }

    if (adaPilihanWajibKosong) {
      hasil.perluPilihan.push({
        menu: menuFinal,
        namaInput: item.nama,
        qty: item.qty || 1,
        jenisPilihan: 'opsi',
        namaOpsi: pilihanWajibKosong.nama, // misal "Suhu"
        opsiTersedia: pilihanWajibKosong.opsi, // sudah array
        varianSku: varianTerpilih.sku,
        pilihanSudahTerisi: pilihanTerisi,
        catatan: item.catatan || null,
      });
      continue;
    }

    hasil.items.push({
      menu: menuFinal,
      varian: varianTerpilih,
      pilihanTerisi,
      namaInput: item.nama,
      qty: item.qty || 1,
      catatan: item.catatan || null,
    });
  }

  return hasil;
}

// ---------- HELPER: resolve varian dari menu + indikasi porsi ----------
function resolveVarian(menu, indikasiPorsi) {
  const daftarVarian = menu.varian || [];

  if (daftarVarian.length === 1) {
    return { varian: daftarVarian[0] };
  }

  // Lebih dari 1 varian (misal Sate Ayam: penuh/setengah)
  if (indikasiPorsi === 'setengah') {
    const v = daftarVarian.find((v) => /setengah|1\/2/i.test(v.label));
    if (v) return { varian: v };
  }
  if (indikasiPorsi === 'penuh') {
    const v = daftarVarian.find((v) => !/setengah|1\/2/i.test(v.label));
    if (v) return { varian: v };
  }

  // Tidak ada indikasi jelas -> minta klarifikasi ke customer
  return {
    butuhKlarifikasi: true,
    opsiTersedia: daftarVarian.map((v) => v.label),
  };
}

// ---------- HELPER: cocokkan nilai pilihan (Suhu/Sambal) dari hasil ekstraksi AI ----------
function cocokkanNilaiPilihan(pilihan, indikasi) {
  const namaLower = pilihan.nama.toLowerCase();
  const opsiList = pilihan.opsi; // SUDAH array dari db.js, tidak perlu JSON.parse lagi

  if (namaLower === 'suhu' && indikasi.suhu) {
    return opsiList.find((o) => o.toLowerCase().includes(indikasi.suhu)) || null;
  }
  if (namaLower === 'sambal' && indikasi.sambal) {
    const cari = indikasi.sambal === 'tanpa' ? 'tanpa' : 'dengan';
    return opsiList.find((o) => o.toLowerCase().includes(cari)) || null;
  }
  return null;
}

/**
 * Dipanggil setelah kasir konfirmasi_bayar -> kabari customer pesanan masuk dapur.
 */
async function generateKonfirmasiOrderMasukDapur(namaCustomer, items, nomorMeja) {
  const daftarItem = items.map((i) => `${i.nama_snapshot} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''}`).join(', ');
  const infoMeja = nomorMeja ? ` untuk meja ${nomorMeja}` : '';

  const prompt = `Pembayaran dari ${namaCustomer || 'customer'} baru saja dikonfirmasi lunas oleh kasir${infoMeja}. Pesanannya: ${daftarItem}.

Buatkan SATU pesan, MAKSIMAL 1 KALIMAT, mengabarkan pembayaran diterima dan pesanan diteruskan ke dapur. Nada hangat dan santai seperti chat ke teman (misal "Makasih ya, pembayarannya udah masuk, pesanannya langsung jalan ke dapur"), bukan bahasa baku. Boleh sedikit "matur nuwun"/"nggih" tapi jangan berlebihan.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip, tanpa kalimat tambahan di luar yang diminta.`;

  return await callAiText(prompt, 250);
}

/**
 * Dipanggil kasir minta broadcast promo.
 */
async function generateBroadcastPromo(menuMenarik) {
  const daftarMenu = menuMenarik
    .map((m) => {
      const hargaTampil = m.varian && m.varian.length === 1
        ? `${rp(m.varian[0].harga)}`
        : (m.varian ? m.varian.map((v) => `${v.label} ${rp(v.harga)}`).join('/') : `mulai ${rp(m.harga_mulai ?? '-')}`);
      return `${m.nama} (${hargaTampil})`;
    })
    .join(', ');

  const prompt = `Hari ini ada menu rekomendasi berikut: ${daftarMenu}

Buatkan SATU pesan broadcast, MAKSIMAL 2 KALIMAT, yang PERSUASIF, hangat, dan santai (kayak admin resto yang akrab, boleh "monggo mampir" secukupnya, bukan bahasa baku), ajak customer buat mampir/order. Highlight menu di atas tanpa terkesan notifikasi otomatis.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callAiText(prompt, 350);
}

async function generatePesanTotalDanQr(namaCustomer, items, subtotal, nominalTransfer, nomorMeja) {
  const daftarItem = items
    .map((i) => {
      const pilihan = i.pilihan_terpilih ? JSON.parse(i.pilihan_terpilih) : null;
      const infoPilihan = pilihan ? ` [${Object.entries(pilihan).map(([k, v]) => `${k}: ${v}`).join(', ')}]` : '';
      return `${i.nama_snapshot}${infoPilihan} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''} @ ${rp(i.harga_satuan_snapshot)} = ${rp(i.harga_satuan_snapshot * i.qty)}`;
    })
    .join('\n');

  const infoMeja = nomorMeja ? `Meja: ${nomorMeja}` : 'Nomor meja belum diinfokan -- mohon sebutkan juga ya Mas/Mbak.';

  const prompt = `Pesanan ${namaCustomer || 'customer'} sudah fix. Rinciannya:

${daftarItem}

${infoMeja}
Subtotal: ${rp(subtotal)}
Total yang harus dibayar: ${rp(nominalTransfer)} (sama persis dengan total pesanan, tidak ada tambahan apa pun)

Buatkan SATU pesan yang akan menyertai gambar QRIS, isinya:
1. Tampilkan rincian tiap item (nama, qty, harga satuan, subtotal) apa adanya seperti di atas, jangan diringkas atau dihilangkan.
2. Sebut total persis ${rp(nominalTransfer)} dan minta customer input nominal PERSIS segitu (jangan dibulatkan). Jangan menyebut kode unik, karena tidak ada.
3. Kalau nomor meja belum diinfokan, minta disebutkan.
Nada santai, ramah, dan natural seperti chat ke teman (bukan bahasa baku), tapi rinciannya harus akurat dan jelas (jangan ubah angka apapun dari yang diberikan).
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callAiText(prompt, 500);
}

module.exports = {
  callAiText,
  callAiJson,
  prosesUpdateStatusMenu,
  prosesOrderCustomer,
  cocokkanJawabanKlarifikasiMenu,
  cocokkanJawabanPilihan,
  generateKonfirmasiOrderMasukDapur,
  generateBroadcastPromo,
  generatePesanTotalDanQr,
  resolveVarian,
};