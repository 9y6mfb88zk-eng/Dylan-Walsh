// Operation Wayfinder (Mission Control workspace): trips and expeditions.
// Real data: place search, 7-day forecast, FCDO advice, airports, routes (OSRM) and live ADS-B flight status.
// AI-drafted itinerary items and cost estimates are labelled as such. Nothing is booked; no fares or schedules exist
// in any free source, so flights are entered by you.
const TABS = [["overview", "Overview"], ["itinerary", "Itinerary"], ["travel", "Flights & transport"], ["routes", "Routes"], ["stay", "Stay & budget"], ["checklist", "Checklist"], ["safety", "Safety & check-ins"], ["notes", "Notes & documents"]];
const KIND_LABEL = { trip: "Trip", hiking: "Hiking expedition", roadtrip: "Road trip", camping: "Camping", city: "City exploration", multicountry: "Multi-country journey", photography: "Photography trip", research: "Geographical research visit" };

export async function mount(el, A) {
  const { api, esc, tz } = A;
  const S = { list: [], open: null, tab: "overview", busy: false };
  const fmt = (iso, o = {}) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric", ...o }) : "—");
  const patch = async (data, extra = {}) => { S.open = await api(`/api/ops/records/${S.open.id}`, { method: "PATCH", body: { data, ...extra } }); drawLayer(); };

  async function load() { S.list = await api("/api/ops/records?op=wayfinder").catch(() => []); drawLayer(); }
  function drawLayer() {
    const pts = [], lines = [];
    const trips = S.open ? [S.open] : S.list;
    for (const t of trips) {
      const d = t.data;
      if (d.destination) pts.push({ lat: d.destination.lat, lon: d.destination.lon, color: "#6fc3d6", r: 5.5, label: t.title, labelZoom: 0, sub: `${KIND_LABEL[d.kind] || "Trip"} · ${d.depart || "dates not set"}`, onClick: () => open(t.id) });
      if (S.open) for (const p of d.places || []) pts.push({ lat: p.lat, lon: p.lon, color: "#8fbf9f", r: 3.5, label: p.name.split(",")[0], labelZoom: 7, sub: p.why || "saved place" });
      for (const r of d.routes || []) if (r.geometry?.length) lines.push({ coords: r.geometry, color: "rgba(111,195,214,.85)", width: 2 });
    }
    A.setLayer("trips", { points: pts, lines });
    return pts;
  }
  function renderList() {
    el.innerHTML = `<h3>Operation Wayfinder <span class="goc-count">${S.list.length}</span></h3>
      <form id="wfNew" class="bb-new"><input class="goc-in" id="wfDest" placeholder="Destination — e.g. Iceland, Kyoto, Cairngorms" aria-label="Destination" required>
        <div class="goc-filters"><select class="goc-sel" id="wfKind" aria-label="Type">${Object.entries(KIND_LABEL).map(([k, n]) => `<option value="${k}">${n}</option>`).join("")}</select><input class="goc-in" id="wfDays" type="number" min="1" max="30" value="5" aria-label="Days"></div>
        <div class="goc-filters"><input class="goc-in" id="wfStart" type="date" aria-label="Departure date"><button class="goc-btn">Plan</button></div>
        <p class="goc-muted goc-small">JARVIS looks up the place, forecast, FCDO advice and nearest airports, then drafts an itinerary (labelled as an AI draft). You can edit everything.</p></form>
      <ol class="goc-evlist">${S.list.map((t) => `<li class="goc-ev"><button class="goc-ev-head" data-open="${t.id}"><span class="goc-ev-cat" style="--c:#6fc3d6"></span><span class="goc-ev-title">${esc(t.title)}</span></button><div class="goc-ev-meta"><span>${esc(KIND_LABEL[t.data.kind] || "Trip")}</span><span>${esc(t.data.destination?.name || "")}</span><span>${t.data.depart ? `${esc(t.data.depart)} → ${esc(t.data.return || "?")}` : "dates not set"}</span></div></li>`).join("") || '<li class="goc-muted">No trips yet.</li>'}</ol>`;
    el.querySelector("#wfNew").onsubmit = async (e) => {
      e.preventDefault(); if (S.busy) return; S.busy = true;
      const btn = el.querySelector("#wfNew .goc-btn"); btn.textContent = "Planning…"; btn.disabled = true;
      try { const t = await api("/api/wayfinder/plan", { method: "POST", body: { destination: el.querySelector("#wfDest").value, kind: el.querySelector("#wfKind").value, days: +el.querySelector("#wfDays").value, start: el.querySelector("#wfStart").value || null } }); await load(); open(t.id); }
      catch (err) { A.toast(err.message); btn.textContent = "Plan"; btn.disabled = false; } finally { S.busy = false; }
    };
    el.querySelectorAll("[data-open]").forEach((b) => b.onclick = () => open(+b.dataset.open));
    A.setContext({ operation: "wayfinder", trips: S.list.slice(0, 10).map((t) => ({ id: t.id, title: t.title, destination: t.data.destination?.name, depart: t.data.depart })) });
  }
  async function open(id) { S.open = await api(`/api/ops/records/${id}`); S.tab = "overview"; const pts = drawLayer(); if (pts.length) A.fit(pts.map((p) => [p.lat, p.lon]), 9); render(); }
  function render() {
    if (!S.open) return renderList();
    const t = S.open, d = t.data;
    A.setContext({ operation: "wayfinder", openTrip: { id: t.id, title: t.title, destination: d.destination?.name, depart: d.depart, return: d.return, kind: d.kind } });
    el.innerHTML = `<div class="bb-head"><button class="goc-btn" id="wfBack">← Trips</button><input class="goc-in" id="wfTitle" value="${esc(t.title)}" aria-label="Trip name"><button class="goc-btn" id="wfPdf">Export PDF</button></div>
      <p class="goc-muted goc-small">${esc(KIND_LABEL[d.kind] || "Trip")} · ${esc(d.destination?.name || "")}${d.aiDraft ? " · contains an AI-drafted plan" : ""}${d.aiError ? ` · AI draft unavailable: ${esc(d.aiError)}` : ""}</p>
      <div class="goc-chips">${TABS.map(([k, n]) => `<button class="goc-chip ${S.tab === k ? "on" : ""}" data-tab="${k}">${n}</button>`).join("")}</div><div class="goc-op-body" id="wfBody"></div>`;
    el.querySelector("#wfBack").onclick = () => { S.open = null; drawLayer(); renderList(); };
    el.querySelector("#wfTitle").onchange = (e) => api(`/api/ops/records/${t.id}`, { method: "PATCH", body: { title: e.target.value } }).then((r) => { S.open = r; load(); });
    el.querySelector("#wfPdf").onclick = () => A.print(t.title, tripPrint(t));
    el.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; render(); });
    TAB[S.tab](el.querySelector("#wfBody"), t, d);
  }
  const listEditor = (body, items, fields, onSave, { add = "Add" } = {}) => {
    body.insertAdjacentHTML("beforeend", `<table class="wf-tbl"><tbody>${items.map((x, i) => `<tr>${fields.map(([k, n]) => `<td><input class="goc-in" data-i="${i}" data-k="${k}" value="${esc(x[k] ?? "")}" placeholder="${n}" aria-label="${n}"></td>`).join("")}<td><button class="goc-x" data-del="${i}" aria-label="Remove">×</button></td></tr>`).join("")}</tbody></table><button class="goc-btn wf-add">${add}</button>`);
    body.querySelectorAll("[data-k]").forEach((inp) => inp.onchange = () => { items[+inp.dataset.i][inp.dataset.k] = inp.value; onSave(items); });
    body.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { items.splice(+b.dataset.del, 1); onSave(items, true); });
    body.querySelector(".wf-add").onclick = () => { items.push(Object.fromEntries(fields.map(([k]) => [k, ""]))); onSave(items, true); };
  };
  const TAB = {
    overview(body, t, d) {
      const r = d.research || {}, w = r.weatherAtCreation;
      body.innerHTML = `<div class="goc-filters"><label class="goc-small">Depart <input class="goc-in" type="date" id="wfD1" value="${esc(d.depart || "")}"></label><label class="goc-small">Return <input class="goc-in" type="date" id="wfD2" value="${esc(d.return || "")}"></label></div>
        <label class="goc-small">Travellers <input class="goc-in" id="wfPeople" value="${esc((d.participants || []).join(", "))}" placeholder="Names, comma separated"></label>
        <dl class="goc-kv"><div><dt>Destination</dt><dd>${esc(d.destination?.name || "—")}</dd></div>
        ${r.country ? `<div><dt>Country</dt><dd>${esc(r.country.name)} · capital ${esc(r.country.capital || "—")}</dd></div><div><dt>Currency</dt><dd>${esc((r.country.currencies || []).join(", "))}</dd></div><div><dt>Languages</dt><dd>${esc((r.country.languages || []).join(", "))}</dd></div><div><dt>Dialling code</dt><dd>${esc(r.country.calling || "—")}</dd></div>` : ""}</dl>
        <h4>Weather</h4><div id="wfWx" class="goc-small">${w ? wxTable(w, "at planning time") : '<span class="goc-muted">Not retrieved yet.</span>'}</div><button class="goc-btn" id="wfWxBtn">Check the weather now</button>
        <h4>Travel advice (UK FCDO)</h4>${r.advice?.url ? `<p class="goc-small">${esc(r.advice.summary || "")}</p><p class="goc-small"><a href="${esc(r.advice.url)}" target="_blank" rel="noopener">Full FCDO advice ↗</a> · updated ${esc(fmt(r.advice.updatedAt))}. Advice changes — re-check before you travel.</p>` : `<p class="goc-muted goc-small">${esc(r.advice?.unavailable || "Not available")}</p>`}
        <h4>Nearest airports</h4><ul class="goc-srcs">${(r.airports || []).map((a) => `<li><b>${esc(a.iata || a.icao)}</b> ${esc(a.name)} · ${a.km} km (straight line)</li>`).join("")}</ul>
        <p class="goc-muted goc-small">Sources: Open-Meteo, GOV.UK (Open Government Licence v3.0), OurAirports, world-countries. Retrieved ${esc(fmt(r.retrievedAt, { hour: "2-digit", minute: "2-digit" }))}.</p>`;
      const save = () => patch({ depart: body.querySelector("#wfD1").value || null, return: body.querySelector("#wfD2").value || null, participants: body.querySelector("#wfPeople").value.split(",").map((x) => x.trim()).filter(Boolean) });
      body.querySelectorAll("#wfD1,#wfD2,#wfPeople").forEach((x) => x.onchange = save);
      body.querySelector("#wfWxBtn").onclick = async () => {
        const x = await api(`/api/wayfinder/destination?q=${encodeURIComponent(d.destination.name)}`).catch((e) => ({ ok: false, error: e.message }));
        body.querySelector("#wfWx").innerHTML = x.weather?.daily ? wxTable(x.weather, "now") : `<span class="goc-warnline">${esc(x.weather?.error || x.error || "Weather unavailable")}</span>`;
        if (x.weather?.daily) patch({ research: { ...d.research, weatherAtCreation: { fetchedAt: x.weather.fetchedAt, daily: x.weather.daily, unit: x.weather.unit }, advice: x.advice?.available ? { url: x.advice.url, updatedAt: x.advice.updatedAt, summary: x.advice.summary, parts: x.advice.parts } : d.research?.advice } });
      };
    },
    itinerary(body, t, d) {
      const days = d.itinerary || [];
      body.innerHTML = `${d.aiDraft ? '<p class="goc-muted goc-small">Days marked “AI draft” were written by JARVIS — check opening times and bookings yourself.</p>' : ""}${days.map((x, i) => `<div class="wf-day"><div class="goc-filters"><b>Day ${x.day}${d.depart ? ` · ${esc(fmt(new Date(Date.parse(d.depart) + (x.day - 1) * 86400_000).toISOString(), { weekday: "short" }))}` : ""}</b><span class="goc-tag">${esc(x.by || "you")}</span></div>
        <input class="goc-in" data-day="${i}" data-f="title" value="${esc(x.title || "")}" placeholder="Theme of the day"><textarea class="goc-in" data-day="${i}" data-f="items" rows="3" placeholder="One plan item per line">${esc((x.items || []).join("\n"))}</textarea></div>`).join("")}<button class="goc-btn" id="wfAddDay">Add a day</button>`;
      body.querySelectorAll("[data-day]").forEach((inp) => inp.onchange = () => { const x = days[+inp.dataset.day]; if (inp.dataset.f === "items") x.items = inp.value.split("\n").map((s) => s.trim()).filter(Boolean); else x.title = inp.value; x.by = "you (edited)"; patch({ itinerary: days }); });
      body.querySelector("#wfAddDay").onclick = () => { days.push({ day: days.length + 1, title: "", items: [], by: "you" }); patch({ itinerary: days }).then(render); };
    },
    travel(body, t, d) {
      const fl = d.flights || [];
      body.innerHTML = `<p class="goc-muted goc-small">Enter your flights. Live status comes from public ADS-B when the aircraft is flying and visible; schedules, fares and booking aren't available from any free source.</p>`;
      listEditor(body, fl, [["no", "Flight no. (e.g. BA662)"], ["from", "From"], ["to", "To"], ["depart", "Departs (local)"], ["arrive", "Arrives (local)"], ["ref", "Booking ref"]], (items, re) => patch({ flights: items }).then(() => re && render()), { add: "Add flight" });
      body.insertAdjacentHTML("beforeend", `<div id="wfFlStatus" class="goc-small"></div>${fl.length ? `<div class="goc-filters">${fl.filter((f) => f.no).map((f) => `<button class="goc-btn" data-st="${esc(f.no)}">Live status ${esc(f.no)}</button>`).join("")}</div>` : ""}
        <h4>Other transport</h4>`);
      body.querySelectorAll("[data-st]").forEach((b) => b.onclick = async () => {
        const r = await api(`/api/wayfinder/flight?no=${encodeURIComponent(b.dataset.st)}`).catch((e) => ({ ok: false, error: e.message }));
        body.querySelector("#wfFlStatus").innerHTML = !r.ok ? `<span class="goc-warnline">${esc(r.error)}</span>` : r.airborne ? `<b>${esc(r.callsign)}</b> (${esc(r.airline || "")}) is airborne: ${esc(r.aircraft.type || "")} ${esc(r.aircraft.reg || "")} at ${r.aircraft.alt?.toLocaleString("en-GB") ?? "?"} ft, ${Math.round(r.aircraft.gs || 0)} kt, seen ${r.aircraft.posAgeSec}s ago. <span class="goc-muted">${esc(r.note || "")}</span>` : `<span class="goc-muted">${esc(r.note)}</span>`;
        if (r.airborne) A.fly(r.aircraft.lat, r.aircraft.lon, 6);
      });
      const tr = d.transport || [];
      const box = document.createElement("div"); body.append(box);
      listEditor(box, tr, [["what", "e.g. Hire car, train, ferry"], ["when", "When"], ["details", "Details / reference"]], (items, re) => patch({ transport: items }).then(() => re && render()), { add: "Add transport" });
    },
    routes(body, t, d) {
      const pl = d.places || [];
      body.innerHTML = `<p class="goc-muted goc-small">Pick two or more saved places to route between. Distances and times are the routing service's estimates (no live traffic); the straight-line distance is shown for comparison.</p>
        <ol class="goc-srcs">${pl.map((p, i) => `<li><label><input type="checkbox" data-wp="${i}"> ${esc(p.name)}</label> <span class="goc-muted">${esc(p.why || "")}</span></li>`).join("") || "<li class='goc-muted'>No saved places yet — add some below.</li>"}</ol>
        <div class="goc-filters"><select class="goc-sel" id="wfProf"><option value="driving">Driving</option><option value="walking">Walking</option><option value="cycling">Cycling</option></select><button class="goc-btn" id="wfRoute">Route</button></div>
        <form class="goc-search" id="wfAddPlace"><input class="goc-in" id="wfPlaceQ" placeholder="Add a place (town, landmark, trailhead)"><button class="goc-btn">Add</button></form>
        <h4>Saved routes</h4><ul class="goc-srcs">${(d.routes || []).map((r, i) => `<li><b>${esc(r.name)}</b> · ${r.distanceKm} km · ${Math.floor(r.durationMin / 60)} h ${r.durationMin % 60} min ${esc(r.profile)} (straight line ${r.straightLineKm} km) <button class="goc-x" data-rdel="${i}" aria-label="Remove">×</button></li>`).join("") || "<li class='goc-muted'>None yet.</li>"}</ul>
        <p class="goc-muted goc-small">Routing: OSRM on OpenStreetMap data (driving: project-osrm.org; walking & cycling: FOSSGIS). Public transport routing isn't available from a free worldwide source.</p>`;
      body.querySelector("#wfRoute").onclick = async () => {
        const sel = [...body.querySelectorAll("[data-wp]:checked")].map((c) => pl[+c.dataset.wp]); if (sel.length < 2) return A.toast("Tick at least two places.");
        const r = await api("/api/wayfinder/route", { method: "POST", body: { points: sel, profile: body.querySelector("#wfProf").value } }).catch((e) => ({ ok: false, error: e.message }));
        if (!r.ok) return A.toast(`${r.error}${r.straightLineKm ? ` (straight line ${r.straightLineKm} km)` : ""}`);
        await patch({ routes: [...(d.routes || []), { name: sel.map((p) => p.name.split(",")[0]).join(" → "), profile: r.profile, distanceKm: r.distanceKm, durationMin: r.durationMin, straightLineKm: r.straightLineKm, geometry: r.geometry, retrievedAt: r.retrievedAt }] });
        A.fit(r.geometry, 12); render();
      };
      body.querySelector("#wfAddPlace").onsubmit = async (e) => {
        e.preventDefault(); const q = body.querySelector("#wfPlaceQ").value.trim(); if (!q) return;
        const x = await api(`/api/wayfinder/destination?q=${encodeURIComponent(q)}`).catch((er) => ({ ok: false, error: er.message }));
        if (!x.ok) return A.toast(x.error);
        await patch({ places: [...pl, { name: x.place.name, lat: x.place.lat, lon: x.place.lon, why: "added by you", geocoder: "Open-Meteo" }] }); render();
      };
      body.querySelectorAll("[data-rdel]").forEach((b) => b.onclick = async () => { const rs = [...(d.routes || [])]; rs.splice(+b.dataset.rdel, 1); await patch({ routes: rs }); render(); });
    },
    stay(body, t, d) {
      const acc = d.accommodation || [], bud = d.budget || { currency: "GBP", items: [] };
      body.innerHTML = "<h4>Accommodation</h4>";
      const a = document.createElement("div"); body.append(a);
      listEditor(a, acc, [["name", "Where"], ["from", "Check-in"], ["to", "Check-out"], ["ref", "Booking ref / address"]], (items, re) => patch({ accommodation: items }).then(() => re && render()), { add: "Add stay" });
      const total = (bud.items || []).reduce((s, x) => s + (+x.amount || 0), 0), est = (bud.items || []).filter((x) => x.estimate).reduce((s, x) => s + (+x.amount || 0), 0);
      body.insertAdjacentHTML("beforeend", `<h4>Budget (${esc(bud.currency)})</h4><p class="goc-small">Total ${total.toLocaleString("en-GB")} ${esc(bud.currency)}${est ? ` — of which ${est.toLocaleString("en-GB")} are AI estimates; replace them with real prices` : ""}</p>`);
      const b = document.createElement("div"); body.append(b);
      listEditor(b, bud.items || [], [["item", "Item"], ["amount", "Amount"], ["by", "Source (you / AI estimate)"]], (items, re) => { for (const x of items) { x.amount = +x.amount || 0; if (x.by !== "AI estimate") x.estimate = false; } patch({ budget: { ...bud, items } }).then(() => re && render()); }, { add: "Add cost" });
    },
    checklist(body, t, d) {
      const cl = d.checklist || [];
      body.innerHTML = `<p class="goc-small">${cl.filter((x) => x.done).length} of ${cl.length} done</p><ul class="wf-check">${cl.map((x, i) => `<li><label><input type="checkbox" data-c="${i}" ${x.done ? "checked" : ""}> ${esc(x.text)}</label><button class="goc-x" data-cdel="${i}" aria-label="Remove">×</button></li>`).join("")}</ul><form class="goc-search" id="wfAddC"><input class="goc-in" id="wfC" placeholder="Add an item"><button class="goc-btn">Add</button></form>`;
      body.querySelectorAll("[data-c]").forEach((c) => c.onchange = () => { cl[+c.dataset.c].done = c.checked; patch({ checklist: cl }); body.querySelector("p").textContent = `${cl.filter((x) => x.done).length} of ${cl.length} done`; });
      body.querySelectorAll("[data-cdel]").forEach((b) => b.onclick = () => { cl.splice(+b.dataset.cdel, 1); patch({ checklist: cl }).then(render); });
      body.querySelector("#wfAddC").onsubmit = (e) => { e.preventDefault(); const v = body.querySelector("#wfC").value.trim(); if (v) { cl.push({ text: v, done: false }); patch({ checklist: cl }).then(render); } };
    },
    safety(body, t, d) {
      const em = d.emergency || { contacts: [], notes: "" };
      body.innerHTML = `<h4>Emergency contacts</h4>`;
      const c = document.createElement("div"); body.append(c);
      listEditor(c, em.contacts || [], [["name", "Name"], ["phone", "Phone"], ["role", "Role (e.g. family, guide)"]], (items, re) => patch({ emergency: { ...em, contacts: items } }).then(() => re && render()), { add: "Add contact" });
      body.insertAdjacentHTML("beforeend", `<label class="goc-small">Emergency notes (insurer, embassy, medical) <textarea class="goc-in" id="wfEm" rows="3">${esc(em.notes || "")}</textarea></label>
        ${d.research?.advice?.parts?.find?.((p) => /help/i.test(p.title)) ? `<p class="goc-small"><a href="${esc(d.research.advice.parts.find((p) => /help/i.test(p.title)).url)}" target="_blank" rel="noopener">FCDO “Getting help” — local emergency numbers and consular help ↗</a></p>` : ""}
        <h4>Check-in reminders</h4><p class="goc-muted goc-small">Each check-in is a reminder that reaches all your devices at that time.</p>
        <ul class="goc-srcs">${(d.checkins || []).map((x) => `<li>${esc(fmt(x.at, { hour: "2-digit", minute: "2-digit" }))} ${esc(x.note || "")}</li>`).join("") || "<li class='goc-muted'>None set.</li>"}</ul>
        <form class="goc-search" id="wfCk"><input class="goc-in" type="datetime-local" id="wfCkAt" aria-label="Check-in time"><input class="goc-in" id="wfCkNote" placeholder="Note (e.g. summit reached)"><button class="goc-btn">Add</button></form>`);
      body.querySelector("#wfEm").onchange = (e) => patch({ emergency: { ...em, notes: e.target.value } });
      body.querySelector("#wfCk").onsubmit = async (e) => { e.preventDefault(); const at = body.querySelector("#wfCkAt").value; if (!at) return; try { S.open = await api(`/api/wayfinder/${t.id}/checkins`, { method: "POST", body: { at: new Date(at).toISOString(), note: body.querySelector("#wfCkNote").value } }); A.toast("Check-in reminder set."); render(); } catch (er) { A.toast(er.message); } };
    },
    notes(body, t, d) {
      body.innerHTML = `<label class="goc-small">Notes <textarea class="goc-in bb-notes" id="wfNotes" rows="6">${esc(t.notes)}</textarea></label><h4>Important documents</h4><p class="goc-muted goc-small">Record what you need and where it is (don't store passport numbers or card details here).</p>`;
      body.querySelector("#wfNotes").onchange = (e) => api(`/api/ops/records/${t.id}`, { method: "PATCH", body: { notes: e.target.value } }).then((r) => { S.open = r; });
      const box = document.createElement("div"); body.append(box);
      listEditor(box, d.documents || [], [["name", "Document"], ["where", "Where it is / expiry"]], (items, re) => patch({ documents: items }).then(() => re && render()), { add: "Add document" });
      body.insertAdjacentHTML("beforeend", `<div class="goc-card-actions"><button class="goc-btn" id="wfDel">Delete this trip</button></div>`);
      body.querySelector("#wfDel").onclick = async () => { if (!confirm(`Delete “${t.title}”?`)) return; await api(`/api/ops/records/${t.id}`, { method: "DELETE" }); S.open = null; await load(); renderList(); };
    },
  };
  function wxTable(w, when) { return `<table class="wf-tbl">${w.daily.slice(0, 7).map((x) => `<tr><td>${esc(x.date)}</td><td>${esc(x.summary)}</td><td>${x.low}–${x.high}${esc(w.unit)}</td><td>rain ${x.rain ?? "?"}%</td></tr>`).join("")}</table><span class="goc-muted">Open-Meteo forecast retrieved ${esc(fmt(w.fetchedAt, { hour: "2-digit", minute: "2-digit" }))} (${when}). Forecasts only reach 7 days ahead.</span>`; }
  function tripPrint(t) {
    const d = t.data;
    return `<section class="bb-sec"><h4>${esc(KIND_LABEL[d.kind] || "Trip")} · ${esc(d.destination?.name || "")}</h4><p>${esc(d.depart || "?")} → ${esc(d.return || "?")} · ${esc((d.participants || []).join(", "))}</p></section>
      <section class="bb-sec"><h4>Itinerary</h4>${(d.itinerary || []).map((x) => `<p><b>Day ${x.day}: ${esc(x.title || "")}</b> <i>(${esc(x.by || "you")})</i><br>${(x.items || []).map(esc).join("<br>")}</p>`).join("")}</section>
      <section class="bb-sec"><h4>Flights</h4>${(d.flights || []).map((f) => `<p>${esc(f.no)} ${esc(f.from)} → ${esc(f.to)} · ${esc(f.depart)} – ${esc(f.arrive)} · ${esc(f.ref)}</p>`).join("") || "<p>None entered.</p>"}</section>
      <section class="bb-sec"><h4>Accommodation</h4>${(d.accommodation || []).map((a) => `<p>${esc(a.name)} · ${esc(a.from)} – ${esc(a.to)} · ${esc(a.ref)}</p>`).join("") || "<p>None entered.</p>"}</section>
      <section class="bb-sec"><h4>Routes</h4>${(d.routes || []).map((r) => `<p>${esc(r.name)}: ${r.distanceKm} km, ${r.durationMin} min (${esc(r.profile)}, OSRM estimate)</p>`).join("") || "<p>None.</p>"}</section>
      <section class="bb-sec"><h4>Checklist</h4>${(d.checklist || []).map((c) => `<p>${c.done ? "☑" : "☐"} ${esc(c.text)}</p>`).join("")}</section>
      <section class="bb-sec"><h4>Emergency</h4>${(d.emergency?.contacts || []).map((c) => `<p>${esc(c.name)} · ${esc(c.phone)} · ${esc(c.role)}</p>`).join("")}<p>${esc(d.emergency?.notes || "")}</p>${d.research?.advice?.url ? `<p>FCDO advice: ${esc(d.research.advice.url)} (updated ${esc(String(d.research.advice.updatedAt || "").slice(0, 10))})</p>` : ""}</section>`;
  }
  async function command(c) {
    if (c.action === "open" && c.id) { await open(c.id); return { ok: true }; }
    if (c.action === "plan") { const t = await api("/api/wayfinder/plan", { method: "POST", body: { destination: c.destination, days: c.days || 5, kind: c.kind || "trip", start: c.start || null } }); await load(); await open(t.id); return { ok: true, id: t.id, title: t.title }; }
    if (c.action === "weather") { if (!S.open && S.list[0]) await open(S.list[0].id); if (!S.open) return { ok: false, error: "No trip is open." }; S.tab = "overview"; render(); el.querySelector("#wfWxBtn")?.click(); return { ok: true }; }
    S.open = null; renderList(); return { ok: true };
  }
  await load(); renderList();
  return { command, refresh: () => load().then(() => !S.open && renderList()), unmount() { A.clearLayer("trips"); } };
}
