// Prepares what the installer ships so JARVIS runs entirely on the laptop:
//   bundle/server-app/  the JARVIS backend (server/, public/, production node_modules)
//   bundle/node/        a pinned Node.js 22 runtime (the backend needs node:sqlite, newer than Electron's Node)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = "22.14.0";
const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.join(here, "..");
const repo = path.join(desktop, "..");
const bundle = path.join(desktop, "bundle");
const target = process.env.JARVIS_TARGET_PLATFORM || process.platform;   // win32 | linux | darwin

fs.rmSync(bundle, { recursive: true, force: true });
const app = path.join(bundle, "server-app");
fs.mkdirSync(app, { recursive: true });
for (const item of ["server", "public", "package.json", "package-lock.json"]) {
  fs.cpSync(path.join(repo, item), path.join(app, item), { recursive: true });
}
console.log("Installing backend production dependencies…");
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: app, stdio: "inherit", shell: process.platform === "win32" });

const archives = { win32: `node-v${NODE_VERSION}-win-x64.zip`, linux: `node-v${NODE_VERSION}-linux-x64.tar.xz`, darwin: `node-v${NODE_VERSION}-darwin-arm64.tar.gz` };
const file = archives[target];
const url = `https://nodejs.org/dist/v${NODE_VERSION}/${file}`;
console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Node download failed: ${res.status}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-node-"));
const archive = path.join(tmp, file);
fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
// Verify against the official checksum list.
const sums = await (await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`)).text();
const expected = sums.split("\n").find((l) => l.endsWith(`  ${file}`))?.split(/\s+/)[0];
const actual = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${file}`);
execFileSync("tar", ["-xf", archive, "-C", tmp], { stdio: "inherit" });
const extracted = path.join(tmp, file.replace(/\.(zip|tar\.xz|tar\.gz)$/, ""));
const nodeDir = path.join(bundle, "node");
if (target === "win32") { fs.mkdirSync(nodeDir, { recursive: true }); fs.copyFileSync(path.join(extracted, "node.exe"), path.join(nodeDir, "node.exe")); }
else { fs.mkdirSync(path.join(nodeDir, "bin"), { recursive: true }); fs.copyFileSync(path.join(extracted, "bin", "node"), path.join(nodeDir, "bin", "node")); fs.chmodSync(path.join(nodeDir, "bin", "node"), 0o755); }
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Bundled Node ${NODE_VERSION} (${target}) and the JARVIS server into desktop/bundle/`);
