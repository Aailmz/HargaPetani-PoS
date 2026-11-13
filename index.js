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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_session');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
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
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('\n✅ The Banjoemas terkoneksi ke WhatsApp!\n');
      console.log('Bot siap menerima pesan.\n');
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const message = m.messages[0];
    if (!message.message || message.key.fromMe) return;

    const remoteJidMentah = message.key.remoteJid;
    if (remoteJidMentah && remoteJidMentah.endsWith('@g.us')) {
      console.log(`(Pesan dari grup diabaikan: ${remoteJidMentah})`);
      return;
    }

    const sender = normalizeJid(message);
    const text = (
      message.message.conversation ||
      message.message.extendedTextMessage?.text ||
      ''
    ).trim();

    console.log(`\n📩 Pesan masuk dari ${sender}: "${text}"`);

    await handleIncomingMessage(sender, text);
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

async function kirimFotoMenu(jid) {
  const folderMenu = path.join(__dirname, 'images', 'menu-pdf');
  if (!fs.existsSync(folderMenu)) {
    console.log('⚠️  Folder images/menu-pdf tidak ditemukan.');
    return false;
  }

  const fileList = fs.readdirSync(folderMenu).filter((f) => /\.(jpg|jpeg|png|pdf)$/i.test(f));
  if (fileList.length === 0) {
    console.log('⚠️  Tidak ada file menu (jpg/png/pdf) di images/menu-pdf.');
    return false;
  }

  try {
    for (const fileName of fileList.sort()) {
      const filePath = path.join(folderMenu, fileName);
      const isPdf = fileName.toLowerCase().endsWith('.pdf');

      if (isPdf) {
        await sock.sendMessage(jid, {
          document: fs.readFileSync(filePath),
          mimetype: 'application/pdf',
          fileName: 'Menu The Banjoemas.pdf',
        });
      } else {
        await sock.sendMessage(jid, { image: fs.readFileSync(filePath) });
      }
      await tunggu(400); // jeda kecil antar file biar urutannya rapi di WA
    }
    return true;
  } catch (err) {
    console.error('❌ Gagal kirim file menu:', err.message);
    return false;
  }
}

function buatKonteksUntukAgent(jid) {
  return {
    jid,
    kirimPesan,
    kirimQrKeCustomer,
    kirimFotoMenu,
  };
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

async function prosesSambutanCustomerBaru(jid) {
  db.registerCustomer(jid);

  const sambutan = await ai.callAiText(
    `Ini pelanggan baru pertama kali chat ke The Banjoemas Resto & Cafe (resto khas Banyumas/Jawa Tengah). Buatkan SATU pesan sambutan singkat (maksimal 2-3 kalimat): mulai dengan "Sugeng rawuh", sedikit kalimat ramah tentang The Banjoemas (resto khas Banyumas, suasana hangat), lalu bilang menu akan dikirimkan. JANGAN tanya nama, jangan tanya data apapun, jangan tanya mau pesan apa dulu -- cukup sambutan + info menu segera dikirim. Panggil pelanggan "Mas/Mbak" secara umum (tidak tau nama).`,
    300
  );

  await kirimPesan(
    jid,
    sambutan || 'Sugeng rawuh Mas/Mbak di The Banjoemas Resto & Cafe 🙏 Monggo dilihat dulu menunya nggih, kami kirimkan sekarang.'
  );

  await kirimFotoMenu(jid);

  console.log(`✅ Sambutan + menu terkirim ke customer baru: ${jid}`);
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
    systemPrompt: agent.SYSTEM_PROMPT_CUSTOMER,
    tools: agent.TOOLS_CUSTOMER,
    historiChat,
    pesanBaru: text,
    eksekutorTools: agent.EKSEKUTOR_CUSTOMER,
    konteks,
  });

  db.simpanChatHistory(jid, 'user', text);

  if (hasil.error) {
    console.error('❌ Agent error (customer):', hasil.error);
    await kirimPesan(jid, hasil.jawabanFinal || 'Maaf nggih, ada kendala. Boleh diulang?');
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
      caption: pesanTotal || `Total pesanan Mas/Mbak adalah Rp${nominalTransfer}. Monggo scan QR ini, input nominal persis segitu nggih.`,
    });
    console.log(`✅ QR + total terkirim ke ${customer.jid} untuk pesanan #${pesananId} (Rp${nominalTransfer})`);
    return true;
  } catch (err) {
    console.error('❌ Gagal kirim QR:', err.message);
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

startBot();