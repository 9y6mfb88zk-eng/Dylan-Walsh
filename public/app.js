// JARVIS front-end: voice loop, orb animation, widgets, tabs, PWA plumbing.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let cfg = null;
let loc = store.get("loc", null);

// ------------------------------------------------------------------ API
async function api(path, { method = "GET", body, raw, headers = {}, signal } = {}) {
  const res = await fetch(path, {
    method, signal, credentials: "same-origin",
    headers: raw ? headers : body !== undefined ? { "content-type": "application/json", ...headers } : headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  if (res.status === 401 && path !== "/api/login") { showGate(); throw new Error("Passcode required"); }
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("json") ? await res.json() : res;
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms);
}

// ------------------------------------------------------------------ Orb state + level
const orbEl = $("#orb"), captionEl = $("#caption"), waveEl = $("#wave"), micBtn = $("#mic");
let state = "idle";
function setState(s) {
  state = s; orbEl.dataset.state = s;
  waveEl.classList.toggle("on", s !== "idle");
  micBtn.classList.toggle("live", s === "listening");
}
function setCaption(text, { user = false } = {}) {
  captionEl.classList.toggle("user", user);
  captionEl.textContent = text || "";
}

const BARS = 28;
for (let i = 0; i < BARS; i++) waveEl.appendChild(document.createElement("span"));
const bars = $$("span", waveEl);

let audioCtx = null, outAnalyser = null, micAnalyser = null;
const freq = new Uint8Array(256), td = new Uint8Array(1024);
let simLevel = 0, simTarget = 0; // used for browser TTS / Web Speech where no real signal exists

function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    outAnalyser = audioCtx.createAnalyser();
    outAnalyser.fftSize = 512; outAnalyser.smoothingTimeConstant = 0.6;
    outAnalyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") audioCtx.resume();
  // iOS unlock: play one silent frame inside the gesture.
  const b = audioCtx.createBuffer(1, 1, 22050), s = audioCtx.createBufferSource();
  s.buffer = b; s.connect(audioCtx.destination); s.start(0);
  return audioCtx;
}

