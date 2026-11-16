import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Start the real backend against the mocks, in a fresh data directory. */
export async function startServer(mock, extraEnv = {}, port = 3900 + Math.floor(Math.random() * 90)) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-test-"));
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(ROOT, "server/index.js")], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, PORT: String(port), JARVIS_DATA_DIR: dataDir, JARVIS_SETUP_TOKEN: "SETUP-1234", IDEAS_ENABLED: "false", REMINDER_POLL_SECONDS: "1", ...mock.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  proc.stdout.on("data", (d) => { out += d; if (process.env.DEBUG) process.stdout.write(d); });
  proc.stderr.on("data", (d) => { out += d; if (process.env.DEBUG) process.stderr.write(d); });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/api/health/ping")).ok) break; } catch {} await sleep(100); }
  return { proc, base, dataDir, port, output: () => out, stop: () => new Promise((r) => { proc.once("exit", r); proc.kill(); }) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A simple cookie-keeping API client, like one device. */
export class Device {
  constructor(base, ua = "Mozilla/5.0 (Windows NT 10.0) Chrome/130") { this.base = base; this.ua = ua; this.cookie = ""; }
  async call(p, { method = "GET", body, raw, headers = {}, csrf = true } = {}) {
    const res = await fetch(this.base + p, {
      method, redirect: "manual",
      headers: { "user-agent": this.ua, ...(body ? { "content-type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...(csrf && method !== "GET" ? { "x-jarvis": "1" } : {}), ...headers },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const v = c.split(";")[0]; if (v.startsWith("jarvis_session=")) this.cookie = v.endsWith("=") ? "" : v; }
    const ct = res.headers.get("content-type") || "";
    return { status: res.status, headers: res.headers, data: ct.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  }
  ws() {
    const ws = new WebSocket(this.base.replace("http", "ws") + "/ws", { headers: { cookie: this.cookie, "user-agent": this.ua } });
    ws.messages = [];
    ws.on("message", (d) => ws.messages.push(JSON.parse(d)));
    return new Promise((resolve, reject) => { ws.once("open", () => resolve(ws)); ws.once("error", reject); ws.once("unexpected-response", (_r, res) => reject(new Error(`ws ${res.statusCode}`))); });
  }
}

export async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  return null;
}
