/* Menu, transitions and the converter form.
   Only two destinations exist, so the menu only offers two. */

const OPTIONS = [
  { name: "CONVERT", tagline: "YouTube jadi link Top4Top", page: "convert" },
  { name: "INFO", tagline: "Cara kerja dan batasan", page: "info" }
];

const COLORS = ["fill-button-1", "fill-button-2", "fill-button-3"];
const SELECTOR_PATH = "M 24.853754, 93.31573 135.14625, 49.684266 114.14751, 97.331142 Z";
const SELECTOR_BG_PATH = "M 12.7428765,95.50088 144.25712,47.499123 116.75625,95.465764 Z";

const $ = (id) => document.getElementById(id);

const mqCoarse = window.matchMedia("(pointer: coarse)");
const mqCompact = window.matchMedia("(max-width: 1023px), (max-height: 520px)");
const mqReduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const netInfo = navigator.connection || {};
const IS_TOUCH = mqCoarse.matches;
const SAVE_DATA = !!netInfo.saveData || /(^|-)2g$/.test(netInfo.effectiveType || "");
const LOW_MEMORY = typeof navigator.deviceMemory === "number" && navigator.deviceMemory <= 4;
const USE_LITE_VIDEO = mqCompact.matches || IS_TOUCH || SAVE_DATA || LOW_MEMORY;
const LOW_POWER = SAVE_DATA || LOW_MEMORY || mqReduceMotion.matches;

document.documentElement.classList.toggle("lite", LOW_POWER);
document.documentElement.classList.toggle("touch", IS_TOUCH);

const optionsList = $("options-list");
const menuColumn = $("menu-column");
const menuHeader = document.querySelector(".menu-profile-header");
const sideNumber = $("side-number");
const loadingScreen = $("loading-screen");
const loadingBar = $("loading-bar");
const loadingPercent = $("loading-percent");
const bgIntro = $("background-video-intro");
const bgLoop = $("background-video-loop");
const toast = $("toast");

let selectedIndex = 0;
let isStarted = false;
let isLoaded = false;
let openPage = null;
let transitioning = false;

function updateMenuScale() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const portrait = h >= w;
  const narrow = w < 1100 && portrait;
  const base = narrow ? (w <= 520 ? 860 : 1150) : 640;
  const scale = Math.max(0.32, Math.min(0.9, Math.min(w / base, h / (w > h ? 640 : 520))));
  document.documentElement.style.setProperty("--menu-scale", scale.toFixed(3));
}
updateMenuScale();
let resizeRaf = 0;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(updateMenuScale);
}, { passive: true });

/* Video sources are set on demand so nothing downloads before it is needed. */
function videoSrc(video) {
  if (!video || video.dataset.srcSet === "1" || !video.dataset.video) return;
  video.dataset.srcSet = "1";
  video.src = `../assets/${video.dataset.video}${USE_LITE_VIDEO ? "-m" : ""}.mp4`;
}

function warmVideo(video) {
  if (!video) return;
  videoSrc(video);
  if (video.preload !== "auto") video.preload = "auto";
}

const pausedByVisibility = new Set();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    document.querySelectorAll("video").forEach((v) => {
      if (!v.paused && !v.ended) {
        pausedByVisibility.add(v);
        v.pause();
      }
    });
  } else {
    pausedByVisibility.forEach((v) => v.play().catch(() => {}));
    pausedByVisibility.clear();
  }
});

/* Audio: Web Audio first, HTMLAudio fallback. Cheap and enough for three files. */
let audioCtx = null;
const buffers = {};

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx({ latencyHint: "interactive" });
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}

let audioLoaded = null;
function loadAudio() {
  if (!audioLoaded) {
    audioLoaded = Promise.all(
      [
        ["nav", "../sfx/navigation.wav"],
        ["close", "../sfx/close-menu.mp3"],
        ["menu", "../sfx/menu-utama.mp3"]
      ].map(async ([key, url]) => {
        try {
          const res = await fetch(url);
          const ctx = getAudioContext();
          if (res.ok && ctx) buffers[key] = await ctx.decodeAudioData(await res.arrayBuffer());
        } catch (_) {}
      })
    );
  }
  return audioLoaded;
}

function playSound(key, volume, fallbackId) {
  const ctx = getAudioContext();
  if (ctx && ctx.state === "running" && buffers[key]) {
    try {
      const src = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = volume;
      src.buffer = buffers[key];
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(0);
      return;
    } catch (_) {}
  }
  const el = fallbackId ? $(fallbackId) : null;
  if (!el) return;
  try {
    el.currentTime = 0;
    el.volume = volume;
    el.play().catch(() => {});
  } catch (_) {}
}

