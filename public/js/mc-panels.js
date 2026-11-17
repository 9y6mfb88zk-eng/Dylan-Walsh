// Mission Control panels. Each one draws only real JARVIS data (diagnostics, tasks, research, notifications, devices…)
// and says plainly when something is unavailable. No invented threat levels, incidents, locations or activity.
import { api } from "./api.js";
import { voice } from "./voice.js";
import { core, STATE_LABEL } from "./corestate.js";
import { $, $$, esc, icon, statusDot, fmtTime, fmtWhen, ago, toast } from "./util.js";

const dot = (s) => statusDot(s === "bad" ? "error" : s);
const empty = (t) => `<p class="mc-empty">${esc(t)}</p>`;
const unavailable = (what, err) => `<p class="mc-empty">${esc(what)} unavailable${err ? ` — ${esc(err)}` : ""}.</p>`;
const utc = (t) => (!t ? null : /T/.test(t) ? (/[zZ]|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`) : `${t.replace(" ", "T")}Z`);
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const tzNow = (tz, opts) => { try { return new Date().toLocaleString("en-GB", { timeZone: tz, ...opts }); } catch { return "—"; } };

// ---------------------------------------------------------------- Panel catalogue
// needs: data keys the panel reads (only visible panels' data is fetched).
export const PANELS = {
  core: { title: "Neural core", needs: [], enter: "core" },
  overview: { title: "Operational overview", needs: ["home", "diag", "notif"], enter: "rise" },
  ops: { title: "Active operations", needs: ["focus", "research", "routines", "pending", "home", "reminders"], enter: "slideL" },
  arch: { title: "System architecture", needs: ["diag"], enter: "unfold" },
  diag: { title: "Live diagnostics", needs: ["diag", "runs"], enter: "slideR" },
  map: { title: "Global information", needs: ["world"], enter: "expand" },
  res: { title: "System resources", needs: ["perf"], enter: "rise" },
  intel: { title: "Intelligence & research", needs: ["research", "briefings"], enter: "rise" },
  comms: { title: "Communications", needs: ["notif", "devices"], expandedNeeds: ["conv"], enter: "rise" },
  act: { title: "Recent activity", needs: ["activity"], enter: "slideR" },
  procs: { title: "Active processes", needs: ["diag", "awareness", "focus", "research", "routines"], enter: "unfold" },
  projects: { title: "Projects", needs: ["projects"], enter: "unfold" },
  personal: { title: "Personal operations", needs: ["home", "reminders", "focus"], enter: "unfold" },
};

// ---------------------------------------------------------------- Renderers: (body, D, { expanded, ctx, exitTo, refresh }) → void
export const RENDER = {
  overview(el, D, o) {
    const h = D.home, d = D.diag;
    if (!h && !d) { el.innerHTML = D.homeErr ? unavailable("Overview", D.homeErr) : empty("Loading…"); return; }
    const tz = o.ctx.settings.timezone;
    const w = h?.weather;
    const n = d ? (d.counts.error || 0) + (d.counts.warn || 0) : null;
    const next = h?.nextEvent, alarm = h?.alarms?.next;
    el.innerHTML = `<div class="mc-ov">
      <div class="mc-ov-time"><b>${esc(tzNow(tz, { hour: "2-digit", minute: "2-digit" }))}</b><span>${esc(tzNow(tz, { weekday: "long", day: "numeric", month: "long" }))} · ${esc((h?.location?.place || o.ctx.settings.home?.place || "").split(",")[0])}</span></div>
      <dl class="mc-kv">
        <div><dt>Weather</dt><dd>${w ? `${esc(w.current.temp)}${esc(w.unitTemp)} · ${esc(w.current.summary || "")}` : D.homeErr ? "unavailable" : "not available"}</dd></div>
        <div><dt>Systems</dt><dd>${d ? `${dot(d.overall)} ${d.overall === "ok" ? "all checked systems operational" : `${n} item${n === 1 ? " needs" : "s need"} attention`}` : "checking…"}</dd></div>
        <div><dt>Next event</dt><dd>${next ? `${esc(next.title)} · ${esc(fmtWhen(next.start))}` : "nothing scheduled"}</dd></div>
        <div><dt>Tasks</dt><dd>${h ? `${h.tasks.overdue.length} overdue · ${h.tasks.dueToday.length} due today · ${h.tasks.total} open` : "—"}</dd></div>
        <div><dt>Next alarm</dt><dd>${alarm ? `${esc(alarm.label || "Alarm")} · ${esc(fmtWhen(alarm.at))}` : "none set"}</dd></div>
        <div><dt>Unread</dt><dd>${D.notif ? `${D.notif.unread} notification${D.notif.unread === 1 ? "" : "s"}` : "—"}</dd></div>
        ${D.init ? `<div><dt>Initialised</dt><dd>${esc(fmtTime(D.init.at))} · ${D.init.ok}/${D.init.total} checks passed</dd></div>` : ""}
      </dl></div>`;
  },

  ops(el, D, o) {
    const items = [];
    const c = o.ctx.conversation;
    if (c?.session || voice.state !== "idle") items.push(["talk", "Conversation", `${STATE_LABEL[core.state] || voice.state}${c?.session ? " · voice session open" : ""}`, "live"]);
    const f = D.focus?.active;
    if (f) items.push(["focus", `Focus: ${f.label || "session"}`, `${Math.ceil(f.remainingSeconds / 60)} min remaining`, "live"]);
    for (const r of (D.research || []).filter((x) => x.status === "running")) items.push(["intel", "Research in progress", r.query, "live"]);
    for (const r of (D.routines?.runs || []).filter((x) => x.status === "running")) items.push(["automations", `Routine: ${r.name}`, `started ${fmtTime(utc(r.started_at))}`, "live"]);
    for (const p of D.pending || []) items.push(["shield", "Waiting for your confirmation", p.summary, "warn"]);
    const ring = D.home?.alarms?.ringing || [];
    for (const a of ring) items.push(["alarm", "Alarm ringing", a.label || "Alarm", "bad"]);
    const soon = (D.reminders?.upcoming || []).filter((r) => Date.parse(r.due_at) - Date.now() < 2 * 3600_000).slice(0, 3);
    for (const r of soon) items.push(["timer", "Reminder due", `${r.text} · ${fmtTime(r.due_at)}`, "ok"]);
    const ag = o.ctx.agent;
    if (o.ctx.desktop) items.push(["mic", "Wake word", ag ? (ag.muted ? "microphone muted" : ag.wakeWord === "listening" ? "listening for “Hey JARVIS” (on this laptop only)" : ag.wakeWord || "starting") : "not reporting", ag && !ag.muted && ag.wakeWord === "listening" ? "ok" : "warn"]);
    el.innerHTML = items.length ? `<ul class="mc-list">${items.map(([ic, t, d, s]) => `<li>${icon(ic)}<div><b>${esc(t)}</b><div class="faint">${esc(d)}</div></div><span class="mc-state-dot ${s}"></span></li>`).join("")}</ul>`
      : empty("No operations in progress. Standing by.");
  },

  arch(el, D, o) {
    const d = D.diag;
    if (!d) { el.innerHTML = D.diagErr ? unavailable("Architecture status", D.diagErr) : empty("Mapping components…"); return; }
    const g = (n) => d.checks.find((c) => c.name === n);
    const st = (c) => c?.status || "unknown";
    const groupStatus = (names) => { const cs = names.map(g).filter(Boolean); const on = cs.filter((c) => c.status !== "off"); return { status: cs.some((c) => c.status === "error") ? "error" : cs.some((c) => c.status === "warn") ? "warn" : on.length ? "ok" : "off", detail: `${cs.filter((c) => c.status === "ok").length} of ${cs.length} connected: ${cs.map((c) => `${c.label} (${c.status})`).join(", ")}` }; };
    const integ = groupStatus(["weather", "google", "monzo", "smarthome", "push"]);
    const N = [
      { id: "devices", label: "Devices", x: 110, y: 46, ...pick(g("clients")) },
      { id: "windows", label: "Windows app", x: 320, y: 46, ...pick(g("desktop")) },
      { id: "mic", label: "Mic & wake word", x: 530, y: 46, ...pick(g("mic")), to: "windows" },
      { id: "ai", label: "AI core", x: 100, y: 172, ...pick(g("ai")) },
      { id: "server", label: "JARVIS server", x: 320, y: 172, status: "ok", detail: `online · ${d.checks.length} components reporting · checked ${fmtTime(d.at)}`, hub: true },
      { id: "db", label: "Database", x: 540, y: 140, ...pick(g("database")) },
      { id: "backup", label: "Backups", x: 540, y: 228, ...pick(g("backup")), to: "db" },
      { id: "memory", label: "Memory", x: 100, y: 272, ...pick(g("memory")) },
      { id: "stt", label: "Speech in", x: 240, y: 306, ...pick(g("stt")) },
      { id: "tts", label: "Voice out", x: 400, y: 306, ...pick(g("tts")) },
      { id: "integ", label: "Integrations", x: 540, y: 306, ...integ },
    ];
    function pick(c) { return { status: st(c), detail: c ? `${c.label}: ${c.detail}` : "No data" }; }
    const byId = Object.fromEntries(N.map((n) => [n.id, n]));
    const cls = (s) => ({ ok: "ok", warn: "warn", error: "bad", off: "off" })[s] || "unknown";
    const edges = N.filter((n) => !n.hub).map((n) => { const a = n, b = byId[n.to || "server"]; return `<line class="mc-edge ${cls(n.status)}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`; }).join("");
    const nodes = N.map((n) => `<g class="mc-node ${cls(n.status)}${n.hub ? " hub" : ""}" data-node="${n.id}" tabindex="0" role="button" aria-label="${esc(n.label)}: ${esc(n.status)}"><title>${esc(n.detail)}</title><circle r="${n.hub ? 20 : 11}" cx="${n.x}" cy="${n.y}" class="halo"/><circle r="${n.hub ? 9 : 5.5}" cx="${n.x}" cy="${n.y}" class="pip"/><text x="${n.x}" y="${n.y + (n.hub ? 36 : 25)}" text-anchor="middle">${esc(n.label)}</text></g>`).join("");
    const counts = N.reduce((a, n) => ((a[cls(n.status)] = (a[cls(n.status)] || 0) + 1), a), {});
    el.innerHTML = `<svg class="mc-arch" viewBox="0 0 640 345" preserveAspectRatio="xMidYMid meet" role="img" aria-label="JARVIS system architecture with live status">${edges}${nodes}</svg>
      <div class="mc-arch-legend faint"><span>${dot("ok")} ${counts.ok || 0} online</span><span>${dot("warn")} ${counts.warn || 0} attention</span><span>${dot("bad")} ${counts.bad || 0} fault</span><span>${dot("off")} ${(counts.off || 0) + (counts.unknown || 0)} not set up / not verified</span></div>
      <div class="mc-arch-detail" id="mcArchDetail">Select a component to see its live status.</div>
      ${o.expanded ? `<table class="tbl mc-tbl"><thead><tr><th>Component</th><th>Status</th><th>Live detail</th><th></th></tr></thead><tbody>${d.checks.filter((c) => !c.name.startsWith("svc:")).map((c) => `<tr><td>${dot(c.status)} ${esc(c.label)}</td><td>${esc(c.status)}</td><td class="faint">${esc(c.detail)}</td><td>${TESTABLE.includes(c.name) ? `<button class="btn tiny ghost" data-test="${c.name}">Test</button>` : ""}</td></tr>`).join("")}</tbody></table>` : ""}`;
    const detail = $("#mcArchDetail", el);
    $$("[data-node]", el).forEach((n) => { const show = () => { $$("[data-node]", el).forEach((x) => x.classList.toggle("sel", x === n)); detail.innerHTML = `<b>${esc(byId[n.dataset.node].label)}</b> — ${esc(byId[n.dataset.node].detail)}`; }; n.onclick = show; n.onkeydown = (e) => { if (e.key === "Enter") show(); }; });
    wireTests(el, o);
  },

  diag(el, D, o) {
    const d = D.diag;
    if (!d) { el.innerHTML = D.diagErr ? unavailable("Diagnostics", D.diagErr) : empty("Running checks…"); return; }
    const checks = d.checks.filter((c) => !c.name.startsWith("svc:"));
    const n = (d.counts.error || 0) + (d.counts.warn || 0);
    const head = `<div class="mc-diag-sum">${dot(d.overall)} <b>${d.overall === "ok" ? "All checked systems operational" : `${n} item${n === 1 ? " needs" : "s need"} attention`}</b><span class="faint">checked ${esc(fmtTime(d.at))}</span></div>`;
    if (!o.expanded) {
      // Problems first with their detail; healthy and not-set-up checks on one line each.
      const rank = { error: 0, warn: 1, unknown: 2, ok: 3, off: 4 };
      const sorted = [...checks].sort((a, b) => (rank[a.status] ?? 5) - (rank[b.status] ?? 5));
      el.innerHTML = head + `<ul class="mc-checks">${sorted.map((c) => `<li title="${esc(c.detail)}">${dot(c.status)}<div><b>${esc(c.label)}</b>${["error", "warn"].includes(c.status) ? `<div class="faint">${esc(String(c.detail).slice(0, 110))}</div>` : ` <span class="faint">· ${esc({ ok: "operational", off: "not set up", unknown: "not verified yet" }[c.status] || c.status)}</span>`}</div></li>`).join("")}</ul>`;
      return;
    }
    const r = D.report || (D.runs?.[0] && { label: `${D.runs[0].level} diagnostics`, overall: D.runs[0].overall, results: D.runs[0].summary, narration: D.runs[0].narration, at: utc(D.runs[0].at), durationMs: D.runs[0].duration_ms });
    el.innerHTML = head + `<div class="row wrap mc-levels">${[["quick", "Quick"], ["full", "Full system"], ["voice", "Voice"], ["ai", "AI"], ["network", "Network"], ["security", "Security"], ["performance", "Performance"], ["hardware", "Hardware"], ["integrations", "Integrations"]].map(([k, l]) => `<button class="btn small" data-level="${k}">${l}</button>`).join("")}</div>
      <div class="diag-grid mc-diag-grid">${checks.map((c) => `<div class="check-card ${c.status}"><div class="spread"><div class="row">${dot(c.status)}<b>${esc(c.label)}</b></div>${TESTABLE.includes(c.name) ? `<button class="btn tiny ghost" data-test="${c.name}">Test</button>` : ""}</div><div class="detail">${esc(c.detail)}</div></div>`).join("")}</div>
      ${r ? `<div class="mc-report"><div class="spread"><span class="label">Last spoken report · ${esc(r.label)}</span><span class="faint">${esc(fmtWhen(r.at))}</span></div><p class="muted">${esc(r.narration.join(" "))}</p></div>` : ""}`;
    $$("[data-level]", el).forEach((b) => b.onclick = async () => {
      $$("[data-level]", el).forEach((x) => x.disabled = true);
      try { await o.ctx.handleUi({ kind: "diagnostics", level: b.dataset.level }, { speak: o.ctx.settings.voice?.speakReplies !== false && (!!o.ctx.desktop || !!voice.cfg.tts) }); } catch (e) { toast(e.message); }
      $$("[data-level]", el).forEach((x) => x.disabled = false);
    });
    wireTests(el, o);
  },

  map(el, D, o) {
    if (!el.__map) {
      el.innerHTML = `<div class="mc-map"><canvas aria-label="World map with your places and the live day/night line"></canvas><div class="mc-map-tip" hidden></div></div><div class="mc-map-info faint"></div><div class="mc-places"></div>`;
      el.__map = createMap($("canvas", el), $(".mc-map-tip", el), (p) => { el.__sel = p; info(); });
    }
    const places = D.world || [];
    el.__map.setPlaces(places, el.__sel);
    const info = () => {
      const p = el.__sel || places.find((x) => x.home);
      $(".mc-map-info", el).innerHTML = D.worldErr ? `Places unavailable — ${esc(D.worldErr)}` : !places.length ? "Loading places…"
        : p ? `<b>${esc(p.name.split(",")[0])}</b> · ${esc(tzNow(p.timezone, { weekday: "short", hour: "2-digit", minute: "2-digit" }))} (${esc(p.offset || "")}) · ${p.weather ? `${esc(p.weather.temp)}${esc(p.weather.unit)} ${esc(p.weather.summary || "")}` : `weather unavailable${p.error ? ` (${esc(p.error)})` : ""}`} <span class="faint">· shaded area is night now</span>` : "";
      $(".mc-places", el).innerHTML = o.expanded ? `<div class="mc-place-grid">${places.map((x) => `<button class="mc-place ${el.__sel === x ? "sel" : ""}" data-place="${x.id}"><b>${esc(x.name.split(",")[0])}${x.home ? " · home" : ""}</b><span>${esc(tzNow(x.timezone, { hour: "2-digit", minute: "2-digit" }))} · ${x.weather ? `${esc(x.weather.temp)}${esc(x.weather.unit)}, ${esc(x.weather.summary || "")}` : "weather unavailable"}</span></button>`).join("")}</div>
        <div class="row" style="margin-top:10px"><button class="btn small ghost" data-exit="world">${icon("globe")}Manage places in World</button></div>` : "";
      $$("[data-place]", el).forEach((b) => b.onclick = () => { el.__sel = places.find((x) => String(x.id) === b.dataset.place); el.__map.setPlaces(places, el.__sel); info(); });
      $$("[data-exit]", el).forEach((b) => b.onclick = () => o.exitTo(b.dataset.exit));
    };
    info();
  },

  res(el, D, o) {
    const p = D.perf;
    if (!p) { el.innerHTML = D.perfErr ? unavailable("Resource monitoring", D.perfErr) : empty("Measuring…"); return; }
    const S = D.series;
    const c = window.__jarvisCore || {};
    const tile = (k, label, v, unit, max) => `<div class="mc-tile"><div class="spread"><span class="label">${label}</span><b>${v == null ? "—" : `${Math.round(v)}${unit}`}</b></div><div class="mc-spark">${spark(S[k], max)}</div></div>`;
    el.innerHTML = `<div class="mc-telemetry">
      ${tile("cpu", "Processor", p.cpuPct, "%", 100)}${tile("ram", "Memory", p.ramPct, "%", 100)}
      ${p.ai?.medianMs != null ? tile("ai", "AI latency", p.ai.medianMs, " ms") : `<div class="mc-tile"><div class="spread"><span class="label">AI latency</span><b>—</b></div><div class="faint mc-note">No AI calls in the last 24 h</div></div>`}
      ${tile("lag", "Server response", p.lagMs + p.dbMs, " ms")}</div>
      <div class="faint mc-note">JARVIS server ${esc(p.rssMb)} MB · ${p.cores} cores · core ${c.alive ? `${c.fps} fps${c.idle ? " (idle mode)" : ""}` : "not drawn"} · measured ${esc(fmtTime(p.at, { second: "2-digit" }))}</div>`;
  },

  intel(el, D, o) {
    const r = D.research, b = D.briefings;
    if (!r && !b) { el.innerHTML = D.researchErr ? unavailable("Research", D.researchErr) : empty("Loading…"); return; }
    const items = [
      ...(r || []).map((x) => ({ at: utc(x.created_at), kind: "Research", title: x.query, status: x.status, body: x.status === "failed" ? x.error : x.report, n: x.sources?.length || 0 })),
      ...(b || []).map((x) => ({ at: utc(x.created_at || x.at), kind: "Briefing", title: `${x.kind || ""} briefing`.trim(), status: "done", body: x.text || x.body || "", n: 0 })),
    ].filter((x) => x.at).sort((a, z) => z.at.localeCompare(a.at)).slice(0, o.expanded ? 12 : 5);
    el.innerHTML = (items.length ? `<ul class="mc-list mc-feed">${items.map((x) => `<li>${icon(x.kind === "Research" ? "intel" : "briefing")}<div><b>${esc(x.title)}</b><div class="faint">${esc(x.kind)} · ${esc(fmtWhen(x.at))}${x.status !== "done" ? ` · ${esc(x.status)}` : ""}${x.n ? ` · ${x.n} source${x.n === 1 ? "" : "s"}` : ""}</div>${o.expanded && x.body ? `<p class="mc-snippet">${esc(String(x.body).replace(/[#*_>]/g, "").slice(0, 260))}…</p>` : ""}</div></li>`).join("")}</ul>`
      : empty("No research or briefings yet. Ask “JARVIS, research …” to start one."))
      + (o.expanded ? `<div class="row" style="margin-top:10px"><button class="btn small ghost" data-exit="intelligence">${icon("intel")}Open the Intelligence Centre</button><button class="btn small ghost" data-exit="briefings">${icon("briefing")}Briefings</button></div>` : "");
    $$("[data-exit]", el).forEach((x) => x.onclick = () => o.exitTo(x.dataset.exit));
  },

  comms(el, D, o) {
    const n = D.notif, dv = D.devices;
    if (!n && !dv) { el.innerHTML = D.notifErr ? unavailable("Notifications", D.notifErr) : empty("Loading…"); return; }
    const live = (dv || []).filter((d) => !d.revoked_at && d.online);
    el.innerHTML = `<div class="mc-sub">${icon("computer")} ${dv ? `${live.length} device${live.length === 1 ? "" : "s"} connected live${live.length ? `: ${live.map((d) => esc(d.name)).join(", ")}` : ""}` : "devices unavailable"}</div>
      <ul class="mc-list">${(n?.items || []).slice(0, o.expanded ? 12 : 5).map((x) => `<li class="${x.read_at ? "" : "unread"}">${icon("notifications")}<div><b>${esc(x.title)}</b><div class="faint">${esc(x.kind)} · ${esc(fmtWhen(x.created_at))}</div></div></li>`).join("") || "<li class=\"faint\">No notifications. All quiet.</li>"}</ul>
      ${o.expanded ? `<div class="label" style="margin:12px 0 6px">Devices</div><ul class="mc-list">${(dv || []).filter((d) => !d.revoked_at).map((d) => `<li>${icon(/phone|ios|iphone/i.test(d.kind + d.name) ? "mic" : "computer")}<div><b>${esc(d.name)}${d.current ? " (this device)" : ""}</b><div class="faint">${d.online ? "connected now" : `last seen ${esc(ago(d.last_seen))}`}</div></div><span class="mc-state-dot ${d.online ? "ok" : "off"}"></span></li>`).join("")}</ul>
        <div class="label" style="margin:12px 0 6px">Latest conversation</div><ul class="mc-list">${(D.conv || []).slice(-6).map((m) => `<li>${icon(m.role === "user" ? "mic" : "talk")}<div><b>${m.role === "user" ? "You" : "JARVIS"}</b><div class="faint">${esc(String(m.content).slice(0, 180))}</div></div></li>`).join("") || '<li class="faint">No messages yet.</li>'}</ul>
        <div class="row" style="margin-top:10px"><button class="btn small ghost" data-exit="talk">${icon("talk")}Open conversation</button><button class="btn small ghost" data-exit="notifications">${icon("notifications")}Notification history</button></div>` : ""}`;
    $$("[data-exit]", el).forEach((x) => x.onclick = () => o.exitTo(x.dataset.exit));
  },

  act(el, D) {
    const a = D.activity;
    if (!a) { el.innerHTML = D.activityErr ? unavailable("Activity", D.activityErr) : empty("Loading…"); return; }
    el.innerHTML = a.length ? `<ul class="mc-list mc-feed">${a.slice(0, 14).map((x) => `<li><span class="mc-time">${esc(fmtTime(utc(x.at)))}</span><div>${esc(x.summary)}<div class="faint">${esc(x.kind)}</div></div></li>`).join("")}</ul>` : empty("No activity yet.");
  },

  procs(el, D, o) {
    const svc = (D.diag?.checks || []).filter((c) => c.name.startsWith("svc:"));
    const lap = D.awareness?.laptop;
    const list = Array.isArray(lap?.topProcesses) ? lap.topProcesses : null;
    el.innerHTML = `<div class="grid cols-2 mc-two">
      <div><div class="label" style="margin-bottom:6px">Laptop processes <span class="faint">(by memory)</span></div>${
        !o.ctx.desktop ? empty("The process list comes from the Windows app, which isn't connected on this device.")
        : D.awarenessErr ? unavailable("Process list", D.awarenessErr)
        : list ? `<table class="tbl mc-tbl"><thead><tr><th>Program</th><th class="amt">Memory</th><th class="amt">CPU time</th></tr></thead><tbody>${list.map((p) => `<tr><td>${esc(p.name)}</td><td class="amt">${esc(p.memMb)} MB</td><td class="amt">${p.cpuSec != null ? `${esc(p.cpuSec)} s` : "—"}</td></tr>`).join("")}</tbody></table><div class="faint mc-note">Laptop CPU ${lap.cpuPct != null ? `${lap.cpuPct}%` : "—"} · memory ${lap.memory?.usedPct ?? "—"}% · CPU time is total since each program started.</div>`
        : empty(typeof lap === "string" ? lap : "Collecting the process list…")}</div>
      <div><div class="label" style="margin-bottom:6px">JARVIS background services</div>${svc.length ? `<ul class="mc-checks">${svc.map((c) => `<li>${dot(c.status)}<div><b>${esc(c.label)}</b><div class="faint">${esc(c.detail)}</div></div></li>`).join("")}</ul>` : empty("No background services reported.")}</div></div>
      <div class="label" style="margin:12px 0 6px">Operations in progress</div><div class="mc-ops-slot"></div>`;
    RENDER.ops($(".mc-ops-slot", el), D, o);
  },

  projects(el, D, o) {
    const ps = D.projects;
    if (!ps) { el.innerHTML = D.projectsErr ? unavailable("Projects", D.projectsErr) : empty("Loading…"); return; }
    const act = ps.filter((p) => p.status !== "done");
    el.innerHTML = act.length ? `<div class="mc-proj-grid">${act.map((p) => { const pr = p.progress || {}; const next = (p.tasks || []).find((t) => !t.done); return `<div class="mc-proj"><div class="spread"><b>${esc(p.title)}</b><span class="pill">${esc(p.kind || "project")}</span></div>
        <div class="bar"><i style="width:${pr.percent || 0}%"></i></div><div class="faint">${pr.percent || 0}% · ${pr.done || 0}/${pr.total || 0} tasks · ${pr.milestonesDone || 0}/${pr.milestonesTotal || 0} milestones${pr.overdue ? ` · ${pr.overdue} overdue` : ""}${p.status === "paused" ? " · paused" : ""}</div>
        ${next ? `<div class="mc-next">Next: ${esc(next.title)}${next.due ? ` · due ${esc(next.due)}` : ""}</div>` : `<div class="mc-next faint">${p.goal ? esc(p.goal.slice(0, 120)) : "No open tasks"}</div>`}</div>`; }).join("")}</div>`
      : empty("No active projects.");
    el.innerHTML += `<div class="row" style="margin-top:10px"><button class="btn small ghost" data-exit="projects">${icon("projects")}Open Projects</button></div>`;
    $$("[data-exit]", el).forEach((x) => x.onclick = () => o.exitTo(x.dataset.exit));
  },

  personal(el, D, o) {
    const h = D.home;
    if (!h) { el.innerHTML = D.homeErr ? unavailable("Personal operations", D.homeErr) : empty("Loading…"); return; }
    const tasks = [...h.tasks.overdue, ...h.tasks.dueToday.filter((t) => !h.tasks.overdue.some((x) => x.id === t.id)), ...h.tasks.open].filter((t, i, a) => a.findIndex((x) => x.id === t.id) === i).slice(0, 8);
    const f = D.focus?.active;
    el.innerHTML = `<div class="grid cols-2 mc-two">
      <div><div class="label" style="margin-bottom:6px">Tasks</div><ul class="mc-list">${tasks.map((t) => `<li><button class="mc-tick" data-done="${t.id}" aria-label="Mark “${esc(t.title)}” done">${icon("check")}</button><div><b>${esc(t.title)}</b><div class="faint">${t.due ? `due ${esc(t.due)}` : "no due date"}${h.tasks.overdue.some((x) => x.id === t.id) ? " · overdue" : ""}${t.priority === 1 ? " · high priority" : ""}</div></div></li>`).join("") || '<li class="faint">No open tasks.</li>'}</ul></div>
      <div><div class="label" style="margin-bottom:6px">Today</div><ul class="mc-list">${(h.events || []).slice(0, 5).map((e) => `<li>${icon("calendar")}<div><b>${esc(e.title)}</b><div class="faint">${esc(fmtWhen(e.start))}</div></div></li>`).join("") || '<li class="faint">No events today.</li>'}
        ${(D.reminders?.upcoming || []).slice(0, 3).map((r) => `<li>${icon("timer")}<div><b>${esc(r.text)}</b><div class="faint">reminder · ${esc(fmtWhen(r.due_at))}</div></div></li>`).join("")}
        ${(h.alarms?.upcoming || []).slice(0, 3).map((a) => `<li>${icon("alarm")}<div><b>${esc(a.label || "Alarm")}</b><div class="faint">${esc(fmtWhen(a.at))}${a.snoozed ? " · snoozed" : ""}</div></div></li>`).join("")}</ul>
        <div class="label" style="margin:12px 0 6px">Focus</div>${f ? `<p class="mc-sub">${icon("focus")} ${esc(f.label || "Focus")} · ${Math.ceil(f.remainingSeconds / 60)} min left</p>` : `<button class="btn small" id="mcFocus">${icon("focus")}Start a 25-minute focus session</button>`}</div></div>
      <div class="row wrap" style="margin-top:10px"><button class="btn small ghost" data-exit="tasks">${icon("tasks")}Tasks</button><button class="btn small ghost" data-exit="calendar">${icon("calendar")}Calendar</button><button class="btn small ghost" data-exit="alarms">${icon("alarm")}Alarms</button><button class="btn small ghost" data-exit="goals">${icon("goals")}Goals & habits</button></div>`;
    $$("[data-done]", el).forEach((b) => b.onclick = async () => { b.disabled = true; try { await api(`/api/tasks/${b.dataset.done}`, { method: "PATCH", body: { done: true } }); toast("Done."); o.refresh(["home"]); } catch (e) { toast(e.message); b.disabled = false; } });
    $("#mcFocus", el)?.addEventListener("click", async () => { try { await api("/api/focus/start", { method: "POST", body: { minutes: 25 } }); toast("Focus session started."); o.refresh(["focus"]); } catch (e) { toast(e.message); } });
    $$("[data-exit]", el).forEach((x) => x.onclick = () => o.exitTo(x.dataset.exit));
  },
};

