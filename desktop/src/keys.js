const first = new URLSearchParams(location.search).get("firstRun") === "1";
const $ = (s) => document.querySelector(s);
(async () => {
  const v = await window.keys.get();
  $("#model").innerHTML = Object.entries(v.models).map(([k, l]) => `<option value="${k}" ${k === v.model ? "selected" : ""}>${l}</option>`).join("");
  for (const [k, set] of Object.entries(v.set)) { const el = document.getElementById(`s_${k}`); if (el && set) el.textContent = "✓ saved"; const inp = document.querySelector(`[name="${k}"]`); if (inp && set) inp.placeholder = "Saved — leave blank to keep"; }
  $("#enc").textContent = v.encrypted ? "Keys are encrypted with your Windows account (DPAPI) and never leave this laptop except to call each service." : "Keys are stored in your JARVIS profile folder (system encryption unavailable on this machine).";
  if (!first) { $("#lead").textContent = "Update keys or the AI model. Blank fields keep their saved value."; $("#later").textContent = "Close"; $("#save").textContent = "Save"; }
})();
document.querySelectorAll("[data-url]").forEach((a) => a.addEventListener("click", () => window.keys.open(a.dataset.url)));
$("#later").addEventListener("click", () => window.keys.close());
$("#f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  const v = await window.keys.get();
  if (first && !data.ANTHROPIC_API_KEY && !v.set.ANTHROPIC_API_KEY) { $("#err").textContent = "Paste your Anthropic API key — JARVIS can't think without it. (Or choose Skip for now.)"; return; }
  if (data.ANTHROPIC_API_KEY && !/^sk-ant-/.test(data.ANTHROPIC_API_KEY.trim())) { $("#err").textContent = "That doesn't look like an Anthropic key (they start with sk-ant-)."; return; }
  $("#save").disabled = true; $("#save").textContent = "Saving…";
  await window.keys.save(data);
  window.keys.close();
});
