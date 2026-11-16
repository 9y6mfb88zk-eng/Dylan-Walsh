import { icon } from "../util.js";
export async function render(root, ctx) {
  const items = [["projects", "Projects", "Plans, milestones and progress"], ["intel", "Research", "Sourced reports and business ideas"], ["memory", "Memory", "What JARVIS remembers about you"], ["settings", "Settings & security", "Devices, pairing, integrations, privacy, system health"]];
  root.innerHTML = `<h2 class="title" style="margin-bottom:12px">More</h2><div class="stack">${items.map(([k, l, d]) => `<button class="glass panel row" data-k="${k}" style="text-align:left"><span style="width:24px;height:24px">${icon(k)}</span><div><b>${l}</b><div class="muted" style="font-size:13px">${d}</div></div></button>`).join("")}</div>`;
  root.querySelectorAll("[data-k]").forEach((b) => b.onclick = () => ctx.go(b.dataset.k));
}
