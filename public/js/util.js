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
  d.innerHTML = `<form method="dialog" class="stack"><h3>${esc(title)}</h3>${fields.map((f) => `<label class="field"><span>${esc(f.label)}</span>${
    f.type === "select" ? `<select class="inp" name="${f.name}">${f.options.map((o) => `<option value="${esc(o[0])}" ${o[0] === f.value ? "selected" : ""}>${esc(o[1])}</option>`).join("")}</select>`
    : f.type === "textarea" ? `<textarea class="inp" name="${f.name}" placeholder="${esc(f.placeholder || "")}">${esc(f.value || "")}</textarea>`
    : `<input class="inp" name="${f.name}" type="${f.type || "text"}" value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder || "")}" ${f.required ? "required" : ""} ${f.step ? `step="${f.step}"` : ""}>`}</label>`).join("")}
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">${esc(ok)}</button></div></form>`;
  return new Promise((resolve) => {
    const form = d.querySelector("form");
    form.onsubmit = (e) => {
      const v = e.submitter?.value;
      if (v !== "ok") { resolve(null); return; }
      resolve(Object.fromEntries(new FormData(form)));
    };
    d.onclose = () => resolve(null);
    d.showModal();
  });
}
const WX = { 0: "☀️", 1: "🌤️", 2: "⛅", 3: "☁️", 45: "🌫️", 48: "🌫️", 51: "🌦️", 53: "🌦️", 55: "🌧️", 61: "🌧️", 63: "🌧️", 65: "🌧️", 66: "🌧️", 67: "🌧️", 71: "🌨️", 73: "🌨️", 75: "❄️", 77: "❄️", 80: "🌦️", 81: "🌧️", 82: "⛈️", 85: "🌨️", 86: "❄️", 95: "⛈️", 96: "⛈️", 99: "⛈️" };
export const wxIcon = (code, day = true) => (code === 0 && !day ? "🌙" : WX[code] || "🌡️");

export const ICONS = {
  home: '<circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".5"/>',
  talk: '<path d="M4 5h16v10H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  agenda: '<rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M4 10h16M9 3v4M15 3v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  money: '<rect x="3" y="6" width="18" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 10h18M7 15h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  projects: '<path d="M4 7h6l2 2h8v10H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
  intel: '<circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  memory: '<path d="M12 4a5 5 0 0 0-5 5c0 2 1 3 1 5v2h8v-2c0-2 1-3 1-5a5 5 0 0 0-5-5zM10 20h4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>',
  settings: '<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  more: '<circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  send: '<path d="M4 12h13M12 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
};
export const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ""}</svg>`;

/** Tiny SVG bar chart. data: [{label, value}] */
export function barChart(data, { height = 140, fmt = (v) => v } = {}) {
  if (!data.length) return '<p class="empty">No data yet.</p>';
  const max = Math.max(...data.map((d) => d.value), 1);
  const w = 100 / data.length;
  return `<svg class="chart" viewBox="0 0 100 ${height / 3}" preserveAspectRatio="none" style="height:${height}px" role="img" aria-label="Chart">
    ${data.map((d, i) => { const bh = (d.value / max) * (height / 3 - 6); return `<rect x="${i * w + w * 0.18}" y="${height / 3 - bh}" width="${w * 0.64}" height="${bh}" rx="0.8" fill="url(#gv)"><title>${esc(d.label)}: ${esc(fmt(d.value))}</title></rect>`; }).join("")}
    <defs><linearGradient id="gv" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#c4b5fd"/><stop offset="1" stop-color="#7c3aed" stop-opacity=".5"/></linearGradient></defs></svg>
    <div class="row" style="justify-content:space-between;font-size:11px;color:var(--muted)">${data.map((d) => `<span>${esc(d.label)}</span>`).join("")}</div>`;
}