function rms(analyser) {
  analyser.getByteTimeDomainData(td);
  let sum = 0;
  for (let i = 0; i < analyser.fftSize && i < td.length; i++) { const v = (td[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / Math.min(analyser.fftSize, td.length));
}

// Ripple rings drawn on canvas, spawned from audio peaks.
const cv = $("#ripples"), cx2 = cv.getContext("2d");
const ripples = [];
let lastSpawn = 0, level = 0, prevLevel = 0;
function resizeCanvas() {
  const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  cv.width = r.width * dpr; cv.height = r.height * dpr; cx2.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", resizeCanvas);

function frame(t) {
  let raw = 0, bandSource = null;
  if (state === "speaking" && speaker.realAudio && outAnalyser) { raw = Math.min(1, rms(outAnalyser) * 3.2); bandSource = outAnalyser; }
  else if (state === "listening" && micAnalyser) { raw = Math.min(1, rms(micAnalyser) * 4); bandSource = micAnalyser; }
  else {
    // Simulated envelope: lively for browser speech, calm for listening/thinking.
    if (state === "speaking") { if (Math.random() < 0.18) simTarget = 0.25 + Math.random() * 0.7; }
    else if (state === "listening") simTarget = 0.12 + 0.08 * Math.sin(t / 380);
    else if (state === "thinking") simTarget = 0.1 + 0.08 * Math.sin(t / 220);
    else simTarget = 0;
    simLevel += (simTarget - simLevel) * 0.18;
    raw = simLevel;
  }
  const cap = state === "speaking" ? 1 : 0.55; // calmer for listening / thinking
  level += (Math.min(raw, cap) - level) * (raw > level ? 0.5 : 0.12);
  document.documentElement.style.setProperty("--level", level.toFixed(3));

  // Waveform bars
  if (bandSource) bandSource.getByteFrequencyData(freq);
  for (let i = 0; i < BARS; i++) {
    const mid = Math.abs(i - (BARS - 1) / 2) / (BARS / 2);
    let v;
    if (bandSource) { const idx = Math.floor(2 + (i < BARS / 2 ? BARS / 2 - i : i - BARS / 2) * 2.2); v = freq[idx] / 255; }
    else v = level * (0.55 + 0.45 * Math.sin(t / 90 + i * 0.9)) * (1 - mid * 0.6);
    const h = state === "idle" ? 3 : 3 + v * (state === "speaking" ? 30 : 14);
    bars[i].style.height = `${h.toFixed(1)}px`;
  }

  // Ripples: spawn on rising edges while speaking, slow pulses when listening/thinking.
  const now = t;
  if (state === "speaking" && level > 0.18 && level - prevLevel > 0.03 && now - lastSpawn > 140) { ripples.push({ r: 0, a: 0.5 + level * 0.5, w: 1 + level * 2.5, hue: 268 }); lastSpawn = now; }
  if (state === "listening" && now - lastSpawn > 1100) { ripples.push({ r: 0, a: 0.35, w: 1.2, hue: 160 }); lastSpawn = now; }
  if (state === "thinking" && now - lastSpawn > 1600) { ripples.push({ r: 0, a: 0.25, w: 1, hue: 285 }); lastSpawn = now; }
  prevLevel = level;

  const w = cv.clientWidth, h = cv.clientHeight;
  cx2.clearRect(0, 0, w, h);
  const base = w * 0.18, max = w * 0.5;
  for (let i = ripples.length - 1; i >= 0; i--) {
    const p = ripples[i];
    p.r += state === "speaking" ? 2.2 + level * 2 : 1.1;
    const life = 1 - p.r / (max - base);
    if (life <= 0) { ripples.splice(i, 1); continue; }
    cx2.beginPath(); cx2.arc(w / 2, h / 2, base + p.r, 0, Math.PI * 2);
    cx2.strokeStyle = `hsla(${p.hue}, 90%, 78%, ${p.a * life})`;
    cx2.lineWidth = p.w * life + 0.3; cx2.shadowColor = `hsla(${p.hue}, 90%, 70%, ${0.6 * life})`; cx2.shadowBlur = 12;
    cx2.stroke();
  }
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ Speaking
function pickBritishVoice() {
  const vs = speechSynthesis.getVoices();
  const pref = ["Daniel", "Arthur", "Google UK English Male", "Microsoft Ryan", "Oliver", "Malcolm", "Microsoft George"];
  for (const n of pref) { const v = vs.find((x) => x.name.includes(n)); if (v) return v; }
  return vs.find((v) => v.lang === "en-GB" && /male/i.test(v.name)) || vs.find((v) => v.lang === "en-GB") || vs.find((v) => v.lang.startsWith("en"));
}
if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};

function splitForSpeech(text) {
  const parts = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  const s = parts.map((p) => p.trim()).filter(Boolean);
  if (s.length <= 1) return s;
  return [s[0], s.slice(1).join(" ")]; // first sentence alone for a fast start, rest together
}

const speaker = {
  gen: 0, src: null, ctrl: null, realAudio: false,
  stop() {
    this.gen++;
    this.ctrl?.abort(); this.ctrl = null;
    try { this.src?.stop(); } catch {}
    this.src = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.realAudio = false;
  },
  async speak(text) {
    this.stop();
    const gen = this.gen;
    if (!text) return;
    setState("speaking");
    try {
      if (cfg?.tts) await this.neural(text, gen);
      else await this.browser(text, gen);
    } catch (e) {
      if (gen !== this.gen) return;
      console.warn("Neural TTS failed, using browser voice:", e);
      await this.browser(text, gen).catch(() => {});
    }
    if (gen === this.gen) { this.realAudio = false; setState("idle"); }
  },
  async neural(text, gen) {
    ensureAudio();
    this.ctrl = new AbortController();
    const signal = this.ctrl.signal;
    // Fetch all chunks in parallel; play in order as each becomes ready.
    const chunks = splitForSpeech(text).map((chunk) =>
      fetch("/api/tts", { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ text: chunk }) })
        .then((r) => { if (!r.ok) throw new Error(`TTS ${r.status}`); return r.arrayBuffer(); })
        .then((buf) => audioCtx.decodeAudioData(buf)));
    for (const p of chunks) {
      const buffer = await p;
      if (gen !== this.gen) return;
      this.realAudio = true;
      await new Promise((resolve) => {
        const src = audioCtx.createBufferSource();
        src.buffer = buffer; src.connect(outAnalyser); src.onended = resolve;
        this.src = src; src.start();
      });
      if (gen !== this.gen) return;
    }
  },
  browser(text, gen) {
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickBritishVoice(); if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-GB";
      u.rate = 0.98; u.pitch = 0.9;
      u.onboundary = () => { simTarget = 0.5 + Math.random() * 0.5; };
      u.onend = u.onerror = () => resolve();
      speechSynthesis.speak(u);
      const iv = setInterval(() => { if (gen !== this.gen || !speechSynthesis.speaking) { clearInterval(iv); resolve(); } }, 250);
    });
  },
};

