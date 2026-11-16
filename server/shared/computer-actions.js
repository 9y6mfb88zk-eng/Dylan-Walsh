// The complete allowlist of computer actions JARVIS may request. Shared by the backend
// (validates before dispatch) and the Windows app (validates again before executing).
// There is deliberately no shell, no delete, no install and no settings action.

export const APPS = {
  chrome: { label: "Google Chrome", win: ["chrome.exe"], mac: ["Google Chrome"], linux: ["google-chrome"] },
  edge: { label: "Microsoft Edge", win: ["msedge.exe"], mac: ["Microsoft Edge"], linux: ["microsoft-edge"] },
  firefox: { label: "Firefox", win: ["firefox.exe"], mac: ["Firefox"], linux: ["firefox"] },
  notepad: { label: "Notepad", win: ["notepad.exe"], mac: ["TextEdit"], linux: ["gedit"] },
  explorer: { label: "File Explorer", win: ["explorer.exe"], mac: ["Finder"], linux: ["xdg-open"] },
  vscode: { label: "Visual Studio Code", win: ["code.cmd", "Code.exe"], mac: ["Visual Studio Code"], linux: ["code"] },
  word: { label: "Microsoft Word", win: ["winword.exe"], mac: ["Microsoft Word"], linux: [] },
  excel: { label: "Microsoft Excel", win: ["excel.exe"], mac: ["Microsoft Excel"], linux: [] },
  calculator: { label: "Calculator", win: ["calc.exe"], mac: ["Calculator"], linux: ["gnome-calculator"] },
  spotify: { label: "Spotify", win: ["spotify.exe"], mac: ["Spotify"], linux: ["spotify"] },
};
export const FOLDERS = ["downloads", "documents", "desktop", "pictures", "music", "videos"];

export const ACTIONS = {
  open_app: { description: "Open an application from the allowlist.", confirm: false },
  open_folder: { description: "Open a standard user folder.", confirm: false },
  open_bookmark: { description: "Open a folder, file or website the user saved as a named shortcut in the JARVIS desktop settings (for example their project folder).", confirm: false },
  open_url: { description: "Open an https web address in the default browser.", confirm: false },
  create_document: { description: "Create a new text or Markdown document in Documents\\JARVIS and open it.", confirm: false },
  search_files: { description: "Search file names in the user's standard folders. Returns up to 20 matches, newest first.", confirm: false },
  open_file: { description: "Open a file previously returned by search_files.", confirm: false },
};

const str = (v, max = 200) => {
  if (typeof v !== "string") throw new Error("Expected text");
  const s = v.trim();
  if (!s || s.length > max) throw new Error("Text is empty or too long");
  if (/[\u0000-\u001f]/.test(s)) throw new Error("Control characters are not allowed");
  return s;
};

/** Validate and normalise an action request. Throws on anything outside the allowlist. */
export function validateAction(action, args = {}) {
  if (!Object.hasOwn(ACTIONS, action)) throw new Error(`Action "${action}" is not permitted.`);
  switch (action) {
    case "open_app": {
      const app = str(args.app, 40).toLowerCase();
      if (!Object.hasOwn(APPS, app)) throw new Error(`"${app}" is not on the allowed app list (${Object.keys(APPS).join(", ")}).`);
      return { app };
    }
    case "open_folder": {
      const folder = str(args.folder, 40).toLowerCase();
      if (!FOLDERS.includes(folder)) throw new Error(`Folder must be one of ${FOLDERS.join(", ")}.`);
      return { folder };
    }
    case "open_bookmark": return { name: str(args.name, 80) };
    case "open_url": {
      const u = new URL(str(args.url, 2000));
      if (u.protocol !== "https:") throw new Error("Only https links can be opened.");
      return { url: u.href };
    }
    case "create_document": {
      const title = str(args.title, 80).replace(/[\\/:*?"<>|]/g, "-");
      const format = args.format === "txt" ? "txt" : "md";
      const content = typeof args.content === "string" ? args.content.slice(0, 50_000) : "";
      return { title, format, content };
    }
    case "search_files": {
      const query = str(args.query, 80);
      const folder = args.folder ? str(args.folder, 40).toLowerCase() : null;
      if (folder && !FOLDERS.includes(folder)) throw new Error(`Folder must be one of ${FOLDERS.join(", ")}.`);
      return { query, folder };
    }
    case "open_file": return { path: str(args.path, 1000) };
  }
}
