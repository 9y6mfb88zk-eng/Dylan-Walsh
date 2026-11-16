import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createActions } from "../src/actions.js";

function setup(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-home-"));
  const paths = Object.fromEntries(["downloads", "documents", "desktop", "pictures", "music", "videos"].map((k) => { const p = path.join(home, k); fs.mkdirSync(p); return [k, p]; }));
  const calls = [];
  const settings = { computerEnabled: true, bookmarks: {}, ...extra };
  const run = createActions({
    paths, settings: () => settings,
    openPath: async (p) => { calls.push(["openPath", p]); return ""; },
    openExternal: async (u) => { calls.push(["openExternal", u]); },
    launch: async (k) => { calls.push(["launch", k]); },
    log: (e) => calls.push(["log", e.action, e.ok]),
  });
  return { run, paths, calls, settings, home };
}

test("only allowlisted actions and apps run", async () => {
  const { run, calls } = setup();
  assert.deepEqual(await run("open_app", { app: "Chrome" }), { opened: "Google Chrome" });
  assert.deepEqual(calls[0], ["launch", "chrome"]);
  await assert.rejects(run("open_app", { app: "regedit" }), /not on the allowed app list/);
  await assert.rejects(run("run_command", { cmd: "del /s c:\\" }), /not permitted/);
  await assert.rejects(run("open_url", { url: "file:///C:/Windows/System32/cmd.exe" }), /Only https/);
  await assert.rejects(run("open_url", { url: "javascript:alert(1)" }), /Only https/);
  assert.deepEqual(await run("open_url", { url: "https://example.com/x" }), { opened: "example.com" });
});

test("folders, documents (never overwritten) and the master switch", async () => {
  const { run, paths, calls, settings } = setup();
  await run("open_folder", { folder: "downloads" });
  assert.deepEqual(calls.find((c) => c[0] === "openPath"), ["openPath", paths.downloads]);
  const a = await run("create_document", { title: "Plan", content: "hello" });
  const b = await run("create_document", { title: "Plan" });
  assert.equal(path.basename(a.created), "Plan.md");
  assert.equal(path.basename(b.created), "Plan (2).md");
  assert.equal(fs.readFileSync(a.created, "utf8"), "hello");
  const c = await run("create_document", { title: "..\\..\\evil", format: "txt" });
  assert.ok(c.created.startsWith(path.join(paths.documents, "JARVIS")), "path traversal neutralised");
  settings.computerEnabled = false;
  await assert.rejects(run("open_folder", { folder: "documents" }), /switched off/);
});

test("file search finds the newest CV; open_file refuses programs and outside paths", async () => {
  const { run, paths } = setup();
  fs.writeFileSync(path.join(paths.documents, "Old CV.pdf"), "x");
  fs.utimesSync(path.join(paths.documents, "Old CV.pdf"), new Date("2024-01-01"), new Date("2024-01-01"));
  fs.mkdirSync(path.join(paths.desktop, "jobs"));
  fs.writeFileSync(path.join(paths.desktop, "jobs", "Dylan CV 2026.docx"), "x");
  fs.writeFileSync(path.join(paths.downloads, "cv-installer.exe"), "x");
  fs.utimesSync(path.join(paths.downloads, "cv-installer.exe"), new Date("2025-01-01"), new Date("2025-01-01"));
  const r = await run("search_files", { query: "cv" });
  assert.equal(r.results[0].name, "Dylan CV 2026.docx");
  assert.ok(r.results.some((x) => x.name === "Old CV.pdf"));
  assert.deepEqual(await run("open_file", { path: r.results[0].path }), { opened: "Dylan CV 2026.docx" });
  await assert.rejects(run("open_file", { path: path.join(paths.downloads, "cv-installer.exe") }), /doesn't open programs/);
  await assert.rejects(run("open_file", { path: "/etc/passwd" }), /only opens files inside your personal folders/);
});

test("named shortcuts: “open my JARVIS project”", async () => {
  const { run, paths, calls } = setup();
  const proj = path.join(paths.documents, "jarvis");
  fs.mkdirSync(proj);
  const s = setup({ bookmarks: { "JARVIS project": proj, "Bank": "https://monzo.com" } });
  fs.mkdirSync(proj, { recursive: true });
  assert.deepEqual(await s.run("open_bookmark", { name: "jarvis project" }), { opened: "JARVIS project" });
  assert.deepEqual(await s.run("open_bookmark", { name: "my JARVIS project folder" }), { opened: "JARVIS project" });
  await assert.rejects(s.run("open_bookmark", { name: "taxes" }), /No shortcut called/);
  void run; void calls;
});

test("the desktop allowlist is identical to the server's", () => {
  const a = fs.readFileSync(new URL("../src/shared/computer-actions.js", import.meta.url), "utf8");
  const b = fs.readFileSync(new URL("../../server/shared/computer-actions.js", import.meta.url), "utf8");
  assert.equal(a, b);
});

test("new laptop actions: folders never overwrite, screenshots stay local, clipboard, windows", async () => {
  const shots = [], clip = { v: "" };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-home-"));
  const paths = Object.fromEntries(["downloads", "documents", "desktop", "pictures", "music", "videos"].map((k) => { const p = path.join(home, k); fs.mkdirSync(p); return [k, p]; }));
  const closed = [];
  const run = createActions({
    paths, settings: () => ({ computerEnabled: true, bookmarks: {} }), openPath: async () => "", openExternal: async () => {}, launch: async () => {},
    screenshot: async () => { shots.push(1); return Buffer.from([0x89, 0x50, 0x4e, 0x47]); },
    clipboard: { readText: () => clip.v, writeText: (t) => { clip.v = t; } },
    windows: { list: async () => [{ app: "notepad", title: "notes.txt" }], focus: async (t) => ({ focused: t }), minimize: async () => ({ minimised: 1 }), close: async (t) => { closed.push(t); return { closeRequested: 1 }; } },
    systemStatus: () => ({ battery: 80 }),
  });
  const a = await run("create_folder", { name: "Clients", parent: "documents" });
  assert.equal(a.path, path.join(paths.documents, "Clients"));
  assert.equal(a.existed, false);
  fs.writeFileSync(path.join(a.path, "keep.txt"), "x");
  const b = await run("create_folder", { name: "Clients", parent: "documents" });
  assert.equal(b.existed, true);
  assert.ok(fs.existsSync(path.join(a.path, "keep.txt")), "existing folder left untouched");
  await assert.rejects(run("create_folder", { name: "../escape", parent: "documents" }), /can't contain/);
  await assert.rejects(run("create_folder", { name: "x", parent: "windows" }), /Parent folder/);
  const s = await run("screenshot", {});
  assert.ok(s.file.startsWith(path.join(paths.pictures, "JARVIS Screenshots")) && fs.existsSync(s.file));
  await run("clipboard_write", { text: "hello" });
  assert.equal((await run("clipboard_read", {})).text, "hello");
  assert.deepEqual((await run("list_windows", {})).windows, [{ app: "notepad", title: "notes.txt" }]);
  await run("close_window", { target: "notepad" });
  assert.deepEqual(closed, ["notepad"]);
  await assert.rejects(run("close_window", { target: "JARVIS" }), /won't close itself/);
  assert.equal((await run("system_status", {})).battery, 80);
});
