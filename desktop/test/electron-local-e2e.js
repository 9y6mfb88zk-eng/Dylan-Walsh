// End-to-end test of the PACKAGED app in laptop mode: the installer layout (bundled Node 22 + server) is started
// by the app itself, keys come from the app, first-run setup needs no code, "Hey JARVIS" is fed in as microphone
// audio, iPhone access is switched on through (a stand-in for) Tailscale, and Exit stops everything.
// Build first:  npm run dist:linux-dir      Run:  xvfb-run -a node test/electron-local-e2e.js
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "../../test/mock-upstream.js";
import { Device, sleep } from "../../test/helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let pw;
try { pw = await import("playwright"); } catch { pw = createRequire(execSync("npm root -g").toString().trim() + "/")("playwright"); }
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const until = async (fn, ms = 20000, step = 200) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return null; };
const portOpen = (host, port) => new Promise((res) => { const s = net.connect(port, host); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); setTimeout(() => { s.destroy(); res(false); }, 1500); });

const exe = path.join(here, "..", "dist", "linux-unpacked", "jarvis-desktop");
if (!fs.existsSync(exe)) { console.error("Build the packaged app first: npm run dist:linux-dir"); process.exit(2); }
fs.rmSync(path.join(os.tmpdir(), "jarvis-fake-tailscale.json"), { force: true });

const mock = await startMock();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-local-"));
const { NODE_EXTRA_CA_CERTS, OPENAI_API_KEY, ...upstreams } = mock.env;   // no OpenAI key: voice must be understood on the laptop
const app = await pw._electron.launch({
  executablePath: exe,
  args: ["--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${path.join(here, "fixtures", "mic-jarvis-alone.wav")}`],
  env: { ...process.env, ...upstreams, NODE_EXTRA_CA_CERTS, XDG_CONFIG_HOME: profile, HOME: profile, JARVIS_TAILSCALE_BIN: path.join(here, "fake-tailscale.cjs"), IDEAS_ENABLED: "false", JARVIS_SERVER_URL: "" },
});
let localUrl = null, port = null;
try {
  const main = await until(async () => app.windows().find((w) => /^http:\/\/localhost:\d+/.test(w.url())), 40000);
  check("the app starts its own JARVIS server and opens it (no cloud)", !!main, main?.url());
  const info = await main.evaluate(() => window.jarvisDesktop.local());
  localUrl = info.url; port = info.port;
  check("server runs from the bundled Node 22 inside the installer layout", info.server === "running", `port ${port}`);
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  check("server is private: reachable on 127.0.0.1 only", (await portOpen("127.0.0.1", port)) && (!lan || !(await portOpen(lan, port))), lan ? `not reachable on ${lan}` : "no LAN interface");

  await main.waitForSelector("#authPw");
  check("first-run setup needs no code (the app supplies it)", await main.isHidden("#codeField"));
  await main.fill("#authPw", "correct horse battery"); await main.fill("#authPw2", "correct horse battery");
  await main.click("#authSubmit");
  await main.waitForSelector("#core", { timeout: 15000 });
  check("account created and signed in on the laptop", true);

  const owner = new Device(localUrl.replace("localhost", "127.0.0.1"));
  await owner.call("/api/login", { method: "POST", body: { password: "correct horse battery" } });
  const health = (await owner.call("/api/health")).data;
  check("AI configured from the app's key store", health.integrations.ai.configured);

  const kwsReady = await until(() => main.evaluate(() => window.jarvisDesktop.getStatus().then((s) => s.kws === "ready" && s)), 20000);
  check("second wake-word engine (keyword spotter) loads from the installer layout", !!kwsReady);
  const woke = await until(() => main.evaluate(() => window.jarvisDesktop.getStatus().then((s) => s.lastWake && s)), 40000);
  check("just “JARVIS” (no “hey”) from the microphone wakes it, on the laptop", woke?.lastWakeSource === "keyword:JARVIS", woke?.lastWakeSource);
  const conv = await until(async () => {
    const c = (await owner.call("/api/conversations")).data;
    const msgs = (await owner.call(`/api/conversations/${c.current}/messages`)).data;
    return msgs.find((m) => m.role === "user" && /weather/i.test(m.content)) && msgs.find((m) => m.role === "assistant") && msgs;
  }, 40000);
  check("voice command answered by the laptop's own server", !!conv);
  check("speech understood by local Whisper (no OpenAI key, nothing uploaded)", !!conv && mock.log.stt === 0 && /weather tomorrow/i.test(conv.find((m) => m.role === "user").content), conv ? `heard: “${conv.find((m) => m.role === "user").content}”` : "");
  check("cheap model by default (Claude Haiku 5.5)", mock.log.anthropic.some((r) => r.model === "claude-haiku-5-5") && mock.log.anthropic.every((r) => !r.fallbacks), mock.log.anthropic.at(-1)?.model);

  // iPhone access through Tailscale
  await main.click('.rail [data-tab="settings"]');
  await main.waitForSelector("#tsOn", { timeout: 10000 });
  check("Settings shows Tailscale connected and offers iPhone access", true);
  await main.click("#tsOn");
  await until(async () => (await app.evaluate(() => 1)) && main.url().startsWith("http://localhost"), 5000);
  const afterOn = await until(() => main.evaluate(() => window.jarvisDesktop?.local?.().then((l) => l.phoneAccess && l.server === "running" && l)), 30000);
  check("iPhone access turned on (tailscale serve → local server)", !!afterOn, afterOn?.phoneUrl);
  await owner.call("/api/login", { method: "POST", body: { password: "correct horse battery" } }).catch(() => {});
  const pair = await until(async () => (await owner.call("/api/pair/create", { method: "POST" })).data, 15000);
  check("pairing QR now points at the private Tailscale address", pair?.url?.startsWith("https://dylans-laptop.tail1234.ts.net/pair#"), pair?.url);

  // Exit stops the server too
  const exited = new Promise((res) => app.process().once("exit", () => res(true)));
  await app.evaluate(({ ipcMain }) => ipcMain.emit("jarvis:quit"));
  check("Exit JARVIS closes the app", await Promise.race([exited, sleep(10000).then(() => false)]));
  check("…and the local server stops with it (nothing left running)", !(await until(async () => !(await portOpen("127.0.0.1", port)) || null, 8000) === null) && !(await portOpen("127.0.0.1", port)));
} catch (e) {
  check("local-mode run completed", false, e.stack?.split("\n").slice(0, 3).join(" | "));
} finally {
  try { await app.close(); } catch {}
  mock.server.close();
}
fs.writeFileSync(path.join(here, "..", "..", "docs", "electron-local-results.json"), JSON.stringify(results, null, 2));
process.exit(results.every((x) => x.ok) ? 0 : 1);
