// Finance service: Monzo connection lifecycle, sync, storage and the questions JARVIS answers.
import { db, tx, getSettings } from "../db.js";
import { config, isProd } from "../config.js";
import * as monzo from "../integrations/monzo.js";
import { createState, consumeState, connections } from "../services/oauth.js";
import { categorize, CATEGORIES } from "./categorize.js";
import * as engine from "./engine.js";
import { changed } from "../realtime.js";
import { audit } from "../security/audit.js";

const DEMO = "demo";
export const demoAllowed = () => config.demoFinance && !isProd;

// ---------------- Connection lifecycle
export function startMonzo({ redirectUri, deviceId }) {
  if (!monzo.monzoConfigured()) throw Object.assign(new Error("Monzo is not configured on the server. Add MONZO_CLIENT_ID and MONZO_CLIENT_SECRET."), { status: 503 });
  return monzo.authorizeUrl({ state: createState("monzo", deviceId), redirectUri });
}

export async function finishMonzo({ state, code, redirectUri }) {
  const st = consumeState(state, "monzo");
  if (!code) throw Object.assign(new Error("Monzo did not return an authorisation code."), { status: 400 });
  const t = await monzo.exchangeCode(code, redirectUri);
  const conn = connections.upsertTokens("monzo", { ...t, status: "pending_approval" });
  audit("finance.connected", { deviceId: st.device_id, provider: "monzo" });
  // Try a first sync. Before the in-app approval Monzo answers 403: we stay "pending_approval".
  await syncConnection(conn).catch(() => {});
  return connections.byId(conn.id);
}

async function accessToken(conn) {
  const { accessToken, refreshToken } = connections.tokens(conn);
  if (Date.parse(conn.expires_at || 0) - Date.now() > 5 * 60_000) return accessToken;
  if (!refreshToken) { connections.setStatus(conn.id, "expired", "Access expired. Reconnect Monzo."); throw new monzo.MonzoError("Monzo access expired", { status: 401 }); }
  try {
    const t = await monzo.refreshTokens(refreshToken);
    connections.upsertTokens("monzo", { ...t, status: conn.status === "pending_approval" ? "pending_approval" : "active" });
    return t.accessToken;
  } catch (e) {
    connections.setStatus(conn.id, "expired", "Monzo refused to refresh access. Reconnect Monzo.");
    throw e;
  }
}

export async function disconnect(provider) {
  const conn = connections.get(provider);
  if (!conn) return false;
  if (provider === "monzo") { try { await monzo.logout(connections.tokens(conn).accessToken); } catch {} }
  tx(() => {
    db.prepare("DELETE FROM fin_accounts WHERE connection_id = ?").run(conn.id); // cascades pots + transactions
    connections.disconnect(conn.id);
  });
  changed("finance");
  return true;
}

// ---------------- Sync
export async function syncAll() {
  const results = [];
  for (const c of connections.all().filter((c) => c.provider === "monzo" || c.provider === DEMO)) {
    results.push(await syncConnection(c).catch((e) => ({ provider: c.provider, error: e.message })));
  }
  return { connections: results.length, errors: results.filter((r) => r?.error).length };
}

