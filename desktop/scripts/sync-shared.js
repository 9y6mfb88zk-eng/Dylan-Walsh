// Copies shared files from the backend so the Windows app works with identical rules and assets:
// the computer-action allowlist (validated on both sides) and the built-in alarm sounds (rung by the alarm window
// even when the server isn't running yet, e.g. straight after the laptop wakes up).
import fs from "node:fs";
fs.copyFileSync(new URL("../../server/shared/computer-actions.js", import.meta.url), new URL("../src/shared/computer-actions.js", import.meta.url));
console.log("synced src/shared/computer-actions.js");
const from = new URL("../../public/sounds/", import.meta.url), to = new URL("../src/alarm/sounds/", import.meta.url);
fs.mkdirSync(to, { recursive: true });
for (const f of fs.readdirSync(from).filter((f) => f.endsWith(".wav"))) fs.copyFileSync(new URL(f, from), new URL(f, to));
console.log("synced src/alarm/sounds/*.wav");