const playNav = () => playSound("nav", 0.6, "sfx-navigation-el");
const playClose = () => playSound("close", 0.75, "sfx-close-menu-el");

/* Reference portfolio plays menu-utama.mp3 at 0.95 once, when loading is done.
   Same asset, same volume, same single-shot guard; only the trigger moved to
   the exact 100% paint so it lands with the loading screen exit. */
let completionSoundPlayed = false;
function playCompletionSound() {
  if (completionSoundPlayed) return;
  completionSoundPlayed = true;
  const ctx = getAudioContext();
  const fire = () => playSound("menu", 0.95, "sfx-menu-utama-el");
  if (ctx && ctx.state !== "running") {
    /* Blocked autoplay must not break loading; playSound falls back to the
       HTMLAudio element and swallows its own rejection. */
    ctx.resume().then(fire).catch(fire);
    return;
  }
  fire();
}

["pointerdown", "keydown"].forEach((evt) => {
  window.addEventListener(evt, () => { loadAudio(); getAudioContext(); }, { capture: true, passive: true, once: false });
});

/* Menu */
let menuItems = [];

function renderMenu() {
  optionsList.innerHTML = "";
  menuItems = [];

  OPTIONS.forEach((opt, index) => {
    const colorClass = COLORS[(index + 2) % COLORS.length];
    const scaleX = (opt.name.length * 0.52 + 1.6) * 1.04;
    const selectorTransform = `translate(-60, -9) rotate(8, 0, 100) scale(${scaleX}, 3.2)`;
    const maskId = `selector-mask-${index}`;

    const item = document.createElement("div");
    item.className = `option-item ${index === 0 ? "selected" : ""}`;
    item.style.zIndex = index === 0 ? 15 : index + 1;
    item.innerHTML = `
      <button type="button" class="option-hitbox" data-index="${index}" aria-label="${opt.name}"></button>
      <svg width="950" height="200" xmlns="http://www.w3.org/2000/svg" class="option-svg"
           style="transform: translate(-60px, ${30 + index * 5}px) rotate(${-14 + index * 6}deg);" aria-hidden="true">
        <defs>
          <mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="950" height="200">
            <rect width="100%" height="100%" fill="black" />
            <g transform="${selectorTransform}" transform-origin="left center">
              <path fill="white" d="${SELECTOR_PATH}" />
              <path class="pulse-anim" transform-origin="52 100" fill="white" d="${SELECTOR_BG_PATH}" />
            </g>
          </mask>
        </defs>
        <g class="selector-group" transform="${selectorTransform}" transform-origin="left center">
          <path class="fill-pink pulse-anim" transform-origin="52 100" d="${SELECTOR_BG_PATH}" />
          <path class="fill-fg" d="${SELECTOR_PATH}" />
        </g>
        <text x="150" y="122" class="option-text base-text ${colorClass}" style="font-size: 4.85rem;">${opt.name}</text>
        <g class="masked-red-group" mask="url(#${maskId})">
          <text x="150" y="122" class="option-text fill-red" style="font-size: 4.85rem;">${opt.name}</text>
        </g>
      </svg>`;

    const hitbox = item.querySelector(".option-hitbox");
    hitbox.addEventListener("mouseenter", () => selectIndex(index));
    hitbox.addEventListener("focus", () => selectIndex(index));
    hitbox.addEventListener("click", (e) => {
      selectIndex(index);
      confirmOption(index, e);
    });

    optionsList.appendChild(item);
    menuItems.push(item);
  });
}

function selectIndex(index) {
  if (index === selectedIndex && menuItems.length > 0) return;
  selectedIndex = index;
  playNav();
  sideNumber.textContent = String(index + 1).padStart(2, "0");
  if (!SAVE_DATA) warmVideo(pageVideo(OPTIONS[index].page));

  menuItems.forEach((item, i) => {
    const on = i === selectedIndex;
    item.classList.toggle("selected", on);
    item.style.zIndex = on ? 15 : i + 1;
  });
}

function pageVideo(page) {
  return page === "convert" ? $("convert-bg-video") : $("info-bg-video");
}

/* Circle wipe: sama persis dengan portofolio. Jumlah titik polygon HARUS selalu sama
   (termasuk saat radius 0), kalau tidak browser tidak bisa menganimasikannya. */
