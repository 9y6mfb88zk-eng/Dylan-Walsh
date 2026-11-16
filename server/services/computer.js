// Routes allowlisted computer actions to the user's connected Windows app. Never a shell.
import { validateAction, ACTIONS } from "../shared/computer-actions.js";
import { onlineDesktop, requestDesktop } from "../realtime.js";
import { audit } from "../security/audit.js";
import { getSettings } from "../db.js";

export async function runComputerAction(action, args, { requestedBy } = {}) {
  if (!getSettings().computer.enabled) return { ok: false, error: "Computer control is switched off in Settings." };
  let clean;
  try { clean = validateAction(action, args); } catch (e) { return { ok: false, error: e.message }; }
  const desk = onlineDesktop();
  if (!desk) return { ok: false, error: "Your laptop isn't connected right now, so I can't do that on it." };
  if (desk.status?.computer === false) return { ok: false, error: "Computer control is disabled in the desktop app's settings." };
  const res = await requestDesktop(desk.deviceId, { action, args: clean });
  audit("computer.action", { deviceId: requestedBy, target: desk.deviceId, action, ok: res.ok, error: res.error || undefined });
  return res;
}
export { ACTIONS };
