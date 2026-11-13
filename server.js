/**
 * YT2Top - YouTube to Top4Top Uploader
 * Jalankan: node server.js
 * Buka:     http://localhost:3000
 *
 * Install dulu:
 *   npm install
 *   sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp
 */

import express from "express";
import axios from "axios";
import FormData from "form-data";
import * as cheerio from "cheerio";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const execAsync = promisify(exec);
const app = express();

// ─── Pengaturan keamanan & batas pemakaian (bisa diubah lewat environment variable) ───
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 5;               // konversi per IP
const RATE_LIMIT_WINDOW_MS = (Number(process.env.RATE_LIMIT_WINDOW_MIN) || 10) * 60 * 1000;
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 2;               // konversi bersamaan
// Verifikasi sertifikat HTTPS yt-dlp aktif secara default. Set YTDLP_INSECURE=1 hanya jika
// jaringan/antivirus kamu memaksa (contoh error: CERTIFICATE_VERIFY_FAILED).
// Auto-update yt-dlp: saat server start, lalu tiap YTDLP_UPDATE_HOURS jam (0 = matikan semua auto-update).
// Kalau download gagal total, server mencoba update sekali lalu mengulang (maks 1x per YTDLP_UPDATE_COOLDOWN_MIN menit).
const UPDATE_HOURS = process.env.YTDLP_UPDATE_HOURS === undefined ? 12 : (Number(process.env.YTDLP_UPDATE_HOURS) || 0);
const UPDATE_COOLDOWN_MS = (process.env.YTDLP_UPDATE_COOLDOWN_MIN === undefined ? 30 : Number(process.env.YTDLP_UPDATE_COOLDOWN_MIN) || 0) * 60 * 1000;
const TLS_FLAG = process.env.YTDLP_INSECURE === "1" ? " --no-check-certificate" : "";

app.disable("x-powered-by");
// Di belakang proxy hosting (Railway/Render/dll) IP asli ada di header X-Forwarded-For.
// TRUST_PROXY=0 kalau server dibuka langsung tanpa proxy (supaya header tidak bisa dipalsukan).
app.set("trust proxy", process.env.TRUST_PROXY === "0" ? false : 1);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "2kb" }));

// Rate limiter sederhana di memori (tanpa dependency baru): maks RATE_LIMIT_MAX konversi per IP per jendela waktu.
const rateHits = new Map();
function takeRateSlot(ip) {
  const now = Date.now();
  const hits = (rateHits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    rateHits.set(ip, hits);
    return { ok: false, retryAfterSec: Math.ceil((RATE_LIMIT_WINDOW_MS - (now - hits[0])) / 1000) };
  }
  hits.push(now);
  rateHits.set(ip, hits);
  return { ok: true };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of rateHits) {
    const fresh = hits.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length) rateHits.set(ip, fresh); else rateHits.delete(ip);
  }
}, 60 * 1000).unref();
let activeJobs = 0;

// Portofolio + converter disajikan dari satu server.
// Hanya folder publik yang dibuka (server.js / package.json tidak ikut terbuka).
const ROOT = path.dirname(fileURLToPath(import.meta.url));
for (const dir of ["assets", "css", "fonts", "js", "sfx", "converter"]) {
  app.use("/" + dir, express.static(path.join(ROOT, dir)));
}
app.get(["/", "/index.html"], (_, res) => res.sendFile(path.join(ROOT, "index.html")));

// ─── top4top Upload Logic ────────────────────────────────────────────────────
const TOP4TOP = "https://top4top.io";
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36";

function makeClient() {
  const jar = new CookieJar();
  return {
    jar,
    client: wrapper(axios.create({
      baseURL: TOP4TOP, jar, withCredentials: true, timeout: 180000,
      validateStatus: () => true,
      headers: { "user-agent": UA, "accept-language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7" }
    }))
  };
}

function getCookieSid(jar) {
  return jar.getCookiesSync(TOP4TOP).find(c => c.key === "sid")?.value || "";
}

