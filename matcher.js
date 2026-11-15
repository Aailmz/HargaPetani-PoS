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
function cariKandidatMenu(namaInput) {
  const semuaMenu = getAllMenu();
  if (semuaMenu.length === 0) {
    return { statusMatch: 'TIDAK_ADA', kandidatTerbaik: null, skorTerbaik: 0 };
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

module.exports = {
  hitungSkorKemiripan,
  normalisasiNama,
  cariKandidatMenu,
  hitungSkorGabungan,
};