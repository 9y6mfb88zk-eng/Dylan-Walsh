// Business: pipeline, clients (with communication history), proposals (AI drafts), invoices, expenses and revenue.
import { api } from "../api.js";
import { $, $$, esc, icon, toast, formDialog, confirmDialog, gbp, toPence, pounds, fmtDay, fmtWhen, localDateStr } from "../util.js";

const STAGES = [["lead", "Lead"], ["contacted", "Contacted"], ["qualified", "Qualified"], ["proposal", "Proposal"], ["won", "Won"], ["active", "Active"], ["lost", "Lost"], ["past", "Past"]];
let tab = "pipeline", openClient = null;

export async function render(root, ctx, params = {}) {
  if (params.focus) { tab = "clients"; openClient = Number(params.focus); }
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Business</h2><p>Clients, leads, proposals and invoices. Nothing is ever sent to a client without you.</p></div>
    <div class="row wrap"><button class="btn small primary" id="addClient">${icon("plus")}Client / lead</button></div></div>
    <div class="grid cols-4" id="kpis" style="margin-bottom:14px"></div>
    <div class="tabs">${[["pipeline", "Pipeline"], ["clients", "Clients"], ["proposals", "Proposals"], ["invoices", "Invoices"], ["expenses", "Expenses"]].map(([k, l]) => `<button data-t="${k}">${l}</button>`).join("")}</div><div id="bz"></div>`;
  $$("[data-t]", root).forEach((b) => b.onclick = () => { tab = b.dataset.t; draw(); });
  $("#addClient", root).onclick = () => editClient();
  await draw();
}
export function refresh(e) { if (e.includes("*") || e.includes("business")) draw(); }

async function draw() {
  $$("[data-t]").forEach((b) => b.classList.toggle("active", b.dataset.t === tab));
  const sum = await api("/api/business/summary");
  const K = $("#kpis"); if (!K) return;
  const pipe = sum.pipeline.filter((p) => !["lost", "past"].includes(p.stage)).reduce((a, p) => a + p.value, 0);
  K.innerHTML = `<article class="panel"><div class="stat"><b>${gbp(sum.revenueMonth)}</b><span>paid this month</span></div></article><article class="panel"><div class="stat"><b>${gbp(sum.revenueYear)}</b><span>paid this year</span></div></article>
    <article class="panel"><div class="stat"><b>${gbp(sum.outstanding)}</b><span>outstanding invoices${sum.overdue.length ? ` · <span style="color:var(--bad)">${sum.overdue.length} overdue</span>` : ""}</span></div></article><article class="panel"><div class="stat"><b>${gbp(pipe)}</b><span>open pipeline value <span class="pill est">estimate</span></span></div></article>`;
  const el = $("#bz");
  if (tab === "pipeline") {
    const clients = await api("/api/clients");
    el.innerHTML = `<div class="kanban">${STAGES.map(([s, l]) => { const cs = clients.filter((c) => c.stage === s); return `<div class="kcol" data-stage="${s}"><div class="spread"><span class="label">${l}</span><span class="faint" style="font-size:12px">${cs.length} · ${gbp(cs.reduce((a, c) => a + c.value, 0))}</span></div>${cs.map((c) => `<div class="kcard" draggable="true" data-c="${c.id}"><b>${esc(c.name)}</b>${c.company ? `<div class="faint" style="font-size:12px">${esc(c.company)}</div>` : ""}<div class="spread" style="font-size:12px;margin-top:4px"><span class="num">${gbp(c.value)}</span>${c.next_follow_up ? `<span class="${c.next_follow_up <= localDateStr() ? "" : "faint"}" style="${c.next_follow_up <= localDateStr() ? "color:var(--warn)" : ""}">follow up ${esc(fmtDay(c.next_follow_up))}</span>` : ""}</div></div>`).join("")}</div>`; }).join("")}</div>
      ${sum.followUps.length ? `<article class="panel" style="margin-top:14px"><div class="panel-head"><span class="label">Follow-ups in the next 7 days</span></div><ul class="list">${sum.followUps.map((c) => `<li class="item clickable" data-c="${c.id}"><div class="grow"><b>${esc(c.name)}</b><div class="meta">${esc(c.stage)} · ${esc(fmtDay(c.next_follow_up))}</div></div></li>`).join("")}</ul></article>` : ""}`;
    $$("[data-c]", el).forEach((c) => c.onclick = () => { openClient = Number(c.dataset.c); tab = "clients"; draw(); });
    $$(".kcard", el).forEach((c) => c.ondragstart = (e) => e.dataTransfer.setData("text/plain", c.dataset.c));
    $$(".kcol", el).forEach((col) => { col.ondragover = (e) => e.preventDefault(); col.ondrop = (e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); if (id) api(`/api/clients/${id}`, { method: "PATCH", body: { stage: col.dataset.stage } }); }; });
  } else if (tab === "clients") {
    const clients = await api("/api/clients");
    const c = clients.find((x) => x.id === openClient);
    const inter = c ? await api(`/api/clients/${c.id}/interactions`) : [];
    el.innerHTML = `<div class="grid cols-2"><article class="panel"><ul class="list">${clients.map((x) => `<li class="item clickable ${x.id === openClient ? "sel" : ""}" data-open="${x.id}"><div class="grow"><b>${esc(x.name)}</b><div class="meta">${esc(x.company || "")} · ${esc(x.stage)} · ${gbp(x.value)}</div></div></li>`).join("") || '<li class="empty">No clients or leads yet.</li>'}</ul></article>
      <article class="panel">${c ? `<div class="spread"><div><h3 style="font-size:22px">${esc(c.name)}</h3><div class="muted">${esc(c.company || "")}${c.email ? ` · <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ""}${c.phone ? ` · ${esc(c.phone)}` : ""}</div></div><button class="btn small ghost" id="editC">${icon("edit")}Edit</button></div>
        <div class="row wrap" style="margin:10px 0"><span class="pill info">${esc(c.stage)}</span><span class="pill">${gbp(c.value)}</span>${c.next_follow_up ? `<span class="pill warn">follow up ${esc(fmtDay(c.next_follow_up))}</span>` : ""}${c.source ? `<span class="pill">via ${esc(c.source)}</span>` : ""}</div>
        ${c.notes ? `<p class="muted" style="white-space:pre-wrap">${esc(c.notes)}</p>` : ""}
        <div class="panel-head" style="margin-top:12px"><span class="label">Communication history</span><button class="btn tiny" id="logI">${icon("plus")}Log</button></div>
        <ul class="list">${inter.map((i) => `<li class="item"><span class="pill">${esc(i.kind)}</span><div class="grow"><div>${esc(i.summary)}</div><div class="meta">${esc(fmtWhen(i.at))}</div></div></li>`).join("") || '<li class="faint" style="font-size:13px">Nothing logged yet.</li>'}</ul>
        <div class="row wrap" style="margin-top:12px"><button class="btn small" id="newInv">${icon("plus")}Invoice</button><button class="btn small" id="newProp">${icon("plus")}Proposal</button></div>`
        : '<p class="empty">Choose a client to see details and history.</p>'}</article></div>`;
    $$("[data-open]", el).forEach((li) => li.onclick = () => { openClient = Number(li.dataset.open); draw(); });
    if (c) {
      $("#editC", el).onclick = () => editClient(c);
      $("#logI", el).onclick = async () => { const v = await formDialog("Log an interaction", [{ name: "kind", label: "Type", type: "select", value: "call", options: [["call", "Call"], ["email", "Email"], ["meeting", "Meeting"], ["note", "Note"]] }, { name: "summary", label: "Summary", type: "textarea", required: true }]); if (v) api("/api/interactions", { method: "POST", body: { client_id: c.id, ...v } }); };
      $("#newInv", el).onclick = () => editInvoice({ client_id: c.id });
      $("#newProp", el).onclick = () => editProposal({ client_id: c.id });
    }
  } else if (tab === "proposals") {
    const [ps, clients] = await Promise.all([api("/api/proposals"), api("/api/clients")]);
    el.innerHTML = `<div class="row end" style="margin-bottom:10px"><button class="btn small" id="np">${icon("plus")}Proposal</button></div><div class="stack">${ps.map((p) => `<article class="panel"><div class="spread"><div><b>${esc(p.title)}</b><div class="meta muted" style="font-size:12px">${esc(clients.find((c) => c.id === p.client_id)?.name || "No client")} · ${gbp(p.amount)} · ${esc(p.status)}</div></div><div class="row"><button class="btn tiny" data-draft="${p.id}">${icon("bolt")}Draft with JARVIS</button><button class="btn tiny ghost" data-ep="${p.id}">${icon("edit")}</button></div></div>${p.body ? `<details style="margin-top:8px"><summary class="faint" style="cursor:pointer;font-size:12.5px">Read</summary><p style="white-space:pre-wrap;font-size:13.5px">${esc(p.body)}</p></details>` : ""}</article>`).join("") || '<p class="empty">No proposals yet.</p>'}</div>`;
    $("#np", el).onclick = () => editProposal();
    $$("[data-ep]", el).forEach((b) => b.onclick = () => editProposal(ps.find((p) => String(p.id) === b.dataset.ep)));
    $$("[data-draft]", el).forEach((b) => b.onclick = async () => { b.disabled = true; b.textContent = "Drafting…"; try { await api(`/api/proposals/${b.dataset.draft}/draft`, { method: "POST" }); toast("Draft written — review it before sending anything."); } catch (e) { toast(e.message); } draw(); });
  } else if (tab === "invoices") {
    const [inv, clients] = await Promise.all([api("/api/invoices"), api("/api/clients")]);
    el.innerHTML = `<div class="row end" style="margin-bottom:10px"><button class="btn small" id="ni">${icon("plus")}Invoice</button></div><article class="panel"><div class="scroll-x"><table class="tbl"><thead><tr><th>Number</th><th>Client</th><th>Issued</th><th>Due</th><th>Status</th><th class="amt">Total</th><th></th></tr></thead><tbody>${inv.map((i) => `<tr><td class="mono">${esc(i.number)}</td><td>${esc(i.client_name || clients.find((c) => c.id === i.client_id)?.name || "")}</td><td class="faint">${esc(i.issued || "")}</td><td class="${i.status === "sent" && i.due < localDateStr() ? "" : "faint"}" style="${i.status === "sent" && i.due < localDateStr() ? "color:var(--bad)" : ""}">${esc(i.due || "")}</td>
      <td><select class="inp" data-st="${i.id}" style="width:auto;padding:4px 28px 4px 8px">${["draft", "sent", "paid", "void"].map((s) => `<option ${s === i.status ? "selected" : ""}>${s}</option>`).join("")}</select></td><td class="amt">${gbp(i.total)}</td><td><button class="btn tiny ghost" data-ei="${i.id}">${icon("edit")}</button></td></tr>`).join("") || '<tr><td colspan="7" class="empty">No invoices yet.</td></tr>'}</tbody></table></div></article>`;
    $("#ni", el).onclick = () => editInvoice();
    $$("[data-st]", el).forEach((s) => s.onchange = () => api(`/api/invoices/${s.dataset.st}`, { method: "PATCH", body: { status: s.value } }).then(() => toast(s.value === "paid" ? "Marked paid." : "Updated.")));
    $$("[data-ei]", el).forEach((b) => b.onclick = () => editInvoice(inv.find((i) => String(i.id) === b.dataset.ei)));
  } else {
    const ex = await api("/api/expenses");
    el.innerHTML = `<div class="row end" style="margin-bottom:10px"><button class="btn small" id="ne">${icon("plus")}Expense</button></div><article class="panel"><div class="scroll-x"><table class="tbl"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th class="amt">Amount</th><th></th></tr></thead><tbody>${ex.map((x) => `<tr><td class="faint">${esc(x.date)}</td><td>${esc(x.description)}</td><td><span class="pill">${esc(x.category)}</span></td><td class="amt">${gbp(x.amount)}</td><td><button class="x" data-dx="${x.id}" aria-label="Delete">×</button></td></tr>`).join("") || '<tr><td colspan="5" class="empty">No expenses recorded.</td></tr>'}</tbody></table></div><p class="faint" style="font-size:12.5px;margin-bottom:0">This month: ${gbp(sum.expensesMonth)}</p></article>`;
    $("#ne", el).onclick = async () => { const v = await formDialog("Business expense", [{ name: "description", label: "Description", required: true }, { name: "amount", label: "Amount (£)", type: "number", step: "0.01", required: true }, { name: "category", label: "Category", value: "general" }, { name: "date", label: "Date", type: "date", value: localDateStr() }]); if (v) api("/api/expenses", { method: "POST", body: { ...v, amount: toPence(v.amount) } }).catch((e) => toast(e.message)); };
    $$("[data-dx]", el).forEach((b) => b.onclick = async () => { if (await confirmDialog("Delete this expense?", "", { ok: "Delete", danger: true })) api(`/api/expenses/${b.dataset.dx}`, { method: "DELETE" }); });
  }
}