export async function syncConnection(conn) {
  if (conn.provider === DEMO) return syncDemo(conn);
  let token;
  try {
    token = await accessToken(conn);
    const accounts = (await monzo.listAccounts(token)).filter((a) => !a.closed);
    const ownIds = new Set(accounts.map((a) => a.id));
    let newTx = 0;
    for (const a of accounts) {
      const bal = await monzo.getBalance(token, a.id);
      const pots = /retail/.test(a.type) ? await monzo.listPots(token, a.id) : [];
      const type = monzo.accountType(a);
      const known = db.prepare("SELECT shared FROM fin_accounts WHERE id = ?").get(a.id);
      db.prepare(`INSERT INTO fin_accounts (id, connection_id, name, type, currency, balance, total_balance, shared, closed, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, balance = excluded.balance,
        total_balance = excluded.total_balance, currency = excluded.currency, updated_at = excluded.updated_at`)
        .run(a.id, conn.id, monzo.accountName(a), type, bal.currency || a.currency || "GBP", bal.balance ?? null, bal.total_balance ?? null, known ? known.shared : 1, new Date().toISOString());
      for (const p of pots) {
        db.prepare(`INSERT INTO fin_pots (id, account_id, name, balance, currency, deleted, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, balance = excluded.balance, deleted = excluded.deleted, updated_at = excluded.updated_at`)
          .run(p.id, a.id, p.name, p.balance, p.currency || "GBP", p.deleted ? 1 : 0, new Date().toISOString());
      }
      const last = db.prepare("SELECT created FROM fin_transactions WHERE account_id = ? ORDER BY created DESC LIMIT 1").get(a.id);
      // Monzo only allows the full history within 5 minutes of authorising; afterwards 90 days.
      const since = last ? new Date(Date.parse(last.created) - 3 * 86400_000).toISOString() : new Date(Date.now() - 89 * 86400_000).toISOString();
      const txs = await monzo.listTransactions(token, a.id, since);
      tx(() => { for (const t of txs) newTx += upsertMonzoTx(t, a.id, ownIds); });
    }
    connections.setStatus(conn.id, "active");
    connections.markSynced(conn.id);
    changed("finance");
    return { provider: "monzo", accounts: accounts.length, newTransactions: newTx };
  } catch (e) {
    if (e.status === 403) connections.setStatus(conn.id, "pending_approval", e.message);
    else if (e.status === 401) connections.setStatus(conn.id, "expired", e.message);
    else db.prepare("UPDATE connections SET last_error = ? WHERE id = ?").run(e.message, conn.id);
    changed("finance");
    throw e;
  }
}

function upsertMonzoTx(t, accountId, ownIds) {
  const potTransfer = !!(t.metadata?.pot_id) || t.scheme === "uk_retail_pot";
  const internal = potTransfer || (t.counterparty?.account_id && ownIds.has(t.counterparty.account_id));
  const merchant = typeof t.merchant === "object" && t.merchant ? t.merchant.name || "" : "";
  const row = {
    id: t.id, account_id: accountId, created: t.created, amount: t.amount, currency: t.currency || "GBP",
    description: potTransfer ? `Pot transfer` : (t.description || "").slice(0, 200), merchant: merchant.slice(0, 120),
    provider_category: t.category || "", internal: internal ? 1 : 0, pot_transfer: potTransfer ? 1 : 0,
    declined: t.decline_reason ? 1 : 0, settled: t.settled ? 1 : 0,
  };
  row.category = categorize({ description: row.description, merchant: row.merchant, providerCategory: row.provider_category, amount: row.amount, internal: !!row.internal });
  const isNew = !db.prepare("SELECT 1 FROM fin_transactions WHERE id = ?").get(t.id);
  db.prepare(`INSERT INTO fin_transactions (id, account_id, created, amount, currency, description, merchant, provider_category, category, internal, pot_transfer, declined, settled)
    VALUES (@id, @account_id, @created, @amount, @currency, @description, @merchant, @provider_category, @category, @internal, @pot_transfer, @declined, @settled)
    ON CONFLICT(id) DO UPDATE SET amount = excluded.amount, description = excluded.description, merchant = excluded.merchant, provider_category = excluded.provider_category,
      category = excluded.category, internal = excluded.internal, pot_transfer = excluded.pot_transfer, declined = excluded.declined, settled = excluded.settled`).run(row);
  return isNew ? 1 : 0;
}

