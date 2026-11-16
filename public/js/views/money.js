// Financial command centre. Every figure shows where it came from; estimates are labelled.
import { api } from "../api.js";
import { $, $$, esc, gbp, toast, confirmDialog, formDialog, barChart, ago, fmtDay, toPence, pounds, localDateStr } from "../util.js";

const SRC = { test: ["TEST DATA", "test"], live: ["live bank data", "ok"], calculated: ["calculated", ""], confirmed: ["confirmed", "ok"], estimated: ["your estimate", "est"], mixed: ["partly estimated", "est"], detected: ["detected pattern", "est"] };
const srcPill = (s) => `<span class="pill ${SRC[s]?.[1] || ""}">${SRC[s]?.[0] || s}</span>`;
const CAT_LABEL = { food: "Food", shopping: "Shopping", transport: "Transport", fuel: "Fuel", bills: "Bills", subscriptions: "Subscriptions", entertainment: "Entertainment", travel: "Travel", transfers: "Transfers", income: "Income", other: "Other" };

let CTX = null;
export async function render(root, ctx, params = {}) {
  CTX = ctx;
  if (params.error) toast(params.error, 7000);
  if (params.connected === "monzo") toast(params.status === "pending_approval" ? "Almost there: approve JARVIS in your Monzo app." : `Monzo connected, ${ctx.settings.profile?.title || "Sir"}.`, 6000);
  root.innerHTML = `<div class="page-head"><div><h2 class="title">Money</h2><p>Read-only. JARVIS never moves money or makes payments.</p></div><div class="row wrap"><button class="btn small primary" id="record">+ Record spending</button><span class="row" id="finActions"></span></div></div><div id="fin"><p class="empty">Loading…</p></div><div id="finExtra"></div>`;
  $("#record", root).onclick = () => recordDialog();
  await load(root);
  if (params.record) recordDialog();
}
export function refresh(entities) { if (entities.includes("*") || entities.includes("finance")) load(document); }

async function recordDialog() {
  const v = await formDialog("Record spending or income", [
    { name: "amount", label: "Amount (£)", type: "number", step: "0.01", required: true, placeholder: "12.50" },
    { name: "description", label: "What for", placeholder: "Lunch" },
    { name: "category", label: "Category", type: "select", value: "food", options: Object.entries(CAT_LABEL) },
    { name: "date", label: "Date", type: "date", value: localDateStr() },
    { name: "income", label: "This is money I received", type: "checkbox", value: false },
  ], { ok: "Record" });
  if (!v) return;
  try { await api("/api/finance/manual", { method: "POST", body: { ...v, amount: toPence(v.amount) } }); toast("Recorded. If your bank later shows the same payment, JARVIS counts it once."); }
  catch (e) { toast(e.message); }
}

