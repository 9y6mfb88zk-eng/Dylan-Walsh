import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, isProd } from "./config.js";
import { kvGet } from "./db.js";
import { authenticate, csrf, isSetupComplete, setupCode } from "./security/auth.js";
import { rateLimit } from "./security/ratelimit.js";
import { attachRealtime, closeRealtime } from "./realtime.js";
import { router as authRoutes } from "./routes/auth.js";
import { router as coreRoutes } from "./routes/core.js";
import { router as financeRoutes, callback as monzoCallback } from "./routes/finance.js";
import { router as calendarRoutes, callback as googleCallback } from "./routes/calendar.js";
import { startScheduler } from "./scheduler.js";
import { brainReady } from "./brain.js";
import { ttsProvider } from "./config.js";
import { demoAllowed } from "./finance/service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// ---------------- Security headers
app.use((req, res, next) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("permissions-policy", "camera=(self), microphone=(self), geolocation=(self)");
  res.setHeader("content-security-policy", [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
    "media-src 'self' blob:", "connect-src 'self' ws: wss:", "worker-src 'self' blob:", "font-src 'self' data:",
    "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'",
  ].join("; "));
  if (req.secure) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  next();
});
app.get("/api/health/ping", (_req, res) => res.json({ ok: true }));

app.use(express.json({ limit: "200kb" }));
app.use(authenticate);
app.use("/api", csrf);
app.use("/api", rateLimit({ name: "api", limit: 600, windowMs: 60_000 }));

app.use(monzoCallback);
app.use(googleCallback);
app.use(authRoutes);
app.use(coreRoutes);
app.use(financeRoutes);
app.use(calendarRoutes);
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error("[error]", err);
  res.status(status).json({ error: status >= 500 && isProd ? "Something went wrong on the server." : err.message || "Internal error" });
});

// ---------------- Static PWA
app.use(express.static(path.join(here, "..", "public"), {
  setHeaders(res, file) {
    if (file.endsWith("sw.js")) { res.setHeader("cache-control", "no-cache"); res.setHeader("service-worker-allowed", "/"); }
    if (file.endsWith(".webmanifest")) res.setHeader("content-type", "application/manifest+json");
  },
}));
app.get(/^\/(?!api\/|ws).*/, (_req, res) => res.sendFile(path.join(here, "..", "public", "index.html")));

export const server = http.createServer(app);
attachRealtime(server);

if (isProd && demoAllowed()) console.warn("[config] Demo finance requested but refused in production.");
server.listen(config.port, config.host, () => {
  console.log(`JARVIS backend listening on http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port} (${config.env}, ${config.hosting})`);
  console.log(`  AI: ${brainReady() ? config.model : "OFF — set ANTHROPIC_API_KEY"} · voice: ${ttsProvider() || "browser"} · Whisper: ${config.openaiKey ? "on" : "off"} · Monzo: ${config.monzoClientId ? "configured" : "not configured"} · Google: ${config.googleClientId ? "configured" : "not configured"}`);
  if (!isSetupComplete()) {
    console.log("\n  ┌──────────────────────────────────────────────────────────┐");
    console.log(`  │  FIRST-RUN SETUP CODE: ${setupCode().padEnd(34)}│`);
    console.log("  │  Open JARVIS in your browser and enter this code.        │");
    console.log("  └──────────────────────────────────────────────────────────┘\n");
  }
  if (!config.publicUrl && config.hosting !== "laptop") console.log("  PUBLIC_URL not set: OAuth redirects and pairing links will use the request's own address.");
});
const stop = startScheduler();
let closing = false;
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
  if (closing) return; closing = true;
  stop(); closeRealtime();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
});
void kvGet;
