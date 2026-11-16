// Financial command centre. Every figure shows where it came from; estimates are labelled.
import { api } from "../api.js";
import { $, $$, esc, gbp, toast, confirmDialog, formDialog, barChart, ago, fmtDay } from "../util.js";

const SRC = { test: ["TEST DATA", "test"], live: ["live bank data", "ok"], calculated: ["calculated", ""], confirmed: ["confirmed", "ok"], estimated: ["your estimate", "est"], mixed: ["partly estimated", "est"], detected: ["detected pattern", "est"] };
const srcPill = (s) => `<span class="pill ${SRC[s]?.[1] || ""}">${SRC[s]?.[0] || s}</span>`;
const CAT_LABEL = { food: "Food", shopping: "Shopping", transport: "Transport", fuel: "Fuel", bills: "Bills", subscriptions: "Subscriptions", entertainment: "Entertainment", travel: "Travel", transfers: "Transfers", income: "Income", other: "Other" };

export async function render(root, ctx, params = {}) {
  if (params.error) toast(params.error, 7000);
  if (params.connected === "monzo") toast(params.status === "pending_approval" ? "Almost there: approve JARVIS in your Monzo app." : "Monzo connected, sir.", 6000);
  root.innerHTML = `<div class="spread" style="margin-bottom:12px"><h2 class="title">Money</h2><div class="row" id="finActions"></div></div><div id="fin"><p class="empty">Loading…</p></div>`;
  await load(root);
}
export function refresh(entities) { if (entities.includes("*") || entities.includes("finance")) load(document); }

