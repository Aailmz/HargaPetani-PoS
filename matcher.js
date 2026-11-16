const { distance } = require('fastest-levenshtein');
const { getAllMenu } = require('./db');

const THRESHOLD_YAKIN = 0.8;
const THRESHOLD_MIN = 0.5;

function hitungSkorKemiripan(a, b) {
  const aNorm = normalisasiNama(a);
  const bNorm = normalisasiNama(b);
  const maxLen = Math.max(aNorm.length, bNorm.length);
  if (maxLen === 0) return 0;
  const jarakEdit = distance(aNorm, bNorm);
  return 1 - jarakEdit / maxLen;
}

function normalisasiNama(nama) {
  return nama
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ');
}

function hitungSkorContainment(a, b) {
  const aNorm = normalisasiNama(a);
  const bNorm = normalisasiNama(b);
  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 1;
  if (bNorm.includes(aNorm) || aNorm.includes(bNorm)) return 0.95;
  return 0;
}

function hitungSkorTokenOverlap(a, b) {
  const tokenA = normalisasiNama(a).split(' ').filter(Boolean);
  const tokenB = normalisasiNama(b).split(' ').filter(Boolean);
  if (tokenA.length === 0 || tokenB.length === 0) return 0;

  let totalSkor = 0;
  for (const ta of tokenA) {
    let skorTerbaikToken = 0;
    for (const tb of tokenB) {
      const maxLen = Math.max(ta.length, tb.length);
      if (maxLen === 0) continue;
      const skorToken = 1 - distance(ta, tb) / maxLen;
      if (skorToken > skorTerbaikToken) skorTerbaikToken = skorToken;
    }
    totalSkor += skorTerbaikToken;
  }
  return totalSkor / tokenA.length;
}

function hitungSkorGabungan(a, b) {
  return Math.max(hitungSkorKemiripan(a, b), hitungSkorContainment(a, b), hitungSkorTokenOverlap(a, b));
}

/**
 * Cari kandidat menu paling mirip dari input nama (dari customer atau kasir).
 * Return: { kandidatTerbaik, skorTerbaik, kandidatKedua, skorKedua, statusMatch }
 * statusMatch: 'YAKIN' | 'AMBIGU' | 'AMBIGU_MULTI' | 'TIDAK_ADA'
 */
// Kata sapaan/basa-basi yang sering ikut kebawa ke nama menu: "2 deh cimplung ubinya", "mau cimplung ubi dong"
// (sudah dicek: tidak ada yang jadi bagian nama/alias menu mana pun di menu.json)
const KATA_BASA_BASI = new Set([
  'deh', 'dong', 'aja', 'saja', 'ya', 'yaa', 'nih', 'sih', 'lah', 'kak', 'mas', 'mbak', 'mba',
  'tolong', 'mau', 'pesen', 'pesan', 'order', 'tambah', 'lagi', 'minta',
]);

// Buang qty/harga/basa-basi yang kadang ikut kebawa AI ke teks:
// "Cimplung Ubi x1", "1 Cimplung Ubi", "Cimplung Ubi Rp33000", "2 deh cimplung ubinya"
function bersihkanInput(namaInput) {
  return normalisasiNama(String(namaInput || ''))
    .replace(/\brp\s?\d+\b/g, '')
    .replace(/\bx\s?\d+\b|\b\d+\s?x\b/g, '')
    .split(' ')
    .filter((t) => t && !KATA_BASA_BASI.has(t))
    .map((t) => (t.length > 4 && t.endsWith('nya') ? t.slice(0, -3) : t)) // "ubinya" -> "ubi"
    .join(' ')
    .replace(/^\d+\s+/, '') // qty di depan ("2 cimplung ubi"); angka di tengah/akhir tetap (alias "v 60")
    .trim();
}

function cariKandidatMenu(namaInput) {
  const semuaMenu = getAllMenu();
  if (semuaMenu.length === 0) {
    return { statusMatch: 'TIDAK_ADA', kandidatTerbaik: null, skorTerbaik: 0 };
  }

  namaInput = bersihkanInput(namaInput) || namaInput;

  // Sama persis dengan nama resmi 1 menu -> pasti itu, jangan dianggap ambigu walau
  // ada menu lain yang skornya tinggi karena alias pendek (misal alias "cimplung" di Cimplung Mix Plate).
  const persis = semuaMenu.filter((m) => normalisasiNama(m.nama) === namaInput);
  if (persis.length === 1) {
    return { statusMatch: 'YAKIN', kandidatTerbaik: persis[0], skorTerbaik: 1 };
  }

  // Sama persis dengan alias 1 menu -> ikuti keputusan pemilik di menu.json (misal "ubi" -> Ubi Goreng)
  const persisAlias = semuaMenu.filter((m) => (m.alias || []).some((a) => normalisasiNama(a) === namaInput));
  if (persisAlias.length === 1) {
    return { statusMatch: 'YAKIN', kandidatTerbaik: persisAlias[0], skorTerbaik: 1 };
  }

  const skorSemua = semuaMenu
    .map((m) => {
      // Skor terbaik di antara nama resmi DAN semua alias-nya
      const kandidatNama = [m.nama, ...(m.alias || [])];
      const skorTerbaikNama = Math.max(...kandidatNama.map((n) => hitungSkorGabungan(namaInput, n)));
      return { menu: m, skor: skorTerbaikNama };
    })
    .sort((a, b) => b.skor - a.skor);

  const terbaik = skorSemua[0];
  const kedua = skorSemua[1];

  const AMBANG_MULTI = 0.75;
  const kandidatMulti = skorSemua.filter((s) => s.skor >= AMBANG_MULTI && terbaik.skor - s.skor < 0.15);

  if (kandidatMulti.length >= 3) {
    return {
      statusMatch: 'AMBIGU_MULTI',
      kandidatList: kandidatMulti.map((k) => k.menu),
      skorTerbaik: terbaik.skor,
    };
  }

  if (terbaik.skor >= THRESHOLD_YAKIN) {
    if (kedua && terbaik.skor - kedua.skor < 0.05) {
      return {
        statusMatch: 'AMBIGU',
        kandidatTerbaik: terbaik.menu,
        skorTerbaik: terbaik.skor,
        kandidatKedua: kedua.menu,
        skorKedua: kedua.skor,
      };
    }
    return { statusMatch: 'YAKIN', kandidatTerbaik: terbaik.menu, skorTerbaik: terbaik.skor };
  }

  if (terbaik.skor >= THRESHOLD_MIN) {
    return {
      statusMatch: 'AMBIGU',
      kandidatTerbaik: terbaik.menu,
      skorTerbaik: terbaik.skor,
      kandidatKedua: kedua ? kedua.menu : null,
      skorKedua: kedua ? kedua.skor : 0,
    };
  }

  return { statusMatch: 'TIDAK_ADA', kandidatTerbaik: null, skorTerbaik: terbaik.skor };
}

// Untuk PERTANYAAN ("cimplung itu apa?"): menu yang nama resminya mengandung kata itu.
// Beda dengan cariKandidatMenu yang untuk ORDER (alias "cimplung" -> Cimplung Mix Plate).
function cariMenuBernamaUmum(namaInput) {
  const kata = bersihkanInput(namaInput);
  if (!kata) return [];
  const pola = new RegExp(`(^|\\s)${kata.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
  return getAllMenu().filter((m) => pola.test(normalisasiNama(m.nama)));
}

module.exports = {
  hitungSkorKemiripan,
  normalisasiNama,
  cariKandidatMenu,
  cariMenuBernamaUmum,
  hitungSkorGabungan,
};