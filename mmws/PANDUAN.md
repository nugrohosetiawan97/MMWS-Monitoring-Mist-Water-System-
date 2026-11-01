# MMWS v2 di Cloudflare: panduan pemasangan

Ini salinan website MMWS dengan perbaikan:

- **Impor riwayat** data beban sebelum mist (CSV logsheet/SCADA).
- **Pengaturan** nameplate dan tanggal energize, sehingga sisa umur bisa dihitung.
- **Input data operator** untuk beban, OTI, dan WTI HV/LV.
- **Unduh CSV.**
- Simulator yang terpisah jelas dari data asli.
- Firmware ESP32 HTTPS dengan kendali lokal cadangan.

Untuk sementara website **tanpa login**: siapa pun yang tahu alamatnya bisa mengubah pengaturan dan mode mist. Kunci PIN bisa diaktifkan kapan saja dengan satu perintah (lihat Langkah 7).

```
[ESP32 + DHT11 + DS18B20 + relay] --HTTPS /api/ingest (token)--> [Cloudflare Worker + Durable Object]
                                                                     │  cron tiap menit: model IEC 60076-7,
[Laptop / HP] ------------------- HTTPS dashboard ---------------->  │  susut umur, keputusan mist
```

Biaya: paket gratis Cloudflare cukup. Pemakaian sekitar 1.440 cron, 1.440 kiriman ESP32, dan ±5.800 permintaan per hari per tab dashboard yang terbuka. Batas paket gratis 100.000 permintaan per hari.

---

## Langkah 1: Siapkan Mac (sekali saja)

1. Pasang **Node.js LTS** dari nodejs.org.
2. Ekstrak `mmws-cloudflare-v2.zip`, lalu buka Terminal di folder itu:

```bash
cd ~/Downloads/mmws-cloudflare
npm install
npx wrangler login        # browser terbuka, izinkan akses ke akun Cloudflare Anda
```

## Langkah 2: Pilih alamat website

Nama Worker di `wrangler.toml` adalah **`mmws-v2`**, jadi website lama Anda di `mmws.tamabyte.com` **tidak tertimpa**. Disarankan pasang dulu di alamat uji, misalnya `mmws2.tamabyte.com`.

Buka `wrangler.toml` dan hapus tanda `#` di baris paling bawah:

```toml
routes = [ { pattern = "mmws2.tamabyte.com", custom_domain = true } ]
```

Domain `tamabyte.com` harus ada di akun Cloudflare yang sama. Cloudflare membuat DNS dan sertifikat HTTPS otomatis.

## Langkah 3: Buat token perangkat ESP32

```bash
openssl rand -hex 16                 # salin hasilnya, misalnya 3f9c...e1
npx wrangler secret put DEVICE_TOKEN # tempel hasil tadi, Enter
```

Simpan token ini. Token yang sama akan dimasukkan ke firmware ESP32.

## Langkah 4: Pasang website

```bash
npx wrangler deploy
```

Buka `https://mmws2.tamabyte.com`. Indikator kanan atas harus **LIVE**.

## Langkah 5: Isi data awal

1. **Pengaturan**: isi nameplate Unit 1 (MVA, tegangan, rugi-rugi/gradien dari test report), **tanggal energize**, dan batas alarm OTI/WTI. Simpan.
2. **Impor riwayat**: pilih CSV data sebelum mist, fase **Sebelum mist**, lalu impor.
   - Format kolom yang dibaca: waktu, beban (MW/MVA/A), ambien, RH, OTI, WTI HV, WTI LV.
   - Pemisah koma atau titik koma diterima, dan desimal koma diterima.
   - Langsung muncul: F_EQA harian, susut umur, dan **sisa umur** berdasarkan pola beban sebelum mist.
3. **Input data** (opsional): masukkan bacaan beban, OTI, dan WTI dari panel. Nilai ini dipakai model sampai ada sumber beban otomatis.

### Uji tanpa ESP32 (opsional)

**Pengaturan → Sumber data & data uji → centang "Jalankan ESP32 virtual"**. Data simulasi muncul dalam 1 menit, ditandai **SIMULASI** di kanan atas dan di banner.

Sebelum ESP32 asli dipasang: hapus centang simulator, lalu tekan **Hapus data uji**. Pengaturan dan data impor tetap tersimpan. Simulator juga berhenti otomatis begitu ESP32 asli mengirim data.

## Langkah 6: Program ESP32

