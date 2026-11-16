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

// Local speech recognition model: NVIDIA Parakeet TDT 0.6B v2 (int8) from the sherpa-onnx releases, checksum-pinned.
// Chosen by measurement (scripts/asr-bench.mjs → docs/asr-benchmark.json): far fewer word errors than Whisper base.en.
const ASR = { file: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2", dir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", sha256: "6fc4426b54aa549a0019b8a75b8dea59164e71790a37ac56a045ad57f915f714", files: ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"] };
const asrDir = path.join(bundle, "asr");
if (ASR.files.every((f) => fs.existsSync(path.join(asrDir, f))) && fs.existsSync(path.join(asrDir, ".source")) && fs.readFileSync(path.join(asrDir, ".source"), "utf8").trim() === ASR.sha256) {
  console.log("Speech model already bundled");
} else {
  const asrUrl = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${ASR.file}`;
  console.log(`Downloading ${asrUrl}`);
  const atmp = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-asr-"));
  const archivePath = path.join(atmp, ASR.file);
  const ar = await fetch(asrUrl);
  if (!ar.ok) throw new Error(`ASR model download failed: ${ar.status}`);
  // Stream to disk while hashing (the archive is ~480 MB).
  const hash = (await import("node:crypto")).createHash("sha256");
  const out = fs.createWriteStream(archivePath);
  for await (const chunk of ar.body) { hash.update(chunk); if (!out.write(chunk)) await new Promise((r) => out.once("drain", r)); }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  if (hash.digest("hex") !== ASR.sha256) throw new Error(`Checksum mismatch for ${ASR.file}`);
  // Windows' built-in tar may lack bzip2; Git for Windows' tar (present on GitHub runners) has it.
  const tars = process.platform === "win32" ? ["C:\\Program Files\\Git\\usr\\bin\\tar.exe", "tar"] : ["tar"];
  const gitPath = (p) => p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, "/$1");
  let extractedOk = false;
  for (const t of tars) {
    const git = process.platform === "win32" && t.includes("Git");
    try { execFileSync(t, ["-xjf", git ? gitPath(archivePath) : archivePath, "-C", git ? gitPath(atmp) : atmp, ...ASR.files.map((f) => `${ASR.dir}/${f}`)], { stdio: "inherit" }); extractedOk = true; break; }
    catch (e) { console.warn(`${t} could not extract: ${e.message}`); }
  }
  if (!extractedOk) throw new Error("Could not extract the speech model archive");
  fs.rmSync(asrDir, { recursive: true, force: true });
  fs.mkdirSync(asrDir, { recursive: true });
  // Move each file; the temp folder can be on another drive (C: vs D: on CI), where rename fails with EXDEV.
  for (const f of ASR.files) { const from = path.join(atmp, ASR.dir, f), to = path.join(asrDir, f); try { fs.renameSync(from, to); } catch (e) { if (e.code !== "EXDEV") throw e; fs.copyFileSync(from, to); fs.unlinkSync(from); } }
  fs.writeFileSync(path.join(asrDir, ".source"), ASR.sha256);
  fs.rmSync(atmp, { recursive: true, force: true });
}
console.log(`Bundled Node ${NODE_VERSION} (${target}), the JARVIS server and the Parakeet speech model into desktop/bundle/`);