// ---------------- Development-only TEST DATA provider
export function enableDemo() {
  if (!demoAllowed()) throw Object.assign(new Error("Test data is only available in development mode (JARVIS_DEMO_FINANCE=true, NODE_ENV not production)."), { status: 403 });
  const conn = connections.upsertTokens(DEMO, { accessToken: "demo", refreshToken: null, expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(), status: "active" });
  return syncDemo(conn);
}
function syncDemo(conn) {
  if (!demoAllowed()) throw new Error("Demo data disabled");
  const now = Date.now();
  const acc = "demo_acc_current";
  tx(() => {
    db.prepare(`INSERT INTO fin_accounts (id, connection_id, name, type, balance, total_balance, shared, updated_at) VALUES (?, ?, 'TEST DATA · Demo Current Account', 'current', 184250, 284250, 1, ?)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`).run(acc, conn.id, new Date().toISOString());
    db.prepare(`INSERT INTO fin_pots (id, account_id, name, balance, updated_at) VALUES ('demo_pot', ?, 'TEST DATA · Savings pot', 100000, ?) ON CONFLICT(id) DO NOTHING`).run(acc, new Date().toISOString());
    const items = [
      ["Tesco", -4520, "groceries"], ["Shell", -6000, "transport"], ["Netflix", -1099, "entertainment"], ["Pret A Manger", -680, "eating_out"],
      ["Amazon", -2999, "shopping"], ["Trainline", -2350, "transport"], ["Spotify", -1199, "entertainment"], ["Octopus Energy", -9500, "bills"],
    ];
    for (let d = 60; d >= 0; d--) {
      const day = new Date(now - d * 86400_000);
      const [m, amt, cat] = items[d % items.length];
      const recurring = ["Netflix", "Spotify", "Octopus Energy"].includes(m);
      if (recurring && day.getUTCDate() !== (m === "Netflix" ? 3 : m === "Spotify" ? 9 : 15)) continue;
      const id = `demo_tx_${day.toISOString().slice(0, 10)}_${m.replace(/\W/g, "")}`;
      const row = { id, account_id: acc, created: day.toISOString(), amount: amt, description: m.toUpperCase(), merchant: `${m}`, provider_category: cat };
      db.prepare(`INSERT INTO fin_transactions (id, account_id, created, amount, description, merchant, provider_category, category) VALUES (@id, @account_id, @created, @amount, @description, @merchant, @provider_category, @category) ON CONFLICT(id) DO NOTHING`)
        .run({ ...row, category: categorize({ ...row, providerCategory: cat }) });
      if (day.getUTCDate() === 25) {
        db.prepare(`INSERT INTO fin_transactions (id, account_id, created, amount, description, merchant, provider_category, category) VALUES (?, ?, ?, 250000, 'TEST DATA SALARY', 'Employer Ltd', 'income', 'income') ON CONFLICT(id) DO NOTHING`)
          .run(`demo_sal_${day.toISOString().slice(0, 10)}`, acc, day.toISOString());
        db.prepare(`INSERT INTO fin_transactions (id, account_id, created, amount, description, provider_category, category, internal, pot_transfer) VALUES (?, ?, ?, -20000, 'Pot transfer', 'savings', 'transfers', 1, 1) ON CONFLICT(id) DO NOTHING`)
          .run(`demo_pot_${day.toISOString().slice(0, 10)}`, acc, day.toISOString());
      }
    }
  });
  connections.markSynced(conn.id);
  changed("finance");
  return { provider: DEMO, accounts: 1, testData: true };
}

// ---------------- Reads
export function loadData() {
  const accounts = db.prepare(`SELECT a.*, c.provider, c.status AS connection_status, c.last_sync_at FROM fin_accounts a JOIN connections c ON c.id = a.connection_id WHERE c.status != 'disconnected'`).all();
  const pots = db.prepare("SELECT p.* FROM fin_pots p JOIN fin_accounts a ON a.id = p.account_id").all();
  const sharedIds = new Set(accounts.filter((a) => a.shared).map((a) => a.id));
  // Manual entries that have since arrived from the bank feed (matched_id) are not counted twice.
  const transactions = db.prepare("SELECT * FROM fin_transactions WHERE matched_id IS NULL ORDER BY created DESC").all().filter((t) => sharedIds.has(t.account_id));
  const bills = db.prepare("SELECT * FROM bills ORDER BY name").all();
  const budgets = Object.fromEntries(db.prepare("SELECT * FROM budgets").all().map((b) => [b.category, b.amount]));
  return { accounts, pots, transactions, bills, budgets };
}

export function position(now = new Date()) {
  const d = loadData(); const s = getSettings();
  const pos = engine.computePosition({ ...d, buffer: s.finance.buffer, now, tz: s.timezone });
  pos.testData = d.accounts.some((a) => a.provider === DEMO);
  return pos;
}