function wavyPolygon(cx, cy, r, numPoints = 72, waves1 = 7, amp1 = 0.085, waves2 = 14, amp2 = 0.035, phase = 0, scaleX = 1.25, scaleY = 1.05) {
  if (r <= 0.5) {
    const pt = `${cx.toFixed(1)}px ${cy.toFixed(1)}px`;
    return `polygon(${new Array(numPoints).fill(pt).join(", ")})`;
  }
  const points = [];
  const step = (2 * Math.PI) / numPoints;
  for (let i = 0; i < numPoints; i++) {
    const theta = i * step;
    const wave = 1 + amp1 * Math.sin(waves1 * theta + phase) + amp2 * Math.cos(waves2 * theta + phase * 1.6);
    points.push(`${(cx + r * wave * Math.cos(theta) * scaleX).toFixed(1)}px ${(cy + r * wave * Math.sin(theta) * scaleY).toFixed(1)}px`);
  }
  return `polygon(${points.join(", ")})`;
}

function radiusFor(origin) {
  return Math.ceil(Math.hypot(
    Math.max(origin.x, window.innerWidth - origin.x),
    Math.max(origin.y, window.innerHeight - origin.y)
  ) * 1.85);
}

function originFrom(el, fallbackX, fallbackY) {
  if (el) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  return { x: fallbackX, y: fallbackY };
}

/* Keep keyboard users inside the screen they just opened. */
function focusFirst(pageEl) {
  const target = pageEl.querySelector("input:not([type=hidden]), button:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])");
  if (target) target.focus({ preventScroll: true });
}

function setMenuInert(on) {
  const menu = $("menu-column");
  const hud = document.querySelector(".hud-controls");
  [menu, hud].forEach((el) => {
    if (!el) return;
    el.inert = on;
    if (on) el.setAttribute("aria-hidden", "true");
    else el.removeAttribute("aria-hidden");
  });
}

function reveal(pageEl, origin, video, bodyClass) {  transitioning = true;
  if (openPage && openPage !== pageEl) closePage(openPage, null, true);
  openPage = pageEl;

  const target = radiusFor(origin);
  pageEl.classList.add(LOW_POWER ? "fade-transitioning" : "circle-transitioning");
  pageEl.setAttribute("aria-hidden", "false");
  if (bgLoop && !bgLoop.paused) bgLoop.pause();

  if (video) {
    videoSrc(video);
    if (video.readyState > 0) video.currentTime = 0;
    video.play().catch(() => {});
  }

  const done = () => {
    pageEl.classList.remove("fade-transitioning", "circle-transitioning");
    pageEl.classList.add("active");
    if (bodyClass) document.body.classList.add(bodyClass);
    transitioning = false;
    setMenuInert(true);
    focusFirst(pageEl);
  };

  if (LOW_POWER) {
    pageEl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out", fill: "forwards" }).onfinish = done;
    return;
  }

  const anim = pageEl.animate([
    { clipPath: wavyPolygon(origin.x, origin.y, 0, 72, 7, 0.085, 14, 0.035, 0.0, 1.25, 1.05) },
    { clipPath: wavyPolygon(origin.x + 22, origin.y - 12, target * 0.45, 72, 7, 0.09, 14, 0.035, 1.2, 1.25, 1.05), offset: 0.38 },
    { clipPath: wavyPolygon(origin.x + 10, origin.y - 5, target * 0.85, 72, 7, 0.075, 14, 0.025, 2.2, 1.20, 1.05), offset: 0.70 },
    { clipPath: wavyPolygon(origin.x, origin.y, target, 72, 7, 0.05, 14, 0.015, 3.4, 1.15, 1.02) }
  ], { duration: 520, easing: "cubic-bezier(0.2, 1, 0.35, 1)", fill: "forwards" });
  anim.onfinish = () => {
    pageEl.style.clipPath = "";
    anim.cancel();
    done();
  };
}

