require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const { rp, nomorPesanan } = require('./format');
const config = require('./config');
const nota = require('./nota');
const agent = require('./agent');

let sock;

const LOGGER_DIAM = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, fatal() {}, child() { return this; } };

const TIMEOUT_KEPUTUSAN_HABIS_MS = 10 * 60 * 1000; // 10 menit

async function cekTimeoutKeputusanHabis() {
  if (!sock?.user) return; // WA belum/tidak terkoneksi
  const itemPending = db.getItemMenungguKeputusanHabis();
  const sekarang = Date.now();

  for (const item of itemPending) {
    const waktuLapor = new Date(item.habis_dilaporkan_at).getTime();
    if (sekarang - waktuLapor < TIMEOUT_KEPUTUSAN_HABIS_MS) continue;

    // Timeout: auto-batal + refund
    db.setStatusItemPesanan(item.id, 'DIBATALKAN_HABIS');
    db.hitungUlangSubtotalAktif(item.pesanan_id);
    const nominal = config.denganPpn(item.harga_satuan_snapshot * item.qty); // refund termasuk PPN
    db.catatRefund({
      pesanan_id: item.pesanan_id,
      pesanan_item_id: item.id,
      nominal,
      alasan: `${item.nama_snapshot} habis, customer tidak respon dalam 10 menit, auto-dibatalkan`,
    });

    const customer = db.getCustomer(item.customer_jid);
    await kirimPesan(
      item.customer_jid,
      `Karena belum ada balasan, ${item.nama_snapshot} dibatalin otomatis ya Mas/Mbak, uangnya (${rp(nominal)}) dikembalikan tunai di kasir. Maaf banget ya 🙏`
    );

    await agent.kirimKeSemuaKasir(
      { kirimPesan },
      `⏱️ AUTO-BATAL (timeout 10 menit) -- Pesanan #${item.pesanan_id} (meja ${item.nomor_meja || '-'}, ${customer.nama || 'customer'})\nItem: ${item.nama_snapshot}\nRefund: ${rp(nominal)} (termasuk PPN)\n\nMohon proses pengembalian uangnya nggih.`
    );

    console.log(`⏱️  Auto-batal item #${item.id} (${item.nama_snapshot}) karena timeout.`);
  }
}

// Pre-order lunas yang jam datangnya tinggal <= 30 menit dan customer belum sampai: tanya apakah tetap datang.
// Jawaban customer ditangani agent lewat tool jadwal_kedatangan (ya -> mulai masak, tidak -> batal, ubah jam).
async function cekJadwalPreOrder() {
  if (!sock?.user) return;
  for (const p of db.getPreOrderPerluDitanya(30)) {
    const sapa = [p.sapaan, p.nama].filter(Boolean).join(' ') || 'Mas/Mbak';
    const nomor = nomorPesanan(p);
    const pesan = `Halo ${sapa}, pesanan ${nomor} buat jam ${p.jam_datang} nanti ya. Tetap sampai resto tepat waktu? Kalau iya, langsung kami masak biar pas sampai udah siap 🍛`;
    db.setJadwalPesanan(p.id, { jadwalStatus: 'DITANYA' }); // ditandai dulu supaya tidak terkirim dobel kalau kirimPesan lambat
    await kirimPesan(p.customer_jid, pesan);
    db.simpanChatHistory(p.customer_jid, 'assistant', pesan);
    console.log(`⏰ Konfirmasi jadwal ${nomor} dikirim ke ${p.customer_jid} (jam ${p.jam_datang}).`);
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  sock = makeWASocket({
    auth: state,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan QR code ini dengan WhatsApp kamu (Linked Devices):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Koneksi terputus. Reconnect:', shouldReconnect);
      if (shouldReconnect) setTimeout(startBot, 3000);
    } else if (connection === 'open') {
      console.log('\n✅ The Banjoemas terkoneksi ke WhatsApp!\n');
      console.log('Bot siap menerima pesan.\n');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.type !== 'notify') return; // abaikan sinkronisasi histori

    const message = m.messages[0];
    if (!message?.message || message.key.fromMe) return;

    const remoteJidMentah = message.key.remoteJid;
    if (remoteJidMentah && remoteJidMentah.endsWith('@g.us')) {
      console.log(`(Pesan dari grup diabaikan: ${remoteJidMentah})`);
      return;
    }

    const sender = normalizeJid(message);

    // Buka pembungkus (mode pesan sementara / view once)
    const isi = message.message.ephemeralMessage?.message
      || message.message.viewOnceMessage?.message
      || message.message;

    const text = (
      isi.conversation ||
      isi.extendedTextMessage?.text ||
      isi.imageMessage?.caption ||
      isi.videoMessage?.caption ||
      isi.documentMessage?.caption ||
      ''
    ).trim();

    try {
      // Foto dari kasir SELALU diproses sebagai foto QR, juga kalau ada caption ("pesanan 1 nih qr-nya").
      // (Sebelumnya foto bercaption dianggap pesan teks biasa, jadi fotonya tidak pernah diteruskan.)
      if (isi.imageMessage && db.isOperator(sender)) {
        console.log(`\n📎 foto dari kasir ${sender}${text ? ` (caption: "${text}")` : ''}`);
        await handleOperatorMedia(sender, message, isi);
        return;
      }

      if (!text) {
        const media = deteksiJenisMedia(isi);
        if (media) {
          console.log(`\n📎 ${media} masuk dari ${sender}`);
          await handlePesanNonTeks(sender, media);
        }
        // reaksi, protokol, dll: diabaikan diam-diam
        return;
      }

      console.log(`\n📩 Pesan masuk dari ${sender}: "${text}"`);
      await handleIncomingMessage(sender, text);
    } catch (err) {
      console.error('❌ Error memproses pesan:', err.message);
    }
  });

  return sock;
}