export function overview() {
  const d = loadData(); const s = getSettings(); const now = new Date();
  const pos = engine.computePosition({ ...d, buffer: s.finance.buffer, now, tz: s.timezone });
  const { start, end } = engine.monthBounds(now, s.timezone);
  const twelveWeeks = new Date(now - 84 * 86400_000);
  return {
    connections: connections.all().filter((c) => ["monzo", DEMO].includes(c.provider)).map(connections.view),
    monzoConfigured: monzo.monzoConfigured(), demoAvailable: demoAllowed(),
    testData: d.accounts.some((a) => a.provider === DEMO),
    accounts: d.accounts.filter((a) => a.type !== "manual").map((a) => ({ id: a.id, name: a.name, type: a.type, balance: a.balance, total_balance: a.total_balance, shared: !!a.shared, provider: a.provider, updated_at: a.updated_at })),
    pots: d.pots.filter((p) => !p.deleted).map((p) => ({ id: p.id, name: p.name, balance: p.balance, account_id: p.account_id })),
    position: pos,
    month: engine.spendingSummary(d.transactions, start, end),
    weekly: engine.weeklySpending(d.transactions, twelveWeeks, now),
    comparison: engine.compareMonths(d.transactions, now, s.timezone),
    subscriptions: engine.detectSubscriptions(d.transactions, now),
    recent: d.transactions.slice(0, 40).map((t) => ({ ...t, category: engine.effectiveCategory(t), auto_category: t.category, manual: t.account_id === "manual-entries" })),
    bills: d.bills, budgets: d.budgets, categories: CATEGORIES,
  };
}

// ---------------- Writes
export function setShared(accountId, shared) { db.prepare("UPDATE fin_accounts SET shared = ? WHERE id = ?").run(shared ? 1 : 0, accountId); changed("finance"); }
export function setCategory(txId, category) {
  if (category && !CATEGORIES.includes(category)) throw Object.assign(new Error("Unknown category"), { status: 400 });
  const ok = db.prepare("UPDATE fin_transactions SET category_override = ? WHERE id = ?").run(category || null, txId).changes > 0;
  changed("finance"); return ok;
}
export function saveBill(b) {
  const amount = Math.round(Number(b.amount));
  if (!b.name || !Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error("A bill needs a name and a positive amount in pence."), { status: 400 });
  const row = {
    name: String(b.name).slice(0, 80), amount, kind: ["bill", "saving", "debt"].includes(b.kind) ? b.kind : "bill",
    frequency: ["monthly", "weekly", "yearly", "once"].includes(b.frequency) ? b.frequency : "monthly",
    day_of_month: b.day_of_month ? Math.min(31, Math.max(1, Number(b.day_of_month))) : null, month: b.month ? Number(b.month) : null,
    weekday: b.weekday != null ? Number(b.weekday) : null, date: b.date || null,
    certainty: b.certainty === "confirmed" ? "confirmed" : "estimated", match_text: String(b.match_text || "").slice(0, 60),
    category: CATEGORIES.includes(b.category) ? b.category : "bills", active: b.active === false ? 0 : 1,
  };
  let id = b.id;
  if (id) db.prepare(`UPDATE bills SET name=@name, amount=@amount, kind=@kind, frequency=@frequency, day_of_month=@day_of_month, month=@month, weekday=@weekday, date=@date, certainty=@certainty, match_text=@match_text, category=@category, active=@active WHERE id=@id`).run({ ...row, id });
  else id = Number(db.prepare(`INSERT INTO bills (name, amount, kind, frequency, day_of_month, month, weekday, date, certainty, match_text, category, active) VALUES (@name, @amount, @kind, @frequency, @day_of_month, @month, @weekday, @date, @certainty, @match_text, @category, @active)`).run(row).lastInsertRowid);
  changed("finance");
  return db.prepare("SELECT * FROM bills WHERE id = ?").get(id);
}
export function removeBill(id) { const ok = db.prepare("DELETE FROM bills WHERE id = ?").run(id).changes > 0; changed("finance"); return ok; }
export function setBudget(category, amount) {
  if (!CATEGORIES.includes(category)) throw Object.assign(new Error("Unknown category"), { status: 400 });
  if (amount == null || amount === "") db.prepare("DELETE FROM budgets WHERE category = ?").run(category);
  else db.prepare("INSERT INTO budgets (category, amount) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET amount = excluded.amount").run(category, Math.round(Number(amount)));
  changed("finance");
}

