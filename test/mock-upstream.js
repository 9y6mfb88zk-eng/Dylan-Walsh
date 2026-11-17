// Stand-ins for every external service, used only by the automated tests:
// Anthropic, Open-Meteo, ElevenLabs, OpenAI (Whisper/embeddings), Monzo, Google Calendar and a push service.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-cert-"));
  const key = path.join(dir, "key.pem"), cert = path.join(dir, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert), certPath: cert };
}

export function speechLikeWav(seconds = 1.6, rate = 22050) {
  const n = Math.floor(seconds * rate), buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate, env = Math.max(0, Math.sin(t * Math.PI * 5)) ** 1.5;
    buf.writeInt16LE(Math.round(env * (0.5 * Math.sin(2 * Math.PI * 140 * t) + 0.3 * Math.sin(2 * Math.PI * 420 * t)) * 20000), 44 + i * 2);
  }
  return buf;
}

/** Month start (Europe/London) helper so fake transactions always fall in the current month. */
function monthStartLondon() {
  const now = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit" }).formatToParts(now).map((x) => [x.type, x.value]));
  const guess = Date.UTC(+p.year, +p.month - 1, 1);
  return new Date(guess - (new Date(guess).toLocaleString("en-GB", { timeZone: "Europe/London", hour: "2-digit", hour12: false }) === "01" ? 3600_000 : 0));
}