// ------------------------------------------------------------------ Listening
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
function sttMode() {
  // iPhone home-screen apps don't reliably support Web Speech, so prefer Whisper there.
  if (cfg?.stt && (isIOS || !SR)) return "server";
  if (SR) return "webspeech";
  return cfg?.stt ? "server" : "none";
}

const listener = {
  active: false, rec: null, stream: null, media: null, cancel: null,
  async start() {
    const mode = sttMode();
    if (mode === "none") { toast("Voice input isn't available in this browser, sir — do type."); $("#textInput").focus(); return; }
    this.active = true; setState("listening"); setCaption("Listening…");
    if (mode === "webspeech") this.webSpeech(); else await this.server();
  },
  stop({ discard = false } = {}) {
    if (!this.active) return;
    if (discard) this.cancel?.();
    this.active = false;
    try { this.rec?.stop(); } catch {}
    if (this.media && this.media.state !== "inactive") this.media.stop();
  },
  webSpeech() {
    const rec = new SR(); this.rec = rec;
    rec.lang = "en-GB"; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let finalText = "", discarded = false;
    this.cancel = () => { discarded = true; };
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      setCaption((finalText + interim).trim() || "Listening…", { user: true });
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed") toast("Microphone permission is needed, sir.");
      else if (e.error !== "no-speech" && e.error !== "aborted") toast(`Speech error: ${e.error}`);
    };
    rec.onend = () => {
      this.active = false; this.rec = null;
      const text = finalText.trim();
      if (!discarded && text) handleUtterance(text);
      else if (state === "listening") { setState("idle"); setCaption(""); }
    };
    rec.start();
  },
  async server() {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { this.active = false; setState("idle"); setCaption(""); toast("Microphone permission is needed, sir."); return; }
    this.stream = stream;
    ensureAudio();
    const srcNode = audioCtx.createMediaStreamSource(stream);
    micAnalyser = audioCtx.createAnalyser(); micAnalyser.fftSize = 1024; srcNode.connect(micAnalyser);

    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg"].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";
    const media = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    this.media = media;
    const parts = []; let discarded = false;
    this.cancel = () => { discarded = true; };
    media.ondataavailable = (e) => e.data.size && parts.push(e.data);

    // Simple voice-activity detection: stop after ~1.3s of silence once speech started.
    let spoke = false, quietSince = performance.now();
    const started = performance.now();
    const vad = setInterval(() => {
      const l = rms(micAnalyser);
      if (l > 0.035) { spoke = true; quietSince = performance.now(); }
      const now = performance.now();
      if ((spoke && now - quietSince > 1300) || now - started > 15000 || (!spoke && now - started > 7000)) this.stop();
    }, 80);

    media.onstop = async () => {
      clearInterval(vad);
      stream.getTracks().forEach((t) => t.stop());
      micAnalyser = null; this.stream = null; this.media = null; this.active = false;
      if (discarded || !spoke) { if (state === "listening") { setState("idle"); setCaption(""); } return; }
      setState("thinking"); setCaption("…");
      try {
        const blob = new Blob(parts, { type: media.mimeType || type || "audio/webm" });
        const { text } = await api("/api/transcribe", { method: "POST", raw: blob, headers: { "content-type": blob.type } });
        if (text) handleUtterance(text); else { setState("idle"); setCaption("I didn't quite catch that, sir."); }
      } catch (e) { setState("idle"); setCaption(""); toast(e.message); }
    };
    media.start(250);
  },
};

