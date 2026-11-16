import * as webpush from "web-push";
import { config } from "./config.js";
import { kvGet, kvSet, pushSubs } from "./db.js";

let keys = { publicKey: config.vapidPublic, privateKey: config.vapidPrivate };
if (!keys.publicKey || !keys.privateKey) {
  keys = kvGet("vapid") || webpush.generateVAPIDKeys();
  kvSet("vapid", keys);
}
webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);

export const vapidPublicKey = keys.publicKey;

/** Send a notification to every subscribed device. Returns count delivered. */
export async function notifyAll(payload) {
  const body = JSON.stringify(payload);
  const subs = pushSubs.all();
  let ok = 0;
  await Promise.all(subs.map(async (sub) => {
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
