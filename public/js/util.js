export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const gbp = (p, { sign = false } = {}) => {
  if (p == null) return "—";
  const neg = p < 0, v = Math.abs(Math.round(p));
  return `${neg ? "−" : sign && p > 0 ? "+" : ""}£${Math.floor(v / 100).toLocaleString("en-GB")}.${String(v % 100).padStart(2, "0")}`;
};
export const fmtTime = (iso, opts = {}) => new Date(iso).toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", ...opts });
export const fmtDay = (iso) => new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
export const fmtWhen = (iso) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const parseDb = (s) => (s ? new Date(String(s).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z")) : null);
export function ago(s) {
  const d = parseDb(s); if (!d) return "never";
  const m = Math.round((Date.now() - d) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
export function toast(msg, ms = 2800) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), ms);
}
/** In-page confirmation dialog. Resolves true/false. */
export function confirmDialog(title, body, { ok = "Confirm", danger = false } = {}) {
  const d = $("#modal");
  d.innerHTML = `<h3>${esc(title)}</h3><p class="muted">${esc(body)}</p><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn ghost" value="no">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" value="yes">${esc(ok)}</button></div>`;
  return new Promise((resolve) => {
    d.querySelectorAll("button").forEach((b) => b.onclick = () => { d.close(); resolve(b.value === "yes"); });
    d.onclose = () => resolve(false);
    d.showModal();
  });
}
export function formDialog(title, fields, { ok = "Save" } = {}) {
  const d = $("#modal");
  d.innerHTML = `<form method="dialog" class="stack"><h3>${esc(title)}</h3>${fields.map((f) => f.type === "checkbox"
    ? `<label class="set-row" style="padding:4px 0"><span>${esc(f.label)}</span><span class="switch"><input type="checkbox" name="${f.name}" ${f.value ? "checked" : ""}><span></span></span></label>`
    : f.type === "days" ? `<div class="field"><span>${esc(f.label)}</span><div class="seg" data-days="${f.name}">${["S", "M", "T", "W", "T", "F", "S"].map((l, i) => `<button type="button" data-d="${i}" class="${(f.value || []).includes(i) ? "active" : ""}" aria-label="${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][i]}">${l}</button>`).join("")}</div><input type="hidden" name="${f.name}" value="${esc((f.value || []).join(","))}"></div>`
    : `<label class="field"><span>${esc(f.label)}</span>${
    f.type === "select" ? `<select class="inp" name="${f.name}">${f.options.map((o) => `<option value="${esc(o[0])}" ${String(o[0]) === String(f.value) ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`
    : f.type === "textarea" ? `<textarea class="inp" name="${f.name}" placeholder="${esc(f.placeholder || "")}">${esc(f.value || "")}</textarea>`
    : `<input class="inp" name="${f.name}" type="${f.type || "text"}" value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder || "")}" ${f.required ? "required" : ""} ${f.step ? `step="${f.step}"` : ""} ${f.min != null ? `min="${f.min}"` : ""} ${f.max != null ? `max="${f.max}"` : ""} ${f.accept ? `accept="${esc(f.accept)}"` : ""}>`}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ""}</label>`).join("")}
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">${esc(ok)}</button></div></form>`;
  d.querySelectorAll("[data-days]").forEach((seg) => seg.querySelectorAll("button").forEach((b) => b.onclick = () => {
    b.classList.toggle("active");
    seg.nextElementSibling.value = [...seg.querySelectorAll("button.active")].map((x) => x.dataset.d).join(",");
  }));
  return new Promise((resolve) => {
    const form = d.querySelector("form");
    form.onsubmit = (e) => {
      const v = e.submitter?.value;
      if (v !== "ok") { resolve(null); return; }
      const out = Object.fromEntries(new FormData(form));
      for (const f of fields) if (f.type === "checkbox") out[f.name] = !!form.elements[f.name].checked;
      for (const f of fields) if (f.type === "days") out[f.name] = out[f.name] ? out[f.name].split(",").map(Number) : [];
      resolve(out);
    };
    d.onclose = () => resolve(null);
    d.showModal();
  });
}
const WX = { 0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️", 45: "🌫️", 48: "🌫️", 51: "🌦️", 53: "🌦️", 55: "🌧️", 61: "🌧️", 63: "🌧️", 65: "🌧️", 66: "🌧️", 67: "🌧️", 71: "🌨️", 73: "🌨️", 75: "❄️", 77: "❄️", 80: "🌦️", 81: "🌧️", 82: "⛈️", 85: "🌨️", 86: "❄️", 95: "⛈️", 96: "⛈️", 99: "⛈️" };
export const wxIcon = (code, day = true) => (code === 0 && !day ? "🌙" : WX[code] || "🌡️");

export { ICONS, icon } from "./icons.js";

/** Tiny SVG bar chart. data: [{label, value}] */
export function barChart(data, { height = 140, fmt = (v) => v } = {}) {
  if (!data.length) return '<p class="empty">No data yet.</p>';
  const max = Math.max(...data.map((d) => d.value), 1);
  const w = 100 / data.length;
  return `<svg class="chart" viewBox="0 0 100 ${height / 3}" preserveAspectRatio="none" style="height:${height}px" role="img" aria-label="Chart">
    ${data.map((d, i) => { const bh = (d.value / max) * (height / 3 - 6); return `<rect x="${i * w + w * 0.18}" y="${height / 3 - bh}" width="${w * 0.64}" height="${bh}" rx="0.8" fill="url(#gv)"><title>${esc(d.label)}: ${esc(fmt(d.value))}</title></rect>`; }).join("")}
    <defs><linearGradient id="gv" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#67e8f9"/><stop offset="1" stop-color="#2f7fe0" stop-opacity=".45"/></linearGradient></defs></svg>
    <div class="row" style="justify-content:space-between;font-size:11px;color:var(--muted)">${data.map((d) => `<span>${esc(d.label)}</span>`).join("")}</div>`;
}

// ---------------------------------------------------------------- More helpers
export const pounds = (p) => (p == null ? "" : (p / 100).toFixed(2));
export const toPence = (v) => Math.round(Number(String(v).replace(/[£,\s]/g, "")) * 100);
export function fmtRel(iso) {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return "";
  const s = Math.round((d - Date.now()) / 1000), a = Math.abs(s);
  const t = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h` : `${Math.round(a / 86400)} d`;
  return s >= 0 ? `in ${t}` : `${t} ago`;
}
export const localDateStr = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
/** Inline SVG sparkline for a series of numbers. */
export function sparkline(values, { height = 36, stroke = "#22d3ee" } = {}) {
  if (!values?.length) return "";
  const max = Math.max(...values, 1), min = Math.min(...values, 0), n = values.length;
  const pts = values.map((v, i) => `${(i / Math.max(1, n - 1)) * 100},${height - 3 - ((v - min) / (max - min || 1)) * (height - 6)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 100 ${height}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}
export const statusDot = (s) => `<span class="dot ${({ ok: "ok", warn: "warn", error: "bad", bad: "bad", off: "off", unknown: "unknown", live: "live" })[s] || "unknown"}"></span>`;
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** The UTC ISO string for a wall-clock date + time in a time zone (DST-safe). */
export function zonedToISO(dateStr, hm = "00:00", tz) {
  const [y, m, d] = dateStr.split("-").map(Number), [h, mi] = hm.split(":").map(Number);
  const target = Date.UTC(y, m - 1, d, h, mi);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    const seen = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
    if (seen === target) break;
    guess += target - seen;
  }
  return new Date(guess).toISOString();
}
/** Local date (YYYY-MM-DD) and time (HH:MM) of an instant in a time zone. */
export function zonedParts(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${String(+p.hour % 24).padStart(2, "0")}:${p.minute}` };
}
export const addDaysStr = (dateStr, n) => { const [y, m, d] = dateStr.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
