// Runs the JARVIS backend on this laptop as a child process (bundled Node 22 + server code),
// listening on 127.0.0.1 only. Restarts it if it crashes; stops it when JARVIS exits.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export function locateServer({ appRoot, resourcesPath, packaged }) {
  if (process.env.JARVIS_SERVER_DIR) return { node: process.env.JARVIS_NODE_BIN || "node", dir: process.env.JARVIS_SERVER_DIR };
  if (packaged) {
    const node = path.join(resourcesPath, "node", process.platform === "win32" ? "node.exe" : "bin/node");
    return { node, dir: path.join(resourcesPath, "server-app") };
  }
  // Running from source: use the repository's server and the system Node (22.13+).
  return { node: process.env.JARVIS_NODE_BIN || "node", dir: path.join(appRoot, "..") };
}

export async function freePort(preferred = 47823) {
  for (let p = preferred; p < preferred + 20; p++) {
    const ok = await new Promise((res) => { const s = net.createServer(); s.once("error", () => res(false)); s.listen(p, "127.0.0.1", () => s.close(() => res(true))); });
    if (ok) return p;
  }
  throw new Error("No free local port for the JARVIS server");
}

export class ServerManager {
  constructor({ node, dir, dataDir, logFile, onState }) {
    Object.assign(this, { node, dir, dataDir, logFile, onState: onState || (() => {}) });
    this.child = null; this.port = null; this.env = {}; this.stopping = false; this.crashes = [];
    this.state = "stopped";
  }
  setState(s, detail) { this.state = s; this.onState(s, detail); }
  log(chunk) {
    try {
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > 2_000_000) fs.renameSync(this.logFile, this.logFile + ".1");
      fs.appendFileSync(this.logFile, chunk);
    } catch {}
  }
  get url() { return `http://localhost:${this.port}`; }

  async start(env, port) {
    this.stopping = false;
    this.port = port || this.port || await freePort();
    this.env = env;
    fs.mkdirSync(this.dataDir, { recursive: true });
    const childEnv = {
      ...process.env, ...Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== "")),
      PORT: String(this.port), HOST: "127.0.0.1", JARVIS_DATA_DIR: this.dataDir, JARVIS_HOSTING: "laptop",
      OAUTH_BASE_URL: `http://localhost:${this.port}`, NODE_ENV: process.env.JARVIS_NODE_ENV || "production",
      ELECTRON_RUN_AS_NODE: undefined,
    };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    this.setState("starting");
    this.child = spawn(this.node, ["--disable-warning=ExperimentalWarning", path.join(this.dir, "server", "index.js")], {
      cwd: this.dir, env: childEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    this.child.stdout.on("data", (d) => this.log(d));
    this.child.stderr.on("data", (d) => this.log(d));
    this.child.on("error", (e) => { this.log(`spawn error: ${e.message}\n`); this.setState("error", e.message); });
    this.child.on("exit", (code, sig) => {
      this.log(`server exited code=${code} signal=${sig}\n`);
      this.child = null;
      if (this.stopping) return this.setState("stopped");
      // Crash recovery with a circuit breaker.
      const now = Date.now();
      this.crashes = this.crashes.filter((t) => now - t < 120_000).concat(now);
      if (this.crashes.length > 5) return this.setState("error", "The JARVIS server keeps stopping. See server.log in %APPDATA%\\JARVIS.");
      this.setState("restarting");
      setTimeout(() => this.start(this.env, this.port).catch(() => {}), 1000 * this.crashes.length);
    });
    const ok = await this.waitReady(30_000);
    this.setState(ok ? "running" : "error", ok ? undefined : "The server did not start in time");
    return ok;
  }

  async waitReady(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!this.child) return false;
      try { if ((await fetch(`http://127.0.0.1:${this.port}/api/health/ping`, { signal: AbortSignal.timeout(1500) })).ok) return true; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async restart(env) {
    await this.stop();
    return this.start(env ?? this.env, this.port);
  }

  stop() {
    this.stopping = true;
    const c = this.child;
    if (!c) return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(() => { try { if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(c.pid), "/T", "/F"]); else c.kill("SIGKILL"); } catch {} res(); }, 4000);
      c.once("exit", () => { clearTimeout(t); res(); });
      try { c.kill("SIGTERM"); } catch { res(); }
    });
  }
}