async function editClient(c = null) {
  const v = await formDialog(c ? "Edit client" : "New client or lead", [
    { name: "name", label: "Name", value: c?.name || "", required: true }, { name: "company", label: "Company", value: c?.company || "" },
    { name: "email", label: "Email", type: "email", value: c?.email || "" }, { name: "phone", label: "Phone", value: c?.phone || "" },
    { name: "stage", label: "Stage", type: "select", value: c?.stage || "lead", options: STAGES }, { name: "value", label: "Estimated value (£)", type: "number", step: "0.01", value: pounds(c?.value) },
    { name: "next_follow_up", label: "Next follow-up", type: "date", value: c?.next_follow_up || "" }, { name: "source", label: "Where they came from", value: c?.source || "" },
    { name: "notes", label: "Notes", type: "textarea", value: c?.notes || "" },
    ...(c ? [{ name: "delete", label: "Delete this client", type: "checkbox", value: false }] : []),
  ]);
  if (!v) return;
  if (c && v.delete) { if (await confirmDialog(`Delete ${c.name}?`, "Their history is kept in invoices.", { ok: "Delete", danger: true })) { await api(`/api/clients/${c.id}`, { method: "DELETE" }); openClient = null; draw(); } return; }
  const body = { ...v, value: v.value ? toPence(v.value) : 0, next_follow_up: v.next_follow_up || null };
  delete body.delete;
  try { const r = c ? await api(`/api/clients/${c.id}`, { method: "PATCH", body }) : await api("/api/clients", { method: "POST", body }); openClient = r.id; toast("Saved."); } catch (e) { toast(e.message); }
}
async function editProposal(p = {}) {
  const clients = await api("/api/clients");
  const v = await formDialog(p.id ? "Edit proposal" : "New proposal", [
    { name: "title", label: "Title", value: p.title || "", required: true },
    { name: "client_id", label: "Client", type: "select", value: String(p.client_id || ""), options: [["", "None"], ...clients.map((c) => [String(c.id), c.name])] },
    { name: "amount", label: "Amount (£)", type: "number", step: "0.01", value: pounds(p.amount) },
    { name: "status", label: "Status", type: "select", value: p.status || "draft", options: [["draft", "Draft"], ["sent", "Sent"], ["accepted", "Accepted"], ["rejected", "Rejected"]] },
    { name: "body", label: "Notes / text (JARVIS can draft it from these)", type: "textarea", value: p.body || "" },
  ]);
  if (!v) return;
  const body = { ...v, client_id: v.client_id ? Number(v.client_id) : null, amount: v.amount ? toPence(v.amount) : 0 };
  try { p.id ? await api(`/api/proposals/${p.id}`, { method: "PATCH", body }) : await api("/api/proposals", { method: "POST", body }); tab = "proposals"; draw(); } catch (e) { toast(e.message); }
}
async function editInvoice(i = {}) {
  const clients = await api("/api/clients");
  const lines = (i.items || []).map((it) => `${it.description} | ${it.quantity} | ${pounds(it.unit)}`).join("\n");
  const v = await formDialog(i.id ? `Invoice ${i.number}` : "New invoice", [
    { name: "client_id", label: "Client", type: "select", value: String(i.client_id || ""), options: [["", "None"], ...clients.map((c) => [String(c.id), c.name])] },
    { name: "items", label: "Items — one per line: description | quantity | unit price £", type: "textarea", value: lines, placeholder: "Website design | 1 | 1200\nHosting (months) | 12 | 10" },
    { name: "due", label: "Due date", type: "date", value: i.due || "" },
    { name: "notes", label: "Notes", value: i.notes || "" },
  ]);
  if (!v) return;
  const items = v.items.split("\n").map((l) => l.split("|").map((s) => s.trim())).filter((p) => p[0]).map(([d, q, u]) => ({ description: d, quantity: Number(q) || 1, unit: toPence(u || 0) }));
  const body = { client_id: v.client_id ? Number(v.client_id) : null, items, due: v.due || undefined, notes: v.notes };
  try { const r = i.id ? await api(`/api/invoices/${i.id}`, { method: "PATCH", body }) : await api("/api/invoices", { method: "POST", body }); toast(`${r.number}: ${gbp(r.total)} (draft — nothing has been sent).`); tab = "invoices"; draw(); } catch (e) { toast(e.message); }
}
