import { api } from "../api.js";
import { voice } from "../voice.js";
import { mountCore } from "../core.js";
import { $, esc, gbp, fmtTime, wxIcon, icon, ago } from "../util.js";

let briefingPending = false;

function greeting() {
  const h = new Date().getHours();
  return `Good ${h < 5 ? "evening" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening"}, sir.`;
}

export async function render(root, ctx) {
  root.innerHTML = `
  <div class="home">
    <section class="stage">
      <div class="core-wrap"><canvas class="core" id="core" aria-label="Talk to JARVIS" role="button" tabindex="0"></canvas><div class="core-label" id="coreLabel">online</div></div>
      <h1 class="greeting" id="greet">${greeting()}</h1>
      <p class="caption" id="caption" aria-live="polite">${ctx.desktop ? "Say “Hey JARVIS”, press Ctrl+Shift+Space, or tap the core." : "Tap the core or the microphone to speak."}</p>
      <div class="composer">
        <form class="pill-input glass" id="composer" autocomplete="off">
          <input id="say" placeholder="Ask JARVIS anything…" enterkeyhint="send" aria-label="Message">
          <button class="icon-btn" aria-label="Send">${icon("send")}</button>
        </form>
        <button class="mic" id="mic" aria-label="Speak">${icon("mic")}</button>
      </div>
      <div class="row wrap" style="justify-content:center;margin-top:12px"><button class="btn small" id="brief">Daily briefing</button><button class="btn small ghost" id="newConv">New conversation</button></div>
    </section>
    <div class="side-panels">
      <article class="glass panel" id="wx"><div class="panel-head"><span class="label">Weather</span><span class="faint" style="font-size:12px" id="wxPlace"></span></div><p class="empty">Fetching forecast…</p></article>
      <div class="grid cols-2">
        <article class="glass panel" data-go="money" style="cursor:pointer"><div class="panel-head"><span class="label">Money</span><span id="finTag"></span></div><div id="fin"><p class="empty">…</p></div></article>
        <article class="glass panel" data-go="agenda" style="cursor:pointer"><div class="panel-head"><span class="label">Today</span></div><div id="today"><p class="empty">…</p></div></article>
      </div>
      <article class="glass panel" data-go="projects" style="cursor:pointer"><div class="panel-head"><span class="label">Projects</span></div><div id="proj"><p class="empty">…</p></div></article>
      <article class="glass panel" data-go="settings" style="cursor:pointer"><div class="panel-head"><span class="label">Systems</span><span class="faint" style="font-size:12px" id="sysAge"></span></div><div id="sys"><p class="empty">…</p></div></article>
    </div>
  </div>`;

  mountCore($("#core", root));
  const offCap = ctx.onCaption((t, user) => { const c = $("#caption", root); if (!c) return; c.textContent = t || ""; c.classList.toggle("user", !!user); });
  const offState = voice.onState((s) => {
    const l = $("#coreLabel", root); if (l) l.textContent = { idle: "online", listening: "listening", thinking: "processing", speaking: "speaking" }[s] || s;
    $("#mic", root)?.classList.toggle("live", s === "listening");
  });

  const talk = () => {
    if (briefingPending) { briefingPending = false; return brief(); }
    if (voice.state === "speaking" || voice.state === "thinking") { voice.stop(); }
    ctx.listenOnce({ chime: false });
  };
  $("#core", root).addEventListener("click", talk);
  $("#core", root).addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); talk(); } });
  $("#mic", root).addEventListener("click", talk);
  $("#composer", root).addEventListener("submit", (e) => {
    e.preventDefault(); voice.ensureAudio();
    const v = $("#say", root).value.trim(); if (!v) return;
    $("#say", root).value = ""; ctx.converse(v);
  });
  async function brief() {
    voice.ensureAudio(); voice.setState("thinking"); ctx.caption("Preparing your briefing…");
    try { const b = await api("/api/briefing"); ctx.caption(b.text); await voice.speak(b.text); }
    catch (e) { voice.setState("idle"); ctx.caption(e.message); }
  }
  $("#brief", root).addEventListener("click", brief);
  $("#newConv", root).addEventListener("click", async () => { await api("/api/conversations", { method: "POST" }); ctx.caption("Fresh start, sir. What shall we tackle?"); });
  root.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => ctx.go(el.dataset.go)));

  await refresh(["*"], ctx);
  const tick = setInterval(() => { $("#greet", root) && ($("#greet", root).textContent = greeting()); }, 60_000);
  return () => { offCap(); offState(); clearInterval(tick); };
}