async function load(root) {
  const el = $("#fin", root); if (!el) return;
  let f;
  try { f = await api("/api/finance"); } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const conn = f.connections.find((c) => c.provider === "monzo") || f.connections.find((c) => c.provider === "demo");
  $("#finActions", root).innerHTML = conn ? `<button class="btn small" id="sync">Sync now</button>` : "";
  $("#sync", root)?.addEventListener("click", async () => { try { const r = await api("/api/finance/sync", { method: "POST" }); toast(r.errors ? "Sync had a problem — see the connection card." : "Synced."); } catch (e) { toast(e.message); } load(root); });

  const connCard = `<article class="glass panel"><div class="panel-head"><span class="label">Bank connection</span>${f.testData ? '<span class="pill test">TEST DATA</span>' : ""}</div>${connectionBody(f, conn)}</article>`;
  loadExtra(root);
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
  $("#connect", el)?.addEventListener("click", async () => {
    try {
      const { url } = await api("/api/finance/monzo/connect", { method: "POST" });
      // In the Windows app, sign-in happens in your normal browser (Monzo's email link works there); a phone or browser goes straight there.
      if (CTX?.desktop) { window.open(url, "_blank"); toast("Monzo's sign-in has opened in your browser. Follow the email link, approve in the Monzo app, then come back and press Sync now.", 12000); }
      else location.href = url;
    } catch (e) { toast(e.message); }
  });
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

// ---------------------------------------------------------------- Manual entries, savings goals, debts, report
async function loadExtra(root) {
  const el = $("#finExtra", root) || $("#finExtra"); if (!el) return;
  let rep, manual;
  try { [rep, manual] = await Promise.all([api("/api/finance/report?months=6"), api("/api/finance/manual")]); } catch (e) { el.innerHTML = `<p class="error">${esc(e.message)}</p>`; return; }
  const months = rep.history.map((h) => ({ label: new Date(h.month + "-01").toLocaleDateString("en-GB", { month: "short" }), value: h.spent / 100 }));
  el.innerHTML = `<div class="grid cols-2" style="margin-top:14px">
    <article class="panel"><div class="panel-head"><span class="label">Savings goals</span><button class="btn small" id="addGoal">+ Goal</button></div>
      ${rep.goals.length ? `<ul class="list">${rep.goals.map((g) => `<li class="item"><div class="grow"><div class="spread"><b>${esc(g.name)}</b><span class="num">${gbp(g.saved)} / ${gbp(g.target)}</span></div><div class="bar" style="margin:6px 0"><i style="width:${g.percent}%"></i></div>
        <div class="meta">${g.deadline ? `by ${fmtDay(g.deadline)}${g.monthlyNeeded ? ` · ${gbp(g.monthlyNeeded)} a month needed` : ""}` : "no deadline"}${g.monthsAtAverage ? ` · ~${g.monthsAtAverage} months at your average saving <span class="pill est">estimate</span>` : ""}</div></div>
        <button class="btn tiny" data-contrib="${g.id}">+ Add</button><button class="x" data-delgoal="${g.id}" aria-label="Delete">×</button></li>`).join("")}</ul>` : '<p class="muted">No savings goals yet. Add one and JARVIS will track progress and the monthly amount needed.</p>'}
      <p class="faint" style="font-size:12px;margin-bottom:0">Tracking only — adding to a goal doesn't move any money.</p></article>
    <article class="panel"><div class="panel-head"><span class="label">Debts</span><button class="btn small" id="addDebt">+ Debt</button></div>
      ${rep.debts.length ? `<ul class="list">${rep.debts.map((d) => `<li class="item"><div class="grow"><div class="spread"><b>${esc(d.name)}</b><span class="num">${gbp(d.balance)}</span></div><div class="meta">${d.apr}% APR · ${gbp(d.min_payment)} a month · ${d.payoffMonths == null ? '<span style="color:var(--warn)">the payment doesn\'t cover the interest</span>' : `clear in ~${d.payoffMonths} months <span class="pill est">estimate</span>`}</div></div><button class="btn tiny ghost" data-editdebt="${d.id}">Edit</button><button class="x" data-deldebt="${d.id}" aria-label="Delete">×</button></li>`).join("")}</ul><p class="muted" style="font-size:13px;margin-bottom:0">Total owed: <b class="num">${gbp(rep.totalDebt)}</b></p>` : '<p class="muted">No debts recorded.</p>'}</article>
  </div>
  <div class="grid cols-2" style="margin-top:14px">
    <article class="panel"><div class="panel-head"><span class="label">Report · last 6 months</span>${rep.testData ? '<span class="pill test">TEST DATA</span>' : ""}</div>
      ${months.some((m) => m.value) ? barChart(months, { fmt: (v) => `£${v.toFixed(2)}` }) : '<p class="muted">Not enough history yet.</p>'}
      <div class="grid cols-3" style="margin-top:12px">
        <div class="stat"><b>${rep.averages.spent != null ? gbp(rep.averages.spent) : "—"}</b><span>average spent / month</span></div>
        <div class="stat"><b>${rep.averages.income != null ? gbp(rep.averages.income) : "—"}</b><span>average income / month</span></div>
        <div class="stat"><b>${rep.averages.net != null ? gbp(rep.averages.net, { sign: true }) : "—"}</b><span>average net / month</span></div>
      </div>
      ${rep.netWorth ? `<div class="calc" style="margin-top:12px"><div class="ln"><span>Cash</span><span class="num">${gbp(rep.netWorth.cash)}</span></div><div class="ln"><span>Savings & pots</span><span class="num">${gbp(rep.netWorth.savings)}</span></div><div class="ln"><span>Credit cards</span><span class="num">${gbp(rep.netWorth.credit)}</span></div><div class="ln"><span>Debts you entered</span><span class="num">${gbp(rep.netWorth.debts)}</span></div><div class="ln total"><span>Net position</span><span class="num">${gbp(rep.netWorth.total)}</span></div></div>` : ""}
    </article>
    <article class="panel"><div class="panel-head"><span class="label">Projection</span><span class="pill est">estimate</span></div>
      ${rep.projection.monthlyNet != null ? `<div class="grid cols-3"><div class="stat"><b>${gbp(rep.projection.in3Months, { sign: true })}</b><span>in 3 months</span></div><div class="stat"><b>${gbp(rep.projection.in6Months, { sign: true })}</b><span>in 6 months</span></div><div class="stat"><b>${gbp(rep.projection.in12Months, { sign: true })}</b><span>in 12 months</span></div></div>` : ""}
      <p class="muted" style="font-size:13px">${esc(rep.projection.note)}</p>
      <div class="panel-head" style="margin-top:14px"><span class="label">Recorded by hand</span><span class="faint" style="font-size:12px">${rep.manualCount} entries</span></div>
      ${manual.length ? `<ul class="list">${manual.slice(0, 12).map((t) => `<li class="item"><div class="grow"><div>${esc(t.description)}${t.matched_id ? ' <span class="pill ok">matched to bank</span>' : ""}</div><div class="meta">${fmtDay(t.created)} · ${esc(CAT_LABEL[t.category] || t.category)}</div></div><b class="num">${gbp(t.amount, { sign: true })}</b><button class="x" data-delman="${esc(t.id)}" aria-label="Delete">×</button></li>`).join("")}</ul>` : '<p class="muted">Tell JARVIS “I just spent £12.50 on food”, or press Record spending.</p>'}
    </article>
  </div>`;
  $("#addGoal", el).onclick = async () => {
    const v = await formDialog("New savings goal", [{ name: "name", label: "Goal", required: true, placeholder: "Holiday" }, { name: "target", label: "Target (£)", type: "number", step: "0.01", required: true }, { name: "saved", label: "Already saved (£)", type: "number", step: "0.01", value: "0" }, { name: "deadline", label: "Target date", type: "date" }]);
    if (v) api("/api/savings-goals", { method: "POST", body: { name: v.name, target: toPence(v.target), saved: toPence(v.saved || 0), deadline: v.deadline || null } }).catch((e) => toast(e.message));
  };
  $$("[data-contrib]", el).forEach((b) => b.onclick = async () => { const v = await formDialog("Add to goal", [{ name: "amount", label: "Amount (£, negative to take out)", type: "number", step: "0.01", required: true }]); if (v) api(`/api/savings-goals/${b.dataset.contrib}/contribute`, { method: "POST", body: { amount: toPence(v.amount) } }).catch((e) => toast(e.message)); });
  $$("[data-delgoal]", el).forEach((b) => b.onclick = async () => { if (await confirmDialog("Delete this goal?", "Its tracked progress will be removed.", { ok: "Delete", danger: true })) api(`/api/savings-goals/${b.dataset.delgoal}`, { method: "DELETE" }); });
  const debtDialog = async (d = {}) => {
    const v = await formDialog(d.id ? "Edit debt" : "Add a debt", [{ name: "name", label: "Name", value: d.name, required: true, placeholder: "Credit card" }, { name: "balance", label: "Balance owed (£)", type: "number", step: "0.01", value: pounds(d.balance), required: true }, { name: "apr", label: "APR (%)", type: "number", step: "0.1", value: d.apr ?? 0 }, { name: "min_payment", label: "Monthly payment (£)", type: "number", step: "0.01", value: pounds(d.min_payment) }]);
    if (v) api(d.id ? `/api/debts/${d.id}` : "/api/debts", { method: d.id ? "PATCH" : "POST", body: { name: v.name, balance: toPence(v.balance), apr: Number(v.apr || 0), min_payment: toPence(v.min_payment || 0) } }).catch((e) => toast(e.message));
  };
  $("#addDebt", el).onclick = () => debtDialog();
  $$("[data-editdebt]", el).forEach((b) => b.onclick = () => debtDialog(rep.debts.find((d) => String(d.id) === b.dataset.editdebt)));
  $$("[data-deldebt]", el).forEach((b) => b.onclick = async () => { if (await confirmDialog("Delete this debt?", "It will be removed from your reports.", { ok: "Delete", danger: true })) api(`/api/debts/${b.dataset.deldebt}`, { method: "DELETE" }); });
  $$("[data-delman]", el).forEach((b) => b.onclick = async () => { if (await confirmDialog("Delete this entry?", "Only entries you recorded by hand can be deleted.", { ok: "Delete", danger: true })) api(`/api/finance/manual/${b.dataset.delman}`, { method: "DELETE" }).catch((e) => toast(e.message)); });
}