async function load(root) {
  const el = $("#fin", root); if (!el) return;
  let f;
  try { f = await api("/api/finance"); } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const conn = f.connections.find((c) => c.provider === "monzo") || f.connections.find((c) => c.provider === "demo");
  $("#finActions", root).innerHTML = conn ? `<button class="btn small" id="sync">Sync now</button>` : "";
  $("#sync", root)?.addEventListener("click", async () => { try { const r = await api("/api/finance/sync", { method: "POST" }); toast(r.errors ? "Sync had a problem — see the connection card." : "Synced."); } catch (e) { toast(e.message); } load(root); });

  const connCard = `<article class="glass panel"><div class="panel-head"><span class="label">Bank connection</span>${f.testData ? '<span class="pill test">TEST DATA</span>' : ""}</div>${connectionBody(f, conn)}</article>`;
  if (!f.accounts.length) { el.innerHTML = `<div class="grid">${connCard}</div>`; wire(el, f); return; }

  const p = f.position, b = p.balances;
  if (f.testData) p.lines.forEach((l) => { if (l.source === "live") l.source = "test"; });
  const LIVE = f.testData ? "test" : "live";
  el.innerHTML = `
  ${f.testData ? '<div class="banner test">You are looking at clearly labelled TEST DATA from development mode. None of these figures are real.</div>' : ""}
  <div class="grid cols-4" style="margin-bottom:14px">
    ${tile("Bank balance", gbp(b.currentTotal), LIVE, "Current accounts, excluding pots")}
    ${tile("Available", gbp(b.available), LIVE, b.overdraftUsed ? `Overdrawn by ${gbp(b.overdraftUsed)}` : "Money you can spend now")}
    ${tile("Budget remaining", Object.keys(f.budgets).length ? gbp(p.budgetRemaining) : "—", "calculated", Object.keys(f.budgets).length ? "Across your category budgets" : "Set budgets below")}
    ${tile("Projected disposable", gbp(p.projectedDisposable), p.commitments.estimated ? "mixed" : "calculated", `≈ ${gbp(p.perDay)} a day for ${p.period.daysLeft} days`)}
  </div>
  <div class="grid cols-2">
    <article class="glass panel"><div class="panel-head"><span class="label">How the figure is worked out</span></div>
      <div class="calc">${p.lines.map((l) => `<div class="ln ${l.total ? "total" : ""}"><span>${esc(l.label)} ${l.total ? "" : srcPill(l.source)}</span><span class="num">${gbp(l.amount)}</span></div>`).join("")}</div>
      ${p.notes.length ? `<ul style="margin:10px 0 0;padding-left:18px;font-size:13px" class="muted">${p.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      ${b.savings.total || b.creditOwed ? `<div class="grid cols-2" style="margin-top:12px;font-size:13px"><div><span class="label">Savings & pots</span><div class="mid">${gbp(b.savings.total)}</div>${b.savings.pots.map((x) => `<div class="muted">${esc(x.name)} · ${gbp(x.balance)}</div>`).join("")}</div>${b.creditOwed ? `<div><span class="label">Owed on credit</span><div class="mid">${gbp(b.creditOwed)}</div><div class="muted">Not counted as money you have.</div></div>` : ""}</div>` : ""}
    </article>
    <article class="glass panel"><div class="panel-head"><span class="label">Still to pay this month</span><button class="btn small" id="addBill">+ Bill / saving / debt</button></div>
      ${p.commitments.items.length ? `<ul class="list">${p.commitments.items.map((i) => `<li class="item"><div class="grow"><div>${esc(i.name)} <span class="pill">${i.kind}</span></div><div class="meta">${fmtDay(i.date)}${i.status === "due_not_seen" ? " · due, payment not seen yet" : ""}</div></div>${srcPill(i.certainty)}<b class="num">${gbp(i.amount)}</b></li>`).join("")}</ul>` : '<p class="muted">No upcoming commitments recorded. Add your bills so “money left” is accurate.</p>'}
      ${p.paid.length ? `<p class="faint" style="font-size:13px;margin-bottom:0">Already paid: ${p.paid.map((x) => `${esc(x.name)} (${gbp(x.amount)})`).join(", ")}</p>` : ""}
      <details style="margin-top:10px"><summary class="faint" style="cursor:pointer;font-size:13px">Manage all ${f.bills.length} recurring items</summary><ul class="list" style="margin-top:8px">${f.bills.map((x) => `<li class="item" data-bill="${x.id}"><div class="grow"><div>${esc(x.name)}</div><div class="meta">${x.frequency}${x.day_of_month ? ` · day ${x.day_of_month}` : ""}${x.date ? ` · ${x.date}` : ""} · ${x.kind}${x.match_text ? ` · matches “${esc(x.match_text)}”` : ""}</div></div>${srcPill(x.certainty)}<b class="num">${gbp(x.amount)}</b><button class="btn small ghost" data-edit="${x.id}">Edit</button><button class="x" data-delbill="${x.id}" aria-label="Delete">×</button></li>`).join("") || '<li class="faint">None yet.</li>'}</ul></details>
    </article>
  </div>
  <div class="grid cols-2" style="margin-top:14px">
    <article class="glass panel"><div class="panel-head"><span class="label">Spending this month <span class="src">excludes transfers between your own accounts</span></span><b class="num">${gbp(f.month.spent)}</b></div>
      <div class="cat-bars">${f.month.byCategory.map((c) => { const bud = f.budgets[c.category]; return `<div class="cat-row"><span>${CAT_LABEL[c.category] || c.category}</span><div class="bar"><i style="width:${Math.round(c.share * 100)}%"></i></div><span class="num" style="text-align:right">${gbp(c.amount)}${bud ? `<br><small class="${c.amount > bud ? "" : "faint"}" style="${c.amount > bud ? "color:var(--bad)" : ""}">of ${gbp(bud)}</small>` : ""}</span></div>`; }).join("") || '<p class="muted">No spending yet this month.</p>'}</div>
      <div class="spread" style="margin-top:10px;font-size:13px"><span class="muted">Income ${gbp(f.month.income)} · Saved to pots ${gbp(p.month.savedToPots)}</span><button class="btn small ghost" id="budgets">Budgets</button></div>
    </article>
    <article class="glass panel"><div class="panel-head"><span class="label">Weekly spending</span><span class="faint" style="font-size:12px">last 12 weeks</span></div>
      ${barChart(f.weekly.map((w) => ({ label: new Date(w.week).toLocaleDateString("en-GB", { day: "numeric", month: "short" }), value: w.amount / 100 })), { fmt: (v) => `£${v.toFixed(2)}` })}
      <div style="margin-top:12px;font-size:14px"><span class="label">Compared with last month</span><div class="spread" style="margin-top:6px"><span>So far this month <b class="num">${gbp(f.comparison.thisMonth.spent)}</b></span><span>Same point last month <b class="num">${gbp(f.comparison.lastMonthSamePoint.spent)}</b></span></div>
        <div class="muted" style="font-size:13px">${f.comparison.change > 0 ? `${gbp(f.comparison.change)} more` : f.comparison.change < 0 ? `${gbp(-f.comparison.change)} less` : "The same"} than this time last month. Last month in full: ${gbp(f.comparison.lastMonthFull.spent)}.</div></div>
    </article>
  </div>
  <div class="grid cols-2" style="margin-top:14px">
    <article class="glass panel"><div class="panel-head"><span class="label">Subscriptions</span><span class="pill est">detected from repeating payments</span></div>
      ${f.subscriptions.length ? `<ul class="list">${f.subscriptions.map((s) => `<li class="item"><div class="grow"><div>${esc(s.name)}</div><div class="meta">last ${s.lastDate} · next expected ~${s.nextExpected}</div></div><b class="num">${gbp(s.amount)}</b></li>`).join("")}</ul><p class="faint" style="font-size:13px;margin-bottom:0">≈ ${gbp(f.subscriptions.reduce((a, s) => a + s.amount, 0))} a month</p>` : '<p class="muted">None detected yet (needs at least two monthly payments).</p>'}
    </article>
    ${connCard}
  </div>
  <article class="glass panel" style="margin-top:14px"><div class="panel-head"><span class="label">Recent transactions</span><span class="faint" style="font-size:12px">change a category to correct it</span></div>
    <div class="scroll-x"><table class="tbl"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th style="text-align:right">Amount</th></tr></thead><tbody>
    ${f.recent.map((t) => `<tr style="${t.declined ? "opacity:.45" : ""}"><td class="mono faint">${t.created.slice(5, 10)}</td><td>${esc(t.merchant || t.description)}${t.internal ? ' <span class="pill">internal</span>' : ""}${t.declined ? ' <span class="pill bad">declined</span>' : ""}</td>
      <td><select class="inp" data-tx="${esc(t.id)}" style="padding:4px 6px;font-size:13px;width:auto">${f.categories.map((c) => `<option value="${c}" ${c === t.category ? "selected" : ""}>${CAT_LABEL[c]}</option>`).join("")}</select>${t.category !== t.auto_category ? ' <span class="pill">edited</span>' : ""}</td>
      <td class="amt ${t.amount > 0 ? "pos" : ""}">${gbp(t.amount, { sign: true })}</td></tr>`).join("")}</tbody></table></div>
  </article>`;
  wire(el, f);
}

function tile(label, value, src, sub) {
  return `<article class="glass panel"><div class="label">${label}</div><div class="mid" style="margin:6px 0">${value}</div><div class="spread" style="font-size:12px"><span class="muted">${esc(sub)}</span>${srcPill(src)}</div></article>`;
}

function connectionBody(f, conn) {
  if (!conn) {
    return `<p style="margin-top:0">Connect your Monzo account so JARVIS can answer money questions from real data. Access is read-only, and your bank login never touches JARVIS.</p>
      ${f.monzoConfigured ? '<button class="btn primary" id="connect">Connect Monzo</button>' : '<p class="faint">Monzo isn\'t configured on the server yet: add MONZO_CLIENT_ID and MONZO_CLIENT_SECRET (see the README).</p>'}
      ${f.demoAvailable ? '<button class="btn ghost" id="demo" style="margin-left:6px">Load labelled test data</button>' : ""}`;
  }
  const status = { active: ["Connected", "ok"], pending_approval: ["Waiting for approval in the Monzo app", "warn"], expired: ["Access expired — reconnect", "bad"], error: ["Error", "bad"] }[conn.status] || [conn.status, "warn"];
  return `<div class="row" style="margin-bottom:8px"><span class="dot ${status[1]}"></span><b>${conn.provider === "demo" ? "Test data" : "Monzo"}</b> · ${status[0]}</div>
    <div class="muted" style="font-size:13px">Last sync: ${ago(conn.last_sync_at)}${conn.last_error ? `<br><span style="color:var(--warn)">${esc(conn.last_error)}</span>` : ""}</div>
    ${conn.status === "pending_approval" ? '<p style="font-size:14px">Open the Monzo app and approve “JARVIS” (Monzo asks for this extra security step). Then tap Sync now.</p>' : ""}
    ${f.accounts.length ? `<div style="margin-top:10px"><span class="label">Accounts shared with JARVIS</span>${f.accounts.map((a) => `<div class="set-row" style="padding:8px 0"><div><div>${esc(a.name)}</div><div class="muted">${a.type}${a.balance != null ? ` · ${gbp(a.balance)}` : ""}</div></div><label class="switch"><input type="checkbox" data-share="${esc(a.id)}" ${a.shared ? "checked" : ""}><span></span></label></div>`).join("")}</div>` : ""}
    <div class="row wrap" style="margin-top:10px">${["expired", "error"].includes(conn.status) && conn.provider === "monzo" ? '<button class="btn primary small" id="connect">Reconnect Monzo</button>' : ""}<button class="btn danger small" id="disconnect" data-provider="${conn.provider}">Disconnect</button></div>`;
}

function wire(el, f) {
  $("#connect", el)?.addEventListener("click", async () => { try { const { url } = await api("/api/finance/monzo/connect", { method: "POST" }); location.href = url; } catch (e) { toast(e.message); } });
  $("#demo", el)?.addEventListener("click", async () => { try { await api("/api/finance/demo", { method: "POST" }); } catch (e) { toast(e.message); } });
  $("#disconnect", el)?.addEventListener("click", async (e) => {
    if (!(await confirmDialog("Disconnect your bank?", "JARVIS will revoke its access and delete all stored balances and transactions from this connection.", { ok: "Disconnect", danger: true }))) return;
    await api("/api/finance/disconnect", { method: "POST", body: { provider: e.target.dataset.provider } }); toast("Disconnected and data deleted.");
  });
  $$("[data-share]", el).forEach((c) => c.onchange = () => api(`/api/finance/accounts/${c.dataset.share}`, { method: "PATCH", body: { shared: c.checked } }));
  $$("[data-tx]", el).forEach((s) => s.onchange = () => api(`/api/finance/transactions/${s.dataset.tx}`, { method: "PATCH", body: { category: s.value } }).then(() => toast("Category updated.")));
  $("#addBill", el)?.addEventListener("click", () => billDialog());
  $$("[data-edit]", el).forEach((b) => b.onclick = () => billDialog(f.bills.find((x) => String(x.id) === b.dataset.edit)));
  $$("[data-delbill]", el).forEach((b) => b.onclick = async () => { if (await confirmDialog("Delete this item?", "It will no longer count towards your commitments.", { ok: "Delete", danger: true })) api(`/api/finance/bills/${b.dataset.delbill}`, { method: "DELETE" }); });
  $("#budgets", el)?.addEventListener("click", async () => {
    const cats = f.categories.filter((c) => !["income", "transfers"].includes(c));
    const v = await formDialog("Monthly budgets (£, blank = none)", cats.map((c) => ({ name: c, label: CAT_LABEL[c], type: "number", step: "0.01", value: f.budgets[c] != null ? (f.budgets[c] / 100).toFixed(2) : "" })));
    if (!v) return;
    for (const c of cats) await api(`/api/finance/budgets/${c}`, { method: "PUT", body: { amount: v[c] === "" ? null : Math.round(Number(v[c]) * 100) } });
    toast("Budgets saved.");
  });
}

async function billDialog(b = {}) {
  const v = await formDialog(b.id ? "Edit item" : "Add a bill, saving or debt payment", [
    { name: "name", label: "Name", value: b.name, required: true },
    { name: "amount", label: "Amount (£)", type: "number", step: "0.01", value: b.amount ? (b.amount / 100).toFixed(2) : "", required: true },
    { name: "kind", label: "Type", type: "select", value: b.kind || "bill", options: [["bill", "Bill"], ["saving", "Planned saving"], ["debt", "Debt repayment"]] },
    { name: "frequency", label: "How often", type: "select", value: b.frequency || "monthly", options: [["monthly", "Monthly"], ["weekly", "Weekly"], ["yearly", "Yearly"], ["once", "Once"]] },
    { name: "day_of_month", label: "Day of month (monthly/yearly)", type: "number", value: b.day_of_month || "" },
    { name: "date", label: "Date (one-off)", type: "date", value: b.date || "" },
    { name: "certainty", label: "Is the amount fixed?", type: "select", value: b.certainty || "estimated", options: [["estimated", "No — it's my estimate"], ["confirmed", "Yes — confirmed amount"]] },
    { name: "match_text", label: "Text in the bank description (marks it paid)", value: b.match_text || "", placeholder: "e.g. VODAFONE" },
  ]);
  if (!v) return;
  const body = { ...v, amount: Math.round(Number(v.amount) * 100), day_of_month: v.day_of_month ? Number(v.day_of_month) : null, date: v.date || null };
  try { await api(b.id ? `/api/finance/bills/${b.id}` : "/api/finance/bills", { method: b.id ? "PUT" : "POST", body }); toast("Saved."); } catch (e) { toast(e.message); }
}
