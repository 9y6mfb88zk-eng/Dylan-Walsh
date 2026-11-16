// Authenticated WebSocket hub: pushes changes to every signed-in device, carries
// desktop-agent status and computer-action requests/results.
import { WebSocketServer } from "ws";
import { readToken, resolveSession } from "./security/auth.js";

const sockets = new Map();          // deviceId -> Set<ws>
const agentStatus = new Map();      // deviceId -> { status, at, deviceName }
const waiters = new Map();          // request id -> { resolve, timer }
let wss = null;

export function attachRealtime(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url.startsWith("/ws")) return socket.destroy();
    // Cookie (browsers / desktop renderer) or bearer token passed as a subprotocol "bearer.<token>".
    let { token, via } = readToken(req);
    const proto = String(req.headers["sec-websocket-protocol"] || "").split(",").map((s) => s.trim()).find((p) => p.startsWith("bearer."));
    if (proto) { token = proto.slice(7); via = "bearer"; }
    if (via === "cookie") {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); return socket.destroy(); }
    }
    const auth = token ? resolveSession(token, { ip: req.socket.remoteAddress }) : null;
    if (!auth) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, auth, proto));
  });
  // Heartbeat: drop dead connections.
  const iv = setInterval(() => {
    for (const set of sockets.values()) for (const ws of set) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false; try { ws.ping(); } catch {}
    }
  }, 30_000);
  iv.unref();
  return wss;
}

function onConnection(ws, auth, proto) {
  ws.isAlive = true;
  ws.auth = auth;
  if (!sockets.has(auth.deviceId)) sockets.set(auth.deviceId, new Set());
  sockets.get(auth.deviceId).add(ws);
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch { return; }
    if (msg.type === "ping") return send(ws, { type: "pong", at: Date.now() });
    if (msg.type === "agent.status" && auth.kind === "desktop") {
      agentStatus.set(auth.deviceId, { status: sanitizeStatus(msg.status), at: new Date().toISOString(), deviceName: auth.deviceName });
      broadcast({ type: "changed", entities: ["health"] });
    }
    if (msg.type === "computer.result" && waiters.has(msg.id)) {
      const w = waiters.get(msg.id); waiters.delete(msg.id); clearTimeout(w.timer);
      w.resolve({ ok: !!msg.ok, result: msg.result, error: msg.error, deviceId: auth.deviceId });
    }
  });
  ws.on("close", () => {
    sockets.get(auth.deviceId)?.delete(ws);
    if (!sockets.get(auth.deviceId)?.size) {
      sockets.delete(auth.deviceId);
      if (agentStatus.has(auth.deviceId)) { agentStatus.get(auth.deviceId).offlineAt = new Date().toISOString(); broadcast({ type: "changed", entities: ["health"] }); }
    }
  });
  send(ws, { type: "hello", deviceId: auth.deviceId, deviceName: auth.deviceName });
}

function sanitizeStatus(s = {}) {
  const pick = (v, n = 80) => (typeof v === "string" ? v.slice(0, n) : typeof v === "number" || typeof v === "boolean" ? v : undefined);
  const out = {};
  for (const k of ["wakeWord", "mic", "micDevice", "muted", "listening", "threshold", "lastWake", "lastScore", "error", "version", "computer"]) {
    if (s[k] !== undefined) out[k] = pick(s[k], 200);
  }
  return out;
}

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

/** Send to every connected device (optionally except one). */
export function broadcast(msg, { except } = {}) {
  for (const [id, set] of sockets) if (id !== except) for (const ws of set) send(ws, msg);
}
export function sendToDevice(deviceId, msg) {
  const set = sockets.get(deviceId);
  if (!set?.size) return false;
  for (const ws of set) send(ws, msg);
  return true;
}
/** Tell all clients which data sets changed so they refetch. */
export function changed(...entities) { broadcast({ type: "changed", entities }); }

export function connectedDevices() { return [...sockets.keys()]; }
export function desktopAgents() {
  return [...agentStatus.entries()].map(([deviceId, v]) => ({ deviceId, ...v, online: sockets.has(deviceId) }));
}
export function onlineDesktop() {
  return desktopAgents().find((a) => a.online) || null;
}

/** Send a request to a desktop agent and wait for its reply. */
export function requestDesktop(deviceId, payload, timeoutMs = 20_000) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    if (!sendToDevice(deviceId, { type: "computer.request", id, ...payload })) return resolve({ ok: false, error: "Your laptop is not connected right now." });
    const timer = setTimeout(() => { waiters.delete(id); resolve({ ok: false, error: "The laptop did not answer in time." }); }, timeoutMs);
    waiters.set(id, { resolve, timer });
  });
}

export function closeRealtime() { wss?.close(); }
