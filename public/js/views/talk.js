// Shared conversation transcript (laptop + phone), with voice and text input.
import { api } from "../api.js";
import { voice } from "../voice.js";
import { $, esc, icon, fmtWhen } from "../util.js";

let convId = null, lastId = 0;

const msgHtml = (m) => `<div class="msg ${m.role}" data-id="${m.id}">
  <div class="who">${m.role === "user" ? esc(m.device_name || "You") : "JARVIS"} · ${esc(fmtWhen(m.created_at.replace(" ", "T") + (m.created_at.includes("Z") ? "" : "Z")))}</div>${esc(m.content)}
  ${m.sources?.length ? `<div class="sources">${m.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>`).join("")}</div>` : ""}</div>`;

export async function render(root, ctx) {
  root.innerHTML = `<div class="convo">
    <div class="spread" style="margin-bottom:8px"><h2 class="title">Conversation</h2><div class="row"><select class="inp" id="convSel" style="max-width:220px" aria-label="Conversation"></select><button class="btn small" id="newC">New</button></div></div>
    <div class="messages glass" id="msgs" style="padding:12px"></div>
    <div class="composer" style="width:100%">
      <form class="pill-input glass" id="f" autocomplete="off"><input id="t" placeholder="Message JARVIS…" enterkeyhint="send" aria-label="Message"><button class="icon-btn" aria-label="Send">${icon("send")}</button></form>
      <button class="mic" id="mic" aria-label="Speak">${icon("mic")}</button>
    </div></div>`;
  $("#f", root).addEventListener("submit", (e) => {
    e.preventDefault(); voice.ensureAudio();
    const v = $("#t", root).value.trim(); if (!v) return;
    $("#t", root).value = "";
    ctx.converse(v, { speak: !!ctx.desktop || voice.cfg.tts });
  });
  $("#mic", root).addEventListener("click", () => ctx.listenOnce());
  $("#newC", root).addEventListener("click", async () => { await api("/api/conversations", { method: "POST" }); await load(); });
  $("#convSel", root).addEventListener("change", async (e) => { await api(`/api/conversations/${e.target.value}/current`, { method: "POST" }); await load(); });
  const off = voice.onState((s) => $("#mic", root)?.classList.toggle("live", s === "listening"));
  await load();
  return off;
}

async function load() {
  const { current, list } = await api("/api/conversations");
  convId = current;
  $("#convSel").innerHTML = list.map((c) => `<option value="${c.id}" ${c.id === current ? "selected" : ""}>${esc(c.title)} (${c.count})</option>`).join("");
  const msgs = await api(`/api/conversations/${current}/messages?limit=200`);
  lastId = msgs.at(-1)?.id || 0;
  const box = $("#msgs");
  box.innerHTML = msgs.length ? msgs.map(msgHtml).join("") : '<p class="empty">Nothing yet. Say hello — this conversation follows you between your laptop and your phone.</p>';
  box.scrollTop = box.scrollHeight;
}

export function onMessage(m) {
  if (m.conversation_id !== convId) return load();
  const box = $("#msgs"); if (!box || box.querySelector(`[data-id="${m.id}"]`)) return;
  box.querySelector(".empty")?.remove();
  box.insertAdjacentHTML("beforeend", msgHtml(m));
  lastId = Math.max(lastId, m.id);
  box.scrollTop = box.scrollHeight;
}
export function refresh(entities) { if (entities.includes("*") || entities.includes("conversations")) load(); }