export function briefingReady() {
  briefingPending = true;
  const c = document.querySelector("#caption");
  if (c) c.textContent = "Your briefing is ready, sir. Tap the core to hear it.";
}

export async function refresh(entities, ctx) {
  const all = entities.includes("*");
  const jobs = [];
  if (all || entities.includes("settings")) jobs.push(loadWeather(ctx));
  if (all || entities.includes("finance")) jobs.push(loadFinance());
  if (all || ["tasks", "reminders", "calendar"].some((e) => entities.includes(e))) jobs.push(loadToday());
  if (all || entities.includes("projects")) jobs.push(loadProjects());
  if (all || entities.includes("health")) jobs.push(loadSystems(ctx));
  await Promise.allSettled(jobs);
}

async function loadWeather() {
  const el = $("#wx"); if (!el) return;
  try {
    const w = await api("/api/weather");
    $("#wxPlace").textContent = w.place;
    el.innerHTML = `<div class="panel-head"><span class="label">Weather <span class="src">${esc(w.source)} · ${fmtTime(w.fetchedAt)}</span></span><span class="faint" style="font-size:12px">${esc(w.place)}</span></div>
      <div class="wx-main"><div class="big">${w.current.temp}${w.unitTemp}</div><div style="flex:1;text-transform:capitalize"><div>${esc(w.current.summary)}</div><div class="muted" style="font-size:13px">Feels ${w.current.feels}° · H ${w.today.high}° L ${w.today.low}°</div></div><div class="wx-icon">${wxIcon(w.current.code, w.current.isDay)}</div></div>
      <div class="metrics"><div class="metric"><span>Rain</span><b>${w.today.rain ?? "–"}%</b></div><div class="metric"><span>Wind</span><b>${w.current.wind} <small>${w.unitWind}</small></b></div><div class="metric"><span>Humidity</span><b>${w.current.humidity}%</b></div></div>
      <div class="wx-hours">${w.hourly.slice(0, 12).map((h, i) => `<div>${i ? h.time.slice(11, 13) : "Now"}<b>${wxIcon(h.code)} ${h.temp}°</b>${h.rain != null ? `${h.rain}%` : ""}</div>`).join("")}</div>
      <div class="wx-days">${(() => { const lo = Math.min(...w.daily.map((d) => d.low)), hi = Math.max(...w.daily.map((d) => d.high)), span = Math.max(1, hi - lo);
        return w.daily.map((d, i) => `<div class="wx-day"><span>${i === 0 ? "Today" : new Date(d.date).toLocaleDateString("en-GB", { weekday: "short" })}</span><span>${wxIcon(d.code)}</span><div class="wx-range"><i style="left:${((d.low - lo) / span) * 100}%;right:${100 - ((d.high - lo) / span) * 100}%"></i></div><span class="num" style="text-align:right">${d.low}° / ${d.high}°</span></div>`).join(""); })()}</div>`;
  } catch (e) { el.innerHTML = `<div class="panel-head"><span class="label">Weather</span></div><p class="error">Weather unavailable: ${esc(e.message)}</p>`; }
}

