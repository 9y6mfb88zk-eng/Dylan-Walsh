// Routes allowlisted computer actions to the user's connected Windows app. Never a shell.
// Actions marked confirm:true (e.g. closing a window) only run once the user has explicitly said yes.
import { validateAction, ACTIONS } from "../shared/computer-actions.js";
import { onlineDesktop, requestDesktop } from "../realtime.js";
import { audit } from "../security/audit.js";
import { getSettings } from "../db.js";
import { logActivity } from "./notify.js";
import * as pending from "./pending.js";

const LABEL = {
  open_app: (a) => `open ${a.app}`, open_folder: (a) => `open ${a.folder}`, open_bookmark: (a) => `open ${a.name}`, open_url: (a) => `open ${a.url}`,
  create_document: (a) => `create document "${a.title}"`, search_files: (a) => `search files for "${a.query}"`, open_file: (a) => `open ${a.path}`,
  create_folder: (a) => `create folder "${a.name}" in ${a.parent}`, screenshot: () => "take a screenshot", list_windows: () => "list open windows",
  focus_window: (a) => `bring ${a.target} to the front`, minimize_window: (a) => `minimise ${a.target}`, close_window: (a) => `close ${a.target}`,
  clipboard_read: () => "read the clipboard", clipboard_write: () => "copy text to the clipboard", lock_screen: () => "lock the laptop", system_status: () => "check system status",
};

export async function runComputerAction(action, args, { requestedBy, confirmed = false } = {}) {
  if (!getSettings().computer.enabled) return { ok: false, error: "Computer control is switched off in Settings." };
  let clean;
  try { clean = validateAction(action, args); } catch (e) { return { ok: false, error: e.message }; }
  if (ACTIONS[action].confirm && !confirmed) return { ok: false, needsConfirmation: true, error: `This needs your confirmation: ${LABEL[action]?.(clean) || action}.` };
  const desk = onlineDesktop();
  if (!desk) return { ok: false, error: "Your laptop isn't connected right now, so I can't do that on it." };
  if (desk.status?.computer === false) return { ok: false, error: "Computer control is disabled in the desktop app's settings." };
  const res = await requestDesktop(desk.deviceId, { action, args: clean });
  audit("computer.action", { deviceId: requestedBy, target: desk.deviceId, action, ok: res.ok, error: res.error || undefined });
  if (res.ok) logActivity("computer", `Laptop: ${LABEL[action]?.(clean) || action}`, { action }, requestedBy);
  return res;
}

/** For the AI: actions that need confirmation become a pending action the user approves. */
export function proposeComputerAction(action, args) {
  const clean = validateAction(action, args);
  return pending.propose("computer.action", { action, args: clean }, `On your laptop: ${LABEL[action]?.(clean) || action}`);
}
pending.registerHandler("computer.action", async ({ action, args }) => {
  const r = await runComputerAction(action, args, { requestedBy: "confirmed", confirmed: true });
  if (!r.ok) throw new Error(r.error || "The laptop couldn't do that.");
  return r.result ?? { ok: true };
});
export { ACTIONS };