function closePage(pageEl, origin, silent) {
  if (!pageEl) return;
  transitioning = true;
  if (!silent) playClose();

  const exit = origin || { x: window.innerWidth - 120, y: window.innerHeight - 55 };
  const target = radiusFor(exit);
  pageEl.classList.remove("active");
  pageEl.classList.add(LOW_POWER ? "fade-transitioning" : "circle-transitioning");

  const done = () => {
    pageEl.classList.remove("fade-transitioning", "circle-transitioning");
    pageEl.setAttribute("aria-hidden", "true");
    const video = pageEl.querySelector("video");
    if (video) video.pause();
    if (bgLoop && bgLoop.paused) bgLoop.play().catch(() => {});
    if (openPage === pageEl) openPage = null;
    transitioning = false;
    setMenuInert(false);
    const hitbox = menuItems[selectedIndex] && menuItems[selectedIndex].querySelector(".option-hitbox");
    if (hitbox) hitbox.focus({ preventScroll: true });
  };

  if (LOW_POWER) {
    pageEl.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease-in", fill: "forwards" }).onfinish = done;
    return;
  }

  const anim = pageEl.animate([
    { clipPath: wavyPolygon(exit.x, exit.y, target, 72, 9, 0.07, 18, 0.025, 0.0, 1.15, 1.25) },
    { clipPath: wavyPolygon(exit.x - 20, exit.y - 12, target * 0.80, 72, 9, 0.08, 18, 0.03, 1.0, 1.15, 1.25), offset: 0.32 },
    { clipPath: wavyPolygon(exit.x - 28, exit.y - 18, target * 0.42, 72, 9, 0.085, 18, 0.03, 2.0, 1.15, 1.25), offset: 0.65 },
    { clipPath: wavyPolygon(exit.x, exit.y, 0, 72, 9, 0.08, 18, 0.025, 3.0, 1.15, 1.25) }
  ], { duration: 480, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" });
  anim.onfinish = () => {
    pageEl.style.clipPath = "";
    anim.cancel();
    done();
  };
}

function confirmOption(index, clickEvent) {
  const page = OPTIONS[index].page;
  const target = $(`${page}-page`);
  const origin = clickEvent && clickEvent.clientX
    ? { x: clickEvent.clientX, y: clickEvent.clientY }
    : originFrom(menuItems[index], window.innerWidth * 0.6, window.innerHeight * 0.5);

  playNav();
  reveal(target, origin, pageVideo(page), `${page}-screen-active`);
}

function backToMenu(pageEl) {
  if (transitioning) return;
  const backBtn = pageEl.querySelector(".slink-hud-btn, #convert-back-btn");
  closePage(pageEl, originFrom(backBtn, 80, window.innerHeight - 60));
}

/* Loading screen follows the real intro download, with a hard timeout. */
let progress = 0;
let targetProgress = 25;
let skipWait = null;

function setProgress(v) {
  targetProgress = Math.min(100, Math.max(targetProgress, Math.round(v)));
}

function paintProgress(v) {
  const rounded = Math.min(100, Math.max(0, Math.round(v)));
  loadingBar.style.width = `${rounded}%`;
  loadingPercent.textContent = `${rounded}%`;
  loadingScreen.setAttribute("aria-valuenow", rounded);
  if (rounded >= 100) playCompletionSound();
}

function tickProgress() {
  return new Promise((resolve) => {
    function tick() {
      if (progress < targetProgress) {
        progress = Math.min(targetProgress, progress + Math.max(1, Math.ceil((targetProgress - progress) * 0.35)));
        paintProgress(progress);
      }
      if (progress >= 100) resolve();
      else requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });
}

function waitForVideo(video, timeoutMs) {
  return new Promise((resolve) => {
    if (!video) return resolve();
    let settled = false;
    let timer = 0;
    const events = ["canplay", "canplaythrough", "error", "abort"];

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      skipWait = null;
      events.forEach((e) => video.removeEventListener(e, finish));
      video.removeEventListener("progress", onProgress);
      resolve();
    };

    const onProgress = () => {
      const d = video.duration;
      if (d > 0 && video.buffered.length) {
        setProgress(25 + Math.min(1, video.buffered.end(video.buffered.length - 1) / d) * 65);
      }
    };

    if (video.readyState >= 3) return finish();
    events.forEach((e) => video.addEventListener(e, finish));
    video.addEventListener("progress", onProgress);
    skipWait = finish;
    timer = setTimeout(finish, timeoutMs);
  });
}

async function startLoading() {
  const ticker = tickProgress();
  warmVideo(bgIntro);
  setProgress(25);
  loadAudio();

  // Never let a slow video stall entry: the app is usable before the backdrop arrives.
  const failSafe = new Promise((r) => setTimeout(r, IS_TOUCH ? 4000 : 6000));

  const fonts = (document.fonts && document.fonts.ready
    ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1200))])
    : Promise.resolve()
  ).catch(() => {});

  await Promise.all([fonts, Promise.race([waitForVideo(bgIntro, IS_TOUCH ? 2500 : 5000), failSafe])]);
  setProgress(100);
  await Promise.race([ticker, new Promise((r) => setTimeout(r, 2500))]);
  paintProgress(100);
  isLoaded = true;
  enterApp();
}