// ------------------------------------------------------------------ Conversation
let pendingBriefing = false;
async function handleUtterance(text) {
  speaker.stop();
  setState("thinking"); setCaption(`“${text}”`, { user: true });
  try {
    const { reply, changed } = await api("/api/chat", { method: "POST", body: { text, loc } });
    setCaption(reply);
    refreshAfter(changed);
    await speaker.speak(reply);
  } catch (e) {
    setState("idle");
    setCaption("Something went awry, sir. " + e.message);
  }
}

async function playBriefing() {
  pendingBriefing = false;
  speaker.stop(); setState("thinking"); setCaption("Preparing your briefing…");
  try {
    const q = loc ? `?lat=${loc.lat}&lon=${loc.lon}&place=${encodeURIComponent(loc.place || "")}` : "";
    const b = await api(`/api/briefing${q}`);
    if (b.weather) renderWeather(b.weather);
    setCaption(b.text);
    await speaker.speak(b.text);
  } catch (e) { setState("idle"); setCaption(e.message); }
}

function onTalkGesture() {
  ensureAudio();
  if (pendingBriefing) return playBriefing();
  if (state === "speaking" || state === "thinking") { speaker.stop(); setState("idle"); return listener.start(); } // barge-in
  if (state === "listening") return listener.stop();
  listener.start();
}
orbEl.addEventListener("click", onTalkGesture);
micBtn.addEventListener("click", onTalkGesture);
$("#textForm").addEventListener("submit", (e) => {
  e.preventDefault(); ensureAudio();
  const v = $("#textInput").value.trim(); if (!v) return;
  $("#textInput").value = ""; $("#textInput").blur();
  listener.stop({ discard: true });
  handleUtterance(v);
});
$("#briefBtn").addEventListener("click", () => { ensureAudio(); playBriefing(); });

// ------------------------------------------------------------------ Greeting
function partOfDay() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: cfg?.timezone }).format(new Date()));
  return h < 5 ? "evening" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
}
function renderGreeting() { $("#greeting").textContent = `Good ${partOfDay()}, sir.`; }

// ------------------------------------------------------------------ Weather
const ICON = (code, day = true) => code === 0 ? (day ? "☀️" : "🌙") : code <= 2 ? (day ? "🌤️" : "☁️") : code === 3 ? "☁️" : code <= 48 ? "🌫️" : code <= 67 ? "🌧️" : code <= 77 ? "❄️" : code <= 82 ? "🌦️" : code <= 86 ? "🌨️" : "⛈️";
function renderWeather(w) {
  $("#wPlace").textContent = w.place;
  $("#wTemp").textContent = `${w.current.temp}°`;
  $("#wSummary").textContent = w.current.summary;
  $("#wHiLo").textContent = `H ${w.today.high}° · L ${w.today.low}° · Feels ${w.current.feels}°${w.today.rain != null ? ` · Rain ${w.today.rain}%` : ""}`;
  $("#wIcon").textContent = ICON(w.current.code, w.current.isDay);
  $("#wHours").innerHTML = w.hourly.slice(0, 10).map((h, i) =>
    `<div>${i === 0 ? "Now" : h.time.slice(11, 13)}<b>${ICON(h.code)} ${h.temp}°</b></div>`).join("");
}
async function loadWeather() {
  try {
    const q = loc ? `?lat=${loc.lat}&lon=${loc.lon}&place=${encodeURIComponent(loc.place || "")}` : "";
    renderWeather(await api(`/api/weather${q}`));
  } catch (e) { $("#wSummary").textContent = "Weather unavailable"; }
}

