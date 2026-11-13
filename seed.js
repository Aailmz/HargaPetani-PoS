// seed.js — jalankan sekali: node seed.js
const db = require('./db');

const menuItems = [
  // ===== GORENGAN =====
  { nama: 'Mendoan', kategori: 'gorengan', deskripsi: 'Tempe tipis khas Banyumas yang dibalut adonan tepung berbumbu, digoreng setengah matang hingga lembut dengan bagian luar yang gurih. Cocok dinikmati dengan cabai rawit dan sambal kecap.', harga: 33000, status: 'tersedia' },
  { nama: 'Bakwan Jagung', kategori: 'gorengan', deskripsi: 'Gorengan berbahan jagung manis pipil yang dicampur adonan tepung dan bumbu pilihan, digoreng hingga bagian luarnya renyah dengan rasa gurih dan sedikit manis.', harga: 33000, status: 'tersedia' },
  { nama: 'Singkong Goreng', kategori: 'gorengan', deskripsi: 'Potongan singkong pilihan yang digoreng hingga bagian luar berwarna keemasan dan renyah, sementara bagian dalamnya tetap empuk dan pulen.', harga: 35000, status: 'tersedia' },
  { nama: 'Ubi Goreng', kategori: 'gorengan', deskripsi: 'Ubi pilihan yang digoreng hingga matang dengan tekstur lembut di bagian dalam dan lapisan luar yang sedikit renyah serta rasa manis alami.', harga: 35000, status: 'tersedia' },
  { nama: 'Cireng', kategori: 'gorengan', deskripsi: 'Camilan khas Sunda berbahan dasar tepung tapioka dengan tekstur kenyal di bagian dalam dan sedikit renyah di bagian luar, disajikan sebagai teman bersantai.', harga: 33000, status: 'tersedia' },
  { nama: 'Tahu Isi', kategori: 'gorengan', deskripsi: 'Tahu goreng yang diisi dengan campuran sayuran berbumbu, kemudian dibalut adonan tepung dan digoreng hingga keemasan dengan tekstur renyah.', harga: 38000, status: 'tersedia' },
  { nama: 'Tahu Bakso', kategori: 'gorengan', deskripsi: 'Tahu pilihan dengan isian adonan bakso yang gurih dan kenyal, diolah hingga matang dan menghasilkan perpaduan rasa tahu serta daging yang lezat.', harga: 38000, status: 'tersedia' },
  { nama: 'Pisang Goreng', kategori: 'gorengan', deskripsi: 'Pisang pilihan yang dibalut adonan kemudian digoreng hingga keemasan. Memiliki tekstur renyah di luar dan lembut manis di bagian dalam.', harga: 33000, status: 'tersedia' },
  { nama: 'Pisang Coklat', kategori: 'gorengan', deskripsi: 'Pisang yang dipadukan dengan cokelat dalam balutan kulit atau adonan renyah, digoreng hingga matang untuk menghasilkan camilan manis dengan perpaduan tekstur yang nikmat.', harga: 33000, status: 'tersedia' },

  // ===== SNACK & REBUSAN =====
  { nama: 'Edamame', kategori: 'snack', deskripsi: 'Kacang kedelai muda yang direbus hingga empuk dan disajikan sederhana untuk camilan ringan dengan rasa gurih alami.', harga: 33000, status: 'tersedia' },
  { nama: 'Rebusan Mix Plate', kategori: 'rebusan', deskripsi: 'Aneka bahan rebusan pilihan dalam satu piring, terdiri dari jagung, ubi, singkong, kacang, dan sayuran sesuai sajian. Cocok untuk camilan tradisional yang mengenyangkan.', harga: 55000, status: 'tersedia' },
  { nama: 'Jagung Manis Rebus', kategori: 'rebusan', deskripsi: 'Jagung manis pilihan yang direbus hingga matang dan empuk, mempertahankan rasa manis alami serta tekstur renyah yang menyenangkan.', harga: 33000, status: 'tersedia' },
  { nama: 'Talas Rebus', kategori: 'rebusan', deskripsi: 'Talas pilihan yang direbus hingga empuk dengan tekstur lembut dan rasa khas yang ringan, cocok dinikmati sebagai camilan tradisional.', harga: 33000, status: 'tersedia' },
  { nama: 'Kacang Rebus', kategori: 'rebusan', deskripsi: 'Kacang tanah pilihan yang direbus hingga matang dan empuk, menghadirkan cita rasa gurih alami sebagai camilan sederhana.', harga: 33000, status: 'tersedia' },

  // ===== CIMPLUNG =====
  { nama: 'Cimplung Mix Plate', kategori: 'cimplung', deskripsi: 'Paket aneka cimplung khas Banyumas yang menggabungkan beberapa pilihan bahan seperti kelapa muda, singkong, ubi, dan pisang. Direbus perlahan dalam air nira kelapa hingga empuk dengan rasa manis alami dan aroma khas.', harga: 55000, status: 'tersedia' },
  { nama: 'Cimplung Kelapa', kategori: 'cimplung', deskripsi: 'Cimplung berbahan kelapa muda yang diolah dengan cara tradisional menggunakan air nira kelapa. Memiliki tekstur lembut dengan cita rasa manis alami dan aroma khas.', harga: 33000, status: 'tersedia' },
  { nama: 'Cimplung Singkong', kategori: 'cimplung', deskripsi: 'Singkong pilihan yang direbus perlahan dalam air nira kelapa hingga empuk dan meresap rasa manisnya. Camilan tradisional khas Banyumas dengan tekstur lembut dan legit.', harga: 33000, status: 'tersedia' },
  { nama: 'Cimplung Ubi', kategori: 'cimplung', deskripsi: 'Ubi yang diolah secara tradisional dengan direbus dalam air nira kelapa hingga matang, menghasilkan tekstur empuk dan rasa manis alami yang khas.', harga: 33000, status: 'tersedia' },
  { nama: 'Cimplung Pisang', kategori: 'cimplung', deskripsi: 'Pisang yang diolah dengan cara tradisional menggunakan air nira kelapa hingga matang dan lembut, menghasilkan perpaduan rasa manis pisang dan legit khas cimplung.', harga: 33000, status: 'tersedia' },

  // ===== MAKANAN BERAT =====
  { nama: 'Sroto Ayam', kategori: 'makanan berat', deskripsi: 'Hidangan khas Banyumas berupa kuah kaldu gurih dengan suwiran ayam, bihun, ketupat, kerupuk, dan bumbu kacang yang memberikan cita rasa khas dan kaya rempah.', harga: 47000, status: 'tersedia' },
  { nama: 'Sroto Daging', kategori: 'makanan berat', deskripsi: 'Sroto khas Banyumas dengan kuah kaldu berbumbu rempah, potongan daging sapi yang empuk, bihun, ketupat, kerupuk, dan sentuhan bumbu kacang yang gurih.', harga: 55000, status: 'tersedia' },
  { nama: 'Mie Goreng Jawa', kategori: 'makanan berat', deskripsi: 'Mie yang dimasak dengan bumbu khas Jawa, dipadukan dengan sayuran dan pelengkap pilihan. Memiliki cita rasa gurih dengan aroma khas masakan rumahan.', harga: 55000, status: 'tersedia' },
  { nama: 'Mie Godog', kategori: 'makanan berat', deskripsi: 'Mie kuah khas Jawa yang dimasak dengan racikan bumbu tradisional, menghasilkan kuah hangat dan gurih dengan tambahan sayuran serta pelengkap.', harga: 55000, status: 'tersedia' },
  { nama: 'Pecel', kategori: 'makanan berat', deskripsi: 'Aneka sayuran rebus segar yang disiram sambal kacang khas pecel dengan perpaduan rasa gurih, manis, dan sedikit pedas. Disajikan bersama pelengkap tradisional.', harga: 35000, status: 'tersedia' },
  { nama: 'Sop Buntut', kategori: 'makanan berat', deskripsi: 'Sup buntut sapi dengan potongan buntut yang dimasak hingga empuk dalam kuah kaldu bening berbumbu rempah. Disajikan hangat dengan sayuran dan pelengkap.', harga: 155000, status: 'tersedia' },
  { nama: 'Nasi Goreng Kambing', kategori: 'makanan berat', deskripsi: 'Nasi goreng dengan potongan daging kambing dan racikan bumbu rempah yang kaya aroma, menghasilkan rasa gurih dan khas dengan sentuhan bumbu tradisional.', harga: 68000, status: 'tersedia' },
  { nama: 'Nasi Goreng Kampung', kategori: 'makanan berat', deskripsi: 'Nasi goreng bergaya rumahan dengan bumbu sederhana khas Indonesia, memiliki cita rasa gurih dan aroma khas nasi goreng tradisional.', harga: 47000, status: 'tersedia' },
  { nama: 'Tongseng Kambing', kategori: 'makanan berat', deskripsi: 'Olahan daging kambing dengan kuah berbumbu rempah, kecap, dan sayuran yang dimasak hingga meresap. Menghadirkan perpaduan rasa gurih, manis, dan kaya aroma.', harga: 75000, status: 'tersedia' },
  { nama: 'Tongseng Sapi', kategori: 'makanan berat', deskripsi: 'Potongan daging sapi yang dimasak dengan bumbu tongseng khas Indonesia, perpaduan rempah, kecap, dan sayuran dalam kuah gurih yang kaya rasa.', harga: 65000, status: 'tersedia' },
  { nama: 'Tongseng Ayam', kategori: 'makanan berat', deskripsi: 'Potongan daging ayam yang dimasak dengan bumbu tongseng, kecap, dan rempah pilihan, menghasilkan hidangan berkuah dengan rasa gurih dan manis.', harga: 55000, status: 'tersedia' },
  { nama: 'Gulai Kambing', kategori: 'makanan berat', deskripsi: 'Daging kambing yang dimasak perlahan dalam kuah santan berbumbu rempah khas gulai, menghasilkan tekstur daging empuk dan kuah yang kaya rasa.', harga: 75000, status: 'tersedia' },
  { nama: 'Gulai Sapi', kategori: 'makanan berat', deskripsi: 'Potongan daging sapi yang dimasak dalam kuah santan kental dengan racikan rempah tradisional, menghadirkan rasa gurih dan aroma yang menggugah selera.', harga: 65000, status: 'tersedia' },
  { nama: 'Gulai Ayam', kategori: 'makanan berat', deskripsi: 'Daging ayam yang dimasak dengan kuah santan dan bumbu rempah khas gulai, menghasilkan hidangan berkuah gurih dengan rasa rempah yang meresap.', harga: 55000, status: 'tersedia' },
  { nama: 'Soto Betawi', kategori: 'makanan berat', deskripsi: 'Soto khas Betawi dengan kuah santan dan rempah yang gurih, dilengkapi potongan daging serta pelengkap khas yang membuat sajian terasa kaya dan mengenyangkan.', harga: 65000, status: 'tersedia' },
  { nama: 'Iga Bakar', kategori: 'makanan berat', deskripsi: 'Iga sapi yang dibumbui dan dibakar hingga matang dengan aroma panggangan yang khas. Disajikan dengan pelengkap untuk menikmati daging iga yang gurih dan lezat.', harga: 155000, status: 'tersedia' },
  { nama: 'Belut Goreng', kategori: 'makanan berat', deskripsi: 'Belut pilihan yang dibumbui kemudian digoreng hingga matang dengan tekstur bagian luar yang renyah dan rasa gurih khas olahan tradisional.', harga: 68000, status: 'tersedia' },
  { nama: 'Ayam Goreng Kampung', kategori: 'makanan berat', deskripsi: 'Ayam kampung yang dimasak dengan bumbu tradisional hingga meresap, kemudian digoreng sampai matang dengan kulit keemasan dan cita rasa gurih.', harga: 55000, status: 'tersedia' },
  { nama: 'Bebek Goreng', kategori: 'makanan berat', deskripsi: 'Daging bebek yang diolah dengan bumbu pilihan hingga meresap, kemudian digoreng sampai matang dengan bagian luar yang gurih dan daging yang kaya rasa.', harga: 68000, status: 'tersedia' },
  { nama: 'Siomay', kategori: 'makanan berat', deskripsi: 'Hidangan siomay yang disajikan dengan saus kacang gurih khas Indonesia dan pelengkap pilihan, menghadirkan perpaduan tekstur lembut dan rasa yang kaya.', harga: 45000, status: 'tersedia' },
  { nama: 'Sate Kambing', kategori: 'makanan berat', deskripsi: 'Potongan daging kambing yang ditusuk dan dibakar hingga matang, disajikan dengan bumbu pelengkap khas sate yang memberikan rasa gurih dan aroma panggangan.', harga: 125000, status: 'tersedia' },
  { nama: 'Sate Kambing 1/2 Porsi', kategori: 'makanan berat', deskripsi: 'Porsi lebih kecil dari sate kambing dengan potongan daging kambing yang dibakar hingga matang dan disajikan bersama bumbu pelengkap khas sate.', harga: 70000, status: 'tersedia' },
  { nama: 'Sate Ayam', kategori: 'makanan berat', deskripsi: 'Potongan daging ayam yang ditusuk dan dibakar hingga matang, menghasilkan aroma khas panggangan dan rasa gurih, disajikan dengan bumbu pelengkap sate.', harga: 55000, status: 'tersedia' },
  { nama: 'Sate Ayam 1/2 Porsi', kategori: 'makanan berat', deskripsi: 'Sate ayam dalam porsi lebih kecil, terdiri dari potongan daging ayam berbumbu yang dibakar hingga matang dan disajikan dengan pelengkap khas sate.', harga: 30000, status: 'tersedia' },
  { nama: 'Sate Taichan', kategori: 'makanan berat', deskripsi: 'Sate ayam yang dibakar dengan bumbu sederhana tanpa baluran saus kacang, disajikan bersama sambal pedas dan perasan jeruk nipis untuk rasa segar dan gurih.', harga: 55000, status: 'tersedia' },
  { nama: 'Steak Sapi', kategori: 'makanan berat', deskripsi: 'Potongan daging sapi yang dimasak hingga tingkat kematangan yang sesuai, disajikan dengan saus steak dan pelengkap seperti kentang goreng serta sayuran.', harga: 185000, status: 'tersedia' },

  // ===== COFFEE =====
  { nama: 'Espresso', kategori: 'coffee', deskripsi: 'Kopi pekat yang diekstraksi menggunakan tekanan tinggi dari biji kopi pilihan. Memiliki karakter rasa kuat, aroma intens, dan lapisan crema khas espresso.', harga: 30000, status: 'tersedia' },
  { nama: 'Americano', kategori: 'coffee', deskripsi: 'Espresso yang dipadukan dengan air panas untuk menghasilkan kopi hitam dengan rasa lebih ringan, aroma kopi yang tetap kuat, dan karakter rasa yang bersih.', harga: 37000, status: 'tersedia' },
  { nama: 'Long Black', kategori: 'coffee', deskripsi: 'Kopi hitam yang dibuat dengan menuangkan espresso ke dalam air panas, menghasilkan aroma yang kuat dengan karakter rasa kopi yang lebih intens.', harga: 37000, status: 'tersedia' },
  { nama: 'Cappuccino', kategori: 'coffee', deskripsi: 'Minuman berbasis espresso yang dipadukan dengan steamed milk dan lapisan foam susu lembut. Memiliki keseimbangan rasa kopi dan susu dengan tekstur creamy.', harga: 45000, status: 'tersedia' },
  { nama: 'Latte', kategori: 'coffee', deskripsi: 'Espresso yang dicampur dengan steamed milk dan sedikit foam susu, menghasilkan minuman kopi dengan tekstur lembut, creamy, dan rasa kopi yang seimbang.', harga: 45000, status: 'tersedia' },
  { nama: 'Mochaccino', kategori: 'coffee', deskripsi: 'Perpaduan espresso, susu, dan cokelat yang menghasilkan minuman kopi dengan rasa creamy, aroma kopi, serta sentuhan manis cokelat.', harga: 58000, status: 'tersedia' },
  { nama: 'Aren Latte', kategori: 'coffee', deskripsi: 'Perpaduan espresso, susu, dan gula aren yang menghasilkan minuman kopi creamy dengan rasa manis khas gula aren serta aroma kopi yang seimbang.', harga: 37000, status: 'tersedia' },
  { nama: 'Gurrescotch Latte', kategori: 'coffee', deskripsi: 'Minuman kopi latte dengan sentuhan rasa butterscotch yang manis dan creamy, dipadukan dengan espresso serta susu untuk menghasilkan karakter rasa yang lembut.', harga: 55000, status: 'tersedia' },
  { nama: 'Creamy Butterscotch', kategori: 'coffee', deskripsi: 'Minuman berbasis kopi dengan perpaduan rasa butterscotch yang manis, buttery, dan creamy. Cocok bagi penikmat kopi dengan karakter rasa yang lembut.', harga: 55000, status: 'tersedia' },
  { nama: 'Irish Black Shot', kategori: 'coffee', deskripsi: 'Minuman kopi dengan karakter espresso yang kuat dan sentuhan rasa khas Irish, menghadirkan kombinasi rasa kopi pekat dengan aroma yang unik.', harga: 50000, status: 'tersedia' },
  { nama: 'Cappuccino Freddo', kategori: 'coffee', deskripsi: 'Cappuccino versi dingin yang memadukan espresso dengan susu dan foam lembut, menghasilkan minuman kopi segar dengan tekstur creamy.', harga: 45000, status: 'tersedia' },

  // ===== MANUAL BREW =====
  { nama: 'V60', kategori: 'manual brew', deskripsi: 'Kopi seduh manual menggunakan metode pour over V60 yang menonjolkan karakter asli biji kopi, aroma yang kompleks, serta rasa yang lebih bersih dan ringan.', harga: 45000, status: 'tersedia' },
  { nama: 'V60 Japanese', kategori: 'manual brew', deskripsi: 'Kopi seduh manual metode V60 dengan teknik Japanese iced coffee, yaitu penyeduhan langsung di atas es untuk menghasilkan kopi dingin yang segar dengan aroma dan karakter rasa kopi yang tetap terjaga.', harga: 50000, status: 'tersedia' },
  { nama: 'French Press', kategori: 'manual brew', deskripsi: 'Kopi yang diseduh menggunakan metode French Press dengan perendaman bubuk kopi dalam air panas sebelum disaring menggunakan plunger. Menghasilkan karakter kopi yang kaya, pekat, dan beraroma.', harga: 45000, status: 'tersedia' },
  { nama: 'Kopi Tubruk', kategori: 'manual brew', deskripsi: 'Kopi tradisional Indonesia yang diseduh langsung bersama air panas tanpa proses penyaringan, menghasilkan rasa kopi yang kuat, pekat, dan autentik.', harga: 40000, status: 'tersedia' },

  // ===== NON COFFEE =====
  { nama: 'Matcha Latte', kategori: 'non coffee', deskripsi: 'Bubuk matcha pilihan yang dipadukan dengan susu untuk menghasilkan minuman berwarna hijau dengan rasa teh hijau khas, sedikit earthy, dan tekstur creamy.', harga: 55000, status: 'tersedia' },
  { nama: 'Matcha Berry Latte', kategori: 'non coffee', deskripsi: 'Perpaduan matcha dengan susu dan sentuhan rasa buah berry yang memberikan kombinasi rasa khas teh hijau, creamy, serta manis dan segar.', harga: 58000, status: 'tersedia' },
  { nama: 'Choco Butter Cream', kategori: 'non coffee', deskripsi: 'Minuman cokelat dengan perpaduan rasa butter cream yang lembut dan creamy, menghasilkan cita rasa manis cokelat yang kaya dan tekstur lembut.', harga: 50000, status: 'tersedia' },

  // ===== TEA =====
  { nama: 'Lemon Mint', kategori: 'tea', deskripsi: 'Minuman teh dengan perpaduan rasa lemon yang segar dan aroma daun mint yang menyegarkan, menghasilkan sensasi rasa citrus yang ringan dan menyenangkan.', harga: 35000, status: 'tersedia' },
  { nama: 'Tropical Dream', kategori: 'tea', deskripsi: 'Minuman teh dengan perpaduan cita rasa buah tropis yang manis dan menyegarkan, cocok dinikmati dingin untuk menemani suasana santai.', harga: 35000, status: 'tersedia' },
  { nama: 'Vanilla Rose', kategori: 'tea', deskripsi: 'Minuman teh dengan sentuhan aroma vanilla yang lembut dan karakter floral dari rose, menghadirkan rasa yang harum, ringan, dan menenangkan.', harga: 35000, status: 'tersedia' },
  { nama: 'Ginger Vanilla', kategori: 'tea', deskripsi: 'Perpaduan teh dengan jahe yang memberikan sensasi hangat dan aroma vanilla yang lembut, menghasilkan minuman dengan karakter rasa rempah yang unik.', harga: 35000, status: 'tersedia' },
  { nama: 'Teh Poci IX Refil', kategori: 'tea', deskripsi: 'Teh yang disajikan menggunakan poci dengan cita rasa teh tradisional yang khas. Termasuk fasilitas refill hingga sembilan kali sesuai ketentuan penyajian restoran.', harga: 30000, status: 'tersedia' },
  { nama: 'Lemon Tea', kategori: 'tea', deskripsi: 'Perpaduan teh dengan perasan atau rasa lemon yang memberikan sensasi citrus segar dan perpaduan rasa manis serta asam. Tersedia dalam pilihan panas maupun dingin.', harga: 28000, status: 'tersedia' },
  { nama: 'Teh Manis', kategori: 'tea', deskripsi: 'Teh pilihan yang diseduh dengan gula untuk menghasilkan rasa manis dan aroma teh yang khas. Tersedia dalam penyajian panas maupun dingin, termasuk free 1x refill.', harga: 18000, status: 'tersedia' },
  { nama: 'Teh Tawar', kategori: 'tea', deskripsi: 'Seduhan teh tanpa tambahan gula dengan cita rasa teh yang ringan dan aroma khas. Tersedia dalam penyajian panas maupun dingin, termasuk free 1x refill.', harga: 18000, status: 'tersedia' },

  // ===== MINUMAN TRADISIONAL =====
  { nama: 'Dawet Banjarnegara', kategori: 'minuman tradisional', deskripsi: 'Minuman tradisional khas Banjarnegara yang terdiri dari cendol lembut dengan kuah santan dan gula merah, menghadirkan perpaduan rasa manis, gurih, dan menyegarkan.', harga: 30000, status: 'tersedia' },
  { nama: 'Legen Siwalan', kategori: 'minuman tradisional', deskripsi: 'Minuman tradisional yang berasal dari nira bunga pohon siwalan atau lontar, memiliki rasa manis alami dan karakter rasa khas yang menyegarkan.', harga: 33000, status: 'tersedia' },
  { nama: 'Kunyit Asem', kategori: 'minuman tradisional', deskripsi: 'Minuman herbal tradisional berbahan kunyit dan asam jawa dengan perpaduan rasa asam dan manis yang menyegarkan serta aroma rempah yang khas.', harga: 33000, status: 'tersedia' },
  { nama: 'Beras Kencur', kategori: 'minuman tradisional', deskripsi: 'Jamu tradisional yang dibuat dari beras dan kencur dengan tambahan rempah serta pemanis, menghasilkan rasa manis, sedikit pedas khas kencur, dan aroma yang harum.', harga: 33000, status: 'tersedia' },
  { nama: 'Jahe Susu', kategori: 'minuman tradisional', deskripsi: 'Minuman hangat dari ekstrak jahe yang dipadukan dengan susu, menghadirkan rasa rempah yang hangat dengan tekstur lembut dan creamy.', harga: 32000, status: 'tersedia' },
  { nama: 'Jahe Sereh', kategori: 'minuman tradisional', deskripsi: 'Minuman herbal hangat yang memadukan jahe dan serai, menghadirkan aroma rempah yang harum dengan rasa hangat dan menyegarkan.', harga: 35000, status: 'tersedia' },
  { nama: 'Bir Pletok', kategori: 'minuman tradisional', deskripsi: 'Minuman tradisional khas Betawi tanpa alkohol yang dibuat dari campuran jahe dan rempah-rempah pilihan, memiliki aroma harum dan sensasi hangat yang khas.', harga: 33000, status: 'tersedia' },
  { nama: 'Es Timun Serut', kategori: 'minuman tradisional', deskripsi: 'Minuman segar berbahan timun yang diserut halus dan disajikan dingin dengan pemanis serta es, menghasilkan rasa ringan dan menyegarkan.', harga: 30000, status: 'tersedia' },

  // ===== REFRESHMENT =====
  { nama: 'Lechy Squash', kategori: 'refreshment', deskripsi: 'Minuman soda atau sparkling dengan perpaduan rasa leci yang manis dan aroma buah yang segar, disajikan dingin untuk memberikan sensasi menyegarkan.', harga: 35000, status: 'tersedia' },
  { nama: 'Blue Sitrus', kategori: 'refreshment', deskripsi: 'Minuman segar berwarna biru dengan karakter rasa citrus yang menyegarkan, memadukan sensasi manis dan asam yang ringan.', harga: 35000, status: 'tersedia' },
  { nama: 'Stroberi Squash', kategori: 'refreshment', deskripsi: 'Minuman squash dengan rasa stroberi yang manis dan sedikit asam, disajikan dingin dengan es untuk menghadirkan sensasi buah yang segar.', harga: 35000, status: 'tersedia' },
  { nama: 'Lemon Squash', kategori: 'refreshment', deskripsi: 'Minuman segar berbahan lemon dengan perpaduan rasa asam dan manis, disajikan dingin dengan sensasi citrus yang menyegarkan.', harga: 35000, status: 'tersedia' },

  // ===== JUS =====
  { nama: 'Jus Mangga', kategori: 'jus', deskripsi: 'Jus buah mangga yang diolah hingga lembut dengan rasa manis alami dan sedikit sentuhan asam khas mangga, disajikan dingin.', harga: 35000, status: 'tersedia' },
  { nama: 'Jus Alpukat', kategori: 'jus', deskripsi: 'Jus alpukat dengan tekstur lembut dan creamy, memiliki rasa khas alpukat yang gurih dan manis, cocok dinikmati sebagai minuman yang menyegarkan.', harga: 35000, status: 'tersedia' },
  { nama: 'Jus Sirsak', kategori: 'jus', deskripsi: 'Jus buah sirsak dengan perpaduan rasa manis dan asam yang khas, diolah hingga lembut dan disajikan dingin untuk memberikan kesegaran.', harga: 35000, status: 'tersedia' },
  { nama: 'Jus Strawberry', kategori: 'jus', deskripsi: 'Jus stroberi dengan cita rasa buah yang manis dan sedikit asam, memiliki aroma segar dan warna merah alami yang menggugah selera.', harga: 35000, status: 'tersedia' },
  { nama: 'Jus Jambu', kategori: 'jus', deskripsi: 'Jus buah jambu dengan tekstur lembut dan rasa manis khas buah jambu, disajikan dingin sebagai pilihan minuman buah yang menyegarkan.', harga: 35000, status: 'tersedia' },

  // ===== MINUMAN (umum) =====
  { nama: 'Jeruk Peras', kategori: 'minuman', deskripsi: 'Minuman dari perasan jeruk segar dengan rasa manis dan asam alami. Tersedia dalam pilihan penyajian panas maupun dingin.', harga: 28000, status: 'tersedia' },
  { nama: 'Air Mineral', kategori: 'minuman', deskripsi: 'Air mineral dalam kemasan untuk menemani hidangan dan memenuhi kebutuhan cairan tubuh.', harga: 10000, status: 'tersedia' },
];

for (const item of menuItems) {
  db.upsertMenu(item);
}

console.log(`✅ Seed selesai: ${menuItems.length} menu dimasukkan.`);