function normalizeJid(message) {
  const remoteJid = message.key.remoteJid;
  const altJid = message.key.senderPn || message.key.remoteJidAlt || null;
  if (remoteJid && remoteJid.endsWith('@lid') && altJid) {
    return altJid;
  }
  return remoteJid;
}

function tunggu(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function kirimPesan(jid, text, jedaMsSebelum = 0) {
  if (jedaMsSebelum > 0) await tunggu(jedaMsSebelum);
  return sock.sendMessage(jid, { text });
}

const DATA_MENU_DIR = path.join(__dirname, 'data_menu');

// Kirim satu file gambar by path absolut, aman kalau file tidak ada.
async function kirimGambarJikaAda(jid, filePathAbsolut, caption) {
  if (!filePathAbsolut || !fs.existsSync(filePathAbsolut)) {
    return false;
  }
  try {
    await sock.sendMessage(jid, { image: fs.readFileSync(filePathAbsolut), caption: caption || undefined });
    return true;
  } catch (err) {
    console.error('❌ Gagal kirim gambar:', err.message);
    return false;
  }
}

// Kirim kartu 1 menu spesifik (dipakai saat tanya_detail_menu).
// Fallback: kartu menu -> foto polos menu -> foto kategori -> (tidak ada apa-apa, teks saja).
async function kirimKartuMenu(jid, menu) {
  if (menu.kartu_path) {
    const ok = await kirimGambarJikaAda(jid, path.join(DATA_MENU_DIR, menu.kartu_path));
    if (ok) return 'kartu';
  }
  if (menu.foto_path) {
    const ok = await kirimGambarJikaAda(jid, path.join(DATA_MENU_DIR, menu.foto_path));
    if (ok) return 'foto';
  }
  return 'tidak_ada';
}

// ---------- MENU PER HALAMAN PDF ----------
// Kartu per-MENU (data_menu/kartu) tetap dipakai untuk menu spesifik. Kumpulan menu (kategori / kelompok / semua)
// dikirim sebagai halaman buku menu (data_menu/halaman_menu/pNN.jpg, dibuat oleh ekspor_menu.py),
// dipetakan lewat data_menu/halaman_menu.json. Halaman yang sudah dikirim tidak dikirim ulang dalam satu kunjungan.
const FILE_HALAMAN = () => config.jalurData('halaman_menu.json');
const DIR_HALAMAN = path.join(DATA_MENU_DIR, 'halaman_menu');

function petaHalaman() {
  try { return JSON.parse(fs.readFileSync(FILE_HALAMAN(), 'utf8')); } catch { return null; }
}

const fileHalaman = (n) => path.join(DIR_HALAMAN, `p${String(n).padStart(2, '0')}.jpg`);

// Halaman yang BARU SAJA dikirim (beberapa detik) tidak dikirim dobel dalam satu permintaan (misal gorengan + rebusan
// sama-sama di halaman 3). Permintaan baru dari customer selalu dikirim lagi, supaya dia tidak perlu scroll ke atas.
const JENDELA_DOBEL_MS = 30 * 1000;
const halamanBaruTerkirim = new Map(); // jid -> Map(nomor -> waktu)

// Kirim daftar halaman (nomor). Caption hanya kalau diisi di halaman_menu.json (kosong = tanpa caption).
async function kirimHalamanMenu(jid, daftarHalaman) {
  const peta = petaHalaman();
  const riwayat = halamanBaruTerkirim.get(jid) || new Map();
  const sekarang = Date.now();
  for (const [n, t] of riwayat) if (sekarang - t > JENDELA_DOBEL_MS) riwayat.delete(n);
  halamanBaruTerkirim.set(jid, riwayat);

  let terkirim = 0; let dilewati = 0; let adaFile = false;
  for (const n of daftarHalaman) {
    if (!fs.existsSync(fileHalaman(n))) continue;
    adaFile = true;
    if (riwayat.has(n)) { dilewati++; continue; }
    const caption = peta?.caption_halaman?.[String(n)] || undefined;
    const ok = await kirimGambarJikaAda(jid, fileHalaman(n), caption);
    if (ok) { terkirim++; riwayat.set(n, Date.now()); await tunggu(400); }
  }
  return { terkirim, dilewati, adaFile };
}

// Kirim halaman untuk 1 kategori. Return 'kartu' (terkirim atau sudah pernah), atau 'tidak_ada' kalau tidak ada gambar yang cocok.
async function kirimKartuKategori(jid, kategori) {
  const peta = petaHalaman();
  const halaman = peta?.kategori?.[kategori.id];
  if (halaman && halaman.length > 0) {
    const hasil = await kirimHalamanMenu(jid, halaman);
    if (hasil.adaFile) return 'kartu';
  }
  // Cadangan: kartu kategori lama / foto sampul (kalau halaman PDF belum diekspor)
  if (kategori.kartu_path) {
    const ok = await kirimGambarJikaAda(jid, path.join(DATA_MENU_DIR, kategori.kartu_path));
    if (ok) return 'kartu';
  }
  if (kategori.foto_path) {
    const caption = kategori.foto_ilustrasi ? '(foto ilustrasi)' : undefined;
    const ok = await kirimGambarJikaAda(jid, path.join(DATA_MENU_DIR, kategori.foto_path), caption);
    if (ok) return 'foto';
  }
  return 'tidak_ada';
}

// Minta menu = buku menu LENGKAP sebagai gambar (semua halaman berurutan).
async function kirimSemuaKartuKategori(jid) {
  const peta = petaHalaman();
  if (peta?.buku_menu?.length) {
    halamanBaruTerkirim.delete(jid); // minta menu lengkap = kirim semuanya
    const hasil = await kirimHalamanMenu(jid, peta.buku_menu);
    if (hasil.adaFile) return true;
  }
  console.log('⚠️  Halaman buku menu belum ada, jalankan: python ekspor_menu.py');
  return false;
}

function buatKonteksUntukAgent(jid) {
  return {
    jid,
    kirimPesan,
    kirimQrKeCustomer,
    kirimKartuMenu,
    kirimKartuKategori,
    kirimSemuaKartuKategori,
  };
}

function deteksiJenisMedia(isi) {
  if (isi.imageMessage) return 'gambar';
  if (isi.audioMessage) return 'voice note';
  if (isi.videoMessage) return 'video';
  if (isi.documentMessage) return 'dokumen';
  if (isi.stickerMessage) return 'stiker';
  return null;
}

async function handlePesanNonTeks(jid, jenisMedia) {
  if (db.isOperator(jid)) return;

  if (!db.isCustomerRegistered(jid)) {
    await prosesSambutanCustomerBaru(jid, { kirimSapaan: true });
    return;
  }
  if (jenisMedia === 'stiker') return;

  const catatanUser = `[customer mengirim ${jenisMedia}]`;

  if (db.getStatusCs(jid) === 'ESKALASI') {
    db.simpanChatHistory(jid, 'user', catatanUser);
    return;
  }

  const pesanan = db.getDraftAtauMenungguBayarByCustomer(jid);
  const customer = db.getCustomer(jid);
  let balasan;

  if (pesanan && pesanan.status === 'MENUNGGU_BAYAR') {
    // Kemungkinan bukti transfer: teruskan info ke semua kasir (kasir yang memastikan di EDC/mutasi)
    const infoMeja = customer.nomor_meja ? ` (meja ${customer.nomor_meja})` : '';
    await agent.kirimKeSemuaKasir(
      { kirimPesan },
      `ℹ️ ${customer.nama || jid.split('@')[0]}${infoMeja} mengirim ${jenisMedia}, kemungkinan bukti transfer untuk pesanan ${nomorPesanan(pesanan)}. Mohon dicek manual nggih.`
    );
    balasan = 'Makasih Mas/Mbak, aku teruskan ke kasir buat dicek ya. Pesanan langsung jalan begitu pembayarannya terkonfirmasi 🙏';
  } else {
    balasan = 'Maaf ya Mas/Mbak, aku baru bisa baca pesan teks. Boleh ditulis aja pesannya?';
  }

  await kirimPesan(jid, balasan);
  db.simpanChatHistory(jid, 'user', catatanUser);
  db.simpanChatHistory(jid, 'assistant', balasan);
}

async function handleIncomingMessage(jid, text) {
  if (db.isOperator(jid)) {
    await handleOperatorMessage(jid, text);
  } else {
    await handleCustomerMessage(jid, text);
  }
}

async function handleCustomerMessage(jid, text) {
  const sudahTerdaftar = db.isCustomerRegistered(jid);

  if (!sudahTerdaftar) {
    await prosesSambutanCustomerBaru(jid);
    // Lanjut proses pesan pertama ini juga lewat agent (misal langsung "mau pesan mendoan 2")
  }

  await routeCustomerTerdaftar(jid, text);
}

// Customer baru: cukup didaftarkan. Sapaan "Sugeng rawuh" + pertanyaan "makan berat atau nyemil dulu"
// dibuat oleh agent di balasan pertamanya (lihat buatKonteksDinamisCustomer), dan menu TIDAK dikirim
// semua sekaligus, tapi per fase (alur 3 fase).
// kirimSapaan=true dipakai kalau pesan pertama bukan teks (agent tidak jalan), jadi sapaan dikirim di sini.
async function prosesSambutanCustomerBaru(jid, { kirimSapaan = false } = {}) {
  db.registerCustomer(jid);
  db.setLayanan(jid, { rencana: 'SEKARANG' }); // chat pertama = sudah duduk di meja (default), tidak perlu ditanya

  if (kirimSapaan) {
    const sapaan = `Sugeng rawuh di The Banjoemas Resto & Cafe, Mas/Mbak. Aku ${config.namaAi()} 🙏 Mau lihat menu dulu, atau langsung pesan?`;
    await kirimPesan(jid, sapaan);
    db.simpanChatHistory(jid, 'assistant', sapaan);
  }

  console.log(`✅ Customer baru terdaftar: ${jid}`);
}

async function routeCustomerTerdaftar(jid, text) {
  if (db.getStatusCs(jid) === 'ESKALASI') {
    db.simpanChatHistory(jid, 'user', text);
    console.log(`(Customer ${jid} sedang status ESKALASI, bot tidak membalas.)`);
    return;
  }

  const historiChat = db.getChatHistory(jid);
  const konteks = buatKonteksUntukAgent(jid);

  // Default: customer sudah di resto. Kunjungan baru (state direset) tidak perlu ditanya lagi "di mana".
  // Kalau dia bilang akan datang jam sekian, AI mengubahnya lewat atur_layanan.
  db.getAlur(jid); // reset state kemarin dulu
  if (!db.getCustomer(jid).rencana_datang) db.setLayanan(jid, { rencana: 'SEKARANG' });

  // Rating pelayanan dan kuis dijawab KODE (angka "1-5" / nomor pilihan kuis), tanpa AI
  const cepat = await agent.tangkapRatingDanKuis(jid, text, konteks);
  if (cepat) {
    await kirimPesan(jid, cepat);
    db.simpanChatHistory(jid, 'user', text);
    db.simpanChatHistory(jid, 'assistant', cepat);
    return;
  }

  // Jawaban "dipanggil apa" (Mas/Mbak) disimpan oleh kode, tidak menunggu AI memanggil tool
  agent.tangkapJawabanSapaan(jid, text, historiChat);
  await agent.tangkapJawabanKedatangan(jid, text, historiChat);

  const hasil = await agent.jalankanAgent({
    systemPrompt: agent.SYSTEM_PROMPT_CUSTOMER + agent.buatBlokInfoResto() + agent.buatKonteksDinamisCustomer(jid),
    tools: agent.TOOLS_CUSTOMER,
    historiChat,
    pesanBaru: text,
    eksekutorTools: agent.EKSEKUTOR_CUSTOMER,
    konteks,
  });

  db.simpanChatHistory(jid, 'user', text);

  if (hasil.error) {
    console.error('❌ Agent error (customer):', hasil.error);
    await kirimPesan(jid, hasil.jawabanFinal || 'Maaf ya, lagi ada kendala. Boleh diulang?');
    return;
  }

  if (hasil.jawabanFinal) {
    const balasan = agent.rapikanBalasanCustomer(jid, hasil.jawabanFinal, {
      pertama: historiChat.length === 0,
      rincianDitampilkan: (hasil.toolBerhasil || []).includes('tampilkan_rincian_order'),
      sudahDilayani: (hasil.toolBerhasil || []).some((t) => ['lihat_menu', 'buat_order', 'rekomendasi_menu', 'cari_menu_atribut', 'tanya_detail_menu'].includes(t)),
    });
    await kirimPesan(jid, balasan);
    db.simpanChatHistory(jid, 'assistant', balasan);
  } else if (!(hasil.toolBerhasil || []).length) {
    // AI tidak menjawab dan tidak ada tindakan: jangan diam. Tanya balik dengan pilihan bernomor.
    const tanya = 'Maaf, aku kurang nangkep maksudnya. Mau yang mana nih?\n1. Lihat menu\n2. Pesan makanan/minuman\n3. Info resto (jam buka, live music, booking)\n4. Panggil waiter';
    await kirimPesan(jid, tanya);
    db.simpanChatHistory(jid, 'assistant', tanya);
  }

  // Pesan tambahan dari sistem (misal tawaran kuis) dikirim SETELAH balasan AI sebagai pesan terpisah
  const tambahan = db.getPendingState(jid, 'tambahan_balasan');
  if (tambahan) {
    db.clearPendingState(jid, 'tambahan_balasan');
    await tunggu(600);
    await kirimPesan(jid, tambahan);
    db.simpanChatHistory(jid, 'assistant', tambahan);
  }
}

async function handleOperatorMessage(jid, text) {
  // Kasir menjawab "foto QR ini untuk yang mana?" -> kode yang meneruskan, tanpa AI
  if (await tangkapJawabanFotoQr(jid, text)) {
    db.simpanChatHistory(jid, 'user', text);
    return;
  }

  const historiChat = db.getChatHistory(jid);
  const konteks = buatKonteksUntukAgent(jid);

  const hasil = await agent.jalankanAgent({
    systemPrompt: agent.SYSTEM_PROMPT_OPERATOR,
    tools: agent.TOOLS_OPERATOR,
    historiChat,
    pesanBaru: text,
    eksekutorTools: agent.EKSEKUTOR_OPERATOR,
    konteks,
  });

  db.simpanChatHistory(jid, 'user', text);

  if (hasil.error) {
    console.error('❌ Agent error (operator):', hasil.error);
    await kirimPesan(jid, hasil.jawabanFinal || 'Maaf, ada kendala. Coba lagi ya.');
    return;
  }

  if (hasil.jawabanFinal) {
    await kirimPesan(jid, hasil.jawabanFinal);
    db.simpanChatHistory(jid, 'assistant', hasil.jawabanFinal);
  }
}

// ========== QR DINAMIS: kasir membuat QR per pesanan di POS, memfoto, lalu mengirim fotonya ke bot ==========
const DIR_QR_MASUK = path.join(__dirname, 'images', 'qr_masuk');

// Caption yang menyertai foto QR ke customer. Dibuat KODE (bukan AI) supaya angkanya selalu sama dengan nota.
function captionQr(p) {
  if (p.jenis === 'PESANAN') {
    const pesanan = db.getPesananById(p.ref_ids[0]);
    const customer = db.getCustomer(p.customer_jid);
    const items = db.getItemsByPesananId(pesanan.id);
    const preOrder = !!pesanan.jam_datang && customer.status_kedatangan !== 'DI_RESTO';
    let lokasi = '';
    if (preOrder) lokasi = ` (datang jam ${pesanan.jam_datang})`;
    else if (pesanan.nomor_meja) lokasi = ` (meja ${pesanan.nomor_meja})`;
    return [
      `Pesanan ${nomorPesanan(pesanan)}${lokasi}:`,
      ...nota.barisItem(items),
      ...nota.barisTotal(nota.hitungDariItem(items)),
      `Scan QR ini ya, bayar persis ${rp(p.nominal)} 🙏`,
      preOrder ? `Nanti di resto, lapor ke waiter sebut nomor pesanan ${nomorPesanan(pesanan)} ya.` : '',
    ].filter(Boolean).join('\n');
  }
  if (p.jenis === 'BILL') {
    const daftar = p.ref_ids.map((id) => db.getPesananById(id)).filter(Boolean);
    const { teks, total } = nota.teksNotaGabungan(daftar);
    return `${p.label}:\n${teks}\nScan QR ini ya, bayar persis ${rp(total.grandTotal)} 🙏`;
  }
  if (p.jenis === 'TAGIHAN') {
    const t = db.getTagihanById(p.ref_ids[0]);
    const pesanan = db.getPesananById(t.pesanan_id);
    return `Kekurangan bayar untuk pesanan ${nomorPesanan(pesanan)}: ${rp(p.nominal)} (sudah termasuk PPN).\nScan QR ini ya, bayar persis ${rp(p.nominal)} 🙏`;
  }
  if (p.jenis === 'DEPOSIT') {
    const b = db.getBooking(p.ref_ids[0]);
    return `Deposit booking #${b.id} (${b.tanggal} jam ${b.jam}): ${rp(p.nominal)}.\nScan QR ini ya, bayar persis ${rp(p.nominal)} 🙏`;
  }
  return `Scan QR ini ya, bayar persis ${rp(p.nominal)} 🙏`;
}

// Kirim foto QR yang sudah disimpan kasir ke customer pemesan
async function kirimQrKeCustomer(permintaanId) {
  const p = db.getPermintaanQr(permintaanId);
  if (!p || !p.qr_path || !fs.existsSync(p.qr_path)) {
    console.log(`⚠️  Foto QR permintaan #${permintaanId} tidak ditemukan.`);
    return false;
  }
  try {
    await sock.sendMessage(p.customer_jid, { image: fs.readFileSync(p.qr_path), caption: captionQr(p) });
    console.log(`✅ QR ${p.label} (${rp(p.nominal)}) terkirim ke ${p.customer_jid}`);
    return true;
  } catch (err) {
    console.error('❌ Gagal kirim QR:', err.message);
    return false;
  }
}

function mejaPermintaan(p) {
  if (p.jenis === 'DEPOSIT') return null;
  const c = db.getCustomer(p.customer_jid);
  const dariPesanan = p.jenis === 'TAGIHAN' ? null : db.getPesananById(p.ref_ids[0])?.nomor_meja;
  return db.normalisasiMeja(c.nomor_meja) || db.normalisasiMeja(dariPesanan);
}

// Mencari permintaan dari teks caption kasir: "pesanan 7", "#7", "meja 5", "booking 3", atau angka saja
function permintaanDariTeks(teks) {
  const t = String(teks || '').toLowerCase();
  const menunggu = db.getPermintaanQrMenunggu();
  if (menunggu.length === 0) return { daftar: [], dicari: false };

  const booking = t.match(/booking\s*#?\s*(\d+)/);
  if (booking) return { daftar: menunggu.filter((p) => p.jenis === 'DEPOSIT' && p.ref_ids.includes(Number(booking[1]))), dicari: true };

  const meja = t.match(/meja\s*([a-z]{0,4}\d{1,3}[a-z]?)/);
  if (meja) {
    const m = db.normalisasiMeja(meja[1]);
    return { daftar: menunggu.filter((p) => mejaPermintaan(p) === m), dicari: true };
  }

  const nomor = t.match(/(?:pesanan|pes|order|#|no\.?|nomor)\s*#?\s*(\d{1,4})/) || t.match(/^\s*#?(\d{1,4})\s*$/);
  if (nomor) {
    const n = Number(nomor[1]);
    return {
      daftar: menunggu.filter((p) => ['PESANAN', 'BILL'].includes(p.jenis) && p.ref_ids.some((id) => db.getPesananById(id)?.no_harian === n)),
      dicari: true,
    };
  }
  return { daftar: [], dicari: false };
}

const deskripsiPermintaan = (p) => `${p.label} | ${agent.sebutCustomer(db.getCustomer(p.customer_jid), p.customer_jid)} | ${rp(p.nominal)}`;

// Simpan foto di permintaan, teruskan ke customer, kabari semua kasir. Gagal kirim = permintaan kembali menunggu.
async function teruskanQrKeCustomer(permintaan, qrPath) {
  db.setPermintaanQrTerkirim(permintaan.id, qrPath);
  const ok = await kirimQrKeCustomer(permintaan.id);
  if (!ok) db.db.prepare(`UPDATE permintaan_qr SET status = 'MENUNGGU' WHERE id = ?`).run(permintaan.id);
  const info = ok
    ? `✅ QR ${deskripsiPermintaan(permintaan)} sudah diteruskan ke customer.`
    : `❌ QR ${permintaan.label} gagal diteruskan ke customer. Coba kirim lagi fotonya.`;
  await agent.kirimKeSemuaKasir({ kirimPesan }, info);
  return ok;
}

// Ambigu: simpan foto, tanya kasir dengan pilihan bernomor. Jawabannya ditangkap di tangkapJawabanFotoQr.
async function tanyaPermintaan(jid, qrPath, daftar, kalimat) {
  db.setPendingState(jid, 'qr_foto', { qrPath, ids: daftar.map((p) => p.id) });
  await kirimPesan(jid, `${kalimat}\n${daftar.map((p, n) => `${n + 1}. ${deskripsiPermintaan(p)}`).join('\n')}\nBalas nomornya ya.`);
}

// Kasir mengirim foto. Penentuan pesanan: (1) reply ke tiket, (2) caption, (3) satu-satunya yang menunggu. Kalau ambigu, TANYA.
async function handleOperatorMedia(jid, message, isi) {
  const gambar = isi.imageMessage;
  if (!gambar) return;

  let buffer;
  try {
    buffer = await downloadMediaMessage(message, 'buffer', {}, { logger: LOGGER_DIAM, reuploadRequest: sock.updateMediaMessage });
  } catch (err) {
    console.error('❌ Gagal mengunduh foto kasir:', err.message);
    await kirimPesan(jid, 'Fotonya gagal terunduh, boleh kirim ulang ya.');
    return;
  }
  fs.mkdirSync(DIR_QR_MASUK, { recursive: true });
  const qrPath = path.join(DIR_QR_MASUK, `qr_${Date.now()}.jpg`);
  fs.writeFileSync(qrPath, buffer);

  const caption = (gambar.caption || '').trim();
  const stanzaId = gambar.contextInfo?.stanzaId;
  let target = stanzaId ? db.getPermintaanDariTiket(stanzaId) : null;
  if (target && target.status !== 'MENUNGGU') {
    const alasan = target.status === 'BATAL' ? 'sudah DIBATALKAN (pesanan berubah)' : 'sudah pernah diproses';
    await kirimPesan(jid, `Tiket ${target.label} ${alasan}, jadi fotonya tidak diteruskan. Kalau tetap perlu, tulis nomor pesanan di caption.`);
    return;
  }

  if (!target) {
    const { daftar, dicari } = permintaanDariTeks(caption);
    if (daftar.length === 1) {
      target = daftar[0];
    } else if (daftar.length > 1) {
      await tanyaPermintaan(jid, qrPath, daftar, 'Ada beberapa yang cocok, foto QR ini untuk yang mana?');
      return;
    } else if (dicari) {
      await kirimPesan(jid, `Tidak ada permintaan QR yang menunggu untuk "${caption}". Cek nomornya ya.`);
      return;
    }
  }

  if (!target) {
    const menunggu = db.getPermintaanQrMenunggu();
    if (menunggu.length === 0) {
      await kirimPesan(jid, 'Tidak ada permintaan QR yang sedang menunggu. Kalau ini untuk pesanan tertentu, tulis nomor pesanannya di caption.');
      return;
    }
    if (menunggu.length > 1) {
      await tanyaPermintaan(jid, qrPath, menunggu, 'Foto QR ini untuk yang mana?');
      return;
    }
    target = menunggu[0];
  }

  await teruskanQrKeCustomer(target, qrPath);
}

// Jawaban kasir atas pertanyaan "untuk yang mana" ("1", "2", atau nomor pesanan). Mengembalikan true kalau ditangani.
async function tangkapJawabanFotoQr(jid, text) {
  const pending = db.getPendingState(jid, 'qr_foto');
  if (!pending) return false;
  const t = String(text || '').trim().toLowerCase();
  const kandidat = pending.ids.map((id) => db.getPermintaanQr(id)).filter((p) => p && p.status === 'MENUNGGU');
  if (kandidat.length === 0) { db.clearPendingState(jid, 'qr_foto'); return false; }

  let target = null;
  const angka = t.match(/^(?:nomor |no |pilihan )?(\d{1,2})$/);
  if (angka && kandidat[Number(angka[1]) - 1]) target = kandidat[Number(angka[1]) - 1];
  if (!target) {
    const { daftar } = permintaanDariTeks(t);
    const cocok = daftar.filter((p) => kandidat.some((k) => k.id === p.id));
    if (cocok.length === 1) target = cocok[0];
  }
  if (!target) {
    if (/^(batal|skip|nggak|gak|tidak)\b/.test(t)) {
      db.clearPendingState(jid, 'qr_foto');
      await kirimPesan(jid, 'Oke, fotonya tidak diteruskan.');
      return true;
    }
    return false; // bukan jawaban pertanyaan, biarkan agent menangani
  }
  db.clearPendingState(jid, 'qr_foto');
  await teruskanQrKeCustomer(target, pending.qrPath);
  return true;
}

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection (bot tetap jalan):', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception (bot tetap jalan):', err.message);
});

function printHelp() {
  console.log('\nCommand yang bisa dipakai di terminal ini:');
  console.log('  hapuspesanan <id>      -> hapus 1 pesanan beserta itemnya. Contoh: hapuspesanan 12');
  console.log('  hapussemuapesanan      -> hapus SEMUA pesanan (reset total, hati-hati!)');
  console.log('  help                   -> tampilkan daftar command ini lagi\n');
}

process.stdin.on('data', (data) => {
  const input = data.toString().trim();
  const inputLower = input.toLowerCase();

  if (inputLower.startsWith('hapuspesanan ')) {
    const parts = input.split(' ');
    const pesananId = parseInt(parts[1]);
    if (!pesananId) {
      console.log('Format salah. Contoh: hapuspesanan 12');
      return;
    }
    const berhasil = db.hapusPesanan(pesananId);
    console.log(berhasil ? `✅ Pesanan #${pesananId} dihapus.` : `❌ Pesanan #${pesananId} tidak ditemukan.`);
    return;
  }

  if (inputLower === 'hapussemuapesanan') {
    const jumlah = db.hapusSemuaPesanan();
    console.log(`✅ ${jumlah} pesanan dihapus (reset total).`);
    return;
  }

  if (inputLower === 'help') {
    printHelp();
  } else if (input) {
    console.log(`Command "${input}" tidak dikenali. Ketik "help" untuk lihat daftar command.`);
  }
});

// Timer didaftarkan SEKALI di luar startBot, supaya tidak menumpuk tiap reconnect
// Permintaan QR yang belum dijawab kasir: ingatkan (3 menit pertama, lalu tiap 5 menit, maksimal 4 kali)
async function cekPengingatQr() {
  if (!sock?.user) return;
  const batasMenit = Number(config.info().pengingat_qr_menit || 3);
  for (const p of db.getPermintaanQrMenunggu()) {
    if (p.pengingat >= 4) continue;
    const acuan = p.pengingat_at || p.created_at.replace(' ', 'T') + 'Z';
    const selang = Date.now() - new Date(acuan).getTime();
    if (selang < (p.pengingat === 0 ? batasMenit : 5) * 60 * 1000) continue;
    db.catatPengingatQr(p.id);
    await agent.kirimKeSemuaKasir({ kirimPesan }, `⏳ Customer masih menunggu QR ${deskripsiPermintaan(p)}. Kirim foto QR-nya ke sini sebagai reply tiket MINTA QR ya.`);
  }
}

// Meja yang belum kosong setelah 3 jam sejak pesanan pertama: tanya semua kasir "sudah kosong?". Diulang tiap 30 menit.
async function cekTimeoutMeja() {
  if (!sock?.user) return;
  const batasJam = Number(config.info().timeout_meja_jam || 3);
  for (const k of db.getKunjunganPerluDitanya(batasJam)) {
    const c = db.getCustomer(k.customer_jid);
    const meja = k.nomor_meja || c.nomor_meja || '-';
    const lama = Math.floor((Date.now() - new Date(k.mulai_at).getTime()) / 3600000);
    db.updateKunjungan(k.id, { ditanya_kasir_at: new Date().toISOString(), jumlah_ditanya: k.jumlah_ditanya + 1 });
    await agent.kirimKeSemuaKasir(
      { kirimPesan },
      `⏰ Meja ${meja} (${agent.sebutCustomer(c, k.customer_jid)}) sudah ${lama} jam. Sudah kosong? Kalau sudah, balas "meja ${meja} kosong" ya.`
    );
  }
}

setInterval(() => {
  cekTimeoutKeputusanHabis().catch((err) => console.error('❌ Error cek timeout:', err.message));
  cekJadwalPreOrder().catch((err) => console.error('❌ Error cek jadwal pre-order:', err.message));
  cekPengingatQr().catch((err) => console.error('❌ Error cek pengingat QR:', err.message));
  cekTimeoutMeja().catch((err) => console.error('❌ Error cek timeout meja:', err.message));
}, 60 * 1000);

if (!db.getInfoResto('aturan_layanan')) {
  console.log('⚠️  info_resto kosong. Jalankan "node seed.js" supaya aturan layanan dan catatan alergen masuk ke prompt.');
}

startBot();
// Dipakai skrip uji (require dari luar). Saat dijalankan langsung (node index.js) tidak ada efeknya.
if (require.main !== module) {
  module.exports = {
    handleOperatorMedia, handleOperatorMessage, tangkapJawabanFotoQr, permintaanDariTeks, kirimQrKeCustomer,
    cekPengingatQr, cekTimeoutMeja, kirimKartuKategori, kirimSemuaKartuKategori, routeCustomerTerdaftar, captionQr,
  };
}
