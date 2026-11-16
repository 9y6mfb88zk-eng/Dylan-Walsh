// Live connection to the backend: reconnects with back-off, replays the outbox, fans out events.
import { flushOutbox } from "./api.js";

const handlers = new Map();
let ws = null, retry = 0, timer = null, wantOpen = false;
export const status = { online: false, since: null };

export function on(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); return () => handlers.get(type).delete(fn); }
function emit(type, data) { handlers.get(type)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

export function connect() {
  wantOpen = true;
  if (ws && ws.readyState <= 1) return;
  clearTimeout(timer);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.onopen = async () => {
    retry = 0; status.online = true; status.since = Date.now();
    emit("status", status);
    await flushOutbox().catch(() => {});
    emit("reconnected");
  };
  ws.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    emit(m.type, m);
  };
  ws.onclose = () => {
    status.online = false; emit("status", status);
    ws = null;
    if (!wantOpen) return;
    const delay = Math.min(30_000, 1000 * 2 ** retry++) + Math.random() * 500;
    timer = setTimeout(connect, delay);
  };
  ws.onerror = () => {};
}
export function disconnect() { wantOpen = false; clearTimeout(timer); ws?.close(); }
export function sendWs(msg) { if (ws?.readyState === 1) { ws.send(JSON.stringify(msg)); return true; } return false; }

addEventListener("online", () => { retry = 0; connect(); flushOutbox().then((n) => n && emit("reconnected")).catch(() => {}); });
// Belt and braces: retry queued writes periodically (covers networks that drop without closing the socket).
setInterval(() => { if (navigator.onLine) flushOutbox().then((n) => n && emit("reconnected")).catch(() => {}); }, 15_000);
addEventListener("offline", () => { status.online = false; emit("status", status); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && wantOpen && (!ws || ws.readyState > 1)) { retry = 0; connect(); } });
setInterval(() => sendWs({ type: "ping" }), 25_000);
