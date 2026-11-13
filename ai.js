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
- Panggil customer "Mas" atau "Mbak".
- Singkat, padat, langsung ke poin.

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

/**
 * Fungsi utama: proses 1 pesan list menu penuh dari kasir.
 */
async function prosesListMenuOperator(pesanMentah) {
  const itemMentah = await ekstrakListMenuMentah(pesanMentah);

  const ringkasan = {
    diupdate: [],
    baru: [],
    habis: [],
    totalDiproses: itemMentah.length,
  };

  for (const item of itemMentah) {
    if (!item.nama) continue;

    const matchResult = cariKandidatMenu(item.nama);
    let namaFinal = item.nama;

    if (matchResult.statusMatch === 'YAKIN') {
      namaFinal = matchResult.kandidatTerbaik.nama;
    } else if (matchResult.statusMatch === 'AMBIGU') {
      const keputusan = await putuskanMenuAmbigu(item.nama, matchResult.kandidatTerbaik, matchResult.kandidatKedua);
      if (keputusan !== 'BARU') {
        namaFinal = keputusan;
      }
    }

    const menuSebelumnya = cariKandidatMenu(namaFinal).kandidatTerbaik;
    const statusBaru = item.habis ? 'habis' : 'tersedia';

    upsertMenu({
      nama: namaFinal,
      kategori: item.kategori,
      deskripsi: item.deskripsi,
      harga: item.habis ? (menuSebelumnya?.harga ?? null) : item.harga,
      status: statusBaru,
    });

    if (item.habis) {
      ringkasan.habis.push(namaFinal);
    } else if (!menuSebelumnya || matchResult.statusMatch === 'TIDAK_ADA') {
      ringkasan.baru.push(namaFinal);
    } else {
      ringkasan.diupdate.push(namaFinal);
    }
  }

  return ringkasan;
}

/**
 * Parse pesan order customer jadi array {nama, qty, catatan}.
 */
async function ekstrakOrderCustomer(pesanCustomer) {
  const systemJson = `Kamu adalah parser teks pesanan makanan/minuman resto dari pelanggan. Jawab HANYA dengan JSON valid array, tanpa markdown fence.`;

  const userPrompt = `Pelanggan menulis pesan order ini:

"${pesanCustomer}"

Ekstrak semua menu yang disebutkan beserta jumlahnya. Kalau tidak disebutkan jumlah, asumsikan 1. Kalau ada catatan khusus per item (misal "pedesnya dikit", "tanpa bawang", "less sugar"), catat di field "catatan".

Abaikan kata-kata basa-basi seperti "dong", "ya", "mau pesan", dll -- fokus cuma nama menu + jumlah + catatan.

Kalau pesan ini sama sekali TIDAK berisi order menu (misal cuma chat biasa/pertanyaan/sapaan), balas array kosong [].

Balas JSON array, format tiap elemen:
{"nama": "...", "qty": angka, "catatan": "..." atau null}`;

  const hasil = await callAiJson(systemJson, userPrompt, 1000);
  if (!hasil || !Array.isArray(hasil)) return [];
  return hasil;
}

/**
 * Proses order customer, match tiap item ke menu di DB.
 * Return: { items: [...], tidakDikenali: [...], perluKlarifikasi: [...] }
 */
async function prosesOrderCustomer(pesanCustomer) {
  const itemMentah = await ekstrakOrderCustomer(pesanCustomer);

  const hasil = { items: [], tidakDikenali: [], perluKlarifikasi: [] };

  for (const item of itemMentah) {
    if (!item.nama) continue;

    const matchResult = cariKandidatMenu(item.nama);

    if (matchResult.statusMatch === 'YAKIN') {
      hasil.items.push({
        menu: matchResult.kandidatTerbaik,
        namaInput: item.nama,
        qty: item.qty || 1,
        catatan: item.catatan || null,
      });
    } else if (matchResult.statusMatch === 'AMBIGU_MULTI') {
      hasil.perluKlarifikasi.push({
        namaInput: item.nama,
        qty: item.qty || 1,
        catatan: item.catatan || null,
        kandidatList: matchResult.kandidatList,
      });
    } else if (matchResult.statusMatch === 'AMBIGU') {
      const keputusan = await putuskanMenuAmbigu(item.nama, matchResult.kandidatTerbaik, matchResult.kandidatKedua);
      if (keputusan !== 'BARU') {
        const menuFinal = [matchResult.kandidatTerbaik, matchResult.kandidatKedua]
          .find((m) => m && m.nama === keputusan);
        hasil.items.push({
          menu: menuFinal || matchResult.kandidatTerbaik,
          namaInput: item.nama,
          qty: item.qty || 1,
          catatan: item.catatan || null,
        });
      } else {
        hasil.tidakDikenali.push(item.nama);
      }
    } else {
      hasil.tidakDikenali.push(item.nama);
    }
  }

  return hasil;
}

