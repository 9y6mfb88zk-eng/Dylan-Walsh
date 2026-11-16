// Finance additions: manual transactions, reconciliation with the bank feed, reports and projections.
// All figures are integer pence. Projections are labelled as estimates; nothing here moves money.
import { db, tx, getSettings } from "../db.js";
import { changed } from "../realtime.js";
import { randomId } from "../security/crypto.js";
import { categorize, CATEGORIES } from "../finance/categorize.js";
import * as engine from "../finance/engine.js";
import { loadData } from "../finance/service.js";
import { savingsGoals, debts } from "./records.js";
import { logActivity } from "./notify.js";

const MANUAL_ACCOUNT = "manual-entries";
const bad = (m) => Object.assign(new Error(m), { status: 400, expose: true });

function manualAccount() {
  let conn = db.prepare("SELECT * FROM connections WHERE provider = 'manual' AND status != 'disconnected' LIMIT 1").get();
  if (!conn) {
    const r = db.prepare("INSERT INTO connections (provider, status) VALUES ('manual', 'active')").run();
    conn = { id: Number(r.lastInsertRowid) };
  }
  if (!db.prepare("SELECT 1 FROM fin_accounts WHERE id = ?").get(MANUAL_ACCOUNT)) {
    // Type 'manual' is deliberately not current/savings/credit: it never changes the balances JARVIS reports.
    db.prepare("INSERT INTO fin_accounts (id, connection_id, name, type, currency, balance, shared, updated_at) VALUES (?, ?, 'Manual entries', 'manual', 'GBP', NULL, 1, ?)")
      .run(MANUAL_ACCOUNT, conn.id, new Date().toISOString());
  }
  return MANUAL_ACCOUNT;
}

