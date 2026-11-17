// Optional free credentials for Global Operations data providers, stored encrypted (AES-256-GCM) in the database.
// None is required: without them JARVIS uses each provider's anonymous allowance and says so.
//   adsbKey           ADSB.lol free key (anonymous 500 requests/day → 1,000 with an ad-hoc key)
//   openskyClientId / openskyClientSecret   OpenSky OAuth2 client credentials (anonymous 400 credits/day → 4,000)
//   reliefwebAppname  ReliefWeb pre-approved appname (required by ReliefWeb for any request)
//   ucdpToken         UCDP API access token (required by UCDP for any request)
import { kvGet, kvSet } from "../db.js";
import { encrypt, decrypt } from "../security/crypto.js";

//   windyKey          Windy Webcams API key (free tier: timelapse player embeds, image links valid 15 min)
//   youtubeKey        YouTube Data API v3 key (free quota) to verify that operator-published camera streams are live
//   nasaKey           NASA api.nasa.gov key (free; without it DEMO_KEY allows a few requests an hour)
export const KEY_NAMES = ["adsbKey", "openskyClientId", "openskyClientSecret", "reliefwebAppname", "ucdpToken", "windyKey", "youtubeKey", "nasaKey"];
const ENV = { adsbKey: "ADSB_LOL_KEY", openskyClientId: "OPENSKY_CLIENT_ID", openskyClientSecret: "OPENSKY_CLIENT_SECRET", reliefwebAppname: "RELIEFWEB_APPNAME", ucdpToken: "UCDP_TOKEN", windyKey: "WINDY_WEBCAMS_KEY", youtubeKey: "YOUTUBE_API_KEY", nasaKey: "NASA_API_KEY" };

export function getKey(name) {
  const stored = kvGet("globalops.keys", {})[name];
  if (stored) { try { return decrypt(stored); } catch { return ""; } }
  return process.env[ENV[name]] || "";
}
/** Which keys are set — never the values. */
export function keyStatus() { return Object.fromEntries(KEY_NAMES.map((k) => [k, !!getKey(k)])); }
export function setKeys(patch) {
  const cur = kvGet("globalops.keys", {});
  for (const k of KEY_NAMES) {
    if (!(k in patch)) continue;
    const v = String(patch[k] ?? "").trim();
    if (!v) delete cur[k]; else cur[k] = encrypt(v.slice(0, 400));
  }
  kvSet("globalops.keys", cur);
  return keyStatus();
}