// ---------------- Answers for the AI (facts only, with provenance)
export function financeFacts(kind, args = {}) {
  const d = loadData(); const s = getSettings(); const now = new Date();
  const bankAccounts = d.accounts.filter((a) => a.provider !== "manual");
  const manualOnly = !bankAccounts.length && d.transactions.length > 0;
  if (!bankAccounts.length && !manualOnly) return { connected: false, message: "No bank account is connected and no spending has been recorded by hand. Connect Monzo in the Money section, or tell me what you spend." };
  if (manualOnly && ["position", "afford", "saving"].includes(kind)) return { connected: false, manualEntriesOnly: true, message: "No bank is connected, so balances and what's left are unknown. Only the spending you've told me about is recorded." };
  const testData = d.accounts.some((a) => a.provider === DEMO);
  const conn = connections.all().find((c) => ["monzo", DEMO].includes(c.provider));
  const base = { connected: !manualOnly, manualEntriesOnly: manualOnly || undefined, testData, lastSync: conn?.last_sync_at, connectionStatus: conn?.status };
  const pos = engine.computePosition({ ...d, buffer: s.finance.buffer, now, tz: s.timezone });
  const fmt = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "number" && /amount|balance|spent|income|total|available|owed|projected|remaining|budget|net|change|perDay|buffer|thisMonth|lastMonth|savedToPots|Used/i.test(k) ? engine.GBP(v) : v)));
  switch (kind) {
    case "position": return { ...base, ...fmt({ balances: pos.balances, commitments: pos.commitments, projectedDisposable: pos.projectedDisposable, perDay: pos.perDay, budgets: pos.budgets, lines: pos.lines }), notes: pos.notes };
    case "spending": {
      const months = Number(args.monthsAgo || 0);
      const { start, end } = engine.monthBounds(now, s.timezone, -months);
      const sum = engine.spendingSummary(d.transactions, start, months ? end : now);
      const cat = args.category ? sum.byCategory.find((c) => c.category === args.category) : null;
      return { ...base, period: `${start.toISOString().slice(0, 10)} to ${(months ? end : now).toISOString().slice(0, 10)}`, ...fmt(args.category ? { category: args.category, spent: cat?.amount || 0 } : { spent: sum.spent, income: sum.income, byCategory: sum.byCategory.slice(0, 8), topMerchants: sum.topMerchants.slice(0, 5) }), internalTransfersExcluded: sum.excludedInternal };
    }
    case "afford": return { ...base, ...fmt(engine.canAfford(pos, Math.round(Number(args.amount) * 100), { category: args.category })) };
    case "subscriptions": return { ...base, detected: fmt(engine.detectSubscriptions(d.transactions, now)), manual: fmt(d.bills.filter((b) => b.category === "subscriptions")), note: "Detected subscriptions are estimates based on repeating payments." };
    case "compare": { const c = engine.compareMonths(d.transactions, now, s.timezone); return { ...base, ...fmt({ thisMonthSoFar: c.thisMonth.spent, lastMonthSamePoint: c.lastMonthSamePoint.spent, lastMonthFull: c.lastMonthFull.spent, change: c.change, biggestChanges: c.byCategory.slice(0, 5) }) }; }
    case "saving": return { ...base, ...fmt({ savedToPotsThisMonth: pos.month.savedToPots, potsTotal: pos.balances.savings.total, plannedSavingsRemaining: pos.commitments.savings, projectedDisposable: pos.projectedDisposable }), note: "Saving capacity = projected disposable money after commitments; the figures above show how it is derived." };
    case "transactions": return { ...base, recent: d.transactions.slice(0, Math.min(Number(args.limit || 10), 25)).map((t) => ({ date: t.created.slice(0, 10), description: t.merchant || t.description, amount: engine.GBP(t.amount), category: engine.effectiveCategory(t), internal: !!t.internal, manual: t.account_id === "manual-entries" || undefined })) };
    default: return { error: "Unknown finance question" };
  }
}