function parseResultUrl(html) {
  const $ = cheerio.load(html);

  // ── Prioritas 1: Link CDN langsung (e.top4top.io / f.top4top.io / subdomain lain)
  // Format: http://e.top4top.io/m_XXXXX.mp3
  const cdnFromInput = $('input[value]').toArray()
    .map(el => $(el).attr("value")?.trim())
    .find(v => v && /^https?:\/\/[a-z]\.top4top\.io\//i.test(v));
  if (cdnFromInput) return cdnFromInput;

  const cdnFromAnchor = $('a[href]').toArray()
    .map(el => $(el).attr("href")?.trim())
    .find(h => h && /^https?:\/\/[a-z]\.top4top\.io\//i.test(h));
  if (cdnFromAnchor) return cdnFromAnchor;

  // ── Prioritas 2: Input/anchor dengan ekstensi audio
  const audioExt = /\.(mp3|m4a|ogg|webm|aac|flac|wav)(\?.*)?$/i;
  const audioFromInput = $('input[value]').toArray()
    .map(el => $(el).attr("value")?.trim())
    .find(v => v && audioExt.test(v));
  if (audioFromInput) return audioFromInput;

  const audioFromAnchor = $('a[href]').toArray()
    .map(el => $(el).attr("href")?.trim())
    .find(h => h && audioExt.test(h));
  if (audioFromAnchor) return audioFromAnchor;

  // ── Prioritas 3: Field berlabel "direct" / "رابط مباشر"
  let labeledDirect = null;
  $(".inputbody").each((_, el) => {
    const title = $(el).find(".btitle").text().trim().toLowerCase();
    const value = $(el).find("input").attr("value")?.trim();
    if (value && (title.includes("مباشر") || title.includes("direct") || title.includes("download")))
      labeledDirect = value;
  });
  if (labeledDirect) return labeledDirect;

  // ── Prioritas 4: Halaman share /p_ atau /a_ (akan di-resolve oleh resolveDirectUrl)
  return $('input[value*="top4top.io/p_"]').attr("value")?.trim()
    || $('input[value*="top4top.io/a_"]').attr("value")?.trim()
    || $('a[href*="top4top.io/p_"]').attr("href")?.trim()
    || $('a[href*="top4top.io/a_"]').attr("href")?.trim()
    || null;
}

/**
 * Jika URL yang didapat masih halaman share (.html), fetch halaman itu
 * dan cari link direct download audio di dalamnya.
 */
async function resolveDirectUrl(shareUrl, client) {
  // Sudah link CDN / audio - tidak perlu resolve
  if (/^https?:\/\/[a-z]\.top4top\.io\//i.test(shareUrl)) return shareUrl;
  if (/\.(mp3|m4a|ogg|webm|aac|flac|wav)(\?.*)?$/i.test(shareUrl)) return shareUrl;

  // Fetch halaman share
  try {
    const res = await client.get(shareUrl, {
      headers: { accept: "text/html,*/*", referer: TOP4TOP + "/" }
    });
    const $ = cheerio.load(res.data || "");

    // Cari link audio di halaman share
    const cdnLink =
      $('a[href]').toArray().map(el => $(el).attr("href")?.trim())
        .find(h => h && /^https?:\/\/[a-z]\.top4top\.io\//i.test(h))
      || $('source[src]').toArray().map(el => $(el).attr("src")?.trim())
        .find(s => s && /top4top\.io/i.test(s))
      || $('[data-url]').toArray().map(el => $(el).attr("data-url")?.trim())
        .find(u => u && /top4top\.io/i.test(u));

    if (cdnLink) return cdnLink;

    // Cari di semua input / anchor dengan ekstensi audio
    const audioExt = /\.(mp3|m4a|ogg|webm|aac|flac|wav)(\?.*)?$/i;
    const audioLink =
      $('a[href]').toArray().map(el => $(el).attr("href")?.trim()).find(h => h && audioExt.test(h))
      || $('input[value]').toArray().map(el => $(el).attr("value")?.trim()).find(v => v && audioExt.test(v));

    if (audioLink) return audioLink;
  } catch (e) {
    console.warn("⚠️ resolveDirectUrl gagal:", e.message);
  }

  // Kembalikan URL asli kalau tidak ketemu
  return shareUrl;
}

async function getSid(client, jar) {
  const res = await client.get("/", { headers: { accept: "text/html,*/*", referer: `${TOP4TOP}/` } });
  const $ = cheerio.load(res.data || "");
  return $('input[name="sid"]').attr("value") || getCookieSid(jar);
}

async function uploadToTop4top(filePath, mimeType = "audio/mpeg") {
  const { jar, client } = makeClient();
  const sid = await getSid(client, jar);
  const form = new FormData();
  if (sid) form.append("sid", sid);
  /* Top4Top numbers upload slots from 1; file_0_ is only the URL-field slot.
     The old file_0_ + duplicate empty fields made PHP drop the upload. */
  form.append("file_1_", fs.createReadStream(filePath), { filename: path.basename(filePath), contentType: mimeType });
  for (let i = 2; i <= 10; i++) form.append(`file_${i}_`, "");
  form.append("submitr", "[ رفع الملفات ]");
  const res = await client.post("/index.php", form, {
    maxBodyLength: Infinity, maxContentLength: Infinity,
    headers: {
      ...form.getHeaders(),
      accept: "text/html,*/*", origin: TOP4TOP, referer: `${TOP4TOP}/`,
      "upgrade-insecure-requests": "1",
      "sec-ch-ua": '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      "sec-ch-ua-mobile": "?1", "sec-ch-ua-platform": '"Android"',
      "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate",
      "sec-fetch-user": "?1", "sec-fetch-dest": "document"
    }
  });

  // Log nilai input dan anchor dari halaman hasil upload
  const $dbg = cheerio.load(res.data || "");
  const allInputs = $dbg('input[value]').toArray().map(el => $dbg(el).attr("value")?.trim()).filter(Boolean);
  const allAnchors = $dbg('a[href]').toArray().map(el => $dbg(el).attr("href")?.trim()).filter(v => v && v.includes("top4top"));
  console.log("📄 Input values di halaman hasil:", allInputs.slice(0, 10));
  console.log("🔗 Anchor hrefs top4top:", allAnchors.slice(0, 10));

  const rawUrl = parseResultUrl(res.data || "");
  if (!rawUrl) return null;

  console.log(`🔍 URL mentah dari parse: ${rawUrl}`);
  const directUrl = await resolveDirectUrl(rawUrl, client);
  console.log(`✅ URL direct final: ${directUrl}`);
  return directUrl;
}

// ─── YouTube Audio Download ───────────────────────────────────────────────────
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

/* Linux (Docker/Render) keeps the original /tmp flow; Windows uses its own
   binary name and the OS temp folder so the app can run locally too. */
const IS_WIN = process.platform === "win32";

async function installYtdlp() {
  const binPath = IS_WIN
    ? path.join(os.tmpdir(), "yt-dlp.exe")
    : "/tmp/yt-dlp";
  // Kalau sudah ada skip
  if (fs.existsSync(binPath)) {
    try { await execAsync(`"${binPath}" --version`); return binPath; } catch {}
  }
  console.log("⬇️  Menginstall yt-dlp...");
  const asset = IS_WIN ? "yt-dlp.exe" : "yt-dlp";
  const chmod = IS_WIN ? "" : ` && chmod +x "${binPath}"`;
  await execAsync(
    `curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset} -o "${binPath}"${chmod}`,
    { timeout: 60000 }
  );
  console.log("✅ yt-dlp berhasil diinstall");
  return binPath;
}

async function getYtdlpBin() {
  // 1. cek PATH dulu
  const lookup = IS_WIN ? "where" : "which";
  try { const { stdout } = await execAsync(`${lookup} yt-dlp`); if (stdout.trim()) return "yt-dlp"; } catch {}
  try { const { stdout } = await execAsync(`${lookup} youtube-dl`); if (stdout.trim()) return "youtube-dl"; } catch {}
  // 2. cek lokasi hasil auto-install
  const cached = IS_WIN ? path.join(os.tmpdir(), "yt-dlp.exe") : "/tmp/yt-dlp";
  if (fs.existsSync(cached)) return cached;
  // 3. auto install
  return await installYtdlp();
}

let updatePromise = null;
let lastUpdateAt = 0;

async function ytdlpVersion(bin) {
  try { const { stdout } = await execAsync(bin + ' --version', { timeout: 15000 }); return stdout.trim() || "?"; }
  catch { return "?"; }
}

// Update yt-dlp. Aman dipanggil bersamaan: kalau update sedang jalan, pemanggil lain ikut menunggu hasil yang sama.
function updateYtdlp(reason) {
  if (UPDATE_HOURS <= 0) return Promise.resolve({ changed: false });
  if (updatePromise) return updatePromise;
  updatePromise = (async () => {
    let changed = false;
    try {
      const bin = await getYtdlpBin();
      const before = await ytdlpVersion(bin);
      let output = "";
      // Tanpa "2>/dev/null": redirect itu tidak valid di cmd.exe Windows.
      try { const r = await execAsync(bin + ' -U', { timeout: 120000 }); output = (r.stdout || "") + (r.stderr || ""); }
      catch (e) { output = (e.stdout || "") + (e.stderr || "") + (e.message || ""); }
      // yt-dlp hasil "pip install" / package manager menolak -U, update lewat pip.
      if (/pip|pypi|package manager/i.test(output)) {
        const pipCmd = IS_WIN ? 'python -m pip install -U yt-dlp' : 'python3 -m pip install -U yt-dlp --break-system-packages';
        try { await execAsync(pipCmd, { timeout: 180000 }); } catch (e) { output += "\n" + (e.message || ""); }
      }
      const after = await ytdlpVersion(bin);
      changed = after !== "?" && before !== after;
      console.log(`🔄 yt-dlp (${reason}): ${before} → ${after}${changed ? " (diperbarui)" : " (tidak berubah)"}`);
      if (!changed && /error|permission|denied|read-only/i.test(output)) {
        console.warn("⚠️  Update yt-dlp bermasalah:", output.trim().slice(0, 300));
      }
    } catch (e) {
      console.warn("⚠️  Update yt-dlp gagal:", e.message);
    } finally {
      lastUpdateAt = Date.now();
      updatePromise = null;
    }
    return { changed };
  })();
  return updatePromise;
}

function scheduleYtdlpUpdates() {
  if (UPDATE_HOURS <= 0) { console.log("ℹ️  Auto-update yt-dlp dimatikan (YTDLP_UPDATE_HOURS=0)"); return; }
  updateYtdlp("startup");
  const run = () => {
    if (activeJobs > 0) { setTimeout(run, 60 * 1000).unref(); return; }   // jangan update di tengah konversi
    updateYtdlp("terjadwal");
  };
  setInterval(run, UPDATE_HOURS * 60 * 60 * 1000).unref();
}

async function getYoutubeInfo(url, bin) {
  const cmd = bin + ' --dump-json --no-playlist' + TLS_FLAG + ' '
    + '--extractor-args "youtube:player_client=tv,web" '
    + '--add-header "Accept-Language:en-US,en;q=0.9" '
    + '"' + url + '"';
  const { stdout } = await execAsync(cmd, { timeout: 30000 });
  return JSON.parse(stdout.trim());
}

// Daftar strategi download - dicoba satu per satu sampai berhasil
const DL_STRATEGIES = [
  // Strategi 1: TV client (paling sering bypass bot detection)
  (bin, tpl, url) => bin + ' -x --audio-format mp3 --audio-quality 5' + TLS_FLAG + ' '
    + '--extractor-args "youtube:player_client=tv,web" '
    + '--add-header "Accept-Language:en-US,en;q=0.9" '
    + '-o "' + tpl + '" "' + url + '"',

  // Strategi 2: Android client
  (bin, tpl, url) => bin + ' -x --audio-format mp3 --audio-quality 5' + TLS_FLAG + ' '
    + '--extractor-args "youtube:player_client=android" '
    + '--add-header "Accept-Language:en-US,en;q=0.9" '
    + '-o "' + tpl + '" "' + url + '"',

  // Strategi 3: mweb client
  (bin, tpl, url) => bin + ' -x --audio-format mp3 --audio-quality 5' + TLS_FLAG + ' '
    + '--extractor-args "youtube:player_client=mweb" '
    + '--sleep-requests 2 --min-sleep-interval 2 '
    + '--add-header "Accept-Language:en-US,en;q=0.9" '
    + '-o "' + tpl + '" "' + url + '"',

  // Strategi 4: bestaudio tanpa convert
  (bin, tpl, url) => bin + ' -f "bestaudio/best"' + TLS_FLAG + ' '
    + '--extractor-args "youtube:player_client=tv" '
    + '-o "' + tpl + '" "' + url + '"',
];

async function downloadYoutubeAudio(url, bin, tag) {
  const tmpDir = os.tmpdir();
  const prefix = 'yt_' + (tag || extractVideoId(url));   // unik per permintaan, jadi dua pengguna tidak saling menimpa file
  const tpl = path.join(tmpDir, prefix + '_%(title)s.%(ext)s');

  let lastError = null;
  const runStrategies = async () => {
    for (let i = 0; i < DL_STRATEGIES.length; i++) {
      const cmd = DL_STRATEGIES[i](bin, tpl, url) + ' 2>&1';
      console.log('⚙️  Strategi ' + (i + 1) + ': ' + cmd);
      try {
        await execAsync(cmd, { timeout: 200000 });
        const mp3Files = fs.readdirSync(tmpDir).filter(f => f.startsWith(prefix) && f.endsWith('.mp3'));
        if (mp3Files.length > 0) return { filePath: path.join(tmpDir, mp3Files[0]), ext: 'mp3' };
        const anyFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith(prefix));
        if (anyFiles.length > 0) return { filePath: path.join(tmpDir, anyFiles[0]), ext: path.extname(anyFiles[0]).slice(1) };
        console.warn('⚠️  Strategi ' + (i + 1) + ' jalan tapi file tidak ditemukan, coba berikutnya...');
      } catch (err) {
        lastError = err;
        console.warn('⚠️  Strategi ' + (i + 1) + ' gagal: ' + (err.stdout || err.message || '').slice(0, 300));
        fs.readdirSync(tmpDir).filter(f => f.startsWith(prefix)).forEach(f => {
          try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
        });
      }
    }

    return null;
  };

  let result = await runStrategies();
  if (result) return result;

  // Semua strategi gagal: biasanya yt-dlp kedaluwarsa karena YouTube berubah. Update sekali lalu coba lagi.
  if (UPDATE_HOURS > 0 && Date.now() - lastUpdateAt >= UPDATE_COOLDOWN_MS) {
    console.log('🩹 Semua strategi gagal. Update yt-dlp lalu ulangi sekali...');
    const { changed } = await updateYtdlp('self-heal');
    if (changed) {
      result = await runStrategies();
      if (result) return result;
    }
  }

  const errDetail = (lastError && (lastError.stdout || lastError.stderr || lastError.message)) || 'Semua strategi gagal';
  throw new Error('Download gagal setelah ' + DL_STRATEGIES.length + ' percobaan.\n' + errDetail);
}

// ─── Routes ──────────────────────────────────────────────────────────────────
app.post("/api/generate", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") return res.json({ success: false, error: "URL tidak boleh kosong" });

  const videoId = extractVideoId(url);
  if (!videoId) return res.json({ success: false, error: "URL YouTube tidak valid" });
  // KEAMANAN: jangan pernah kirim URL mentah dari pengguna ke shell (exec). extractVideoId hanya
  // mencari pola di dalam teks, jadi URL berisi tanda kutip atau $(...) bisa lolos validasi dan
  // menjalankan perintah di server. Bangun ulang URL dari ID 11 karakter [A-Za-z0-9_-] yang aman.
  const safeUrl = "https://www.youtube.com/watch?v=" + videoId;

  const slot = takeRateSlot(req.ip);
  if (!slot.ok) {
    res.set("Retry-After", String(slot.retryAfterSec));
    const minutes = Math.max(1, Math.ceil(slot.retryAfterSec / 60));
    return res.status(429).json({ success: false, error: `Terlalu banyak permintaan. Coba lagi sekitar ${minutes} menit lagi.` });
  }
  if (activeJobs >= MAX_CONCURRENT) {
    return res.status(503).json({ success: false, error: "Server sedang sibuk memproses konversi lain. Coba lagi sebentar lagi." });
  }
  activeJobs++;

  const tag = videoId + "_" + crypto.randomBytes(4).toString("hex");
  let stage = "info";
  let tmpFile = null;
  try {
    const bin = await getYtdlpBin();
    console.log(`\n[1/3] Info video: ${safeUrl}`);
    let title = "Audio";
    try { const info = await getYoutubeInfo(safeUrl, bin); title = info.title || "Audio"; } catch {}

    console.log(`[2/3] Download audio...`);
    stage = "download";
    const { filePath, ext } = await downloadYoutubeAudio(safeUrl, bin, tag);
    tmpFile = filePath;
    const mimeMap = { mp3: "audio/mpeg", m4a: "audio/mp4", webm: "audio/webm", ogg: "audio/ogg" };

    console.log(`[3/3] Upload ke top4top...`);
    stage = "upload";
    const resultUrl = await uploadToTop4top(filePath, mimeMap[ext] || "audio/mpeg");

    if (!resultUrl) return res.json({ success: false, error: "Upload berhasil tapi link tidak ditemukan. Coba lagi." });

    console.log(`✅ Done: ${resultUrl}`);
    res.json({ success: true, url: resultUrl, title });
  } catch (err) {
    // Detail teknis hanya masuk log server. Pengguna cuma menerima pesan singkat yang aman
    // (tanpa path folder, perintah, atau output mentah yt-dlp).
    console.error("❌ ERROR (" + stage + "):", err.message);
    if (err.stderr) console.error("❌ STDERR:", err.stderr);
    if (err.stdout) console.error("❌ STDOUT:", err.stdout);
    const safeMsg = stage === "upload"
      ? "Upload ke Top4Top gagal. Coba lagi nanti."
      : stage === "download"
        ? "Download gagal. Video mungkin privat, dibatasi umur atau wilayah, atau YouTube sedang memblokir server. Coba lagi nanti."
        : "Server gagal menyiapkan yt-dlp. Coba lagi nanti.";
    res.json({ success: false, error: safeMsg });
  } finally {
    activeJobs--;
    // Bersihkan semua file sementara milik permintaan ini (termasuk sisa file perantara).
    try {
      const prefix = "yt_" + tag;
      fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(prefix)).forEach(f => {
        try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch {}
      });
    } catch {}
    if (tmpFile) try { fs.unlinkSync(tmpFile); } catch {}
  }
});

app.get("/api/health", (_, res) => res.json({ ok: true }));

// Error express (JSON rusak, body terlalu besar) dijawab JSON singkat, bukan halaman error dengan stack trace.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const tooBig = err && err.type === "entity.too.large";
  res.status(tooBig ? 413 : 400).json({ success: false, error: tooBig ? "Permintaan terlalu besar." : "Permintaan tidak valid." });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`\n🚀 Server berjalan di http://localhost:${PORT}`);
  console.log(`   Buka di browser: http://localhost:${PORT}\n`);
  try { await getYtdlpBin(); } catch (e) { console.warn("⚠️ Auto-install yt-dlp gagal:", e.message); }   // pakai yt-dlp di PATH kalau ada, kalau tidak baru download
  scheduleYtdlpUpdates();
});