const TESTABLE = ["ai", "weather", "monzo", "google", "smarthome", "tts", "stt", "database", "network", "push"];
function wireTests(el, o) {
  $$("[data-test]", el).forEach((b) => b.onclick = async () => {
    b.disabled = true; b.textContent = "Testing…";
    try { const r = await api(`/api/diagnostics/test/${b.dataset.test}`, { method: "POST" }); toast(`${r.ok ? "✓ Passed" : "✗ Failed"} in ${r.latencyMs} ms — ${r.detail}`, 6000); }
    catch (e) { toast(e.message); }
    b.disabled = false; b.textContent = "Test";
    o.refresh(["diag"]);
  });
}

// ---------------------------------------------------------------- Sparkline (newest on the right)
export const SERIES_MAX = 40;
export function spark(values, fixedMax) {
  if (!values || values.length < 2) return '<div class="faint mc-note">Collecting…</div>';
  const H = 40, max = fixedMax ?? (Math.max(...values) * 1.2 || 1);
  const x = (i) => ((SERIES_MAX - values.length + i) / (SERIES_MAX - 1)) * 100;
  const pts = values.map((v, i) => `${x(i).toFixed(2)},${(H - 2 - (Math.min(v, max) / max) * (H - 4)).toFixed(2)}`).join(" ");
  return `<svg viewBox="0 0 100 ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${x(0).toFixed(2)},${H} ${pts} 100,${H}" class="fill"/><polyline points="${pts}" class="line"/></svg>`;
}