/** Record a spend or income the user tells JARVIS about. amount in pence: positive = money out unless income. */
export function addManualTransaction({ amount, description = "", category, date, income = false, note = "" } = {}, { deviceId } = {}) {
  const pence = Math.round(Math.abs(Number(amount)));
  if (!Number.isFinite(pence) || pence <= 0) throw bad("The amount must be more than zero");
  if (pence > 10_000_000) throw bad("That amount looks too large to record by hand");
  if (category && !CATEGORIES.includes(category)) throw bad(`Category must be one of ${CATEGORIES.join(", ")}`);
  const created = date ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00Z` : date) : new Date();
  if (Number.isNaN(created.getTime())) throw bad("Invalid date");
  const account = manualAccount();
  const signed = income ? pence : -pence;
  const desc = String(description || (income ? "Income" : "Spending")).trim().slice(0, 200);
  const cat = category || categorize({ description: desc, merchant: desc, providerCategory: "", amount: signed, internal: false });
  const id = `manual-${randomId().slice(0, 12)}`;
  db.prepare(`INSERT INTO fin_transactions (id, account_id, created, amount, currency, description, merchant, provider_category, category, internal, pot_transfer, declined, settled, note)
    VALUES (?, ?, ?, ?, 'GBP', ?, ?, 'manual', ?, 0, 0, 0, 1, ?)`).run(id, account, created.toISOString(), signed, desc, desc, cat, String(note).slice(0, 500));
  changed("finance");
  logActivity("finance", `${income ? "Income" : "Spending"} recorded: ${engine.GBP(pence)} ${desc ? `— ${desc}` : ""} (${cat})`, { id }, deviceId);
  return db.prepare("SELECT * FROM fin_transactions WHERE id = ?").get(id);
}
export function removeManualTransaction(id) {
  if (!String(id).startsWith("manual-")) throw bad("Only manual entries can be deleted; bank transactions come from your bank.");
  const ok = db.prepare("DELETE FROM fin_transactions WHERE id = ? AND account_id = ?").run(String(id), MANUAL_ACCOUNT).changes > 0;
  changed("finance");
  return ok;
}
export function manualTransactions(limit = 100) {
  return db.prepare("SELECT * FROM fin_transactions WHERE account_id = ? ORDER BY created DESC LIMIT ?").all(MANUAL_ACCOUNT, limit);
}

/**
 * When a bank transaction arrives with the same amount within two days of a manual entry, link them so the spend
 * is only counted once. Returns how many were matched.
 */
export function reconcileManual() {
  const open = db.prepare("SELECT * FROM fin_transactions WHERE account_id = ? AND matched_id IS NULL").all(MANUAL_ACCOUNT);
  let matched = 0;
  tx(() => {
    for (const m of open) {
      const t = Date.parse(m.created);
      const hit = db.prepare(`SELECT id FROM fin_transactions WHERE account_id != ? AND amount = ? AND declined = 0 AND internal = 0
        AND created BETWEEN ? AND ? AND id NOT IN (SELECT matched_id FROM fin_transactions WHERE matched_id IS NOT NULL) ORDER BY ABS(julianday(created) - julianday(?)) LIMIT 1`)
        .get(MANUAL_ACCOUNT, m.amount, new Date(t - 2 * 86400_000).toISOString(), new Date(t + 2 * 86400_000).toISOString(), m.created);
      if (hit) { db.prepare("UPDATE fin_transactions SET matched_id = ? WHERE id = ?").run(hit.id, m.id); matched++; }
    }
  });
  if (matched) changed("finance");
  return { matched };
}

/** Months to clear a debt at a fixed monthly payment (null if the payment never clears it). */
export function payoffMonths(balance, aprPercent, monthly) {
  if (balance <= 0) return 0;
  if (monthly <= 0) return null;
  const r = aprPercent / 100 / 12;
  if (r === 0) return Math.ceil(balance / monthly);
  if (monthly <= balance * r) return null;
  return Math.ceil(-Math.log(1 - (r * balance) / monthly) / Math.log(1 + r));
}

/** Monthly history, savings goals, debts and simple projections — every estimate is marked as one. */
export function report({ months = 6 } = {}) {
  const s = getSettings(); const tz = s.timezone; const now = new Date();
  const d = loadData();
  const txs = d.transactions.filter((t) => !t.matched_id);
  const history = [];
  for (let i = months - 1; i >= 0; i--) {
    const { start, end } = engine.monthBounds(now, tz, -i);
    const sum = engine.spendingSummary(txs, start, i === 0 ? now : end);
    history.push({ month: engine.localDate(start, tz).slice(0, 7), spent: sum.spent, income: sum.income, net: sum.income - sum.spent, partial: i === 0, byCategory: sum.byCategory.slice(0, 6) });
  }
  const full = history.filter((h) => !h.partial && (h.spent || h.income));
  const avg = (k) => (full.length ? Math.round(full.reduce((a, h) => a + h[k], 0) / full.length) : null);
  const avgNet = avg("net");
  const pos = engine.computePosition({ ...d, transactions: txs, buffer: s.finance.buffer, now, tz });
  const goals = savingsGoals.list().map((g) => {
    const left = Math.max(0, g.target - g.saved);
    const monthsLeft = g.deadline ? Math.max(1, Math.round((Date.parse(g.deadline) - now) / (30.44 * 86400_000))) : null;
    return { ...g, left, monthlyNeeded: monthsLeft ? Math.ceil(left / monthsLeft) : null, monthsAtAverage: avgNet > 0 ? Math.ceil(left / avgNet) : null };
  });
  const debtRows = debts.list().map((x) => ({ ...x, payoffMonths: payoffMonths(x.balance, x.apr, x.min_payment) }));
  const totalDebt = debtRows.reduce((a, x) => a + x.balance, 0);
  const bank = d.accounts.filter((a) => a.type !== "manual");
  return {
    asOf: now.toISOString(), bankConnected: bank.length > 0, testData: d.accounts.some((a) => a.provider === "demo"),
    history,
    averages: { spent: avg("spent"), income: avg("income"), net: avgNet, basedOnMonths: full.length, estimate: true },
    netWorth: bank.length ? { cash: pos.balances.currentTotal, savings: pos.balances.savings.total, credit: -pos.balances.creditOwed, debts: -totalDebt, total: pos.balances.currentTotal + pos.balances.savings.total - pos.balances.creditOwed - totalDebt, note: "Debts you entered by hand are included; credit and overdraft limits are not." } : null,
    projection: avgNet != null ? {
      estimate: true, monthlyNet: avgNet,
      in3Months: avgNet * 3, in6Months: avgNet * 6, in12Months: avgNet * 12,
      note: `Based on your average net of the last ${full.length} full month(s). Real results will differ.`,
    } : { estimate: true, note: "Not enough history yet for a projection." },
    goals, debts: debtRows, totalDebt,
    manualCount: db.prepare("SELECT COUNT(*) AS n FROM fin_transactions WHERE account_id = ?").get(MANUAL_ACCOUNT).n,
  };
}

/** Add money to a savings goal's tracked total (bookkeeping only — no money is moved). */
export function contributeToGoal(id, pence) {
  const g = savingsGoals.get(id);
  if (!g) return null;
  const amount = Math.round(Number(pence));
  if (!Number.isFinite(amount) || amount === 0) throw bad("Enter an amount");
  return savingsGoals.update(id, { saved: Math.max(0, g.saved + amount) });
}