/** Stream a message the way the Anthropic API does (Server-Sent Events). */
function writeSSE(res, m) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { ...m, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  m.content.forEach((b, i) => {
    if (b.type === "text") {
      ev("content_block_start", { index: i, content_block: { type: "text", text: "" } });
      for (const chunk of b.text.match(/\S+\s*/g) || []) ev("content_block_delta", { index: i, delta: { type: "text_delta", text: chunk } });
      for (const c of b.citations || []) ev("content_block_delta", { index: i, delta: { type: "citations_delta", citation: c } });
    } else if (b.type === "tool_use") {
      ev("content_block_start", { index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      ev("content_block_delta", { index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev("content_block_stop", { index: i });
  });
  ev("message_delta", { delta: { stop_reason: m.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  ev("message_stop", {});
  res.end();
}

export function startMock() {
  const log = { anthropic: [], tts: [], stt: 0, push: [], meteo: 0, monzo: [], google: [] };
  const state = { monzoApproved: false, monzoTokenVersion: 0, googleEvents: [], adsbRemaining: 500, adsbDown: false, openskyDown: false, openskyCount: 3000, gdelt429: false, gdeltCalls: 0 };
  log.adsb = []; log.opensky = []; log.gdelt = []; log.tiles = 0;
  let ideaN = 0, toolCounter = 0;

  const msg = (content, stop_reason = "end_turn") => ({
    id: `msg_${Math.random().toString(36).slice(2)}`, type: "message", role: "assistant", model: "claude-opus-5-5",
    content, stop_reason, stop_sequence: null, stop_details: null, usage: { input_tokens: 10, output_tokens: 10 },
  });
  const toolUse = (name, input) => msg([{ type: "tool_use", id: `toolu_${++toolCounter}`, name, input }], "tool_use");
  const text = (t, citations) => msg([{ type: "text", text: t, ...(citations ? { citations } : {}) }]);

  // Decide what "Claude" does, from the conversation so far.
  function anthropicReply(body) {
    if (body.output_config?.format) {
      ideaN++;
      return text(JSON.stringify({ title: `Idea ${ideaN}: ${["Villa cleaning scheduler", "Ship crew visa assistant", "Greek menu translator"][ideaN % 3]}`,
        pitch: "A clear problem. Someone pays.", why_now: "Timing is right.", budget: "under £300", mvp: ["Step one", "Step two", "Step three"], first_move: `Call five prospects for idea ${ideaN}` }));
    }
    const last = body.messages.at(-1);
    const firstUser = typeof body.messages.findLast((m) => m.role === "user" && typeof m.content === "string")?.content === "string"
      ? body.messages.findLast((m) => m.role === "user" && typeof m.content === "string").content : "";
    if (Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
      const results = last.content.map((r) => r.content).join(" ");
      if (/diagnostic/i.test(firstUser)) { try { return text(JSON.parse(last.content[0].content).narration.join(" ")); } catch { return text(`Diagnostics failed: ${results}`); } }
      if (/boxing/i.test(firstUser)) return text(/needsConfirmation/.test(results) ? "Would you like me to remember that for future conversations, Sir?" : /"ok":true/.test(results) ? "Noted for the future, Sir." : `I couldn't: ${results}`);
      if (/remind/i.test(firstUser)) return text("Very good, sir. I'll remind you to call your mum at six.");
      if (/weather/i.test(firstUser)) return text(`Tomorrow: ${results.match(/Tomorrow ([^.]+)/)?.[1] || "unknown"}.`);
      if (/i just spent/i.test(firstUser)) return text(/"ok":true/.test(results) ? "Noted, Sir: twelve pounds fifty on food." : `I couldn't record that: ${results}`);
      if (/money|spent/i.test(firstUser)) return text(`Finance facts: ${results}`);
      if (/open chrome/i.test(firstUser)) return text(/"ok":true/.test(results) ? "Chrome is open, sir." : `I couldn't: ${results}`);
      if (/gym/i.test(firstUser)) return text(/needsConfirmation/.test(results) ? "That clashes. Shall I go ahead?" : "Booked, sir.");
      if (/business/i.test(firstUser)) return text("I've set up the project, sir.");
      if (/alarm/i.test(firstUser)) { const next = results.match(/"next":"([^"]+)"/)?.[1]; return text(next ? `Alarm set, Sir — ${next}.` : `I couldn't set that: ${results}`); }
      if (/aircraft around/i.test(firstUser)) { try { const r = JSON.parse(last.content[0].content); return text(r.ok ? `${r.aircraftVisible} aircraft visible around ${r.area}, Sir, from ${r.source}.` : `Flight data isn't available: ${r.error}`); } catch { return text(`Couldn't read: ${results}`); } }
      if (/flight zzz999/i.test(firstUser)) { const r = JSON.parse(last.content[0].content); return text(r.ok ? "Found it." : `ZZZ999 isn't visible in the available data, Sir.`); }
      if (/time is it in/i.test(firstUser)) return text(`In Tokyo it's ${results.match(/"localTime":"([^"]+)"[^}]*"timezone":"Asia\/Tokyo"|Tokyo[^}]*"localTime":"([^"]+)"/)?.slice(1).find(Boolean) || "unknown"}.`);
      return text("Very good, sir. Consider it done.");
    }
    const t = typeof last.content === "string" ? last.content : "";
    if (/business idea/i.test(t)) { const m = JSON.stringify(body.system || "").match(/#(\d+) [^#]*website design agency[^\\|]*/i); return text(m ? `That would be the website design agency for small businesses, Sir (memory #${m[1]}).` : "I don't have a business idea on file, Sir."); }
    if (body.tools) {
      if (/aircraft around cyprus/i.test(t)) return toolUse("global_operations", { action: "flights_area", place: "Cyprus", radius_nm: 120 });
      if (/find flight zzz999/i.test(t)) return toolUse("global_operations", { action: "flights_find", query: "ZZZ999" });
      if (/yes, remember that i've started boxing/i.test(t)) return toolUse("remember", { fact: "Has started boxing training", category: "hobby", user_confirmed: true });
      if (/i've started boxing/i.test(t)) return toolUse("remember", { fact: "Has started boxing training", category: "hobby", user_confirmed: false });
      if (/run a full diagnostic/i.test(t)) return toolUse("run_diagnostics", { level: "full" });
      if (/remind me to call my mum at six/i.test(t)) {
        const six = new Date(Date.now() + 3 * 3600_000); six.setUTCMinutes(0, 0, 0);
        return toolUse("add_reminder", { text: "Call your mum", due_at: six.toISOString() });
      }
      if (/remind me in two seconds/i.test(t)) return toolUse("add_reminder", { text: "stretch your legs", due_at: new Date(Date.now() + 2000).toISOString() });
      if (/weather tomorrow/i.test(t)) return toolUse("get_weather", {});
      if (/how much money have i got/i.test(t)) return toolUse("finance", { question: "position" });
      if (/how much have i spent/i.test(t)) return toolUse("finance", { question: "spending" });
      if (/add .*task/i.test(t)) return toolUse("add_task", { title: "Buy milk" });
      if (/set an alarm for seven/i.test(t)) return toolUse("set_alarm", { time: "07:00", label: "Wake up", repeat: "weekdays" });
      if (/i just spent £12\.50 on food/i.test(t)) return toolUse("record_money", { amount_pounds: 12.5, description: "Lunch", category: "food" });
      if (/what time is it in tokyo/i.test(t)) return toolUse("world_time", { places: ["Tokyo"] });
      if (/tell me a long story/i.test(t)) return text("Once upon a time, Sir, there was a laptop. It woke at seven. It made the tea. The end.");
      if (/open chrome/i.test(t)) return toolUse("computer", { action: "open_app", app: "chrome" });
      if (/schedule a gym/i.test(t)) { const s0 = new Date(Date.now() + 86400_000); s0.setUTCMinutes(0, 0, 0); return toolUse("calendar_create", { title: "Gym", start: s0.toISOString() }); }
      if (/start a business/i.test(t)) return toolUse("create_project", { title: "Website business", goal: "Launch a web design business", milestones: [{ title: "Validate", tasks: [{ title: "Interview 5 local businesses", priority: 1 }] }, { title: "Launch", tasks: [{ title: "Build portfolio site" }] }] });
      if (/research/i.test(t)) return text("According to the source, X is true.", [{ type: "web_search_result_location", url: "https://example.org/a", title: "Example A", cited_text: "X is true" }]);
    }
    if (/briefing/i.test(t)) return text("Good morning, sir. Here is your briefing from real data.");
    return text("At your service, sir.");
  }

  const handler = (req, res) => inner(req, res).catch((e) => { console.error("[mock]", e); res.writeHead(500); res.end(String(e)); });
  const inner = async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, "http://x");
    const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    const p = url.pathname;

    if (p === "/anthropic-401/v1/messages") return json(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    if (p === "/v1/messages") {
      const body = JSON.parse(raw.toString()); log.anthropic.push(body);
      const reply = anthropicReply(body);
      return body.stream ? writeSSE(res, reply) : json(200, reply);
    }
    if (p.startsWith("/v1/models/") && state.anthropicDown) return json(500, { type: "error", error: { type: "api_error", message: "Internal server error" } });
    if (p.startsWith("/v1/models/")) return json(200, { type: "model", id: decodeURIComponent(p.slice(11)), display_name: "Mock model", created_at: "2026-01-01T00:00:00Z" });

    if (p === "/v1/forecast") {
      log.meteo++;
      const hours = Array.from({ length: 168 }, (_, i) => new Date(Date.now() + i * 3600_000).toISOString().slice(0, 13) + ":00");
      const days = Array.from({ length: 7 }, (_, i) => new Date(Date.now() + i * 86400_000).toISOString().slice(0, 10));
      return json(200, {
        timezone: "Asia/Nicosia",
        current: { time: hours[0], temperature_2m: 21.4, apparent_temperature: 20.9, relative_humidity_2m: 60, weather_code: 1, wind_speed_10m: 12, wind_gusts_10m: 20, is_day: 1, precipitation: 0 },
        hourly: { time: hours, temperature_2m: hours.map((_, i) => 15 + (i % 10)), weather_code: hours.map(() => 1), precipitation_probability: hours.map(() => 5), wind_speed_10m: hours.map(() => 10) },
        daily: { time: days, weather_code: [1, 0, 61, 3, 2, 1, 0], temperature_2m_max: [23, 24, 20, 19, 22, 23, 25], temperature_2m_min: [14, 15, 13, 12, 14, 15, 16],
          precipitation_probability_max: [5, 0, 70, 20, 10, 5, 0], precipitation_sum: [0, 0, 4, 0.2, 0, 0, 0], wind_speed_10m_max: [15, 12, 30, 18, 14, 12, 10], uv_index_max: [4, 5, 2, 3, 4, 5, 6],
          sunrise: days.map((d) => d + "T06:20"), sunset: days.map((d) => d + "T16:45") },
      });
    }
    if (p === "/v1/search") {
      if (/tokyo/i.test(url.searchParams.get("name") || "")) return json(200, { results: [{ name: "Tokyo", admin1: "Tokyo", country: "Japan", latitude: 35.69, longitude: 139.69, timezone: "Asia/Tokyo" }] });
      return json(200, { results: [{ name: "Larnaca", admin1: "Larnaca", country: "Cyprus", latitude: 34.92, longitude: 33.63, timezone: "Asia/Nicosia" }] });
    }

    if (p.startsWith("/v1/text-to-speech/")) { log.tts.push(JSON.parse(raw.toString())); res.writeHead(200, { "content-type": "audio/mpeg" }); return res.end(speechLikeWav()); }
    if (p === "/v1/audio/transcriptions") { log.stt++; return json(200, { text: "What's the weather like?" }); }
    if (p === "/v1/embeddings") { const input = JSON.parse(raw.toString()).input; const v = Array.from({ length: 8 }, (_, i) => (input.charCodeAt(i % input.length) % 7) / 7); return json(200, { data: [{ embedding: v }] }); }

    // ---- Monzo
    if (p.startsWith("/monzo")) {
      const mp = p.slice(6);
      log.monzo.push(mp);
      if (mp === "/oauth2/token") {
        const f = new URLSearchParams(raw.toString());
        if (f.get("client_secret") !== "monzo-secret") return json(401, { code: "unauthorized.bad_client", message: "bad client" });
        state.monzoTokenVersion++;
        return json(200, { access_token: `monzo-access-${state.monzoTokenVersion}`, refresh_token: `monzo-refresh-${state.monzoTokenVersion}`, expires_in: f.get("grant_type") === "refresh_token" ? 21600 : 21600, user_id: "user_1", token_type: "Bearer", client_id: "monzo-client" });
      }
      if (mp === "/oauth2/logout") return json(200, {});
      const auth = req.headers.authorization || "";
      if (!auth.startsWith("Bearer monzo-access-")) return json(401, { code: "unauthorized.bad_access_token" });
      if (!state.monzoApproved) return json(403, { code: "forbidden.insufficient_permissions", message: "Approve in app" });
      if (mp === "/ping/whoami") return json(200, { authenticated: true, user_id: "user_1" });
      if (mp === "/accounts") return json(200, { accounts: [{ id: "acc_current", type: "uk_retail", description: "user_1", closed: false, currency: "GBP" }, { id: "acc_flex", type: "uk_monzo_flex", description: "flex", closed: false }] });
      if (mp === "/balance") {
        const id = url.searchParams.get("account_id");
        return json(200, id === "acc_flex" ? { balance: -12000, total_balance: -12000, currency: "GBP" } : { balance: 123456, total_balance: 223456, currency: "GBP", spend_today: -450 });
      }
      if (mp === "/pots") return json(200, { pots: [{ id: "pot_1", name: "Holiday", balance: 100000, currency: "GBP", deleted: false }] });
      if (mp === "/transactions") {
        const acc = url.searchParams.get("account_id");
        if (acc !== "acc_current") return json(200, { transactions: [] });
        const ms = monthStartLondon().getTime();
        const at = (min) => new Date(Math.min(ms + min * 60_000, Date.now() - 60_000)).toISOString();
        return json(200, { transactions: [
          { id: "tx_salary", created: at(1), amount: 200000, currency: "GBP", description: "EMPLOYER LTD", category: "income", settled: true, merchant: null },
          { id: "tx_tesco", created: at(2), amount: -4520, currency: "GBP", description: "TESCO STORES", category: "groceries", settled: true, merchant: { name: "Tesco" } },
          { id: "tx_shell", created: at(3), amount: -6000, currency: "GBP", description: "SHELL", category: "transport", settled: true, merchant: { name: "Shell" } },
          { id: "tx_pot", created: at(4), amount: -20000, currency: "GBP", description: "pot_1", category: "savings", settled: true, metadata: { pot_id: "pot_1" }, scheme: "uk_retail_pot" },
          { id: "tx_declined", created: at(5), amount: -99999, currency: "GBP", description: "BIG TV", category: "shopping", decline_reason: "INSUFFICIENT_FUNDS", merchant: { name: "Currys" } },
          { id: "tx_netflix", created: at(6), amount: -1099, currency: "GBP", description: "NETFLIX.COM", category: "entertainment", settled: true, merchant: { name: "Netflix" } },
        ] });
      }
      return json(404, { code: "not_found" });
    }

    // ---- Google
    if (p.startsWith("/google")) {
      const gp = p.slice(7);
      log.google.push(`${req.method} ${gp}`);
      if (gp === "/token") return json(200, { access_token: "g-access", refresh_token: "g-refresh", expires_in: 3600, scope: "https://www.googleapis.com/auth/calendar.events", token_type: "Bearer" });
      if (req.headers.authorization !== "Bearer g-access") return json(401, { error: { message: "bad token" } });
      if (gp === "/calendar/v3/calendars/primary/events" && req.method === "GET") return json(200, { items: state.googleEvents });
      if (gp === "/calendar/v3/calendars/primary/events" && req.method === "POST") {
        const b = JSON.parse(raw.toString()); const ev = { id: `g${state.googleEvents.length + 1}`, status: "confirmed", ...b };
        state.googleEvents.push(ev); return json(200, ev);
      }
      const m = gp.match(/^\/calendar\/v3\/calendars\/primary\/events\/(.+)$/);
      if (m && req.method === "PATCH") { const ev = state.googleEvents.find((e) => e.id === m[1]); Object.assign(ev, JSON.parse(raw.toString())); return json(200, ev); }
      if (m && req.method === "DELETE") { state.googleEvents = state.googleEvents.filter((e) => e.id !== m[1]); res.writeHead(204); return res.end(); }
      return json(404, { error: { message: "nope" } });
    }

    // ---- Global Operations stand-ins (flights, events, tiles). Deterministic, clearly synthetic test traffic.
    if (p.startsWith("/adsb/")) {
      log.adsb.push(p);
      if (state.adsbDown) return json(503, { msg: "down" });
      if (state.adsbRemaining <= 0) { res.writeHead(429, { "content-type": "application/json", "retry-after": "60", "x-ratelimit-limit": "500", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "60" }); return res.end("{}"); }
      state.adsbRemaining--;
      const hdr = { "content-type": "application/json", "x-ratelimit-limit": "500, 500;w=86400", "x-ratelimit-remaining": String(state.adsbRemaining), "x-ratelimit-reset": "3600" };
      const now = Date.now();
      const ac = (i, lat, lon, extra = {}) => ({ hex: `7a${String(i).padStart(4, "0")}`, type: "adsb_icao", flight: `TST${i}  `, r: `5B-T${String(i).padStart(2, "0")}`, t: i % 2 ? "A320" : "B738", alt_baro: i % 7 === 0 ? "ground" : 2000 + i * 1500, gs: 300 + i, track: (i * 37) % 360, baro_rate: i % 3 ? 0 : -640, lat, lon, seen_pos: i % 11 === 0 ? 90 : 2, seen: 1, category: "A3", ...extra });
      let m;
      if ((m = p.match(/^\/adsb\/v2\/point\/([-\d.]+)\/([-\d.]+)\/(\d+)$/))) {
        const lat = +m[1], lon = +m[2];
        const list = Array.from({ length: 12 }, (_, i) => ac(i + 1, lat + ((i % 4) - 1.5) * 0.3, lon + (Math.floor(i / 4) - 1) * 0.4));
        list.push(ac(90, lat + 0.1, lon + 0.1, { dbFlags: 1, flight: "MIL01   " }));       // military: must be hidden
        list.push({ ...ac(91, lat - 0.1, lon - 0.1), hex: "7a9999", flight: "PRIV1   " });   // on the PIA list: must be hidden
        res.writeHead(200, hdr); return res.end(JSON.stringify({ ac: list, msg: "No error", now, total: list.length }));
      }
      if (p === "/adsb/v2/mil") { res.writeHead(200, hdr); return res.end(JSON.stringify({ ac: [{ hex: "7a0090" }, { hex: "ae1234" }], now })); }
      if (p === "/adsb/v2/pia") { res.writeHead(200, hdr); return res.end(JSON.stringify({ ac: [{ hex: "7a9999" }, { hex: "000001" }], now })); }
      if (p === "/adsb/v2/ladd") { res.writeHead(200, hdr); return res.end(JSON.stringify({ ac: [{ hex: "000002" }], now })); }
      if ((m = p.match(/^\/adsb\/v2\/(hex|callsign|reg)\/(.+)$/))) {
        const q = decodeURIComponent(m[2]).toUpperCase();
        const found = q === "7A0005" || q === "TST5" || q === "5B-T05" ? [ac(5, 34.9, 33.6)] : [];
        res.writeHead(200, hdr); return res.end(JSON.stringify({ ac: found, now }));
      }
      return json(404, {});
    }
    if (p.startsWith("/opensky/")) {
      log.opensky.push(p + url.search);
      if (state.openskyDown) return json(503, {});
      if (p === "/opensky/states/all") {
        const q = Object.fromEntries(url.searchParams);
        const box = q.lamin ? [+q.lamin, +q.lomin, +q.lamax, +q.lomax] : [-90, -180, 90, 180];
        const t = Math.floor(Date.now() / 1000), states = [];
        for (let i = 0; i < state.openskyCount; i++) {
          const lat = -55 + ((i * 7.31) % 125), lon = -175 + ((i * 13.7) % 350);
          if (lat < box[0] || lat > box[2] || lon < box[1] || lon > box[3]) continue;
          const hex = i === 0 ? "ae1234" : `b${String(i).padStart(5, "0")}`;            // i=0 is on the military list
          states.push([hex, `OSK${i}`.padEnd(8), "Testland", t - 3, t - 1, lon, lat, 9000 + (i % 30) * 100, false, 230, (i * 11) % 360, 0, null, 9100, "1000", false, 0, 3]);
        }
        res.writeHead(200, { "content-type": "application/json", "x-rate-limit-remaining": "390" }); return res.end(JSON.stringify({ time: t, states }));
      }
      return json(404, {});
    }
    if (p === "/gdacs") return json(200, { type: "FeatureCollection", features: [
      { type: "Feature", geometry: { type: "Point", coordinates: [101.8, -4.0] }, properties: { eventtype: "FL", eventid: 1, name: "Flood in Indonesia", htmldescription: "Green Flood in Indonesia", alertlevel: "Green", iscurrent: "true", country: "Indonesia", iso3: "IDN", fromdate: "2026-11-10T01:00:00", datemodified: new Date(Date.now() - 3600_000).toISOString().slice(0, 19), polygonlabel: "Centroid", url: { report: "https://www.gdacs.org/report.aspx?eventid=1" } } },
      { type: "Feature", geometry: { type: "Point", coordinates: [86.9, 21.0] }, properties: { eventtype: "TC", eventid: 2, name: "Tropical Cyclone TEST-26", htmldescription: "Red Tropical Cyclone", alertlevel: "Red", iscurrent: "true", country: "India", iso3: "IND", fromdate: "2026-11-15T00:00:00", datemodified: new Date(Date.now() - 7200_000).toISOString().slice(0, 19), polygonlabel: "Centroid", url: { report: "https://www.gdacs.org/report.aspx?eventid=2" } } }] });
    if (p === "/usgs") return json(200, { type: "FeatureCollection", metadata: { count: 1 }, features: [
      { id: "us7000test", geometry: { type: "Point", coordinates: [140.1, 35.9, 10] }, properties: { mag: 5.1, magType: "mb", place: "100 km E of Noda, Japan", time: Date.now() - 5400_000, updated: Date.now() - 5000_000, url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000test", status: "reviewed", tsunami: 0, title: "M 5.1 - 100 km E of Noda, Japan" } }] });
    if (p === "/gdelt") {
      state.gdeltCalls++; log.gdelt.push(url.searchParams.get("query"));
      if (state.gdelt429) { res.writeHead(429, { "content-type": "text/plain" }); return res.end("Please limit requests to one every 5 seconds"); }
      const q = url.searchParams.get("query") || "";
      const d = (h) => new Date(Date.now() - h * 3600_000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      if (/ceasefire/.test(q)) return json(200, { articles: [
        { url: "https://news-a.example/ceasefire-1", title: "Ceasefire agreed in Sudan after talks in Jeddah", seendate: d(5), domain: "news-a.example", language: "English", sourcecountry: "United Kingdom" },
        { url: "https://news-b.example/sudan-truce", title: "Sudan ceasefire agreed after Jeddah talks", seendate: d(3), domain: "news-b.example", language: "English", sourcecountry: "United States" },
        { url: "https://news-c.example/x", title: "Truce holds in disputed region, officials say", seendate: d(2), domain: "news-c.example", language: "English", sourcecountry: "France" }] });
      return json(200, {});
    }
    if (p === "/reliefweb/disasters") {
      if (url.searchParams.get("appname") !== "approved-test-app") return json(403, { status: 403, error: { message: "You are not using an approved appname." } });
      return json(200, { data: [{ id: "51234", fields: { name: "Test Region: Cholera Outbreak - Nov 2026", status: "ongoing", date: { created: new Date(Date.now() - 86400_000).toISOString(), event: new Date(Date.now() - 2 * 86400_000).toISOString() }, primary_country: { iso3: "yem", location: { lat: 15.5, lon: 48.5 } }, country: [{ name: "Yemen", iso3: "yem" }], type: [{ name: "Epidemic" }], url_alias: "https://reliefweb.int/disaster/ep-2026-test" } }] });
    }
    if (p.startsWith("/ucdp/gedevents/")) {
      if (req.headers["x-ucdp-access-token"] !== "ucdp-test-token") { res.writeHead(401); return res.end("API token required"); }
      const v = p.split("/").pop(), now0 = new Date(), d = new Date(Date.UTC(now0.getUTCFullYear(), now0.getUTCMonth() - 1, 1)); const want = `${String(d.getUTCFullYear()).slice(2)}.0.${d.getUTCMonth() + 1}`;   // last month's candidate release
      if (v !== want) return json(404, { error: "no such version" });
      return json(200, { TotalCount: 1, Result: [{ id: 990001, type_of_violence: 1, dyad_name: "Government of Testland - Test Front", conflict_name: "Testland: Government", country: "Sudan", adm_1: "Khartoum state", latitude: 15.5527, longitude: 32.5324, where_prec: 1, date_start: new Date(Date.now() - 20 * 86400_000).toISOString().slice(0, 10), best: 7, source_article: "Test source A; Test source B" }] });
    }
    if (p === "/rainviewer") return json(200, { version: "2.0", host: url.origin === "http://x" ? `http://${req.headers.host}` : url.origin, radar: { past: [{ time: Math.floor(Date.now() / 1000) - 600, path: "/v2/radar/test1" }] } });
    if (p.startsWith("/tile/") || p.startsWith("/v2/radar/")) { log.tiles++; res.writeHead(200, { "content-type": "image/png" }); return res.end(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex")); }

    if (p.startsWith("/push/")) { log.push.push({ path: p, bytes: raw.length }); res.writeHead(201); return res.end(); }
    json(404, { error: "mock: not found " + p });
  };

  const server = http.createServer(handler);
  const tls = selfSigned();
  const pushServer = https.createServer({ key: tls.key, cert: tls.cert }, handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => pushServer.listen(0, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${server.address().port}`;
    resolve({
      server: { close() { server.close(); pushServer.close(); } }, log, state, url,
      pushUrl: `https://127.0.0.1:${pushServer.address().port}`, caPath: tls.certPath,
      env: {
        ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: url,
        ELEVENLABS_API_KEY: "test-eleven", ELEVENLABS_BASE_URL: url,
        OPENAI_API_KEY: "test-openai", OPENAI_BASE_URL: url,
        OPEN_METEO_URL: `${url}/v1/forecast`, GEOCODE_URL: `${url}/v1/search`,
        MONZO_CLIENT_ID: "monzo-client", MONZO_CLIENT_SECRET: "monzo-secret", MONZO_AUTH_URL: `${url}/monzo-auth`, MONZO_API_URL: `${url}/monzo`,
        GOOGLE_CLIENT_ID: "g-client", GOOGLE_CLIENT_SECRET: "g-secret", GOOGLE_AUTH_URL: `${url}/google-auth`, GOOGLE_TOKEN_URL: `${url}/google/token`, GOOGLE_API_URL: `${url}/google`,
        NODE_EXTRA_CA_CERTS: tls.certPath,
        ADSB_LOL_URL: `${url}/adsb`, OPENSKY_URL: `${url}/opensky`, OPENSKY_AUTH_URL: `${url}/opensky-auth`, GDACS_URL: `${url}/gdacs`, USGS_URL: `${url}/usgs`, GDELT_URL: `${url}/gdelt`, GDELT_SPACING_MS: "20",
        RELIEFWEB_URL: `${url}/reliefweb`, UCDP_URL: `${url}/ucdp`, RAINVIEWER_URL: `${url}/rainviewer`, TILES_TEST_URL: `${url}/tile`,
      },
    });
  })));
}
