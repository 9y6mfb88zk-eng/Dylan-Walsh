// World: an interactive 3D globe of your places, live local times and a real weather comparison.
import { api } from "../api.js";
import { $, $$, esc, icon, toast, formDialog, confirmDialog, wxIcon } from "../util.js";

let places = [], globe = null, clockT = null;

export async function render(root, ctx) {
  root.innerHTML = `<div class="page-head"><div><h2 class="title">World</h2><p>Drag the globe to turn it. Times and weather are live.</p></div><button class="btn small primary" id="add">${icon("plus")}Place</button></div>
    <div class="grid" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)" id="wGrid">
      <article class="panel" style="padding:0;overflow:hidden"><div class="globe-wrap"><canvas id="globe" aria-label="Globe"></canvas><div id="labels" style="position:absolute;inset:0;pointer-events:none"></div></div></article>
      <div class="stack"><article class="panel"><div class="panel-head"><span class="label">Local times</span></div><div class="grid cols-2" id="clocks"></div></article>
      <article class="panel"><div class="panel-head"><span class="label">Weather comparison</span></div><div class="scroll-x"><table class="tbl" id="wx"></table></div></article></div></div>`;
  if (ctx.isPhone()) $("#wGrid", root).style.gridTemplateColumns = "minmax(0,1fr)";
  $("#add", root).onclick = addPlace;
  await load();
  try { globe = await mountGlobe($("#globe", root), $("#labels", root), ctx.settings.appearance?.animation); } catch (e) { $("#globe", root).replaceWith(Object.assign(document.createElement("p"), { className: "empty", textContent: `The 3D globe isn't available on this device (${e.message}).` })); }
  globe?.setPlaces(places);
  clockT = setInterval(drawClocks, 1000);
  return () => { clearInterval(clockT); globe?.destroy(); globe = null; };
}
export function refresh(e) { if (e.includes("*") || e.includes("world") || e.includes("settings")) load().then(() => globe?.setPlaces(places)); }

async function load() {
  places = await api("/api/world");
  drawClocks();
  const W = $("#wx"); if (!W) return;
  W.innerHTML = `<thead><tr><th>Place</th><th></th><th class="amt">Now</th><th class="amt">Today</th><th></th></tr></thead><tbody>${places.map((p) => `<tr><td>${esc(p.name.split(",")[0])}${p.home ? ' <span class="pill info">home</span>' : ""}</td><td>${p.weather ? `${wxIcon(p.weather.code, p.weather.isDay)} <span class="faint" style="font-size:12px">${esc(p.weather.summary)}</span>` : `<span class="faint" style="font-size:12px">${esc(p.error || "")}</span>`}</td><td class="amt">${p.weather ? `${p.weather.temp}${p.weather.unit}` : "—"}</td><td class="amt faint">${p.weather ? `${p.weather.low}–${p.weather.high}°` : ""}</td><td>${p.home ? "" : `<button class="x" data-del="${p.id}" aria-label="Remove">×</button>`}</td></tr>`).join("")}</tbody>`;
  $$("[data-del]", W).forEach((b) => b.onclick = async () => { if (await confirmDialog("Remove this place?", "", { ok: "Remove", danger: true })) api(`/api/locations/${b.dataset.del}`, { method: "DELETE" }); });
}
function drawClocks() {
  const el = $("#clocks"); if (!el) return;
  el.innerHTML = places.map((p) => { const t = new Date().toLocaleTimeString("en-GB", { timeZone: p.timezone, hour: "2-digit", minute: "2-digit" }); const d = new Date().toLocaleDateString("en-GB", { timeZone: p.timezone, weekday: "short" }); return `<button class="clock-card" data-fly="${p.id}" style="text-align:left"><span class="label">${esc(p.name.split(",")[0])}</span><b>${t}</b><span class="faint" style="font-size:12px">${d} · ${esc(p.offset || "")}</span></button>`; }).join("");
  $$("[data-fly]", el).forEach((b) => b.onclick = () => { const p = places.find((x) => String(x.id) === b.dataset.fly); if (p) globe?.flyTo(p.lat, p.lon); });
}
async function addPlace() {
  const v = await formDialog("Add a place", [{ name: "q", label: "City or country", required: true, placeholder: "Tokyo" }], { ok: "Search" });
  if (!v) return;
  const res = await api("/api/locations/lookup", { method: "POST", body: { q: v.q } }).catch((e) => (toast(e.message), []));
  if (!res.length) return toast("No place found.");
  const pick = res.length === 1 ? { i: "0" } : await formDialog("Which one?", [{ name: "i", label: "Place", type: "select", value: "0", options: res.map((r, i) => [String(i), r.name]) }], { ok: "Add" });
  if (!pick) return;
  const r = res[Number(pick.i)];
  try { await api("/api/locations", { method: "POST", body: { name: r.name, lat: r.lat, lon: r.lon, timezone: r.timezone } }); toast(`${r.name} added.`); } catch (e) { toast(e.message); }
}

