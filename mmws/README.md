# MMWS v2: siap deploy ke Cloudflare

Folder ini sudah lengkap dan sudah diuji build-nya. Tidak perlu mengedit file apa pun dan tidak perlu Terminal.

## A. Unggah ke GitHub (±3 menit)
1. Buka github.com, klik **+**, lalu **New repository**. Isi nama `mmws`, pilih **Private**, lalu klik **Create repository**.
2. Klik **uploading an existing file**.
3. Buka folder `mmws` ini, pilih **semua isinya** (Cmd+A), lalu seret ke halaman GitHub.
4. Klik **Commit changes**.

## B. Deploy di Cloudflare (±3 menit)
1. Buka dash.cloudflare.com, lalu **Workers & Pages**, lalu **Create**, lalu **Import a repository**.
2. Sambungkan GitHub, lalu pilih repo `mmws`.
3. Biarkan semua isian bawaan, lalu klik **Deploy**.
4. Selesai. Website bisa dibuka di `https://mmws-v2.<akun-anda>.workers.dev`.

## C. Pasang di mmws.tamabyte.com
1. Buka **Workers & Pages**, pilih **Worker lama**, lalu **Settings**, lalu **Domains & Routes**. Hapus `mmws.tamabyte.com`.
2. Buka **Workers & Pages**, pilih **mmws-v2**, lalu **Settings**, lalu **Domains & Routes**, lalu **Add**, lalu **Custom domain**. Isi `mmws.tamabyte.com`.

Worker lama tidak terhapus, jadi bisa dikembalikan kapan saja.

## D. Token ESP32 (saat alat siap)
1. Buka **mmws-v2**, lalu **Settings**, lalu **Variables and Secrets**, lalu **Add**.
2. Isi Type **Secret**, Name `DEVICE_TOKEN`, dan Value berupa kata acak yang panjang. Klik **Deploy**.
3. Masukkan kata yang sama ke `firmware/mmws_esp32_http/mmws_esp32_http.ino`, bersama WiFi dan `INGEST_URL = "https://mmws.tamabyte.com/api/ingest"`.

## Update versi berikutnya
Unggah file baru ke repo GitHub yang sama, lalu klik Commit. Cloudflare memperbarui website otomatis. Data tetap tersimpan.

Panduan lengkap (PIN, simulator, firmware, perawatan) ada di PANDUAN.md.
