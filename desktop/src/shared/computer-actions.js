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
  create_folder: { description: "Create a new folder inside one of the standard folders (never replaces anything).", confirm: false },
  screenshot: { description: "Save a screenshot of the screen to Pictures\\JARVIS Screenshots (stays on the laptop).", confirm: false },
  list_windows: { description: "List the apps that have open windows.", confirm: false },
  focus_window: { description: "Bring an open window to the front (by app or window title).", confirm: false },
  minimize_window: { description: "Minimise an open window (by app or window title).", confirm: false },
  close_window: { description: "Close an app's window. Unsaved work could be lost, so this always needs your confirmation.", confirm: true },
  clipboard_read: { description: "Read the text currently on the clipboard.", confirm: false },
  clipboard_write: { description: "Put text on the clipboard.", confirm: false },
  lock_screen: { description: "Lock the laptop.", confirm: false },
  system_status: { description: "Battery, uptime and screen information.", confirm: false },
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
    case "create_folder": {
      const name = str(args.name, 80);
      if (/[\\/:*?"<>|]|^\.+$/.test(name)) throw new Error("Folder names can't contain \\ / : * ? \" < > | or be dots only.");
      const parent = args.parent ? str(args.parent, 40).toLowerCase() : "documents";
      if (!FOLDERS.includes(parent)) throw new Error(`Parent folder must be one of ${FOLDERS.join(", ")}.`);
      return { name, parent };
    }
    case "focus_window": case "minimize_window": case "close_window": return { target: str(args.target ?? args.app ?? args.title, 120) };
    case "clipboard_write": return { text: typeof args.text === "string" ? args.text.slice(0, 20_000) : str(args.text, 20_000) };
    case "screenshot": case "list_windows": case "clipboard_read": case "lock_screen": case "system_status": return {};
  }
}
