// Allowlisted laptop actions. Every request is validated twice: by the backend and again here.
// No shell commands from the AI, no deleting, no installing, no settings changes, no running downloaded programs.
import fs from "node:fs";
import path from "node:path";
import { validateAction, APPS, FOLDERS } from "./shared/computer-actions.js";

const BLOCKED_EXT = new Set([".exe", ".msi", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".scr", ".pif", ".reg", ".lnk", ".hta", ".cpl", ".msc", ".jar", ".appx", ".msix", ".dll", ".sys"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "AppData", "$Recycle.Bin", ".cache", ".npm", "Library"]);

/**
 * deps: { paths: {downloads, documents, desktop, pictures, music, videos}, openPath(p), openExternal(url),
 *         launch(appKey, candidates), settings(): {bookmarks, computerEnabled}, log(entry),
 *         screenshot() → PNG Buffer, clipboard {readText, writeText}, windows {list, focus, minimize, close}, lock(), systemStatus() }
 */
export function createActions(deps) {
  const recent = new Set();   // files returned by the last searches: the only ones open_file may open

  function inRoots(p) {
    const real = path.resolve(p);
    return FOLDERS.some((f) => { const root = path.resolve(deps.paths[f]); return real === root || real.startsWith(root + path.sep); });
  }
  function safeFile(p) {
    if (BLOCKED_EXT.has(path.extname(p).toLowerCase())) throw new Error("For your safety JARVIS doesn't open programs or scripts.");
  }

  const handlers = {
    async open_app({ app }) {
      const def = APPS[app];
      await deps.launch(app, def);
      return { opened: def.label };
    },
    async open_folder({ folder }) {
      const p = deps.paths[folder];
      const err = await deps.openPath(p);
      if (err) throw new Error(err);
      return { opened: folder };
    },
    async open_bookmark({ name }) {
      const bms = deps.settings().bookmarks || {};
      const key = Object.keys(bms).find((k) => k.toLowerCase() === name.toLowerCase())
        || Object.keys(bms).find((k) => k.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(k.toLowerCase()));
      if (!key) throw new Error(`No shortcut called "${name}". Add one in JARVIS → Settings → Voice & laptop.`);
      const target = bms[key];
      if (/^https:\/\//i.test(target)) { await deps.openExternal(target); return { opened: key }; }
      if (!fs.existsSync(target)) throw new Error(`The shortcut "${key}" points to a location that no longer exists.`);
      if (fs.statSync(target).isFile()) safeFile(target);
      const err = await deps.openPath(target);
      if (err) throw new Error(err);
      return { opened: key };
    },
    async open_url({ url }) { await deps.openExternal(url); return { opened: new URL(url).hostname }; },
    async create_document({ title, format, content }) {
      const dir = path.join(deps.paths.documents, "JARVIS");
      fs.mkdirSync(dir, { recursive: true });
      let file = path.join(dir, `${title}.${format}`);
      for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${title} (${i}).${format}`);   // never overwrite
      fs.writeFileSync(file, content || (format === "md" ? `# ${title}\n\n` : ""), { flag: "wx" });
      await deps.openPath(file);
      return { created: file };
    },
    async search_files({ query, folder }) {
      const roots = folder ? [folder] : FOLDERS;
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hits = [];
      let seen = 0;
      const walk = (dir, depth) => {
        if (depth > 5 || seen > 25000) return;
        let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (++seen > 25000) return;
          if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else if (e.isFile() && terms.every((t) => e.name.toLowerCase().includes(t))) {
            try { hits.push({ name: e.name, path: full, modified: fs.statSync(full).mtime.toISOString(), folder: path.basename(path.dirname(full)) }); } catch {}
          }
        }
      };
      for (const r of roots) walk(deps.paths[r], 0);
      hits.sort((a, b) => b.modified.localeCompare(a.modified));
      const top = hits.slice(0, 20);
      top.forEach((h) => recent.add(path.resolve(h.path)));
      return { count: hits.length, results: top };
    },
    async create_folder({ name, parent }) {
      const dir = path.join(deps.paths[parent], name);
      if (!inRoots(dir)) throw new Error("Folders can only be created inside your personal folders.");
      const existed = fs.existsSync(dir);
      if (!existed) fs.mkdirSync(dir, { recursive: false });      // never replaces or merges anything
      return { path: dir, existed };
    },
    async screenshot() {
      if (!deps.screenshot) throw new Error("Screenshots aren't available on this system.");
      const png = await deps.screenshot();
      const dir = path.join(deps.paths.pictures, "JARVIS Screenshots");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `Screenshot ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`);
      fs.writeFileSync(file, png, { flag: "wx" });
      return { file, bytes: png.length };                       // stays on the laptop; never uploaded
    },
    async list_windows() {
      if (!deps.windows) throw new Error("Window control isn't available on this system.");
      return { windows: (await deps.windows.list()).slice(0, 40) };
    },
    async focus_window({ target }) { if (!deps.windows) throw new Error("Window control isn't available on this system."); return deps.windows.focus(target); },
    async minimize_window({ target }) { if (!deps.windows) throw new Error("Window control isn't available on this system."); return deps.windows.minimize(target); },
    async close_window({ target }) {
      if (!deps.windows) throw new Error("Window control isn't available on this system.");
      if (/jarvis/i.test(target)) throw new Error("JARVIS won't close itself that way. Use the tray icon → Exit JARVIS.");
      return deps.windows.close(target);
    },
    async clipboard_read() { if (!deps.clipboard) throw new Error("Clipboard isn't available."); const text = deps.clipboard.readText() || ""; return { text: text.slice(0, 20_000), truncated: text.length > 20_000 }; },
    async clipboard_write({ text }) { if (!deps.clipboard) throw new Error("Clipboard isn't available."); deps.clipboard.writeText(text); return { copied: text.length }; },
    async lock_screen() { if (!deps.lock) throw new Error("Locking isn't available on this system."); await deps.lock(); return { locked: true }; },
    async system_status() { return deps.systemStatus ? deps.systemStatus() : {}; },
    async open_file({ path: p }) {
      const real = path.resolve(p);
      if (!recent.has(real) && !inRoots(real)) throw new Error("JARVIS only opens files inside your personal folders.");
      if (!fs.existsSync(real)) throw new Error("That file no longer exists.");
      safeFile(real);
      const err = await deps.openPath(real);
      if (err) throw new Error(err);
      return { opened: path.basename(real) };
    },
  };

  return async function run(action, args) {
    if (deps.settings().computerEnabled === false) throw new Error("Computer control is switched off in the JARVIS desktop settings.");
    const clean = validateAction(action, args);
    try {
      const result = await handlers[action](clean);
      deps.log?.({ at: new Date().toISOString(), action, args: clean, ok: true });
      return result;
    } catch (e) {
      deps.log?.({ at: new Date().toISOString(), action, args: clean, ok: false, error: e.message });
      throw e;
    }
  };
}