async function loadFinance() {
  const el = $("#fin"); if (!el) return;
  try {
    const f = await api("/api/finance");
    $("#finTag").innerHTML = f.testData ? '<span class="pill test">TEST DATA</span>' : f.connections[0] ? `<span class="faint" style="font-size:12px">synced ${ago(f.connections[0].last_sync_at)}</span>` : "";
    if (!f.accounts.length) { el.innerHTML = `<p class="muted" style="margin:0">No bank connected.</p><p class="faint" style="font-size:13px">${f.monzoConfigured ? "Connect Monzo in Money." : "Monzo isn't configured on the server yet."}</p>`; return; }
    const p = f.position;
    el.innerHTML = `<div class="mid">${gbp(p.balances.available)}</div><div class="muted" style="font-size:12px">available now</div>
      <div style="margin-top:8px;font-size:13px">After commitments: <b class="num">${gbp(p.projectedDisposable)}</b>${p.commitments.estimated ? ' <span class="pill est">incl. estimates</span>' : ""}</div>
      <div class="muted" style="font-size:13px">Spent this month: <span class="num">${gbp(f.month.spent)}</span></div>`;
  } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function loadToday() {
  const el = $("#today"); if (!el) return;
  try {
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const [cal, rem, tasks] = await Promise.all([api(`/api/calendar?from=${new Date().toISOString()}&to=${end.toISOString()}`), api("/api/reminders"), api("/api/tasks")]);
    const today = new Date().toISOString().slice(0, 10);
    const items = [
      ...cal.events.map((e) => ({ t: e.all_day ? "all day" : fmtTime(e.start), text: e.title })),
      ...rem.upcoming.filter((r) => new Date(r.due_at) <= end).map((r) => ({ t: fmtTime(r.due_at), text: `⏰ ${r.text}` })),
      ...tasks.filter((t) => t.due && t.due <= today).map((t) => ({ t: t.due < today ? "overdue" : "today", text: t.title })),
    ];
    el.innerHTML = items.length ? `<ul class="list">${items.slice(0, 6).map((i) => `<li class="row" style="font-size:13px"><span class="mono faint" style="min-width:52px">${esc(i.t)}</span><span>${esc(i.text)}</span></li>`).join("")}</ul>` : `<p class="muted" style="margin:0">A clear day, sir. ${tasks.length} open task${tasks.length === 1 ? "" : "s"}.</p>`;
  } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function loadProjects() {
  const el = $("#proj"); if (!el) return;
  try {
    const ps = (await api("/api/projects")).filter((p) => p.status !== "done").slice(0, 4);
    el.innerHTML = ps.length ? ps.map((p) => `<div style="margin-bottom:8px"><div class="spread" style="font-size:14px"><span>${esc(p.title)}</span><span class="num muted">${p.progress.percent}%${p.progress.overdue ? ` · <span style="color:var(--bad)">${p.progress.overdue} overdue</span>` : ""}</span></div><div class="bar"><i style="width:${p.progress.percent}%"></i></div></div>`).join("")
      : '<p class="muted" style="margin:0">No active projects. Try “JARVIS, I want to start a business.”</p>';
  } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}

async function loadSystems(ctx) {
  const el = $("#sys"); if (!el) return;
  try {
    const h = await api("/api/health");
    ctx.desktopOnline = h.desktops.some((d) => d.online);
    const bad = h.services.filter((s) => ["error", "stale"].includes(s.state));
    const lap = h.desktops.find((d) => d.online);
    el.innerHTML = `<div class="grid cols-2" style="gap:6px;font-size:13px">
      <div class="row"><span class="dot ${h.integrations.ai.configured ? "ok" : "bad"}"></span>AI ${h.integrations.ai.configured ? "online" : "not configured"}</div>
      <div class="row"><span class="dot ${lap ? (lap.status?.wakeWord === "listening" ? "live" : "warn") : ""}"></span>Laptop ${lap ? (lap.status?.wakeWord === "listening" ? "listening" : lap.status?.muted ? "muted" : "online") : "offline"}</div>
      <div class="row"><span class="dot ${h.integrations.monzo.connection?.status === "active" ? "ok" : h.integrations.monzo.connection ? "warn" : ""}"></span>Bank ${h.integrations.monzo.connection?.status?.replace("_", " ") || "not connected"}</div>
      <div class="row"><span class="dot ${h.integrations.google.connection ? "ok" : ""}"></span>Calendar ${h.integrations.google.connection ? "Google" : "local only"}</div>
      <div class="row"><span class="dot ${bad.length ? "bad" : "ok"}"></span>${bad.length ? `${bad.length} service issue${bad.length > 1 ? "s" : ""}` : "Services nominal"}</div>
      <div class="row"><span class="dot ${h.integrations.voice.tts ? "ok" : "warn"}"></span>Voice ${h.integrations.voice.tts || "browser"}</div></div>`;
    $("#sysAge").textContent = `up ${Math.round(h.server.uptime / 60)} min`;
  } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
}
