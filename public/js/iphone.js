// iPhone: JARVIS installs from Safari onto the Home Screen (Apple only distributes downloadable apps through the
// App Store). This guides the install where it happens, and offers notifications once JARVIS runs from the icon —
// iPhones only allow web notifications for Home Screen apps, and only after a tap.
import { api } from "./api.js";
import { esc, icon, toast } from "./util.js";

export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const otherBrowser = () => /CriOS|FxiOS|EdgiOS|OPiOS/.test(navigator.userAgent);
const remembered = (k) => { try { return Number(localStorage.getItem(k) || 0) > Date.now(); } catch { return false; } };
const remember = (k, days) => { try { localStorage.setItem(k, String(Date.now() + days * 864e5)); } catch {} };

const SHARE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';

function sheet(id, html) {
  document.getElementById(id)?.remove();
  const el = document.createElement("aside");
  el.id = id; el.className = "ios-sheet glass"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Install JARVIS");
  el.innerHTML = html;
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add("in"));
  return el;
}
const close = (el) => { el.classList.remove("in"); setTimeout(() => el.remove(), 300); };

/** In Safari (not yet installed): how to put JARVIS on the Home Screen, with the real buttons to tap. */
export function showInstallGuide({ force = false } = {}) {
  if (!isIOS() || isStandalone() || (!force && remembered("jarvis.iosHint"))) return false;
  const el = sheet("iosInstall", `
    <div class="spread"><b class="ios-title">Install JARVIS on your iPhone</b><button class="x" data-x aria-label="Close">×</button></div>
    <ol class="ios-steps">
      ${otherBrowser() ? "<li>Open this page in <b>Safari</b> (copy the address into Safari).</li>" : ""}
      <li>Tap <span class="ios-key">${SHARE} Share</span> ${otherBrowser() ? "" : "at the bottom of Safari"}</li>
      <li>Scroll down and tap <span class="ios-key">＋ Add to Home Screen</span>, then <b>Add</b></li>
      <li>Open <b>JARVIS</b> from the new icon — it runs full-screen like an app, and you'll be able to turn on notifications</li>
    </ol>
    <div class="row end"><button class="btn small ghost" data-later>Later</button><button class="btn small primary" data-x>Got it</button></div>`);
  el.querySelectorAll("[data-x]").forEach((b) => b.onclick = () => { remember("jarvis.iosHint", 30); close(el); });
  el.querySelector("[data-later]").onclick = () => { remember("jarvis.iosHint", 1); close(el); };
  return true;
}

/** Turn on push notifications for this device (must run from a tap). */
export async function enablePush(ctx) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) throw new Error(isIOS() && !isStandalone() ? "On iPhone, add JARVIS to the Home Screen first and open it from the icon." : "This browser can't receive notifications.");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications weren't allowed. You can change this in the iPhone's Settings → Notifications → JARVIS.");
  const reg = await navigator.serviceWorker.ready;
  const key = ctx.session.vapidPublicKey, pad = "=".repeat((4 - (key.length % 4)) % 4);
  const bytes = Uint8Array.from(atob((key + pad).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const s = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes }));
  await api("/api/push/subscribe", { method: "POST", body: s.toJSON() });
}

/** Running from the Home Screen without notifications yet: offer them once (Apple requires a tap). */
export async function offerNotifications(ctx) {
  if (!isIOS() || !isStandalone() || !("Notification" in window) || Notification.permission !== "default" || remembered("jarvis.iosPush")) return false;
  const title = ctx.settings.profile?.title || "Sir";
  const el = sheet("iosPush", `
    <div class="spread"><b class="ios-title">${icon("notifications")} Notifications</b><button class="x" data-x aria-label="Close">×</button></div>
    <p class="muted" style="margin:6px 0 12px;font-size:14px">Reminders, alarms, briefings and research results can reach this iPhone even when JARVIS is closed, ${esc(title)}.</p>
    <div class="row end"><button class="btn small ghost" data-x>Not now</button><button class="btn small primary" data-on>Turn on notifications</button></div>`);
  el.querySelectorAll("[data-x]").forEach((b) => b.onclick = () => { remember("jarvis.iosPush", 14); close(el); });
  el.querySelector("[data-on]").onclick = async () => {
    try { await enablePush(ctx); toast(`Notifications on, ${title}.`); } catch (e) { toast(e.message, 7000); }
    remember("jarvis.iosPush", 365); close(el);
  };
  return true;
}
