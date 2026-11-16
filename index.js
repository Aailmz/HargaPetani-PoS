require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const ai = require('./ai');
const agent = require('./agent');

let sock;

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
    const nominal = item.harga_satuan_snapshot * item.qty;
    db.catatRefund({
      pesanan_id: item.pesanan_id,
      pesanan_item_id: item.id,
      nominal,
      alasan: `${item.nama_snapshot} habis, customer tidak respon dalam 10 menit, auto-dibatalkan`,
    });

    const customer = db.getCustomer(item.customer_jid);
    await kirimPesan(
      item.customer_jid,
      `Karena belum ada balasan, ${item.nama_snapshot} dibatalin otomatis ya Mas/Mbak, uangnya (Rp${nominal}) bakal dikembalikan. Maaf banget ya 🙏`
    );

    const operatorUtama = db.getAllOperators().find((o) => o.is_utama === 1);
    if (operatorUtama) {
      await kirimPesan(
        operatorUtama.jid,
        `⏱️ AUTO-BATAL (timeout 10 menit) -- Pesanan #${item.pesanan_id} (meja ${item.nomor_meja || '-'}, ${customer.nama || 'customer'})\nItem: ${item.nama_snapshot}\nRefund: Rp${nominal}\n\nMohon proses pengembalian uangnya nggih.`
      );
    }

    console.log(`⏱️  Auto-batal item #${item.id} (${item.nama_snapshot}) karena timeout.`);
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

// Kirim kartu 1 kategori (dipakai saat lihat_menu dengan kategori spesifik).
async function kirimKartuKategori(jid, kategori) {
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

// Kirim semua kartu kategori sekaligus (dipakai saat sambutan customer baru / minta lihat semua menu).
async function kirimSemuaKartuKategori(jid) {
  const semuaKategori = db.getAllKategori();
  if (semuaKategori.length === 0) {
    console.log('⚠️  Tidak ada kategori di database, jalankan seed.js dulu.');
    return false;
  }
  let adaYangTerkirim = false;
  for (const kat of semuaKategori) {
    const hasil = await kirimKartuKategori(jid, kat);
    if (hasil !== 'tidak_ada') adaYangTerkirim = true;
    await tunggu(400); // jeda kecil antar file biar urutannya rapi di WA
  }
  return adaYangTerkirim;
}

function buatKonteksUntukAgent(jid) {
  return {
    jid,
    kirimPesan,
    kirimQrKeCustomer,
    kirimKartuMenu,
    kirimKartuKategori,
    kirimSemuaKartuKategori,
    kirimQrKekuranganKeCustomer,
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
    // Kemungkinan bukti transfer: teruskan info ke kasir (kasir yang memastikan di EDC/mutasi)
    const operatorUtama = db.getAllOperators().find((o) => o.is_utama === 1);
    if (operatorUtama) {
      const infoMeja = customer.nomor_meja ? ` (meja ${customer.nomor_meja})` : '';
      await kirimPesan(
        operatorUtama.jid,
        `ℹ️ ${customer.nama || jid.split('@')[0]}${infoMeja} mengirim ${jenisMedia}, kemungkinan bukti transfer untuk pesanan #${pesanan.id}. Mohon dicek manual nggih.`
      );
    }
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

  if (kirimSapaan) {
    const sapaan = 'Sugeng rawuh di The Banjoemas Resto & Cafe 🙏 Mau mulai dari makan berat, atau nyemil dulu nih, Mas/Mbak?';
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
    await kirimPesan(jid, hasil.jawabanFinal);
    db.simpanChatHistory(jid, 'assistant', hasil.jawabanFinal);
  }
}

async function handleOperatorMessage(jid, text) {
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

async function kirimQrKeCustomer(pesananId, nominalTransfer) {
  const pesanan = db.getPesananById(pesananId);
  const customer = db.getCustomer(pesanan.customer_jid);
  const items = db.getItemsByPesananId(pesananId);

  const pesanTotal = await ai.generatePesanTotalDanQr(
    customer.nama,
    items,
    pesanan.subtotal,
    nominalTransfer,
    pesanan.nomor_meja
  );

  const qrPath = path.join(__dirname, 'images', 'qr', 'qris-statis.jpg');

  if (!fs.existsSync(qrPath)) {
    console.log('⚠️  File QR statis tidak ditemukan di images/qr/qris-statis.jpg');
    await kirimPesan(
        customer.jid,
        `${pesanTotal || `Total pesanan Mas/Mbak adalah Rp${nominalTransfer}.`}\n\n(QR belum tersedia, mohon hubungi kasir untuk info rekening/QR manual)`
    );
    return false;
  }

  try {
    await sock.sendMessage(customer.jid, {
      image: fs.readFileSync(qrPath),
      caption: pesanTotal || `Totalnya Rp${nominalTransfer}. Scan QR ini ya, bayar persis segitu.`,
    });
    console.log(`✅ QR + total terkirim ke ${customer.jid} untuk pesanan #${pesananId} (Rp${nominalTransfer})`);
    return true;
  } catch (err) {
    console.error('❌ Gagal kirim QR:', err.message);
    return false;
  }
}

async function kirimQrKekuranganKeCustomer(tagihanId) {
  const tagihan = db.getTagihanById(tagihanId);
  const pesanan = db.getPesananById(tagihan.pesanan_id);
  const jid = pesanan.customer_jid;

  const caption =
    `Kekurangan bayar untuk pesanan #${pesanan.id}: Rp${tagihan.nominal}.\n` +
    `Scan QR ini ya, bayar persis Rp${tagihan.nominal_transfer} 🙏`;

  const qrPath = path.join(__dirname, 'images', 'qr', 'qris-statis.jpg');

  if (!fs.existsSync(qrPath)) {
    console.log('⚠️  File QR statis tidak ditemukan di images/qr/qris-statis.jpg');
    await kirimPesan(jid, `${caption}\n\n(QR belum tersedia, mohon hubungi kasir untuk info pembayaran)`);
    return false;
  }

  try {
    await sock.sendMessage(jid, { image: fs.readFileSync(qrPath), caption });
    console.log(`✅ QR kekurangan terkirim ke ${jid} untuk tagihan #${tagihanId} (Rp${tagihan.nominal_transfer})`);
    return true;
  } catch (err) {
    console.error('❌ Gagal kirim QR kekurangan:', err.message);
    return false;
  }
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
setInterval(() => {
  cekTimeoutKeputusanHabis().catch((err) => console.error('❌ Error cek timeout:', err.message));
}, 60 * 1000);

if (!db.getInfoResto('aturan_layanan')) {
  console.log('⚠️  info_resto kosong. Jalankan "node seed.js" supaya aturan layanan dan catatan alergen masuk ke prompt.');
}

startBot();