// ---------------------------------------------------------------- World map: coastlines, your places, the real day/night line
let LINES = null;
export function createMap(canvas, tip, onSelect) {
  let places = [], sel = null, W = 0, H = 0, dpr = 1;
  const g = canvas.getContext("2d");
  const night = document.createElement("canvas"); night.width = 180; night.height = 90;
  const proj = (lon, lat) => [((lon + 180) / 360) * W, ((90 - lat) / 180) * H];
  function sunPosition(date = new Date()) {
    // Subsolar point: solar declination and the equation of time (accurate to well under a degree).
    const start = Date.UTC(date.getUTCFullYear(), 0, 0), day = (date - start) / 864e5;
    const decl = 23.44 * Math.sin((2 * Math.PI * (284 + day)) / 365);
    const B = (2 * Math.PI * (day - 81)) / 364, eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
    const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
    return { lat: decl, lon: -15 * (utcH - 12 + eot / 60) };
  }
  function drawNight() {
    const s = sunPosition(), ng = night.getContext("2d"), img = ng.createImageData(180, 90), r = Math.PI / 180;
    for (let y = 0; y < 90; y++) for (let x = 0; x < 180; x++) {
      const lat = 90 - (y + 0.5) * 2, lon = (x + 0.5) * 2 - 180;
      const alt = Math.asin(Math.sin(lat * r) * Math.sin(s.lat * r) + Math.cos(lat * r) * Math.cos(s.lat * r) * Math.cos((lon - s.lon) * r)) / r;
      const a = Math.max(0, Math.min(1, (-alt + 1) / 7));       // civil twilight blend
      const i = (y * 180 + x) * 4; img.data[i] = 4; img.data[i + 1] = 2; img.data[i + 2] = 18; img.data[i + 3] = Math.round(a * 150);
    }
    ng.putImageData(img, 0, 0);
  }
  function draw() {
    if (!W || !H) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = "rgba(10, 6, 30, .55)"; g.fillRect(0, 0, W, H);
    g.strokeStyle = "rgba(168, 85, 247, .12)"; g.lineWidth = 1; g.beginPath();
    for (let lon = -150; lon < 180; lon += 30) { const [x] = proj(lon, 0); g.moveTo(x, 0); g.lineTo(x, H); }
    for (let lat = -60; lat <= 60; lat += 30) { const [, y] = proj(0, lat); g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();
    if (LINES) {
      g.strokeStyle = "rgba(196, 160, 255, .75)"; g.lineWidth = 0.8; g.beginPath();
      for (const l of LINES) for (let i = 0; i + 3 < l.length; i += 2) {
        const [x1, y1] = proj(l[i], l[i + 1]), [x2, y2] = proj(l[i + 2], l[i + 3]);
        if (Math.abs(x2 - x1) > W / 2) continue;
        g.moveTo(x1, y1); g.lineTo(x2, y2);
      }
      g.stroke();
    }
    drawNight(); g.imageSmoothingEnabled = true; g.drawImage(night, 0, 0, W, H);
    for (const p of places) {
      const [x, y] = proj(p.lon, p.lat), on = p === sel;
      g.beginPath(); g.arc(x, y, on ? 9 : 6, 0, Math.PI * 2); g.fillStyle = p.home ? "rgba(255,255,255,.18)" : "rgba(232,121,249,.2)"; g.fill();
      g.beginPath(); g.arc(x, y, on ? 4 : 3, 0, Math.PI * 2); g.fillStyle = p.home ? "#ffffff" : "#e879f9"; g.fill();
      g.font = "600 10.5px Rajdhani, sans-serif"; g.fillStyle = on ? "#ffffff" : "rgba(233,213,255,.9)";
      g.fillText(p.name.split(",")[0].toUpperCase(), x + 8, y + 3.5);
    }
  }
  function resize() {
    const r = canvas.getBoundingClientRect(); dpr = Math.min(devicePixelRatio || 1, 2);
    W = r.width; H = r.height; canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr)); draw();
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  const nearest = (e) => { const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top; let best = null, bd = 14; for (const p of places) { const [x, y] = proj(p.lon, p.lat), d = Math.hypot(x - mx, y - my); if (d < bd) { bd = d; best = p; } } return { p: best, mx, my }; };
  canvas.addEventListener("pointermove", (e) => {
    const { p, mx, my } = nearest(e);
    canvas.style.cursor = p ? "pointer" : "default";
    if (!p) { tip.hidden = true; return; }
    tip.hidden = false; tip.style.left = `${mx + 12}px`; tip.style.top = `${my - 8}px`;
    tip.innerHTML = `<b>${esc(p.name.split(",")[0])}</b><br>${esc(tzNow(p.timezone, { hour: "2-digit", minute: "2-digit", weekday: "short" }))}${p.weather ? ` · ${esc(p.weather.temp)}${esc(p.weather.unit)}` : ""}`;
  });
  canvas.addEventListener("pointerleave", () => { tip.hidden = true; });
  canvas.addEventListener("click", (e) => { const { p } = nearest(e); if (p) { sel = p; draw(); onSelect(p); } });
  if (!LINES) fetch("/vendor/world-lines.json").then((r) => r.json()).then((j) => { LINES = j.lines; draw(); }).catch(() => {});
  const minute = setInterval(draw, 60_000);            // the day/night line moves; nothing else animates
  return {
    setPlaces(ps, s) { places = ps; sel = s && ps.find((p) => p.id === s.id) || null; draw(); },
    destroy() { ro.disconnect(); clearInterval(minute); },
  };
}