function enterApp() {
  if (isStarted) return;
  isStarted = true;

  /* Covers the skip path (click or Enter before 100). The guard in
     playCompletionSound keeps it to one sound per loading cycle. */
  playCompletionSound();

  loadingScreen.classList.add("dismissed");
  setTimeout(() => { loadingScreen.style.display = "none"; }, 450);

  menuColumn.classList.add("menu-entered");
  menuHeader.classList.add("menu-entered");

  if (bgIntro) {
    warmVideo(bgIntro);
    if (bgIntro.readyState > 0) bgIntro.currentTime = 0;
    bgIntro.play().catch(() => switchToLoop());
  }
  setTimeout(() => warmVideo(pageVideo(OPTIONS[selectedIndex].page)), 2500);
}

let loopSwitched = false;
function switchToLoop() {
  if (loopSwitched || !bgLoop) return;
  loopSwitched = true;
  warmVideo(bgLoop);
  if (bgLoop.readyState > 0) bgLoop.currentTime = 0;
  bgLoop.play()
    .then(() => {
      if (bgIntro) {
        bgIntro.classList.add("fade-out");
        setTimeout(() => { bgIntro.pause(); bgIntro.style.display = "none"; }, 300);
      }
    })
    .catch(() => { if (bgIntro) bgIntro.classList.add("fade-out"); });
}

if (bgIntro) {
  bgIntro.addEventListener("ended", switchToLoop);
  bgIntro.addEventListener("error", switchToLoop);
  bgIntro.addEventListener("timeupdate", () => {
    if (!loopSwitched && bgIntro.duration > 0 && bgIntro.currentTime >= bgIntro.duration - 0.1) switchToLoop();
  });
}

/* Converter */
const form = $("convert-form");
const urlInput = $("ytUrl");
const pasteBtn = $("pasteBtn");
const generateBtn = $("generateBtn");
const btnText = $("btnText");
const convProgress = $("convProgress");
const resultEmpty = $("resultEmpty");
const resultSuccess = $("resultSuccess");
const resultError = $("resultError");
const resultTitle = $("resultTitle");
const resultUrl = $("resultUrl");
const openBtn = $("openBtn");
const copyBtn = $("copyBtn");

/* Same shapes the server accepts in extractVideoId. */
const VIDEO_ID = [
  /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/
];

function isYouTubeUrl(value) {
  return VIDEO_ID.some((p) => p.test(value));
}

let toastTimer = 0;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setBusy(on) {
  generateBtn.disabled = on;
  btnText.textContent = on ? "Memproses" : "Generate dan Upload";
  convProgress.hidden = !on;
}

function showEmpty() {
  resultEmpty.hidden = false;
  resultSuccess.hidden = true;
  resultError.hidden = true;
}

/* Map backend wording to something a visitor can act on, keep the raw text one click away. */
function describeError(raw) {
  if (/Command failed|Download gagal|yt-dlp|ffmpeg/i.test(raw)) {
    return "Server gagal mengunduh audio dari YouTube. Coba lagi beberapa saat.";
  }
  if (/Upload berhasil tapi link/i.test(raw)) {
    return "Audio sudah diunggah, tetapi Top4Top tidak mengirim link. Coba lagi.";
  }
  if (/URL YouTube tidak valid/i.test(raw)) {
    return "Link YouTube tidak dikenali server. Pakai watch, youtu.be, shorts, atau embed.";
  }
  if (/Terlalu banyak permintaan|Server sedang sibuk|Upload ke Top4Top gagal|menyiapkan yt-dlp|Permintaan (terlalu besar|tidak valid)/i.test(raw)) {
    return raw;
  }
  return "Server tidak bisa menyelesaikan permintaan.";
}

function showError(message, raw) {
  resultEmpty.hidden = true;
  resultSuccess.hidden = true;
  resultError.hidden = false;
  $("resultErrorText").textContent = message;
  const detail = $("resultErrorDetail");
  const detailText = raw || "";
  $("resultErrorRaw").textContent = detailText;
  detail.hidden = !detailText || detailText === message;
  revealResult();
}