/**
 * Dipanggil setelah kasir konfirmasi_bayar -> kabari customer pesanan masuk dapur.
 */
async function generateKonfirmasiOrderMasukDapur(namaCustomer, items, nomorMeja) {
  const daftarItem = items.map((i) => `${i.nama_snapshot} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''}`).join(', ');
  const infoMeja = nomorMeja ? ` untuk meja ${nomorMeja}` : '';

  const prompt = `Pembayaran dari ${namaCustomer || 'customer'} baru saja dikonfirmasi lunas oleh kasir${infoMeja}. Pesanannya: ${daftarItem}.

Buatkan SATU pesan singkat (maksimal 2 kalimat) mengabarkan bahwa pembayaran sudah diterima dan pesanan langsung diteruskan ke dapur. Nada hangat, berterima kasih, nuansa khas resto Jawa secukupnya (boleh "matur nuwun"/"nggih" tapi jangan berlebihan).
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callAiText(prompt, 250);
}

/**
 * Dipanggil setelah kasir update_menu & konfirmasi broadcast (kalau mau dipakai alurnya).
 */
async function generateRingkasanUpdateMenu(ringkasan) {
  const prompt = `Barusan selesai update data menu dari list yang dikirim kasir. Hasilnya:
- Total ${ringkasan.totalDiproses} item diproses
- Menu baru ditambahkan: ${ringkasan.baru.length > 0 ? ringkasan.baru.join(', ') : 'tidak ada'}
- Menu yang diupdate: ${ringkasan.diupdate.length} item
- Menu habis/tidak tersedia: ${ringkasan.habis.length > 0 ? ringkasan.habis.join(', ') : 'tidak ada'}

Buatkan SATU pesan singkat (maksimal 2 kalimat) ke KASIR yang merangkum hasil ini dengan jelas. Ini pesan ke rekan kerja, boleh langsung/teknis, tidak perlu gaya persuasif jualan.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callAiText(prompt, 400);
}

/**
 * Dipanggil kasir minta broadcast promo.
 */
async function generateBroadcastPromo(menuMenarik) {
  const daftarMenu = menuMenarik.map((m) => `${m.nama}: Rp${m.harga}`).join(', ');

  const prompt = `Hari ini ada menu rekomendasi berikut: ${daftarMenu}

Buatkan SATU pesan broadcast singkat (maksimal 2-3 kalimat) yang PERSUASIF dan hangat, gaya admin resto Jawa yang ramah (boleh ada "monggo mampir" atau sejenisnya secukupnya), ajak customer buat mampir/order. Highlight menu di atas tanpa terkesan notifikasi otomatis.
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callAiText(prompt, 350);
}

async function generatePesanTotalDanQr(namaCustomer, items, subtotal, nominalTransfer, nomorMeja) {
  const daftarItem = items
    .map((i) => `${i.nama_snapshot} x${i.qty}${i.catatan ? ` (${i.catatan})` : ''} @ Rp${i.harga_satuan_snapshot} = Rp${i.harga_satuan_snapshot * i.qty}`)
    .join('\n');

  const infoMeja = nomorMeja ? `Meja: ${nomorMeja}` : 'Nomor meja belum diinfokan -- mohon sebutkan juga ya Mas/Mbak.';

  const prompt = `Pesanan ${namaCustomer || 'customer'} sudah fix. Rinciannya:

${daftarItem}

${infoMeja}
Subtotal: Rp${subtotal}
Total transfer: Rp${nominalTransfer} (digit terakhir itu kode unik transaksi, bukan typo -- jelaskan ini ke customer)

Buatkan SATU pesan yang akan menyertai gambar QRIS, isinya:
1. Tampilkan rincian tiap item (nama, qty, harga satuan, subtotal) apa adanya seperti di atas, jangan diringkas atau dihilangkan.
2. Sebut total transfer persis Rp${nominalTransfer} dan minta customer input nominal PERSIS segitu (jangan dibulatkan), jelaskan kode unik di digit terakhir biar gampang dicek dari pihak kami.
3. Kalau nomor meja belum diinfokan, minta disebutkan.
Nada tetap ramah, natural, nuansa resto Jawa secukupnya, tapi rinciannya harus akurat (jangan ubah angka apapun dari yang diberikan).
Balas HANYA dengan isi pesannya saja, tanpa tanda kutip.`;

  return await callAiText(prompt, 500);
}

module.exports = {
  callAiText,
  callAiJson,
  prosesListMenuOperator,
  generateRingkasanUpdateMenu,
  prosesOrderCustomer,
  cocokkanJawabanKlarifikasiMenu,
  generateKonfirmasiOrderMasukDapur,
  generateBroadcastPromo,
  generatePesanTotalDanQr,
};