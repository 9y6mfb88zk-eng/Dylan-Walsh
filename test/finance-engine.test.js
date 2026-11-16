import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../server/finance/engine.js";

const tz = "Europe/London";
const now = new Date("2026-11-16T12:00:00Z");
const tx = (id, created, amount, extra = {}) => ({ id, created, amount, category: "other", internal: 0, declined: 0, ...extra });

const accounts = [
  { id: "cur", name: "Current", type: "current", balance: 150000, shared: 1 },
  { id: "cur2", name: "Joint", type: "current", balance: -5000, shared: 1 },       // overdrawn
  { id: "cc", name: "Card", type: "credit", balance: -30000, shared: 1 },          // owes £300
  { id: "hidden", name: "Not shared", type: "current", balance: 999999, shared: 0 },
];
const pots = [{ account_id: "cur", name: "Holiday", balance: 50000, deleted: 0 }];
const transactions = [
  tx("t1", "2026-11-01T09:00:00Z", 250000, { category: "income" }),
  tx("t2", "2026-11-02T09:00:00Z", -4000, { category: "food" }),
  tx("t3", "2026-11-03T09:00:00Z", -20000, { category: "transfers", internal: 1, pot_transfer: 1 }),    // to pot: not spending
  tx("t4", "2026-11-04T09:00:00Z", -99900, { category: "shopping", declined: 1 }),                      // declined: ignored
  tx("t5", "2026-11-05T09:00:00Z", -1099, { category: "subscriptions", merchant: "Netflix" }),
  tx("t6", "2026-11-10T09:00:00Z", -95000, { category: "bills", description: "RENT LANDLORD" }),       // matches rent bill → paid
  tx("t7", "2026-10-05T09:00:00Z", -1099, { category: "subscriptions", merchant: "Netflix" }),
  tx("t8", "2026-10-07T09:00:00Z", -3000, { category: "food" }),
  tx("t9", "2026-11-12T09:00:00Z", -2500, { category: "food", category_override: "entertainment" }),   // user correction wins
];
const bills = [
  { id: 1, name: "Rent", amount: 95000, kind: "bill", frequency: "monthly", day_of_month: 10, certainty: "confirmed", match_text: "rent", active: 1 },
  { id: 2, name: "Phone", amount: 2000, kind: "bill", frequency: "monthly", day_of_month: 20, certainty: "estimated", match_text: "vodafone", active: 1 },
  { id: 3, name: "Savings plan", amount: 10000, kind: "saving", frequency: "monthly", day_of_month: 28, certainty: "confirmed", active: 1 },
  { id: 4, name: "Loan", amount: 15000, kind: "debt", frequency: "monthly", day_of_month: 1, certainty: "confirmed", match_text: "loanco", active: 1 },  // due 1st, not seen
  { id: 5, name: "Old", amount: 1, kind: "bill", frequency: "monthly", day_of_month: 25, active: 0 },
];

test("position separates balances, never counts credit/overdraft limits, ignores unshared accounts", () => {
  const p = E.computePosition({ accounts, pots, transactions, bills, budgets: { food: 20000 }, buffer: 5000, now, tz });
  assert.equal(p.balances.currentTotal, 145000);           // 1500 - 50
  assert.equal(p.balances.available, 150000);               // overdrawn account contributes 0, not negative limit
  assert.equal(p.balances.overdraftUsed, 5000);
  assert.equal(p.balances.creditOwed, 30000);
  assert.equal(p.balances.savings.total, 50000);
  assert.ok(!JSON.stringify(p).includes("999999"), "unshared account excluded");
});

test("commitments: paid bills drop out, due-but-unseen stay, estimates are labelled", () => {
  const p = E.computePosition({ accounts, pots, transactions, bills, budgets: {}, buffer: 0, now, tz });
  assert.deepEqual(p.paid.map((b) => b.name), ["Rent"]);
  const names = p.commitments.items.map((i) => `${i.name}:${i.status}`);
  assert.deepEqual(names.sort(), ["Loan:due_not_seen", "Phone:upcoming", "Savings plan:upcoming"]);
  assert.equal(p.commitments.total, 2000 + 10000 + 15000);
  assert.equal(p.commitments.estimated, 2000);
  assert.equal(p.projectedDisposable, 150000 - 27000);
  assert.ok(p.notes.some((n) => /estimates/.test(n)));
  assert.ok(p.notes.some((n) => /overdraft/.test(n)));
  assert.ok(p.notes.some((n) => /credit/i.test(n)));
  assert.equal(p.lines.at(-1).amount, p.projectedDisposable);
});

test("spending excludes internal transfers and declined payments; overrides win", () => {
  const { start } = E.monthBounds(now, tz);
  const s = E.spendingSummary(transactions, start, now);
  assert.equal(s.spent, 4000 + 1099 + 95000 + 2500);
  assert.equal(s.income, 250000);
  assert.equal(s.excludedInternal, 1);
  assert.equal(s.byCategory.find((c) => c.category === "entertainment").amount, 2500);
  assert.equal(s.byCategory.find((c) => c.category === "food").amount, 4000);
  assert.equal(E.savedInRange(transactions, start, now), 20000);
});

test("budgets and affordability", () => {
  const p = E.computePosition({ accounts, pots, transactions, bills, budgets: { food: 5000 }, buffer: 5000, now, tz });
  assert.deepEqual(p.budgets[0], { category: "food", budget: 5000, spent: 4000, remaining: 1000 });
  assert.equal(E.canAfford(p, 30000).verdict, "yes");
  assert.equal(E.canAfford(p, 120000).verdict, "tight");      // fits only by eating the buffer
  assert.equal(E.canAfford(p, 200000).verdict, "no");
  assert.equal(E.canAfford(p, 3000, { category: "food" }).verdict, "over_budget");
  assert.equal(E.canAfford(E.computePosition({ accounts: [], now, tz }), 100).verdict, "unknown");
});

test("subscriptions are detected from repeating monthly payments", () => {
  const subs = E.detectSubscriptions(transactions, now);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].name, "Netflix");
  assert.equal(subs[0].amount, 1099);
  assert.equal(subs[0].certainty, "detected");
});

test("month comparison and month boundaries in local time", () => {
  const c = E.compareMonths(transactions, now, tz);
  assert.equal(c.lastMonthFull.spent, 4099);
  const b = E.monthBounds(new Date("2026-07-15T12:00:00Z"), tz);
  assert.equal(b.start.toISOString(), "2026-06-30T23:00:00.000Z");      // BST midnight
  assert.equal(E.monthBounds(now, tz).start.toISOString(), "2026-11-01T00:00:00.000Z");
});

test("bill schedules: monthly clamps to month length, weekly, yearly, once", () => {
  const { start, end } = E.monthBounds(new Date("2026-02-10T12:00:00Z"), tz);
  assert.deepEqual(E.billOccurrences({ frequency: "monthly", day_of_month: 31 }, start, end, tz), ["2026-02-28"]);
  assert.equal(E.billOccurrences({ frequency: "weekly", weekday: 1 }, start, end, tz).length, 4);
  assert.deepEqual(E.billOccurrences({ frequency: "yearly", month: 2, day_of_month: 14 }, start, end, tz), ["2026-02-14"]);
  assert.deepEqual(E.billOccurrences({ frequency: "once", date: "2026-03-01" }, start, end, tz), []);
});

test("GBP formatting", () => {
  assert.equal(E.GBP(123456), "£1,234.56");
  assert.equal(E.GBP(-5), "-£0.05");
});
