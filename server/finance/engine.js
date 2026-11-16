// Financial calculation engine — pure functions, integer pence, fully explained.
// Rules:
// - Credit limits and overdraft limits are never treated as money you own.
// - Movements between your own accounts/pots are excluded from spending and income.
// - Manually entered bills keep their certainty label ("estimated" vs "confirmed"); nothing is presented as confirmed unless it is.

export const GBP = (p) => {
  const neg = p < 0; const v = Math.abs(Math.round(p));
  return `${neg ? "-" : ""}£${Math.floor(v / 100).toLocaleString("en-GB")}.${String(v % 100).padStart(2, "0")}`;
};

// ---------------- Dates (month boundaries in the user's time zone)
function zonedParts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    .formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
/** UTC instant of local midnight on y-m-d in tz. */
export function zonedMidnight(y, m, d, tz) {
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    guess += Date.UTC(y, m - 1, d) - asUtc;
  }
  return new Date(guess);
}
export function monthBounds(now, tz, offset = 0) {
  const p = zonedParts(now, tz);
  const y = p.y + Math.floor((p.m - 1 + offset) / 12);
  const m = ((p.m - 1 + offset) % 12 + 12) % 12 + 1;
  const start = zonedMidnight(y, m, 1, tz);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  return { start, end: zonedMidnight(ny, nm, 1, tz), year: y, month: m, daysInMonth: new Date(Date.UTC(ny, nm - 1, 0)).getUTCDate() };
}
export function localDate(date, tz) { const p = zonedParts(date, tz); return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`; }

// ---------------- Transactions
export const effectiveCategory = (t) => t.category_override || t.category || "other";
const counts = (t) => !t.declined && !t.internal;
const inRange = (t, a, b) => { const c = Date.parse(t.created); return c >= a.getTime() && c < b.getTime(); };

export function spendingSummary(transactions, start, end) {
  const txs = transactions.filter((t) => inRange(t, start, end) && counts(t));
  const out = txs.filter((t) => t.amount < 0);
  const inc = txs.filter((t) => t.amount > 0);
  const byCategory = {};
  for (const t of out) { const c = effectiveCategory(t); byCategory[c] = (byCategory[c] || 0) - t.amount; }
  const merchants = {};
  for (const t of out) { const k = (t.merchant || t.description || "Unknown").trim(); merchants[k] = (merchants[k] || 0) - t.amount; }
  const spent = out.reduce((s, t) => s - t.amount, 0);
  const income = inc.reduce((s, t) => s + t.amount, 0);
  return {
    start: start.toISOString(), end: end.toISOString(),
    spent, income, net: income - spent, count: txs.length,
    byCategory: Object.entries(byCategory).map(([category, amount]) => ({ category, amount, share: spent ? +(amount / spent).toFixed(3) : 0 })).sort((a, b) => b.amount - a.amount),
    topMerchants: Object.entries(merchants).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount).slice(0, 8),
    excludedInternal: transactions.filter((t) => inRange(t, start, end) && t.internal && !t.declined).length,
  };
}

/** Weekly totals (Monday-start) for the given range. */
export function weeklySpending(transactions, start, end) {
  const weeks = new Map();
  for (const t of transactions) {
    if (!inRange(t, start, end) || !counts(t) || t.amount >= 0) continue;
    const d = new Date(t.created); const day = (d.getUTCDay() + 6) % 7;
    const wk = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
    weeks.set(wk, (weeks.get(wk) || 0) - t.amount);
  }
  return [...weeks.entries()].sort().map(([week, amount]) => ({ week, amount }));
}

/** Net money moved into your own pots/savings (positive = saved). */
export function savedInRange(transactions, start, end) {
  return transactions.filter((t) => inRange(t, start, end) && t.internal && !t.declined && t.pot_transfer).reduce((s, t) => s - t.amount, 0);
}

// ---------------- Recurring payments (detected = estimated)
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");
export function detectSubscriptions(transactions, now = new Date()) {
  const groups = new Map();
  for (const t of transactions) {
    if (!counts(t) || t.amount >= 0) continue;
    const k = norm(t.merchant || t.description); if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const subs = [];
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    list.sort((a, b) => Date.parse(a.created) - Date.parse(b.created));
    const months = new Set(list.map((t) => t.created.slice(0, 7)));
    if (months.size < 2) continue;
    const last = list.at(-1), prev = list.at(-2);
    const gap = (Date.parse(last.created) - Date.parse(prev.created)) / 86400_000;
    const similar = Math.abs(last.amount - prev.amount) <= Math.max(100, Math.abs(prev.amount) * 0.15);
    const isSubCat = list.some((t) => effectiveCategory(t) === "subscriptions");
    if (!(gap >= 26 && gap <= 35 && similar) && !(isSubCat && similar)) continue;
    const next = new Date(Date.parse(last.created) + 30 * 86400_000);
    if (now - Date.parse(last.created) > 45 * 86400_000) continue;   // looks cancelled
    subs.push({ name: last.merchant || last.description, amount: -last.amount, lastDate: last.created.slice(0, 10), nextExpected: next.toISOString().slice(0, 10),
      occurrences: list.length, category: effectiveCategory(last), certainty: "detected" });
  }
  return subs.sort((a, b) => b.amount - a.amount);
}

// ---------------- Manual commitments
/** Occurrence dates (YYYY-MM-DD, local) of a bill within [start, end). */
export function billOccurrences(bill, start, end, tz) {
  const out = [];
  const s = localDate(start, tz), e = localDate(new Date(end.getTime() - 1), tz);
  const [sy, sm] = s.split("-").map(Number);
  const pad = (n) => String(n).padStart(2, "0");
  const dim = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (bill.frequency === "once") { if (bill.date >= s && bill.date <= e) out.push(bill.date); return out; }
  if (bill.frequency === "weekly") {
    for (let t = Date.parse(s + "T12:00:00Z"); ; t += 86400_000) {
      const d = new Date(t).toISOString().slice(0, 10); if (d > e) break;
      if (new Date(t).getUTCDay() === Number(bill.weekday ?? 1)) out.push(d);
    }
    return out;
  }
  // monthly / yearly: walk months covered by the range
  for (let y = sy, m = sm; `${y}-${pad(m)}` <= e.slice(0, 7); m === 12 ? (y++, m = 1) : m++) {
    if (bill.frequency === "yearly" && Number(bill.month) !== m) continue;
    const d = `${y}-${pad(m)}-${pad(Math.min(Number(bill.day_of_month) || 1, dim(y, m)))}`;
    if (d >= s && d <= e) out.push(d);
  }
  return out;
}

function matchesBill(t, bill) {
  if (!bill.match_text) return false;
  const text = `${t.merchant || ""} ${t.description || ""}`.toLowerCase();
  return text.includes(bill.match_text.toLowerCase()) && t.amount < 0 && Math.abs(-t.amount - bill.amount) <= Math.max(100, bill.amount * 0.1);
}

// ---------------- The "how much have I got" engine
export function computePosition({ accounts = [], pots = [], transactions = [], bills = [], budgets = {}, buffer = 0, now = new Date(), tz = "Europe/London" }) {
  const { start, end } = monthBounds(now, tz);
  const today = localDate(now, tz);
  const shared = accounts.filter((a) => a.shared && !a.closed);
  const current = shared.filter((a) => a.type === "current");
  const savingsAccts = shared.filter((a) => a.type === "savings");
  const credit = shared.filter((a) => a.type === "credit");
  const livePots = pots.filter((p) => !p.deleted && shared.some((a) => a.id === p.account_id));

  const currentTotal = current.reduce((s, a) => s + (a.balance ?? 0), 0);
  const overdraftUsed = current.filter((a) => (a.balance ?? 0) < 0).reduce((s, a) => s - a.balance, 0);
  const available = current.reduce((s, a) => s + Math.max(0, a.balance ?? 0), 0);
  const savingsTotal = livePots.reduce((s, p) => s + p.balance, 0) + savingsAccts.reduce((s, a) => s + (a.balance ?? 0), 0);
  const creditOwed = credit.reduce((s, a) => s + Math.max(0, -(a.balance ?? 0)), 0);

  // Commitments still to come this month
  const monthTx = transactions.filter((t) => inRange(t, start, end) && !t.declined);
  const items = [], paid = [];
  for (const b of bills.filter((b) => b.active)) {
    for (const date of billOccurrences(b, start, end, tz)) {
      const hit = monthTx.find((t) => matchesBill(t, b));
      const entry = { id: b.id, name: b.name, kind: b.kind, amount: b.amount, date, certainty: b.certainty, category: b.category };
      if (hit) paid.push({ ...entry, paidOn: hit.created.slice(0, 10) });
      else items.push({ ...entry, status: date >= today ? "upcoming" : "due_not_seen" });
    }
  }
  const sum = (k) => items.filter((i) => i.kind === k).reduce((s, i) => s + i.amount, 0);
  const commitments = { items: items.sort((a, b) => a.date.localeCompare(b.date)), bills: sum("bill"), savings: sum("saving"), debt: sum("debt") };
  commitments.total = commitments.bills + commitments.savings + commitments.debt;
  commitments.confirmed = items.filter((i) => i.certainty === "confirmed").reduce((s, i) => s + i.amount, 0);
  commitments.estimated = commitments.total - commitments.confirmed;

  // Budgets
  const month = spendingSummary(transactions, start, end);
  const spentBy = Object.fromEntries(month.byCategory.map((c) => [c.category, c.amount]));
  const budgetRows = Object.entries(budgets).map(([category, budget]) => ({ category, budget, spent: spentBy[category] || 0, remaining: budget - (spentBy[category] || 0) }));
  const budgetRemaining = budgetRows.reduce((s, b) => s + Math.max(0, b.remaining), 0);

  const projected = available - commitments.total;
  const daysLeft = Math.max(1, Math.round((end - now) / 86400_000));

  const lines = [
    { label: "Available in current accounts", amount: available, source: "live" },
    ...(commitments.bills ? [{ label: "Bills still to pay this month", amount: -commitments.bills, source: certaintyOf(items, "bill") }] : []),
    ...(commitments.debt ? [{ label: "Debt repayments still due", amount: -commitments.debt, source: certaintyOf(items, "debt") }] : []),
    ...(commitments.savings ? [{ label: "Planned savings still to move", amount: -commitments.savings, source: certaintyOf(items, "saving") }] : []),
    { label: "Projected disposable until month end", amount: projected, source: "calculated", total: true },
  ];
  const notes = [];
  if (overdraftUsed) notes.push(`You are ${GBP(overdraftUsed)} into your overdraft. Overdraft limits are not counted as available money.`);
  if (creditOwed) notes.push(`You owe ${GBP(creditOwed)} on credit cards. Credit limits are not counted as money you have.`);
  if (items.some((i) => i.status === "due_not_seen")) notes.push("Some bills were due earlier this month but no matching payment has been seen yet; they are still counted.");
  if (commitments.estimated) notes.push(`${GBP(commitments.estimated)} of commitments are your estimates, not confirmed amounts.`);
  if (!current.length) notes.push("No current account is connected, so available money is unknown.");

  return {
    asOf: now.toISOString(), period: { start: start.toISOString(), end: end.toISOString(), daysLeft },
    balances: {
      current: current.map((a) => ({ id: a.id, name: a.name, balance: a.balance })), currentTotal,
      available, overdraftUsed,
      savings: { pots: livePots.map((p) => ({ name: p.name, balance: p.balance })), accounts: savingsAccts.map((a) => ({ name: a.name, balance: a.balance })), total: savingsTotal },
      credit: credit.map((a) => ({ name: a.name, owed: Math.max(0, -(a.balance ?? 0)) })), creditOwed,
    },
    commitments, paid,
    budgets: budgetRows, budgetRemaining,
    projectedDisposable: projected,
    perDay: Math.floor(Math.max(0, projected) / daysLeft),
    buffer,
    month: { spent: month.spent, income: month.income, savedToPots: savedInRange(transactions, start, end) },
    lines, notes,
    connected: current.length > 0,
  };
}
const certaintyOf = (items, kind) => {
  const k = items.filter((i) => i.kind === kind);
  return k.every((i) => i.certainty === "confirmed") ? "confirmed" : k.some((i) => i.certainty === "confirmed") ? "mixed" : "estimated";
};

export function canAfford(position, amount, { category } = {}) {
  const after = position.projectedDisposable - amount;
  const afterBuffer = after - (position.buffer || 0);
  const budget = category ? position.budgets.find((b) => b.category === category) : null;
  const verdict = !position.connected ? "unknown" : afterBuffer >= 0 ? (budget && budget.remaining < amount ? "over_budget" : "yes") : after >= 0 ? "tight" : "no";
  return {
    amount, verdict, projectedBefore: position.projectedDisposable, projectedAfter: after, buffer: position.buffer || 0,
    budget: budget ? { category, remaining: budget.remaining } : null,
    explanation: [
      `Projected disposable money until month end: ${GBP(position.projectedDisposable)} (available ${GBP(position.balances.available)} minus ${GBP(position.commitments.total)} commitments).`,
      `After spending ${GBP(amount)}: ${GBP(after)}.`,
      position.buffer ? `Safety buffer you set: ${GBP(position.buffer)}.` : null,
      budget ? `${category} budget remaining: ${GBP(budget.remaining)}.` : null,
    ].filter(Boolean),
  };
}

export function compareMonths(transactions, now, tz) {
  const cur = monthBounds(now, tz), prev = monthBounds(now, tz, -1);
  const elapsed = now - cur.start;
  const thisMonth = spendingSummary(transactions, cur.start, now);
  const lastSamePoint = spendingSummary(transactions, prev.start, new Date(Math.min(prev.start.getTime() + elapsed, prev.end.getTime())));
  const lastFull = spendingSummary(transactions, prev.start, prev.end);
  const cats = new Set([...thisMonth.byCategory, ...lastSamePoint.byCategory].map((c) => c.category));
  const byCategory = [...cats].map((c) => ({
    category: c,
    thisMonth: thisMonth.byCategory.find((x) => x.category === c)?.amount || 0,
    lastMonthSamePoint: lastSamePoint.byCategory.find((x) => x.category === c)?.amount || 0,
  })).map((r) => ({ ...r, change: r.thisMonth - r.lastMonthSamePoint })).sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
  return { thisMonth, lastMonthSamePoint: lastSamePoint, lastMonthFull: lastFull, change: thisMonth.spent - lastSamePoint.spent, byCategory };
}
