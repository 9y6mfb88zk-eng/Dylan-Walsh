// Windows-only smoke test (run in CI): registers the exact "wake the laptop for the next alarm" task JARVIS creates,
// reads it back from Task Scheduler to confirm WakeToRun is set and the trigger time is right, then deletes it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createAgent } from "../src/agent.js";

if (process.platform !== "win32") { console.log("skipped (Windows only)"); process.exit(0); }
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-smoke-"));
const agent = createAgent({ getBase: () => null, getCookie: async () => null, userAgent: "smoke", runAction: async () => ({}), onRing() {}, onStopRing() {}, log() {}, dataDir, exePath: process.execPath });
agent.stop();
const when = new Date(Date.now() + 3 * 86400_000); when.setSeconds(0, 0);
const xml = agent.taskXml(when);
const file = path.join(dataDir, "task.xml");
fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, "utf16le")]));
const name = "JARVIS CI Smoke";
let ok = false;
try {
  execFileSync("schtasks.exe", ["/Create", "/TN", name, "/XML", file, "/F"], { stdio: "pipe" });
  const back = execFileSync("schtasks.exe", ["/Query", "/TN", name, "/XML"], { encoding: "utf8" });
  const pad = (n) => String(n).padStart(2, "0");
  const local = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
  ok = /<WakeToRun>true<\/WakeToRun>/.test(back) && back.includes(local) && back.includes("--alarm-check");
  console.log(ok ? `OK: task registered for ${local} with WakeToRun` : `FAILED: unexpected task definition\n${back}`);
} catch (e) {
  console.log("FAILED:", e.stderr?.toString() || e.message);
} finally {
  try { execFileSync("schtasks.exe", ["/Delete", "/TN", name, "/F"], { stdio: "pipe" }); } catch {}
}
process.exit(ok ? 0 : 1);