function revealResult() {
  const row = $("row-result");
  if (row) row.scrollIntoView({ block: "nearest" });
}

function showSuccess(title, url) {
  resultEmpty.hidden = true;
  resultError.hidden = true;
  resultSuccess.hidden = false;
  const label = title && title.trim() && title.trim().toLowerCase() !== "audio" ? `Judul: ${title.trim()}` : "";
  resultTitle.textContent = label;
  resultTitle.hidden = !label;
  resultUrl.textContent = url;
  resultUrl.href = url;
  openBtn.href = url;
  revealResult();
}

pasteBtn.addEventListener("click", async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return showToast("Clipboard kosong.");
    urlInput.value = text;
    urlInput.focus();
    showToast(isYouTubeUrl(text) ? "Link ditempel." : "Ditempel, tapi bukan link YouTube.");
  } catch {
    urlInput.focus();
    showToast("Akses clipboard ditolak browser.");
  }
});

urlInput.addEventListener("focus", async () => {
  if (urlInput.value) return;
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (isYouTubeUrl(text)) {
      urlInput.value = text;
      showToast("Link YouTube terdeteksi di clipboard.");
    }
  } catch (_) {}
});

copyBtn.addEventListener("click", async () => {
  const url = resultUrl.textContent;
  if (!url) return;
  try {
    await navigator.clipboard.writeText(url);
    showToast("Link disalin.");
  } catch {
    showToast("Browser menolak akses clipboard. Salin manual dari tautan.");
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();

  if (!url) {
    showError("URL masih kosong. Tempel link video YouTube dulu.");
    urlInput.focus();
    return;
  }
  if (!isYouTubeUrl(url)) {
    showError("Itu bukan link YouTube yang dikenali server. Pakai watch, youtu.be, shorts, atau embed.");
    urlInput.focus();
    return;
  }

  showEmpty();
  setBusy(true);
  const started = performance.now();

  try {
    const res = await fetch("../api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    const data = await res.json().catch(() => null);

    if (!data) {
      showError(`Server menolak permintaan (HTTP ${res.status}). Coba lagi.`);
      return;
    }
    if (!res.ok && !data.error) {
      showError(`Server menolak permintaan (HTTP ${res.status}). Coba lagi.`);
      return;
    }
    if (data.success && data.url) {
      showSuccess(data.title, data.url);
      showToast("Upload selesai.");
      return;
    }
    const raw = data.error || "";
    showError(describeError(raw), raw);
  } catch (err) {
    showError("Tidak bisa menghubungi server. Pastikan proses node berjalan, lalu coba lagi.", err.message);
  } finally {
    setBusy(false);
    const seconds = Math.round((performance.now() - started) / 1000);
    if (seconds > 3) $("progressText").textContent = `Server selesai memproses dalam sekitar ${seconds} detik.`;
  }
});

/* ESC di menu utama: kembali ke portofolio (satu folder di atas /converter/). */
let isLeaving = false;
function backToPortfolio() {
  if (isLeaving) return;
  isLeaving = true;
  playClose();
  setTimeout(() => { window.location.href = "../"; }, 250);
}

/* Keyboard: arrows move, Enter confirms, Escape returns. */
document.addEventListener("keydown", (e) => {
  if (!isStarted) {
    if (isLoaded || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      enterApp();
    }
    return;
  }

  if (openPage) {
    if (e.key === "Escape" || e.key.toLowerCase() === "b") {
      e.preventDefault();
      backToMenu(openPage);
    }
    return;
  }

  if (e.key === "Escape" || e.key.toLowerCase() === "b") {
    e.preventDefault();
    backToPortfolio();
  } else if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") {
    e.preventDefault();
    selectIndex((selectedIndex + 1) % OPTIONS.length);
  } else if (e.key === "ArrowUp" || e.key.toLowerCase() === "w") {
    e.preventDefault();
    selectIndex((selectedIndex - 1 + OPTIONS.length) % OPTIONS.length);
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    confirmOption(selectedIndex);
  }
});

$("home-back-btn").addEventListener("click", backToPortfolio);
$("convert-back-btn").addEventListener("click", () => backToMenu($("convert-page")));
$("info-back-btn").addEventListener("click", () => backToMenu($("info-page")));

if (loadingScreen) {
  loadingScreen.addEventListener("click", () => {
    if (skipWait) skipWait();
    else if (isLoaded) enterApp();
  });
}

renderMenu();
selectIndex(0);
startLoading();
