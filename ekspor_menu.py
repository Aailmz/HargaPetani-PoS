"""
Ubah PDF buku menu jadi gambar per halaman untuk dikirim bot lewat WhatsApp.

Cara pakai (dari folder proyek):
    python ekspor_menu.py
    python ekspor_menu.py "images/menu-pdf/Menu The Banjoemas.pdf"

Hasil: data_menu/halaman_menu/p01.jpg, p02.jpg, ... (lebar 1080 px, JPEG).
Ganti menu = timpa file PDF lalu jalankan skrip ini lagi. Pemetaan halaman -> kategori ada di
data_menu/halaman_menu.json (ubah nomor halaman di sana kalau susunan PDF berubah).

Butuh: pip install pymupdf pillow
"""
import io
import os
import sys

import pymupdf
from PIL import Image

PDF_BAWAAN = os.path.join("images", "menu-pdf", "Menu The Banjoemas.pdf")
KELUAR = os.path.join("data_menu", "halaman_menu")
LEBAR = 1080


def main():
    pdf = sys.argv[1] if len(sys.argv) > 1 else PDF_BAWAAN
    if not os.path.exists(pdf):
        sys.exit(f"File tidak ditemukan: {pdf}")
    os.makedirs(KELUAR, exist_ok=True)
    for lama in os.listdir(KELUAR):
        if lama.startswith("p") and lama.endswith(".jpg"):
            os.remove(os.path.join(KELUAR, lama))

    dok = pymupdf.open(pdf)
    for i, hal in enumerate(dok, start=1):
        zoom = LEBAR / hal.rect.width
        pix = hal.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
        img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
        jalur = os.path.join(KELUAR, f"p{i:02d}.jpg")
        img.save(jalur, "JPEG", quality=82, optimize=True)
        print(f"{jalur}  {img.size[0]}x{img.size[1]}  {os.path.getsize(jalur) // 1024} KB")
    print(f"Selesai: {len(dok)} halaman.")


if __name__ == "__main__":
    main()
