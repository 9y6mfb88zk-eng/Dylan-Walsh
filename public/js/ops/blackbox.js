// Operation Blackbox (Mission Control workspace): research dossiers.
// Facts are shown with their numbered sources; AI interpretation is labelled; nothing is cited that isn't in the list.
const CONF = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };

export async function mount(el, A) {
  const { api, esc, tz } = A;
  const meta = await api("/api/ops/meta").catch(() => ({ blackboxCategories: {} }));
  const S = { view: "list", openId: null, compare: new Set(), list: [], poll: 0 };
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
  const cites = (arr, d) => (arr || []).map((n) => d.sources?.[n - 1] ? `<a href="${esc(d.sources[n - 1].url)}" target="_blank" rel="noopener noreferrer" class="bb-cite" title="${esc(d.sources[n - 1].title)}">[${n}]</a>` : "").join("");

  async function load() { S.list = await api("/api/ops/records?op=blackbox&kind=dossier").catch(() => []); drawLayer(); }
  function drawLayer(only) {
    const pts = [];
    for (const d of only ? [only] : S.list) for (const l of d.data.locations || []) if (l.lat != null) pts.push({ lat: l.lat, lon: l.lon, color: "#c9b37a", shape: "square", r: 4, label: l.name.split(",")[0], labelZoom: only ? 0 : 6, sub: `${d.title} — ${l.why}`, onClick: () => open(d.id) });
    A.setLayer("dossiers", { points: pts, lines: [] });
    return pts;
  }
  function render() {
    if (S.view === "dossier") return renderDossier();
    if (S.view === "compare") return renderCompare();
    el.innerHTML = `<h3>Operation Blackbox <span class="goc-count">${S.list.length}</span></h3>
      <form id="bbNew" class="bb-new">
        <input class="goc-in" id="bbSubject" placeholder="Subject — e.g. Airbus A350, Reykjanes eruptions, 4X-EKA, Kourou spaceport" aria-label="Subject" required maxlength="200">
        <input class="goc-in" id="bbQuestion" placeholder="Research question (optional)" aria-label="Research question" maxlength="600">
        <div class="goc-filters"><select class="goc-sel" id="bbCat" aria-label="Category">${Object.entries(meta.blackboxCategories).map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join("")}</select><button class="goc-btn">Open dossier</button></div>
        <p class="goc-muted goc-small">Public information only. People: public figures in their public or professional role — no private individuals, addresses or whereabouts. Research uses JARVIS's AI with web search (your Anthropic account) plus free reference sources.</p>
      </form>
      ${A.selectedAircraft() ? `<button class="goc-btn" id="bbAircraft">Research the selected aircraft (${esc(A.selectedAircraft().callsign || A.selectedAircraft().reg || A.selectedAircraft().hex)})</button>` : ""}
      <div class="goc-filters"><input class="goc-in" id="bbFind" placeholder="Search dossiers, tags" aria-label="Search dossiers">${S.compare.size >= 2 ? `<button class="goc-btn" id="bbCmp">Compare ${S.compare.size}</button>` : `<span class="goc-muted goc-small">Tick two or more to compare</span>`}</div>
      <ol class="goc-evlist">${S.list.map((d) => `<li class="goc-ev bb-row"><label class="bb-tick"><input type="checkbox" data-cmp="${d.id}" ${S.compare.has(d.id) ? "checked" : ""} aria-label="Compare"></label><button class="goc-ev-head" data-open="${d.id}"><span class="goc-ev-cat" style="--c:${d.status === "ready" ? "#8fc1cf" : d.status === "working" ? "#b9a66b" : "#d9594f"}"></span><span class="goc-ev-title">${esc(d.title)}</span></button>
        <div class="goc-ev-meta"><span>${esc(meta.blackboxCategories[d.data.category] || d.data.category)}</span><span>${d.status === "working" ? `researching · ${esc(d.data.steps?.at(-1)?.step || "")}` : d.status === "ready" ? `${(d.data.sources || []).length} sources` : esc(d.data.error || d.status)}</span><span>${esc(fmt(d.updated_at))}</span>${d.tags.map((t) => `<span class="goc-tag">${esc(t)}</span>`).join("")}</div></li>`).join("") || '<li class="goc-muted">No dossiers yet.</li>'}</ol>`;
    el.querySelector("#bbNew").onsubmit = async (e) => {
      e.preventDefault();
      try { const r = await api("/api/blackbox/dossiers", { method: "POST", body: { subject: el.querySelector("#bbSubject").value, question: el.querySelector("#bbQuestion").value, category: el.querySelector("#bbCat").value } }); A.toast("Researching. The dossier fills in as each step completes."); await load(); open(r.id); }
      catch (err) { A.toast(err.message); }
    };
    const ac = el.querySelector("#bbAircraft");
    if (ac) ac.onclick = async () => { const a = A.selectedAircraft(); const r = await api("/api/blackbox/dossiers", { method: "POST", body: { subject: a.reg || a.callsign || a.hex, question: `Public information about this aircraft${a.type ? ` (type ${a.type})` : ""}: type, operator if public, history and any published incidents.`, category: "aircraft" } }).catch((e) => (A.toast(e.message), null)); if (r) { await load(); open(r.id); } };
    el.querySelector("#bbFind").oninput = async (e) => { const q = e.target.value.trim(); S.list = await api(`/api/ops/records?op=blackbox&kind=dossier${q ? `&q=${encodeURIComponent(q)}` : ""}`).catch(() => S.list); const pos = e.target.selectionStart; render(); const n = el.querySelector("#bbFind"); n.value = q; n.focus(); n.setSelectionRange(pos, pos); };
    const cmp = el.querySelector("#bbCmp"); if (cmp) cmp.onclick = () => { S.view = "compare"; render(); };
    el.querySelectorAll("[data-open]").forEach((b) => b.onclick = () => open(+b.dataset.open));
    el.querySelectorAll("[data-cmp]").forEach((c) => c.onchange = () => { const id = +c.dataset.cmp; c.checked ? S.compare.add(id) : S.compare.delete(id); render(); });
    A.setContext({ operation: "blackbox", dossiers: S.list.slice(0, 10).map((d) => ({ id: d.id, title: d.title })) });
  }
  function dossierHtml(d, { print = false } = {}) {
    const D = d.data;
    if (d.status === "working") return `<p class="goc-muted">Researching… ${esc(D.steps?.at(-1)?.step || "")}</p><ol class="bb-steps">${(D.steps || []).map((s) => `<li>${esc(s.step)} <span class="goc-muted">${esc(fmt(s.at))}</span></li>`).join("")}</ol>`;
    if (d.status === "refused" || d.status === "failed") return `<p class="goc-warnline">${esc(D.error || d.status)}</p>${D.referenceOnly ? "" : ""}`;
    const sec = (t, body) => (body ? `<section class="bb-sec"><h4>${t}</h4>${body}</section>` : "");
    return `${D.images?.length ? `<figure class="bb-fig"><img src="${esc(D.images[0].url)}" alt="" loading="lazy" referrerpolicy="no-referrer"><figcaption>${esc(D.images[0].artist || "")} · ${esc(D.images[0].licence)} · <a href="${esc(D.images[0].filePage)}" target="_blank" rel="noopener">Wikimedia Commons</a></figcaption></figure>` : ""}
      ${sec("Executive summary", D.executiveSummary ? `<p>${esc(D.executiveSummary)}</p><p class="goc-muted goc-small">${esc(D.aiNote || "")}</p>` : "")}
      ${sec("Subject overview", D.overview ? `<p>${esc(D.overview)}</p>` : D.wiki ? `<p>${esc(D.wiki.description || "")}</p>` : "")}
      ${D.aircraft ? sec("Public aircraft data", `<dl class="goc-kv"><div><dt>ICAO24</dt><dd>${esc(D.aircraft.hex)}</dd></div><div><dt>Registration</dt><dd>${esc(D.aircraft.reg || "—")}</dd></div><div><dt>Type code</dt><dd>${esc(D.aircraft.type || "—")}</dd></div><div><dt>Callsign</dt><dd>${esc(D.aircraft.callsign || "—")}</dd></div><div><dt>Observed</dt><dd>${esc(fmt(D.aircraft.seen))} · ${esc(D.aircraft.source)}</dd></div></dl>`) : ""}
      ${D.airport ? sec("Airport", `<dl class="goc-kv"><div><dt>Name</dt><dd>${esc(D.airport.name)}</dd></div><div><dt>Codes</dt><dd>${esc(D.airport.iata || "—")} / ${esc(D.airport.icao)}</dd></div><div><dt>Location</dt><dd>${esc(D.airport.city)}, ${esc(D.airport.country)} · ${D.airport.lat}, ${D.airport.lon}</dd></div></dl>`) : ""}
      ${sec("Key findings", (D.findings || []).length ? `<ul class="bb-findings">${D.findings.map((f) => `<li class="${f.kind}"><span class="bb-kind">${f.kind === "sourced" ? "Source fact" : "AI interpretation"} · ${CONF[f.confidence] || f.confidence}</span> ${esc(f.text)} ${cites(f.sources, D)}</li>`).join("")}</ul>` : "")}
      ${sec("Timeline", (D.timeline || []).length ? `<ol class="bb-timeline">${D.timeline.map((t) => `<li><b>${esc(t.date)}</b> ${esc(t.event)} ${cites(t.sources, D)}</li>`).join("")}</ol>` : "")}
      ${sec("Relevant locations", (D.locations || []).length ? `<ul class="goc-srcs">${D.locations.map((l, i) => `<li>${l.lat != null && !print ? `<button class="goc-btn bb-fly" data-fly="${i}">Map</button> ` : ""}<b>${esc(l.name)}</b> — ${esc(l.why)} <span class="goc-muted">${l.lat != null ? `${l.lat.toFixed(3)}, ${l.lon.toFixed(3)} (${esc(l.geocoder)})` : esc(l.geocoder)}</span></li>`).join("")}</ul>` : "")}
      ${sec("Historical context", D.historicalContext ? `<p>${esc(D.historicalContext)}</p>` : "")}
      ${sec("Contradictory information", (D.contradictions || []).length ? D.contradictions.map((c) => `<p><b>${esc(c.topic)}</b></p><ul>${c.positions.map((p) => `<li>${esc(p.claim)} ${cites(p.sources, D)}</li>`).join("")}</ul>`).join("") : "<p class='goc-muted'>No contradictions were identified between the sources.</p>")}
      ${sec("Relevant documents", (D.documents || []).length ? `<ul>${D.documents.map((x) => `<li>${esc(x.title)} ${cites([x.source], D)}</li>`).join("")}</ul>` : "")}
      ${sec("Limitations", (D.limitations || []).length ? `<ul>${D.limitations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "")}
      ${sec(`Sources (${(D.sources || []).length})`, `<ol class="bb-sources">${(D.sources || []).map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a> <span class="goc-muted">${esc(s.publisher || "")} · ${esc(s.kind)} · accessed ${esc(fmt(s.accessedAt))}</span></li>`).join("")}</ol>`)}
      ${sec("Research steps", `<ol class="bb-steps">${(D.steps || []).map((s) => `<li>${esc(s.step)} <span class="goc-muted">${esc(fmt(s.at))}</span></li>`).join("")}</ol>`)}`;
  }
  async function open(id) {
    S.openId = id; S.view = "dossier";
    clearInterval(S.poll);
    await renderDossier();
    S.poll = setInterval(async () => { const d = await api(`/api/ops/records/${id}`).catch(() => null); if (!d || S.openId !== id || S.view !== "dossier") return clearInterval(S.poll); if (d.status !== "working") { clearInterval(S.poll); await load(); } renderDossier(d); }, 4000);
  }
  async function renderDossier(pre) {
    const d = pre || await api(`/api/ops/records/${S.openId}`).catch(() => null);
    if (!d) { S.view = "list"; return render(); }
    const pts = drawLayer(d);
    if (!pre && pts.length) A.fit(pts.map((p) => [p.lat, p.lon]), 6);
    A.setContext({ operation: "blackbox", openDossier: { id: d.id, title: d.title, subject: d.data.subject, category: d.data.category } });
    el.innerHTML = `<div class="bb-head"><button class="goc-btn" id="bbBack">← Dossiers</button><input class="goc-in" id="bbTitle" value="${esc(d.title)}" aria-label="Dossier title"><button class="goc-btn" id="bbPdf" ${d.status !== "ready" ? "disabled" : ""}>Export PDF</button></div>
      <p class="goc-muted goc-small">${esc(meta.blackboxCategories[d.data.category] || "")}${d.data.question ? ` · Question: ${esc(d.data.question)}` : ""} · ${d.status === "ready" ? `generated ${esc(fmt(d.data.generatedAt))}` : esc(d.status)}</p>
      <div class="bb-body">${dossierHtml(d)}</div>
      <section class="bb-sec"><h4>Your notes and tags</h4><textarea class="goc-in bb-notes" id="bbNotes" rows="3" placeholder="Notes" aria-label="Notes">${esc(d.notes)}</textarea>
        <input class="goc-in" id="bbTags" value="${esc(d.tags.join(", "))}" placeholder="Tags, comma separated" aria-label="Tags">
        <div class="goc-filters"><input class="goc-in" id="bbSrcUrl" placeholder="Add a source URL" aria-label="Source URL"><input class="goc-in" id="bbSrcTitle" placeholder="Source title" aria-label="Source title"></div>
        <div class="goc-card-actions"><button class="goc-btn" id="bbSave">Save notes</button><button class="goc-btn" id="bbAddSrc">Add source</button><button class="goc-btn" id="bbRerun">Re-run research</button><button class="goc-btn" id="bbDel">Delete</button></div></section>`;
    el.querySelector("#bbBack").onclick = () => { clearInterval(S.poll); S.view = "list"; drawLayer(); render(); };
    el.querySelector("#bbTitle").onchange = (e) => api(`/api/ops/records/${d.id}`, { method: "PATCH", body: { title: e.target.value } }).then(load);
    el.querySelector("#bbPdf").onclick = () => A.print(d.title, `<div class="bb-print">${dossierHtml(d, { print: true })}${d.notes ? `<section class="bb-sec"><h4>Notes</h4><p>${esc(d.notes)}</p></section>` : ""}</div>`);
    el.querySelector("#bbSave").onclick = async () => { await api(`/api/ops/records/${d.id}`, { method: "PATCH", body: { notes: el.querySelector("#bbNotes").value, tags: el.querySelector("#bbTags").value } }); A.toast("Saved."); load(); };
    el.querySelector("#bbAddSrc").onclick = async () => {
      const url = el.querySelector("#bbSrcUrl").value.trim(); if (!/^https?:\/\//.test(url)) return A.toast("Enter a full http(s) address.");
      const sources = [...(d.data.sources || []), { title: el.querySelector("#bbSrcTitle").value.trim() || url, url, publisher: "added by you", kind: "user", accessedAt: new Date().toISOString() }];
      await api(`/api/ops/records/${d.id}`, { method: "PATCH", body: { data: { sources } } }); renderDossier();
    };
    el.querySelector("#bbRerun").onclick = async () => { await api(`/api/blackbox/dossiers/${d.id}/rerun`, { method: "POST" }).catch((e) => A.toast(e.message)); open(d.id); };
    el.querySelector("#bbDel").onclick = async () => { if (!confirm(`Delete the dossier “${d.title}”?`)) return; await api(`/api/ops/records/${d.id}`, { method: "DELETE" }); clearInterval(S.poll); S.view = "list"; await load(); render(); };
    el.querySelectorAll("[data-fly]").forEach((b) => b.onclick = () => { const l = d.data.locations[+b.dataset.fly]; A.fly(l.lat, l.lon, 8); });
  }
  async function renderCompare() {
    const ds = (await Promise.all([...S.compare].map((id) => api(`/api/ops/records/${id}`).catch(() => null)))).filter(Boolean);
    el.innerHTML = `<div class="bb-head"><button class="goc-btn" id="bbBack">← Dossiers</button><b>Comparing ${ds.length} dossiers</b></div>
      <div class="bb-compare">${ds.map((d) => `<div class="goc-box"><h4>${esc(d.title)}</h4><p class="goc-small">${esc(d.data.executiveSummary || d.data.error || "")}</p>
        <ul class="goc-small">${(d.data.findings || []).filter((f) => f.kind === "sourced").slice(0, 6).map((f) => `<li>${esc(f.text)} ${cites(f.sources, d.data)}</li>`).join("")}</ul>
        <p class="goc-muted goc-small">${(d.data.sources || []).length} sources · ${(d.data.timeline || []).length} timeline entries · ${(d.data.contradictions || []).length} contradictions</p></div>`).join("")}</div>`;
    el.querySelector("#bbBack").onclick = () => { S.view = "list"; render(); };
  }
  async function command(c) {
    if (c.action === "open" && c.id) { await open(c.id); return { ok: true }; }
    if (c.action === "new" && c.subject) { const r = await api("/api/blackbox/dossiers", { method: "POST", body: { subject: c.subject, question: c.question || "", category: c.category || "general" } }); await load(); open(r.id); return { ok: true, id: r.id }; }
    if (c.action === "aircraft") { const a = A.selectedAircraft(); if (!a) return { ok: false, error: "No aircraft is selected on the map." }; return command({ action: "new", subject: a.reg || a.callsign || a.hex, category: "aircraft", question: "Public information about this aircraft." }); }
    S.view = "list"; render(); return { ok: true };
  }
  await load(); render();
  return { command, refresh: () => load().then(() => S.view === "list" && render()), unmount() { clearInterval(S.poll); A.clearLayer("dossiers"); } };
}