// ------------------------------------------------------------------ Location
function renderLoc() { $("#locState").textContent = loc ? `${loc.place} (${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)})` : `${cfg.defaultLocation.place} (default)`; }
function requestLocation({ quiet = false } = {}) {
  if (!navigator.geolocation) { if (!quiet) toast("Location isn't available here."); return; }
  store.set("locAsked", true);
  navigator.geolocation.getCurrentPosition(async (pos) => {
    loc = { lat: +pos.coords.latitude.toFixed(4), lon: +pos.coords.longitude.toFixed(4), place: "Current location" };
    store.set("loc", loc);
    api("/api/location", { method: "POST", body: loc }).catch(() => {});
    renderLoc(); loadWeather();
  }, (err) => { if (!quiet) toast(err.code === 1 ? "Location permission declined — using Dhekelia." : "Couldn't get your location."); },
  { enableHighAccuracy: false, timeout: 10000, maximumAge: 15 * 60 * 1000 });
}
$("#locBtn").addEventListener("click", () => requestLocation());

// ------------------------------------------------------------------ Tasks
let showDone = false;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
async function loadTasks() {
  const list = await api(`/api/tasks${showDone ? "?all=1" : ""}`);
  const open = list.filter((t) => !t.done);
  $("#taskCount").textContent = open.length;
  $("#taskNext").textContent = open[0]?.title || "Nothing pressing";
  $("#taskList").innerHTML = list.length ? list.map((t) => `
    <li class="glass ${t.done ? "done" : ""}" data-id="${t.id}">
      <button class="check" data-act="toggle" aria-label="Toggle">${t.done ? "✓" : ""}</button>
      <div class="grow"><div>${esc(t.title)}</div>${t.notes || t.due ? `<div class="meta">${esc([t.due && `Due ${t.due}`, t.notes].filter(Boolean).join(" · "))}</div>` : ""}</div>
      <button class="del" data-act="del" aria-label="Delete">×</button>
    </li>`).join("") : `<li class="empty">All clear, sir.</li>`;
}
$("#taskList").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); const li = e.target.closest("li[data-id]"); if (!b || !li) return;
  const id = li.dataset.id;
  if (b.dataset.act === "toggle") await api(`/api/tasks/${id}`, { method: "PATCH", body: { done: !li.classList.contains("done") } });
  if (b.dataset.act === "del") await api(`/api/tasks/${id}`, { method: "DELETE" });
  loadTasks();
});
$("#taskForm").addEventListener("submit", async (e) => {
  e.preventDefault(); const v = $("#taskInput").value.trim(); if (!v) return;
  $("#taskInput").value = ""; await api("/api/tasks", { method: "POST", body: { title: v } }); loadTasks();
});
$("#toggleDone").addEventListener("click", () => { showDone = !showDone; $("#toggleDone").textContent = showDone ? "Hide done" : "Show done"; loadTasks(); });

// ------------------------------------------------------------------ Reminders
const fmtWhen = (iso) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
async function loadReminders() {
  const { upcoming, recent } = await api("/api/reminders");
  $("#remNext").textContent = upcoming[0]?.text || "None";
  $("#remWhen").textContent = upcoming[0] ? fmtWhen(upcoming[0].due_at) : "";
  $("#remList").innerHTML = upcoming.length ? upcoming.map((r) => `
    <li class="glass" data-id="${r.id}"><div class="grow"><div>${esc(r.text)}</div><div class="meta">${fmtWhen(r.due_at)}</div></div><button class="del" aria-label="Cancel">×</button></li>`).join("")
    : `<li class="empty">No reminders set.</li>`;
  $("#remRecent").innerHTML = recent.map((r) => `<li class="glass"><div class="grow"><div>${esc(r.text)}</div><div class="meta">${fmtWhen(r.due_at)}</div></div></li>`).join("");
}
$("#remList").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]"); if (!li || !e.target.closest(".del")) return;
  await api(`/api/reminders/${li.dataset.id}`, { method: "DELETE" }); loadReminders();
});
$("#remForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#remText").value.trim(), when = $("#remWhenInput").value;
  if (!text || !when) return;
  await api("/api/reminders", { method: "POST", body: { text, due_at: new Date(when).toISOString() } });
  $("#remText").value = ""; $("#remWhenInput").value = "";
  toast("Reminder set, sir."); loadReminders();
});

