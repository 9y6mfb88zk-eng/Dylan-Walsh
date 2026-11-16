// Window management and system status for the allowlisted laptop actions.
// The target (an app or window title) is passed to PowerShell as an environment variable and only ever used as a
// string to compare against — never as code. Fixed scripts only.
import { execFile } from "node:child_process";
import os from "node:os";
import fs from "node:fs";

const ps = (script, env = {}) => new Promise((resolve, reject) => {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: 15_000, env: { ...process.env, ...env } }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().slice(0, 200))) : resolve(String(stdout))));
});
const USER32 = `Add-Type -Namespace J -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(System.IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);';`;
// Find windows whose process name or title contains the target (case-insensitive), excluding JARVIS itself.
const FIND = `$t = $env:JARVIS_TARGET.ToLowerInvariant(); $w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -notmatch '^(JARVIS|electron)$' -and ($_.ProcessName.ToLowerInvariant().Contains($t) -or $_.MainWindowTitle.ToLowerInvariant().Contains($t)) };`;

export function windowsControl(platform = process.platform) {
  if (platform !== "win32") return null;
  return {
    async list() {
      const out = await ps("Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object ProcessName, MainWindowTitle | ConvertTo-Json -Compress");
      const rows = out.trim() ? [].concat(JSON.parse(out)) : [];
      return rows.filter((r) => !/^(JARVIS|electron)$/i.test(r.ProcessName)).map((r) => ({ app: r.ProcessName, title: r.MainWindowTitle }));
    },
    async focus(target) {
      const out = await ps(`${USER32} ${FIND} if (-not $w) { 'none' } else { $p = $w | Select-Object -First 1; [J.W]::ShowWindowAsync($p.MainWindowHandle, 9) | Out-Null; [J.W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; $p.ProcessName }`, { JARVIS_TARGET: target });
      if (out.trim() === "none") throw new Error(`No open window matches “${target}”.`);
      return { focused: out.trim() };
    },
    async minimize(target) {
      const out = await ps(`${USER32} ${FIND} if (-not $w) { 'none' } else { foreach ($p in $w) { [J.W]::ShowWindowAsync($p.MainWindowHandle, 6) | Out-Null }; ($w | Measure-Object).Count }`, { JARVIS_TARGET: target });
      if (out.trim() === "none") throw new Error(`No open window matches “${target}”.`);
      return { minimised: Number(out.trim()) || 1 };
    },
    async close(target) {
      // CloseMainWindow asks the app to close normally (it can still prompt to save) — never a forced kill.
      const out = await ps(`${FIND} if (-not $w) { 'none' } else { foreach ($p in $w) { $p.CloseMainWindow() | Out-Null }; ($w | Measure-Object).Count }`, { JARVIS_TARGET: target });
      if (out.trim() === "none") throw new Error(`No open window matches “${target}”.`);
      return { closeRequested: Number(out.trim()) || 1 };
    },
  };
}

export async function lockScreen(platform = process.platform) {
  if (platform === "win32") return new Promise((resolve, reject) => execFile("rundll32.exe", ["user32.dll,LockWorkStation"], { windowsHide: true }, (e) => (e ? reject(e) : resolve())));
  if (platform === "linux") return new Promise((resolve, reject) => execFile("loginctl", ["lock-session"], (e) => (e ? reject(new Error("Couldn't lock this session.")) : resolve())));
  throw new Error("Locking isn't supported on this system.");
}

export async function systemStatus({ displays = 1, platform = process.platform } = {}) {
  const out = { uptime: `${Math.round(os.uptime() / 3600)} h`, displays, platform: `${os.type()} ${os.release()}` };
  try {
    if (platform === "win32") {
      const j = await ps("Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json -Compress");
      if (j.trim()) { const b = [].concat(JSON.parse(j))[0]; out.battery = b.EstimatedChargeRemaining; out.charging = [2, 6, 7, 8, 9].includes(b.BatteryStatus); }
    } else if (fs.existsSync("/sys/class/power_supply/BAT0/capacity")) {
      out.battery = Number(fs.readFileSync("/sys/class/power_supply/BAT0/capacity", "utf8"));
      out.charging = /Charging|Full/.test(fs.readFileSync("/sys/class/power_supply/BAT0/status", "utf8"));
    }
  } catch {}
  return out;
}
