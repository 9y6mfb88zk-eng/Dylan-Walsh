// Conversation: the shared transcript (laptop + phone), live streaming replies, voice controls and history.
import { api } from "../api.js";
import { voice } from "../voice.js";
import { core, STATE_LABEL } from "../corestate.js";
import { mountCore } from "../core.js";
import { $, esc, icon, fmtWhen, toast, confirmDialog } from "../util.js";

let convId = null, CTX = null;

const msgHtml = (m) => `<div class="msg ${m.role}" data-id="${m.id}">
  <div class="who">${m.role === "user" ? esc(m.device_name || "You") : "JARVIS"} · ${esc(fmtWhen(m.created_at.replace(" ", "T") + (m.created_at.includes("Z") ? "" : "Z")))}</div>${esc(m.content)}
  ${m.sources?.length ? `<div class="sources">${m.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join("")}</div>` : ""}</div>`;

export async function render(root, ctx) {
  CTX = ctx;
  const s = ctx.settings.voice || {};
  root.innerHTML = `<div class="convo">
    <div class="spread wrap">
      <div class="conv-state"><canvas id="miniCore"></canvas><div><b id="cState" class="label" style="color:var(--cyan-3)">${STATE_LABEL[core.state]}</b><div class="faint" style="font-size:12px" id="cMode">${s.continuous === false ? "Single question mode" : `Continuous conversation · ends after ${s.timeoutSec || 8}s of silence or “End conversation”`}</div></div></div>
      <div class="row wrap"><select class="inp" id="convSel" style="max-width:240px" aria-label="Conversation"></select><button class="btn small" id="newC">${icon("plus")}New</button><button class="btn small ghost" id="delC" title="Delete this conversation">${icon("trash")}</button></div>
    </div>
    <div class="messages panel flat" id="msgs"></div>
    <div class="stack" style="gap:8px">
      <div class="composer" style="width:100%">
        <form class="pill-input" id="f" autocomplete="off"><input id="t" placeholder="Message JARVIS…" enterkeyhint="send" aria-label="Message"><button class="icon-btn" aria-label="Send">${icon("send")}</button></form>
        <button class="mic" id="mic" aria-label="Speak">${icon("mic")}</button>
      </div>
      <div class="row wrap" style="justify-content:center;font-size:12px" class="faint">
        <button class="btn tiny ghost" id="stop">${icon("stop")}Stop</button>
        <button class="btn tiny ghost" id="end">End conversation</button>
        <button class="btn tiny ghost" id="repeat">Repeat that</button>
        <span class="faint">Voice commands: “Stop listening” · “End conversation” · “Stay with me” · “Listen again” · “Stop speaking” · “Repeat that”</span>
      </div>
    </div></div>`;
  const mini = mountCore($("#miniCore", root), { animation: ctx.settings.appearance?.animation });
  $("#f", root).addEventListener("submit", (e) => {
    e.preventDefault(); voice.ensureAudio();
    const v = $("#t", root).value.trim(); if (!v) return;
    $("#t", root).value = "";
    ctx.converse(v);
  });
  $("#mic", root).addEventListener("click", () => ctx.listen());
  $("#stop", root).addEventListener("click", () => ctx.conversation.interrupt());
  $("#end", root).addEventListener("click", () => ctx.conversation.endSession());
  $("#repeat", root).addEventListener("click", async () => { const r = ctx.conversation.lastReply; if (!r) return toast("Nothing to repeat yet."); const sp = voice.createSpeaker(); sp.push(r); sp.finish(); });
  $("#newC", root).addEventListener("click", async () => { await api("/api/conversations", { method: "POST" }); await load(); });
  $("#delC", root).addEventListener("click", async () => { if (await confirmDialog("Delete this conversation?", "Its messages are removed from every device. Saved memories stay.", { ok: "Delete", danger: true })) { await api(`/api/conversations/${convId}`, { method: "DELETE" }); await load(); } });
  $("#convSel", root).addEventListener("change", async (e) => { await api(`/api/conversations/${e.target.value}/current`, { method: "POST" }); await load(); });
  const offState = core.on((st) => { const el = $("#cState", root); if (el) el.textContent = STATE_LABEL[st]; $("#mic", root)?.classList.toggle("live", st === "listening"); });
  // Live bubble while JARVIS's reply streams in.
  const offStream = ctx.conversation.onStream((ev) => {
    const box = $("#msgs", root); if (!box) return;
    let live = box.querySelector(".msg.live");
    if (ev.type === "start") { live?.remove(); box.querySelector(".empty")?.remove(); box.insertAdjacentHTML("beforeend", `<div class="msg user live-user"><div class="who">You · now</div>${esc(ev.text)}</div><div class="msg assistant live"><div class="who">JARVIS · thinking…</div><span class="txt"></span></div>`); }
    if (ev.type === "delta" && live) { live.querySelector(".txt").textContent = ev.reply; live.querySelector(".who").textContent = "JARVIS · speaking"; }
    if (ev.type === "done") setTimeout(load, 300);
    box.scrollTop = box.scrollHeight;
  });
  await load();
  return () => { offState(); offStream(); mini.destroy(); };
}

async function load() {
  const { current, list } = await api("/api/conversations");
  convId = current;
  const sel = $("#convSel"); if (!sel) return;
  sel.innerHTML = list.map((c) => `<option value="${c.id}" ${c.id === current ? "selected" : ""}>${esc(c.title)} (${c.count})</option>`).join("");
  const msgs = await api(`/api/conversations/${current}/messages?limit=200`);
  const box = $("#msgs");
  box.innerHTML = msgs.length ? msgs.map(msgHtml).join("") : `<p class="empty">Nothing yet. Say hello — this conversation follows you between your laptop and your phone.</p>`;
  box.scrollTop = box.scrollHeight;
}

export function onMessage(m) {
  if (m.conversation_id !== convId) return load();
  const box = $("#msgs"); if (!box || box.querySelector(`[data-id="${m.id}"]`)) return;
  if (box.querySelector(".msg.live")) return;          // the streaming bubble is replaced when the reply is complete
  box.querySelector(".empty")?.remove();
  box.insertAdjacentHTML("beforeend", msgHtml(m));
  box.scrollTop = box.scrollHeight;
}
export function refresh(entities) { if (entities.includes("*") || entities.includes("conversations")) { if (!document.querySelector("#msgs .msg.live")) load(); } }
void CTX;
