import express from "express";
import { oauthBase } from "../config.js";
import * as finance from "../finance/service.js";
import { auditFromReq } from "../security/audit.js";
import { rateLimit } from "../security/ratelimit.js";
import { oauthResultPage } from "../services/oauth-page.js";
import { notify } from "../services/notify.js";

export const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const redirectUri = (req) => `${oauthBase(req)}/oauth/monzo/callback`;

router.get("/api/finance", (req, res) => res.json(finance.overview()));
router.get("/api/finance/position", (req, res) => res.json(finance.position()));
router.get("/api/finance/transactions", (req, res) => {
  const { transactions } = finance.loadData();
  const limit = Math.min(Number(req.query.limit || 100), 500);
  res.json(transactions.slice(0, limit));
});

router.post("/api/finance/monzo/connect", (req, res) => {
  auditFromReq(req, "finance.connect_started", { provider: "monzo" });
  res.json({ url: finance.startMonzo({ redirectUri: redirectUri(req), deviceId: req.auth.deviceId }) });
});
router.post("/api/finance/sync", rateLimit({ name: "finsync", limit: 6, windowMs: 60_000 }), wrap(async (req, res) => {
  const r = await finance.syncAll();
  const { reconcileManual } = await import("../services/money.js");
  res.json({ ...r, ...reconcileManual() });
}));
router.post("/api/finance/disconnect", wrap(async (req, res) => {
  const ok = await finance.disconnect(req.body?.provider || "monzo");
  auditFromReq(req, "finance.disconnected", { provider: req.body?.provider || "monzo" });
  res.json({ ok });
}));
router.post("/api/finance/demo", wrap(async (req, res) => { auditFromReq(req, "finance.demo_enabled"); res.json(await finance.enableDemo()); }));
router.patch("/api/finance/accounts/:id", (req, res) => { finance.setShared(req.params.id, !!req.body?.shared); auditFromReq(req, "finance.account_sharing", { account: req.params.id, shared: !!req.body?.shared }); res.json({ ok: true }); });
router.patch("/api/finance/transactions/:id", (req, res) => res.json({ ok: finance.setCategory(req.params.id, req.body?.category || null) }));
router.post("/api/finance/bills", (req, res) => res.status(201).json(finance.saveBill(req.body || {})));
router.put("/api/finance/bills/:id", (req, res) => res.json(finance.saveBill({ ...(req.body || {}), id: Number(req.params.id) })));
router.delete("/api/finance/bills/:id", (req, res) => res.json({ ok: finance.removeBill(Number(req.params.id)) }));
router.put("/api/finance/budgets/:category", (req, res) => { finance.setBudget(req.params.category, req.body?.amount); res.json({ ok: true }); });

/** OAuth redirect target (validated by single-use state, not by cookie, so it also works from Safari). */
export const callback = express.Router();
callback.get("/oauth/monzo/callback", wrap(async (req, res) => {
  // Signed-in browser (phone app / cloud): back into the app. Otherwise (laptop default browser): a clear result page.
  const inApp = !!req.auth;
  if (req.query.error) {
    const msg = String(req.query.error_description || req.query.error);
    return inApp ? res.redirect(`/?tab=finance&error=${encodeURIComponent(msg)}`) : oauthResultPage(res, { ok: false, title: "Monzo wasn't connected", lines: [msg, "Go back to JARVIS → Money and press Connect Monzo to try again."] });
  }
  try {
    const conn = await finance.finishMonzo({ state: req.query.state, code: req.query.code, redirectUri: redirectUri(req) });
    const waiting = conn.status === "pending_approval";
    notify({ kind: "finance", title: waiting ? "Approve JARVIS in your Monzo app" : "Monzo connected", body: waiting ? "Open the Monzo app and tap Allow, then press Sync now in JARVIS → Money." : "Your accounts are syncing (read-only).", url: "/?tab=finance" }).catch(() => {});
    if (inApp) return res.redirect(`/?tab=finance&connected=monzo&status=${conn.status}`);
    oauthResultPage(res, { ok: true, title: waiting ? "Nearly there — approve in the Monzo app" : "Monzo is connected", lines: waiting
      ? ["JARVIS has signed in to Monzo (read-only).", "Monzo needs one more step: open the Monzo app on your phone, look for the notification asking to allow access to your data, and tap Allow.", "Then go back to JARVIS → Money and press Sync now."]
      : ["Your Monzo accounts are now syncing to JARVIS (read-only — JARVIS can never move money).", "Go back to JARVIS → Money to see them."] });
  } catch (e) {
    inApp ? res.redirect(`/?tab=finance&error=${encodeURIComponent(e.message)}`) : oauthResultPage(res, { ok: false, title: "Monzo wasn't connected", lines: [e.message] });
  }
}));
