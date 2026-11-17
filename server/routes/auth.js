import express from "express";
import QRCode from "qrcode";
import { config, publicBase, ttsProvider } from "../config.js";
import * as auth from "../security/auth.js";
import { auditFromReq, recentAudit } from "../security/audit.js";
import { vapidPublicKey } from "../push.js";
import { brainReady } from "../brain.js";
import { localAsrAvailable } from "../local-asr.js";
import { getSettings } from "../db.js";
import { connectedDevices } from "../realtime.js";

export const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Public: what the app needs before sign-in, plus account state after. */
router.get("/api/session", (req, res) => {
  const base = { setupComplete: auth.isSetupComplete(), signedIn: !!req.auth };
  if (!req.auth) return res.json(base);
  res.json({
    ...base,
    device: { id: req.auth.deviceId, name: req.auth.deviceName, kind: req.auth.kind },
    brain: brainReady(), model: config.model, tts: ttsProvider(), stt: !!config.openaiKey || localAsrAvailable(), sttLocal: localAsrAvailable(), webSearch: config.webSearch,
    vapidPublicKey, userName: config.userName, settings: getSettings(),
    publicUrl: publicBase(req), env: config.env, hosting: config.hosting,
    version: process.env.JARVIS_VERSION || process.env.npm_package_version || "",
  });
});

router.post("/api/setup", wrap(async (req, res) => {
  const { token, device } = auth.createOwner({ password: req.body?.password, code: req.body?.code, deviceName: req.body?.deviceName, ua: req.get("user-agent") || "", ip: req.ip });
  auth.setSessionCookie(req, res, token);
  res.status(201).json({ ok: true, device, token: req.body?.wantToken ? token : undefined });
}));

router.post("/api/login", wrap(async (req, res) => {
  const { token, device } = auth.login({ username: req.body?.username, password: req.body?.password, deviceName: req.body?.deviceName, ua: req.get("user-agent") || "", ip: req.ip });
  auth.setSessionCookie(req, res, token);
  res.json({ ok: true, device, token: req.body?.wantToken ? token : undefined });
}));

router.post("/api/pair/redeem", wrap(async (req, res) => {
  const { token, device } = auth.redeemPairing({ code: req.body?.code, shortCode: req.body?.shortCode, deviceName: req.body?.deviceName, ua: req.get("user-agent") || "", ip: req.ip });
  auth.setSessionCookie(req, res, token);
  res.json({ ok: true, device, token: req.body?.wantToken ? token : undefined });
}));

// ---------------- Everything below needs a session
router.use("/api", (req, res, next) => (["/api/session", "/api/setup", "/api/login", "/api/pair/redeem", "/api/health/ping"].includes(req.path) ? next() : auth.requireAuth(req, res, next)));

router.post("/api/logout", (req, res) => {
  if (req.auth?.token) auth.revokeToken(req.auth.token);
  auditFromReq(req, "logout");
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.post("/api/pair/create", wrap(async (req, res) => {
  const p = auth.createPairing(req.auth.deviceId);
  const url = `${publicBase(req)}/pair#${p.code}`;
  const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#1a0b2e", light: "#ffffff" } });
  res.json({ url, shortCode: p.shortCode, expiresAt: p.expiresAt, qrSvg });
}));

router.get("/api/devices", (req, res) => { const live = new Set(connectedDevices()); res.json(auth.listDevices().map((d) => ({ ...d, current: d.id === req.auth.deviceId, online: live.has(d.id) }))); });
router.patch("/api/devices/:id", (req, res) => { auth.renameDevice(req.params.id, req.body?.name || "Device"); auditFromReq(req, "device.renamed", { target: req.params.id }); res.json({ ok: true }); });
router.delete("/api/devices/:id", (req, res) => {
  const ok = auth.revokeDevice(req.params.id);
  auditFromReq(req, "device.revoked", { target: req.params.id });
  if (req.params.id === req.auth.deviceId) auth.clearSessionCookie(res);
  res.json({ ok });
});
router.post("/api/password", wrap(async (req, res) => {
  auth.changePassword(req.auth.userId, req.body?.current, req.body?.next, req.auth.deviceId);
  auditFromReq(req, "password.changed");
  res.json({ ok: true });
}));
router.get("/api/audit", (req, res) => res.json(recentAudit(Math.min(Number(req.query.limit || 100), 500))));
