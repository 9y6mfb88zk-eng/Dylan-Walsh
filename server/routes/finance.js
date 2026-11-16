import express from "express";
import { publicBase } from "../config.js";
import * as finance from "../finance/service.js";
import { auditFromReq } from "../security/audit.js";
import { rateLimit } from "../security/ratelimit.js";

export const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const redirectUri = (req) => `${publicBase(req)}/oauth/monzo/callback`;

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
router.post("/api/finance/sync", rateLimit({ name: "finsync", limit: 6, windowMs: 60_000 }), wrap(async (req, res) => res.json(await finance.syncAll())));
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
  if (req.query.error) return res.redirect(`/?tab=finance&error=${encodeURIComponent(String(req.query.error_description || req.query.error))}`);
  try {
    const conn = await finance.finishMonzo({ state: req.query.state, code: req.query.code, redirectUri: redirectUri(req) });
    res.redirect(`/?tab=finance&connected=monzo&status=${conn.status}`);
  } catch (e) {
    res.redirect(`/?tab=finance&error=${encodeURIComponent(e.message)}`);
  }
}));