// ------------------------------------------------------------------ Ideas
const ago = (iso) => { const m = Math.round((Date.now() - new Date(iso.replace(" ", "T") + (iso.includes("Z") ? "" : "Z"))) / 60000); return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
async function loadIdeas(focusId) {
  const { ideas, everyMinutes } = await api("/api/ideas");
  $("#ideasHint").textContent = `A fresh idea is drafted in the background every ${everyMinutes} minutes, and you'll get a notification.`;
  const latest = ideas[0];
  $("#ideaTeaser").textContent = latest ? latest.title : "The first will arrive shortly, sir.";
  $("#ideaAge").textContent = latest ? ago(latest.created_at) : "";
  $("#ideaList").innerHTML = ideas.length ? ideas.map((i) => `
    <article class="glass idea" id="idea-${i.id}" data-id="${i.id}">
      <div class="tags"><span>${ago(i.created_at)}</span>${i.budget ? `<span>· ${esc(i.budget)}</span>` : ""}</div>
      <h3>${esc(i.title)}</h3>
      <p>${esc(i.pitch)}</p>
      ${i.why_now ? `<p class="muted">${esc(i.why_now)}</p>` : ""}
      <ol>${i.mvp.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
      <div class="fm"><b>First move this week</b>${esc(i.first_move)}</div>
      <div class="acts">
        <button class="pill-btn" data-act="task" ${i.added_to_tasks ? "disabled" : ""}>${i.added_to_tasks ? "Added to tasks" : "Add first move to tasks"}</button>
        <button class="del" data-act="del" aria-label="Dismiss">×</button>
      </div>
    </article>`).join("") : `<div class="empty glass card">No ideas yet. ${cfg.brain ? "The first is on its way." : "Add an Anthropic API key to start the idea engine."}</div>`;
  if (focusId) { const el = $(`#idea-${focusId}`); if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("flash"); } }
}
$("#ideaList").addEventListener("click", async (e) => {
  const b = e.target.closest("button"); const card = e.target.closest(".idea"); if (!b || !card) return;
  if (b.dataset.act === "task") { await api(`/api/ideas/${card.dataset.id}/task`, { method: "POST" }); toast("Added to your tasks, sir."); loadTasks(); }
  if (b.dataset.act === "del") await api(`/api/ideas/${card.dataset.id}`, { method: "DELETE" });
  loadIdeas();
});
$("#genIdea").addEventListener("click", async () => {
  const b = $("#genIdea"); b.disabled = true; b.textContent = "Thinking…";
  try { const i = await api("/api/ideas/generate", { method: "POST" }); await loadIdeas(i.id); }
  catch (e) { toast(e.message); }
  finally { b.disabled = false; b.textContent = "New idea now"; }
});

// ------------------------------------------------------------------ Memory & settings
async function loadMemories() {
  const m = await api("/api/memories");
  $("#memList").innerHTML = m.length ? m.map((x) => `<li class="glass" data-id="${x.id}"><div class="grow">${esc(x.fact)}</div><button class="del" aria-label="Forget">×</button></li>`).join("") : `<li class="empty">Nothing yet. Tell me what matters to you, sir.</li>`;
}
$("#memList").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]"); if (!li || !e.target.closest(".del")) return;
  await api(`/api/memories/${li.dataset.id}`, { method: "DELETE" }); loadMemories();
});
$("#clearHist").addEventListener("click", async () => { await api("/api/history/clear", { method: "POST" }); toast("Conversation forgotten, sir."); });
$("#voiceTest").addEventListener("click", () => { ensureAudio(); const t = "At your service, sir. Shall I put the kettle on?"; setCaption(t); speaker.speak(t); });
$("#pushTest").addEventListener("click", async () => {
  try { const { sent } = await api("/api/push/test", { method: "POST" }); toast(sent ? `Sent to ${sent} device${sent > 1 ? "s" : ""}.` : "No devices subscribed yet."); } catch (e) { toast(e.message); }
});

