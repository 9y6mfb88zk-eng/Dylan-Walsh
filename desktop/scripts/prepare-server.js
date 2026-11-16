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

// Local speech recognition model (Whisper base.en, int8) from the sherpa-onnx releases, checksum-pinned.
const ASR = { file: "sherpa-onnx-whisper-base.en.tar.bz2", sha256: "475bc7052ce299c007f6d5d5407ba8601f819a2867f6eecee510ed17df581542" };
const asrUrl = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${ASR.file}`;
console.log(`Downloading ${asrUrl}`);
const ar = await fetch(asrUrl);
if (!ar.ok) throw new Error(`ASR model download failed: ${ar.status}`);
const atmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-asr-"));
const abuf = Buffer.from(await ar.arrayBuffer());
const asum = (await import("node:crypto")).createHash("sha256").update(abuf).digest("hex");
if (asum !== ASR.sha256) throw new Error(`Checksum mismatch for ${ASR.file}`);
fs.writeFileSync(path.join(atmp, ASR.file), abuf);
// Windows' built-in tar may lack bzip2; Git for Windows' tar (present on GitHub runners) has it.
const tars = process.platform === "win32" ? ["C:\\Program Files\\Git\\usr\\bin\\tar.exe", "tar"] : ["tar"];
let extractedOk = false;
for (const t of tars) {
  try { execFileSync(t, ["-xjf", process.platform === "win32" && t.includes("Git") ? path.join(atmp, ASR.file).replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1") : path.join(atmp, ASR.file), "-C", process.platform === "win32" && t.includes("Git") ? atmp.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1") : atmp], { stdio: "inherit" }); extractedOk = true; break; }
  catch (e) { console.warn(`${t} could not extract: ${e.message}`); }
}
if (!extractedOk) throw new Error("Could not extract the speech model archive");
const asrDir = path.join(bundle, "asr");
fs.mkdirSync(asrDir, { recursive: true });
for (const f of ["base.en-encoder.int8.onnx", "base.en-decoder.int8.onnx", "base.en-tokens.txt"]) fs.copyFileSync(path.join(atmp, "sherpa-onnx-whisper-base.en", f), path.join(asrDir, f));
fs.rmSync(atmp, { recursive: true, force: true });
console.log(`Bundled Node ${NODE_VERSION} (${target}), the JARVIS server and local Whisper into desktop/bundle/`);
