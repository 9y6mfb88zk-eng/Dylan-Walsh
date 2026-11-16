import * as webpush from "web-push";
import { config } from "./config.js";
import { kvGet, kvSet, pushSubs } from "./db.js";
import { broadcast } from "./realtime.js";

let keys = { publicKey: config.vapidPublic, privateKey: config.vapidPrivate };
if (!keys.publicKey || !keys.privateKey) {
  keys = kvGet("vapid") || webpush.generateVAPIDKeys();
  kvSet("vapid", keys);
}
webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
export const vapidPublicKey = keys.publicKey;

/**
 * Notify the user everywhere: web push (iPhone home-screen app, browsers) and a live
 * message to connected apps (the Windows app shows a native notification).
 * Returns how many push deliveries succeeded.
 */
export async function notifyAll(payload) {
  broadcast({ type: "notify", notification: payload });
  const body = JSON.stringify(payload);
  let ok = 0;
  await Promise.all(pushSubs.all().map(async (sub) => {
    try {
      await webpush.sendNotification(sub, body, { TTL: 60 * 60 * 12, urgency: payload.urgency || "normal" });
      ok++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) pushSubs.remove(sub.endpoint);
      else console.warn("[push] send failed:", err.statusCode || err.message);
    }
  }));
  return ok;
}