Buka `firmware/mmws_esp32_http/mmws_esp32_http.ino` di Arduino IDE.

- Library yang diperlukan: **DHT sensor library**, **Adafruit Unified Sensor**, **OneWire**, dan **DallasTemperature**.
- Board: **ESP32 Dev Module**.

Isi bagian KONFIGURASI:

```cpp
const char* WIFI_SSID    = "WiFi router 4G di GI";
const char* WIFI_PASS    = "password WiFi";
const char* INGEST_URL   = "https://mmws2.tamabyte.com/api/ingest";
const char* DEVICE_TOKEN = "token dari Langkah 3";
```

Upload, lalu buka Serial Monitor (115200). Harus muncul `[HTTP] OK, mist=0, kirim lagi 60 s`.

| Pesan Serial Monitor | Arti / solusi |
|---|---|
| `menunggu jam NTP untuk HTTPS` | Normal beberapa detik setelah WiFi tersambung. Bila terus muncul, cek kuota/sinyal router 4G. |
| `401: DEVICE_TOKEN tidak cocok` | Token di firmware berbeda dengan `wrangler secret`. |
| `503: DEVICE_TOKEN belum diatur` | Langkah 3 belum dijalankan. |
| `gagal kode -1` | Tidak ada internet, atau URL salah. |

Wiring sama dengan versi sebelumnya:

| Komponen | Pin ESP32 |
|---|---|
| DHT11 ambien | GPIO4 |
| DHT11 udara masuk radiator | GPIO16 |
| DS18B20 | GPIO17 (pull-up 4k7) |
| Relay pompa | GPIO26 (aktif LOW) |
| Float switch | GPIO27 |

Perilaku firmware:

- **Pengiriman:** data dikirim tiap 60 detik, dipercepat menjadi 10 detik saat perintah mist berubah.
- **Server diam lebih dari 5 menit:** ESP32 pindah ke kendali lokal (ambang suhu tangki 70 °C).
- **Koneksi putus:** data per menit disimpan sampai 24 jam, lalu dikirim ulang otomatis. Log menulis "Data cadangan dari ESP32 diterima".
- **Air habis (float switch):** pompa dimatikan di ESP32 dan server ikut menahan perintah mist. Dashboard menampilkan ALARM.

## Langkah 7: Mengunci website dengan PIN (nanti)

```bash
npx wrangler secret put MMWS_PIN      # contoh: 482916
```

Setelah itu, mengubah pengaturan, mode mist, input, impor, dan hapus data meminta PIN. Melihat dashboard tetap terbuka.

Untuk kembali tanpa PIN:

```bash
npx wrangler secret delete MMWS_PIN
```

Untuk mengunci penuh (melihat pun perlu login email), aktifkan **Cloudflare Access** (Zero Trust, gratis sampai 50 pengguna) pada alamat website. Kecualikan path `/api/ingest` supaya ESP32 tetap bisa mengirim data.

## Langkah 8: Pindah ke alamat utama

Setelah versi baru terbukti berjalan:

1. Di dashboard Cloudflare, buka **Workers & Pages → Worker lama → Settings → Domains & Routes**, lalu hapus `mmws.tamabyte.com`.
2. Ubah `wrangler.toml` menjadi `pattern = "mmws.tamabyte.com"`, lalu jalankan `npx wrangler deploy`.
3. Ubah `INGEST_URL` di firmware dan upload ulang.

Data di `mmws2` ikut pindah, karena data tersimpan di Worker, bukan di alamat.

## Perawatan

| Kebutuhan | Cara |
|---|---|
| Lihat log server langsung | `npx wrangler tail` |
| Perbarui versi | Ekstrak versi baru di folder yang sama → `npx wrangler deploy`. Data tetap. |
| Cadangan data | **Unduh CSV** (7 hari live). Simpan juga file CSV impor asli Anda. |
| Ganti token ESP32 | `npx wrangler secret put DEVICE_TOKEN`, lalu upload ulang firmware |

## Batas yang perlu diketahui

- **Riwayat live** disimpan 7 hari per menit. Agregat harian (F_EQA, susut umur) disimpan permanen. Untuk arsip tesis, unduh CSV tiap minggu.
- **Impor CSV** dikirim per 1.000 baris. Bila muncul "Kesalahan server" saat mengimpor file sangat besar, pecah file per 2–3 bulan.
- **Data aset PLN:** pastikan ada izin tertulis UPT/UP2B sebelum data beban dan suhu dikirim ke server cloud.
