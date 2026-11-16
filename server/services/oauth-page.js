// The page shown at the end of a Monzo/Google sign-in. On the laptop, sign-in happens in your normal browser
// (which isn't logged in to JARVIS), so instead of the JARVIS login screen it shows a clear "all done" page.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function oauthResultPage(res, { ok, title, lines = [] }) {
  res.status(ok ? 200 : 400).type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JARVIS — ${esc(title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#030712;color:#e6f7ff;font:16px/1.6 system-ui,Segoe UI,sans-serif}
main{max-width:520px;margin:24px;padding:32px;border:1px solid rgba(56,189,248,.35);border-radius:18px;background:linear-gradient(160deg,rgba(14,30,56,.9),rgba(4,10,24,.95));box-shadow:0 0 60px rgba(34,211,238,.12)}
h1{margin:0 0 8px;font-size:22px;color:${ok ? "#67e8f9" : "#fca5a5"}}p{margin:10px 0;color:#bfd7ea}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:${ok ? "#22d3ee" : "#f87171"};box-shadow:0 0 12px currentColor;margin-right:8px}
small{color:#7c93a8}</style></head><body><main><h1><span class="dot"></span>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}<p><small>You can close this tab and go back to JARVIS.</small></p></main></body></html>`);
}
