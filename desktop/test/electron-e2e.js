// End-to-end test of the real Windows app code under Electron (run on Linux with xvfb in CI/dev).
// A WAV file containing "Hey JARVIS … what is the weather tomorrow" is fed in as the microphone.
// Checks: tray app starts, signs in, local wake word fires from real audio, a voice session runs
// (Whisper → AI → reply), status reaches the backend, mute stops listening, computer action round-trip,
// close-to-tray keeps it running, Exit JARVIS quits completely.
// Usage: xvfb-run -a node test/electron-e2e.js
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startMock } from "../../test/mock-upstream.js";
import { startServer, Device, sleep } from "../../test/helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
let pw;
try { pw = await import("playwright"); } catch { pw = createRequire(execSync("npm root -g").toString().trim() + "/")("playwright"); }
const require = createRequire(import.meta.url);
const electronPath = require("electron");

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const until = async (fn, ms = 20000, step = 200) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch {} await sleep(step); } return null; };

const mock = await startMock();
const srv = await startServer(mock, {}, 3987);
const base = srv.base;   // http://127.0.0.1:3987
const owner = new Device(base);
await owner.call("/api/setup", { method: "POST", body: { code: "SETUP-1234", password: "correct horse battery" } });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-electron-"));
const app = await pw._electron.launch({
  executablePath: electronPath,
  args: [path.join(here, ".."), "--no-sandbox", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${path.join(here, "fixtures", "mic-session.wav")}`, "--autoplay-policy=no-user-gesture-required"],
  env: { ...process.env, JARVIS_SERVER_URL: base, XDG_CONFIG_HOME: profile, HOME: profile, JARVIS_DEBUG: "1" },
});
const logs = [];
app.process().stdout?.on("data", (d) => logs.push(String(d)));

try {
  const main = await until(async () => app.windows().find((w) => w.url().startsWith(base)));
  check("app opens the JARVIS window pointed at the server", !!main);
  main.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));

  // Sign in through the real login screen (the app's own Chromium profile keeps the session).
  await main.waitForSelector("#authPw");
  await main.fill("#authPw", "correct horse battery");
  await main.click("#authSubmit");
  await main.waitForSelector("#core", { timeout: 15000 });
  check("signed in from the desktop app", true);
  check("desktop bridge exposed only to the JARVIS origin", await main.evaluate(() => !!window.jarvisDesktop && typeof window.jarvisDesktop.runAction === "function"));

  const listening = await until(() => main.evaluate(() => window.jarvisDesktop.getStatus().then((s) => s.wakeWord === "listening" && s)), 30000);
  check("local wake-word service is listening on the microphone", !!listening, listening ? `mic: ${listening.micDevice}` : "");

  const devStatus = await until(async () => (await owner.call("/api/health")).data.desktops.find((d) => d.online && d.status?.wakeWord), 15000);
  check("backend health shows the laptop online with real wake-word status", !!devStatus, devStatus?.status?.wakeWord);

  // The WAV says "Hey JARVIS" after 4 s, then the command.
  const woke = await until(() => main.evaluate(() => window.jarvisDesktop.getStatus().then((s) => s.lastWake)), 40000);
  check("“Hey JARVIS” spoken into the microphone is detected locally", !!woke);

  const conv = await until(async () => {
    const c = (await owner.call("/api/conversations")).data;
    const msgs = (await owner.call(`/api/conversations/${c.current}/messages`)).data;
    return msgs.find((m) => m.role === "user" && /weather/i.test(m.content)) && msgs.find((m) => m.role === "assistant") && msgs;
  }, 40000);
  check("voice session: command transcribed, answered and synced to the account", !!conv, conv ? `heard: “${conv.find((m) => m.role === "user").content}”` : "");
  check("only the command audio was uploaded (one transcription per session)", mock.log.stt >= 1 && mock.log.stt <= 2, `${mock.log.stt} uploads`);
  check("reply was spoken with the neural voice", !!(await until(() => mock.log.tts.length >= 1, 10000)));

  // Mute stops listening immediately
  await main.evaluate(() => window.jarvisDesktop.setMuted(true));
  const muted = await until(() => main.evaluate(() => window.jarvisDesktop.getStatus().then((s) => s.muted && s.wakeWord === "muted")), 5000);
  check("mute switch stops the wake-word listener", !!muted);
  await main.evaluate(() => window.jarvisDesktop.setMuted(false));
  check("unmute resumes listening", !!(await until(() => main.evaluate(() => window.jarvisDesktop.getStatus().then((s) => s.wakeWord === "listening")), 15000)));

  // Computer action round-trip through the backend: create a document via the allowlist
  const r = await owner.call("/api/computer", { method: "POST", body: { action: "create_document", args: { title: "JARVIS test note", content: "Created by the E2E test" } } });
  check("allowlisted computer action executes on the laptop", r.data.ok === true && /JARVIS test note\.md$/.test(r.data.result?.created || ""), r.data.error || r.data.result?.created);
  const bad = await owner.call("/api/computer", { method: "POST", body: { action: "open_file", args: { path: "/etc/passwd" } } });
  check("laptop refuses files outside the personal folders", bad.data.ok === false, bad.data.error);

  // Close to tray keeps it running
  // Same as clicking the window's X button
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() !== "JARVIS audio service" && w.isVisible())?.close());
  await sleep(800);
  const wins = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ t: w.getTitle(), v: w.isVisible(), d: w.isDestroyed() })));
  check("closing the window keeps JARVIS running in the tray", wins.length >= 2 && wins.every((w) => !w.v), JSON.stringify(wins));
  const st2 = await until(async () => (await owner.call("/api/health")).data.desktops.find((d) => d.online), 5000);
  check("still connected to the backend while hidden", !!st2);

  // Exit JARVIS quits fully
  const exited = new Promise((res) => app.process().once("exit", () => res(true)));
  await app.evaluate(({ ipcMain }) => ipcMain.emit("jarvis:quit"));
  check("Exit JARVIS ends the process completely", await Promise.race([exited, sleep(8000).then(() => false)]));
  const off = await until(async () => (await owner.call("/api/health")).data.desktops.every((d) => !d.online), 5000);
  check("backend reports the laptop offline after exit", !!off);
} catch (e) {
  check("electron run completed", false, e.message);
} finally {
  try { await app.close(); } catch {}
  await srv.stop(); mock.server.close();
}
const errs = logs.filter((l) => /pageerror|Uncaught/.test(l));
check("no renderer errors", errs.length === 0, errs.slice(0, 3).join(" | "));
fs.writeFileSync(path.join(here, "..", "..", "docs", "electron-results.json"), JSON.stringify(results, null, 2));
process.exit(results.every((x) => x.ok) ? 0 : 1);
