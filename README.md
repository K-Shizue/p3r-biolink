This website is inspired by P3R.


## Top4Top Converter (/converter/)

Portofolio dan converter YouTube ke Top4Top berjalan dari satu server Node.js.

```
npm install
npm start
```

Buka http://localhost:3000 (portofolio) dan http://localhost:3000/converter/ (converter).
Butuh `yt-dlp` dan `ffmpeg` terpasang di server (sudah ada di `Dockerfile`).

Catatan: converter butuh server Node.js, jadi tidak bisa jalan di GitHub Pages.
Gunakan Railway/Render/VPS (lihat `Dockerfile` dan `nixpacks.toml`).

### Pengaturan opsional (environment variable)

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `PORT` | 3000 | Port server |
| `RATE_LIMIT_MAX` | 5 | Maks konversi per IP per jendela waktu |
| `RATE_LIMIT_WINDOW_MIN` | 10 | Panjang jendela rate limit (menit) |
| `MAX_CONCURRENT` | 2 | Maks konversi yang diproses bersamaan |
| `TRUST_PROXY` | 1 | Isi `0` kalau server dibuka langsung tanpa proxy hosting |
| `YTDLP_UPDATE_HOURS` | 12 | Jeda auto-update yt-dlp (jam). `0` = matikan semua auto-update |
| `YTDLP_UPDATE_COOLDOWN_MIN` | 30 | Jeda minimal antar update darurat saat download gagal |
| `YTDLP_INSECURE` | (mati) | Isi `1` untuk mematikan verifikasi HTTPS yt-dlp, hanya jika muncul error `CERTIFICATE_VERIFY_FAILED` |

### Auto-update yt-dlp

YouTube sering berubah, jadi yt-dlp yang lama bisa mendadak gagal. Server memperbaruinya sendiri:
- saat server start, lalu tiap `YTDLP_UPDATE_HOURS` jam (ditunda kalau ada konversi berjalan);
- otomatis saat download gagal total: update sekali lalu coba ulang.

Update memakai `yt-dlp -U`, atau `pip install -U` kalau yt-dlp terpasang lewat pip. Lihat log `🔄 yt-dlp (...)` di terminal untuk versi sebelum dan sesudah.
Kalau yt-dlp terpasang lewat package manager (apt, brew, nix) atau di folder yang tidak bisa ditulis, update gagal dan tertulis peringatan di log. Update lewat package manager tersebut, atau hapus dan biarkan server mengunduh sendiri.
