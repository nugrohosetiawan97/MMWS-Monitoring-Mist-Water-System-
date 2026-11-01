# MMWS v2 — cukup 5 file, tanpa folder

| File | Isi |
|---|---|
| worker.js | dashboard + server + mesin hitung (satu file) |
| wrangler.toml | pengaturan Cloudflare |
| package.json | daftar alat deploy |
| mmws_esp32_http.ino | firmware ESP32 (tidak dipakai Cloudflare, disimpan untuk Arduino IDE) |
| README.md | panduan ini |

Unggah ke GitHub: **Add file → Upload files** → seret kelima file → **Commit changes**.
Cloudflare: Build command **kosong**, Deploy command `npx wrangler deploy`, Root directory `/`.
Deploy 2 Nov 2026
