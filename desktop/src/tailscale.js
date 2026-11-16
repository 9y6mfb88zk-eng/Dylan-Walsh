// iPhone access through Tailscale (free private network): `tailscale serve` publishes the local JARVIS server
// over HTTPS to your own devices only. Nothing is opened to the public internet.
import { execFile } from "node:child_process";
import fs from "node:fs";

export function tailscaleBin() {
  if (process.env.JARVIS_TAILSCALE_BIN) return process.env.JARVIS_TAILSCALE_BIN;
  if (process.platform === "win32") {
    for (const p of ["C:\\Program Files\\Tailscale\\tailscale.exe", "C:\\Program Files (x86)\\Tailscale\\tailscale.exe"]) if (fs.existsSync(p)) return p;
    return null;
  }
  if (process.platform === "darwin" && fs.existsSync("/Applications/Tailscale.app/Contents/MacOS/Tailscale")) return "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
  return "tailscale";
}

function run(args, timeout = 20000) {
  const bin = tailscaleBin();
  if (!bin) return Promise.resolve({ ok: false, missing: true, out: "" });
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ""}${stderr || ""}`;
      resolve({ ok: !err, missing: err?.code === "ENOENT", out, code: err?.code });
    });
  });
}

/** { installed, running, loggedIn, dnsName, url, serving, loginUrl } */
export async function status(port) {
  const r = await run(["status", "--json"]);
  if (r.missing) return { installed: false };
  let j = null; try { j = JSON.parse(r.out.slice(r.out.indexOf("{"))); } catch {}
  if (!j) return { installed: true, running: false, error: r.out.trim().slice(0, 200) };
  const dns = (j.Self?.DNSName || "").replace(/\.$/, "");
  const st = { installed: true, running: j.BackendState === "Running", loggedIn: j.BackendState !== "NeedsLogin", loginUrl: j.AuthURL || null, dnsName: dns, url: dns ? `https://${dns}` : null };
  const s = await run(["serve", "status", "--json"]);
  try { st.serving = JSON.stringify(JSON.parse(s.out.slice(s.out.indexOf("{")) || "{}")).includes(`127.0.0.1:${port}`); } catch { st.serving = false; }
  return st;
}

/** Turn on HTTPS access for your tailnet. Returns { ok, url } or { ok:false, enableUrl, error }. */
export async function enable(port) {
  const st = await status(port);
  if (!st.installed) return { ok: false, error: "Tailscale isn't installed on this laptop.", download: "https://tailscale.com/download/windows" };
  if (!st.running) return { ok: false, error: "Tailscale is installed but not connected. Open Tailscale and sign in, then try again.", loginUrl: st.loginUrl };
  const r = await run(["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`], 30000);
  const link = r.out.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
  if (!r.ok || (/not enabled/i.test(r.out) && link)) {
    return { ok: false, enableUrl: link || null, error: link ? "Tailscale needs HTTPS turned on for your network (one click). Open the link, approve it, then try again." : r.out.trim().slice(0, 300) };
  }
  return { ok: true, url: st.url };
}

export async function disable() {
  const r = await run(["serve", "--https=443", "off"]);
  return { ok: r.ok, error: r.ok ? null : r.out.trim().slice(0, 300) };
}