// ---------------------------------------------------------------- The globe (Three.js)
async function mountGlobe(canvas, labels, animation) {
  const THREE = await import("/vendor/three/three.module.min.js");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 4.2);
  const g = new THREE.Group(); scene.add(g);
  const R = 1;
  const toV = (lat, lon, r = R) => { const phi = (90 - lat) * Math.PI / 180, th = (lon + 180) * Math.PI / 180; return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th)); };
  // Ocean sphere with a fresnel rim
  g.add(new THREE.Mesh(new THREE.SphereGeometry(R * 0.995, 64, 64), new THREE.ShaderMaterial({
    transparent: true, depthWrite: true,
    vertexShader: "varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalMatrix*normal; vV = -mv.xyz; gl_Position = projectionMatrix*mv; }",
    fragmentShader: "varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 2.5); gl_FragColor = vec4(vec3(0.02,0.09,0.18) + vec3(0.13,0.83,0.93)*f*0.9, 1.0); }",
  })));
  // Graticule
  const grat = [];
  for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 4) grat.push(toV(lat, lon, 1.001), toV(lat, lon + 4, 1.001));
  for (let lon = -180; lon < 180; lon += 30) for (let lat = -88; lat < 88; lat += 4) grat.push(toV(lat, lon, 1.001), toV(lat + 4, lon, 1.001));
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(grat), new THREE.LineBasicMaterial({ color: 0x2f7fe0, transparent: true, opacity: 0.18 })));
  // Coastlines and borders
  const { lines } = await fetch("/vendor/world-lines.json").then((r) => r.json());
  const pts = [];
  for (const l of lines) for (let i = 0; i + 3 < l.length; i += 2) pts.push(toV(l[i + 1], l[i], 1.002), toV(l[i + 3], l[i + 2], 1.002));
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.75 })));
  // Atmosphere halo
  g.add(new THREE.Mesh(new THREE.SphereGeometry(R * 1.12, 48, 48), new THREE.ShaderMaterial({ transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: "varying vec3 vN; void main(){ vN = normalize(normalMatrix*normal); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
    fragmentShader: "varying vec3 vN; void main(){ float i = pow(0.62 - dot(vN, vec3(0.0,0.0,1.0)), 3.0); gl_FragColor = vec4(0.13,0.83,0.93,1.0)*i*1.6; }" })));
  let markers = [];
  const markGroup = new THREE.Group(); g.add(markGroup);
  function setPlaces(ps) {
    markGroup.clear(); markers = [];
    labels.innerHTML = "";
    for (const p of ps) {
      const v = toV(p.lat, p.lon, 1.01);
      const m = new THREE.Mesh(new THREE.SphereGeometry(p.home ? 0.022 : 0.016, 12, 12), new THREE.MeshBasicMaterial({ color: p.home ? 0xffffff : 0x00e5ff }));
      m.position.copy(v); markGroup.add(m);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.036, 32), new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
      ring.position.copy(v); ring.lookAt(v.clone().multiplyScalar(2)); markGroup.add(ring);
      const el = document.createElement("div");
      el.style.cssText = "position:absolute;transform:translate(10px,-50%);font:600 11px var(--display);letter-spacing:.12em;text-transform:uppercase;color:var(--ice);text-shadow:0 0 8px rgba(0,229,255,.8);white-space:nowrap";
      el.textContent = p.name.split(",")[0];
      labels.appendChild(el);
      markers.push({ v, el, ring });
    }
  }
  // Interaction
  let rotY = -0.6, rotX = 0.35, velY = 0.0015, drag = null, target = null;
  const reduced = animation === "reduced" || animation === "off" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, ry: rotY, rx: rotX }; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing"; target = null; });
  canvas.addEventListener("pointermove", (e) => { if (!drag) return; rotY = drag.ry + (e.clientX - drag.x) * 0.006; rotX = Math.max(-1.2, Math.min(1.2, drag.rx + (e.clientY - drag.y) * 0.006)); });
  canvas.addEventListener("pointerup", () => { drag = null; canvas.style.cursor = "grab"; });
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); camera.position.z = Math.max(2.4, Math.min(7, camera.position.z + e.deltaY * 0.002)); }, { passive: false });
  function resize() { const r = canvas.getBoundingClientRect(); renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75)); renderer.setSize(r.width, r.height, false); camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix(); }
  const ro = new ResizeObserver(resize); ro.observe(canvas); resize();
  let raf = 0, t = 0;
  const tmp = new THREE.Vector3();
  function frame() {
    raf = requestAnimationFrame(frame);
    t += 0.016;
    if (target) { rotY += (target.ry - rotY) * 0.08; rotX += (target.rx - rotX) * 0.08; if (Math.abs(target.ry - rotY) < 0.002) target = null; }
    else if (!drag && !reduced) rotY += velY;
    g.rotation.set(rotX, rotY, 0);
    const r = canvas.getBoundingClientRect();
    for (const m of markers) {
      tmp.copy(m.v).applyMatrix4(g.matrixWorld);
      const facing = tmp.clone().normalize().dot(camera.position.clone().normalize()) > 0.1;
      tmp.project(camera);
      m.el.style.left = `${(tmp.x * 0.5 + 0.5) * r.width}px`; m.el.style.top = `${(-tmp.y * 0.5 + 0.5) * r.height}px`;
      m.el.style.opacity = facing ? 1 : 0;
      m.ring.scale.setScalar(1 + 0.35 * Math.sin(t * 3));
    }
    renderer.render(scene, camera);
  }
  frame();
  return {
    setPlaces,
    flyTo(lat, lon) { const ry = -((lon + 180) * Math.PI / 180) + Math.PI / 2 + Math.PI; let d = ((ry - rotY) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI; target = { ry: rotY + d, rx: lat * Math.PI / 180 }; },
    destroy() { cancelAnimationFrame(raf); ro.disconnect(); renderer.dispose(); renderer.forceContextLoss?.(); },
  };
}