// ------------------------------------------------------------------ Push
function b64ToBytes(b64) { const p = "=".repeat((4 - (b64.length % 4)) % 4); const s = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); }
async function pushStatus() {
  const el = $("#pushState"), btn = $("#pushBtn");
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    el.textContent = isIOS && !standalone ? "On iPhone: Share → Add to Home Screen, then open JARVIS from there." : "Not supported in this browser";
    btn.disabled = true; return;
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  el.textContent = sub ? "On for this device" : Notification.permission === "denied" ? "Blocked in system settings" : "Off";
  btn.textContent = sub ? "Disable" : "Enable";
  if (sub) api("/api/push/subscribe", { method: "POST", body: sub.toJSON() }).catch(() => {});
}
$("#pushBtn").addEventListener("click", async () => {
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) { await api("/api/push/unsubscribe", { method: "POST", body: { endpoint: existing.endpoint } }); await existing.unsubscribe(); return pushStatus(); }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications weren't allowed."); return pushStatus(); }
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) });
    await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
    toast("Notifications on, sir."); pushStatus();
  } catch (e) { toast(e.message); }
});

// ------------------------------------------------------------------ Tabs & routing
function go(tab, { idea } = {}) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === tab));
  $$(".dock button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  scrollTo({ top: 0 });
  if (tab === "tasks") loadTasks();
  if (tab === "reminders") loadReminders();
  if (tab === "ideas") loadIdeas(idea);
  if (tab === "settings") { loadMemories(); pushStatus(); }
  if (tab === "home") { renderGreeting(); resizeCanvas(); }
}
$$(".dock button").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
$$("[data-go]").forEach((c) => c.addEventListener("click", () => go(c.dataset.go)));

function route(urlStr) {
  const u = new URL(urlStr, location.href);
  const tab = u.searchParams.get("tab");
  if (u.searchParams.get("briefing")) {
    go("home"); pendingBriefing = true;
    setCaption("Your briefing is ready, sir. Tap the orb to hear it.");
  } else if (tab) go(tab, { idea: u.searchParams.get("idea") });
  history.replaceState(null, "", "/");
}

function refreshAfter(changed = []) {
  if (changed.includes("tasks")) loadTasks();
  if (changed.includes("reminders")) loadReminders();
  loadMemories().catch(() => {});
}

// ------------------------------------------------------------------ Gate
function showGate() { $("#gate").hidden = false; setTimeout(() => $("#gateInput").focus(), 50); }
$("#gateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await api("/api/login", { method: "POST", body: { passcode: $("#gateInput").value } }); $("#gate").hidden = true; boot(); }
  catch (err) { $("#gateErr").textContent = err.message; }
});

// ------------------------------------------------------------------ Boot
async function boot() {
  cfg = await api("/api/config");
  if (cfg.authRequired && !cfg.authed) return showGate();
  $("#statusChip").classList.toggle("off", !cfg.brain);
  $("#statusText").textContent = cfg.brain ? "Online" : "Offline mind";
  $("#voiceState").textContent = cfg.tts ? `Neural (${cfg.tts === "elevenlabs" ? "ElevenLabs" : "OpenAI"}) — British butler` : "Browser voice (add an ElevenLabs or OpenAI key for the butler)";
  const m = sttMode();
  $("#sttState").textContent = m === "server" ? "Whisper transcription" : m === "webspeech" ? "Browser speech recognition" + (cfg.stt ? " (Whisper fallback ready)" : "") : "Type only (add OPENAI_API_KEY for iPhone voice)";
  $("#installHint").textContent = isIOS && !standalone ? "To install on iPhone: open in Safari, tap Share, then “Add to Home Screen”. Notifications work once installed." : "";
  renderGreeting(); renderLoc(); resizeCanvas();
  loadWeather(); loadTasks().catch(() => {}); loadReminders().catch(() => {}); loadIdeas().catch(() => {});
  if (loc) api("/api/location", { method: "POST", body: loc }).catch(() => {});
  if (!store.get("locAsked")) requestLocation({ quiet: true });
  else if (navigator.permissions) navigator.permissions.query({ name: "geolocation" }).then((p) => p.state === "granted" && requestLocation({ quiet: true })).catch(() => {});
  route(location.href);
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("SW failed", e));
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "navigate") route(e.data.url); });
}
setInterval(() => { renderGreeting(); if (document.visibilityState === "visible") { loadReminders().catch(() => {}); } }, 60_000);
setInterval(() => document.visibilityState === "visible" && loadWeather(), 15 * 60_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && cfg) { loadIdeas().catch(() => {}); loadTasks().catch(() => {}); } });
requestAnimationFrame(frame);
boot().catch((e) => { setCaption(e.message); });
