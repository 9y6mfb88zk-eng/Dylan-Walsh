// The JARVIS core in 3D (Three.js, vendored). Every visual state is driven by core.state (real events) and by
// real audio levels: the microphone while listening, JARVIS's own voice while speaking.
// Quality adapts to the machine; "reduced" slows everything down and "off" renders a still frame.
import { core } from "./corestate.js";

const STATES = {
  //            primary     secondary   intensity spin  agit  particles scan sats  spectrum
  idle:        ["#22d3ee", "#2f7fe0", 0.85, 0.25, 0.0, 0.35, 0, 0, 0.25],
  listening:   ["#00e5ff", "#67e8f9", 1.15, 0.5, 0.15, 0.6, 0, 0, 1.0],
  thinking:    ["#cdeffd", "#2f7fe0", 1.05, 1.6, 0.25, 1.4, 1, 0, 0.35],
  speaking:    ["#00e5ff", "#22d3ee", 1.25, 0.6, 0.35, 0.8, 0, 0, 1.0],
  researching: ["#67e8f9", "#4f86bd", 1.05, 1.0, 0.2, 1.1, 1, 1, 0.4],
  executing:   ["#f2faff", "#8fa5bb", 1.1, 1.3, 0.15, 0.9, 0, 0, 0.5],
  alarm:       ["#ffffff", "#00e5ff", 1.6, 1.8, 0.6, 1.8, 0, 0, 1.0],
  offline:     ["#60778f", "#3a4c60", 0.35, 0.08, 0.0, 0.1, 0, 0, 0.1],
  error:       ["#e8a46a", "#9a5a3c", 0.8, 0.45, 0.05, 0.5, 0, 0, 0.3],   // a muted amber "fault", never an alarm red
};

// Mission Control palette: the same states and behaviour, in violet. Alarm and offline keep their warning colours.
const PALETTES = {
  mission: { idle: ["#c084fc", "#7c3aed"], listening: ["#e879f9", "#c084fc"], thinking: ["#f5d0fe", "#7c3aed"], speaking: ["#d946ef", "#a855f7"], researching: ["#c084fc", "#6d28d9"], executing: ["#faf5ff", "#a78bfa"] },
};

const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;} vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);} vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
i=mod289(i);vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}`;

/** Mount the 3D core. Throws if WebGL isn't available (the caller then uses the 2D core). */
// Shared live stats for the performance view and tests: frames actually drawn per second, live WebGL cores, idle mode.
const stats = (window.__jarvisCore ||= { fps: 0, alive: 0, tier: null, idle: false });
// Idle mode: when nothing is happening (core idle, no audio, no pointer/keys) the core draws less often.
// Measured: under software rendering a composited frame costs ~4 CPU cores-worth at full rate (docs/performance.md).
const IDLE_AFTER_MS = 15_000, IDLE_FPS = 30, BACKGROUND_FPS = 10;
let lastActivity = performance.now(), windowFocused = document.hasFocus?.() ?? true;
const touch = () => { lastActivity = performance.now(); };
for (const ev of ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]) addEventListener(ev, touch, { passive: true });
addEventListener("focus", () => { windowFocused = true; touch(); });
addEventListener("blur", () => { windowFocused = false; });

// quality: auto | high | medium | low. density: particle count multiplier (0.25–1.5). bloom: glow intensity (0 = off).
export async function mountCore3D(canvas, { quality = "auto", animation = "full", density = 1, bloom: bloomLevel = 1 } = {}) {
  const T0 = performance.now(), timings = {};
  const THREE = await import("/vendor/three/three.module.min.js");
  timings.importMs = Math.round(performance.now() - T0);
  const test = document.createElement("canvas");
  if (!(test.getContext("webgl2") || test.getContext("webgl"))) throw new Error("WebGL unavailable");

  // Transparent canvas with premultiplied alpha: additive light shows over the page like a hologram.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  camera.position.set(0, 0, 7.4);
  const root = new THREE.Group();
  scene.add(root);

  const mobile = matchMedia("(max-width: 900px)").matches || /iPhone|iPad|Android/.test(navigator.userAgent);
  let tier = quality === "auto" ? (mobile || (navigator.hardwareConcurrency || 4) < 4 ? "low" : "high") : quality === "medium" ? "medium" : quality;
  density = Math.max(0.25, Math.min(1.5, Number(density) || 1));
  bloomLevel = Math.max(0, Math.min(1.5, Number(bloomLevel ?? 1)));
  const mountAt = performance.now();
  let firstFrameResolve; const firstFrame = new Promise((r) => (firstFrameResolve = r));
  const reduced = animation === "reduced" || matchMedia("(prefers-reduced-motion: reduce)").matches;
  const still = animation === "off";
  const disposables = [];
  const keep = (o) => (disposables.push(o), o);

  // ---------------- Core sphere (noise-displaced, fresnel glow)
  const uni = { uTime: { value: 0 }, uLevel: { value: 0 }, uAgit: { value: 0 }, uC1: { value: new THREE.Color(STATES.idle[0]) }, uC2: { value: new THREE.Color(STATES.idle[1]) }, uIntensity: { value: 1 } };
  const coreMat = keep(new THREE.ShaderMaterial({
    uniforms: uni, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `${NOISE}
      uniform float uTime, uLevel, uAgit; varying vec3 vN; varying vec3 vView; varying float vNoise;
      void main(){ float n = snoise(normal*1.6 + vec3(uTime*0.35)); float n2 = snoise(normal*4.2 - vec3(uTime*0.7));
        float d = (n*0.6 + n2*0.28) * (0.035 + uLevel*0.24 + uAgit*0.06); vec3 p = position + normal*d; vNoise = n;
        vec4 mv = modelViewMatrix*vec4(p,1.0); vView = -mv.xyz; vN = normalMatrix*normal; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uC1, uC2; uniform float uIntensity, uTime, uLevel; varying vec3 vN; varying vec3 vView; varying float vNoise;
      void main(){ vec3 n = normalize(vN), v = normalize(vView); float f = pow(1.0 - max(dot(n,v),0.0), 2.3);
        float bands = 0.5 + 0.5*sin(vNoise*7.0 + uTime*2.2); vec3 c = mix(uC2, uC1, f)*(0.22 + f*1.7) + uC1*bands*0.16 + vec3(1.0)*pow(f,7.0)*0.55;
        gl_FragColor = vec4(c*uIntensity*(1.0 + uLevel*0.9), clamp(0.16 + f, 0.0, 1.0)); }`,
  }));
  const coreMesh = new THREE.Mesh(keep(new THREE.IcosahedronGeometry(1, tier === "high" ? 40 : tier === "medium" ? 30 : 20)), coreMat);
  root.add(coreMesh);
  const nucleusMat = keep(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  const nucleus = new THREE.Mesh(keep(new THREE.SphereGeometry(0.2, 24, 24)), nucleusMat);
  root.add(nucleus);

  // ---------------- Geodesic shell
  const shellMat = keep(new THREE.LineBasicMaterial({ color: STATES.idle[0], transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
  const shell = new THREE.LineSegments(keep(new THREE.WireframeGeometry(keep(new THREE.IcosahedronGeometry(1.38, 2)))), shellMat);
  root.add(shell);

  // ---------------- Orbit rings, segmented ring, bezel ticks
  const ringMat = (op) => keep(new THREE.MeshBasicMaterial({ color: STATES.idle[0], transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  const torus = (r, t, op) => new THREE.Mesh(keep(new THREE.TorusGeometry(r, t, 6, 240)), ringMat(op));
  const ringA = torus(1.98, 0.007, 0.75); ringA.rotation.set(1.25, 0.15, 0);
  const ringB = torus(2.28, 0.005, 0.55); ringB.rotation.set(-0.95, 0.55, 0);
  const ringBPivot = new THREE.Group(); ringBPivot.add(ringB);
  root.add(ringA, ringBPivot);
  const dashPts = [];
  for (let i = 0; i < 64; i++) { const a0 = (i / 64) * Math.PI * 2, a1 = a0 + (Math.PI * 2 / 64) * 0.55; for (let k = 0; k < 6; k++) { const a = a0 + (a1 - a0) * (k / 6), b = a0 + (a1 - a0) * ((k + 1) / 6); dashPts.push(Math.cos(a) * 2.55, Math.sin(a) * 2.55, 0, Math.cos(b) * 2.55, Math.sin(b) * 2.55, 0); } }
  const dashGeo = keep(new THREE.BufferGeometry()); dashGeo.setAttribute("position", new THREE.Float32BufferAttribute(dashPts, 3));
  const dashMat = keep(new THREE.LineBasicMaterial({ color: STATES.idle[1], transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }));
  const dashes = new THREE.LineSegments(dashGeo, dashMat);
  root.add(dashes);
  const tickPts = [];
  for (let i = 0; i < 180; i++) { const a = (i / 180) * Math.PI * 2, r0 = 2.82, r1 = r0 + (i % 15 === 0 ? 0.12 : 0.045); tickPts.push(Math.cos(a) * r0, Math.sin(a) * r0, 0, Math.cos(a) * r1, Math.sin(a) * r1, 0); }
  const tickGeo = keep(new THREE.BufferGeometry()); tickGeo.setAttribute("position", new THREE.Float32BufferAttribute(tickPts, 3));
  const tickMat = keep(new THREE.LineBasicMaterial({ color: "#8fa5bb", transparent: true, opacity: 0.32, depthWrite: false }));
  const ticks = new THREE.LineSegments(tickGeo, tickMat);
  root.add(ticks);

  // ---------------- Audio spectrum ring (instanced bars)
  const BARS = tier === "low" ? 72 : 120;
  const barGeo = keep(new THREE.BoxGeometry(0.014, 1, 0.014)); barGeo.translate(0, 0.5, 0);
  const barMat = keep(new THREE.MeshBasicMaterial({ color: STATES.idle[0], transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
  const bars = new THREE.InstancedMesh(barGeo, barMat, BARS);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), zAxis = new THREE.Vector3(0, 0, 1), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  const barVals = new Float32Array(BARS);
  root.add(bars);

  // ---------------- Particles
  const N = Math.round((tier === "high" ? 2400 : tier === "medium" ? 1500 : 900) * density);
  const pp = new Float32Array(N * 3), ps = new Float32Array(N), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const r = 1.9 + Math.pow(Math.random(), 0.7) * 1.9, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    pp[i * 3] = r * Math.sin(ph) * Math.cos(th); pp[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.8; pp[i * 3 + 2] = r * Math.cos(ph);
    ps[i] = 0.6 + Math.random() * 1.6; seed[i] = Math.random();
  }
  const pGeo = keep(new THREE.BufferGeometry());
  pGeo.setAttribute("position", new THREE.BufferAttribute(pp, 3));
  pGeo.setAttribute("aSize", new THREE.BufferAttribute(ps, 1));
  pGeo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  const pUni = { uTime: uni.uTime, uPixel: { value: 1 }, uLevel: uni.uLevel, uC: { value: new THREE.Color(STATES.idle[0]) }, uIntensity: { value: 1 } };
  const pMat = keep(new THREE.ShaderMaterial({
    uniforms: pUni, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `attribute float aSize; attribute float aSeed; uniform float uTime, uPixel, uLevel; varying float vTw;
      void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); vTw = 0.5 + 0.5*sin(uTime*1.6 + aSeed*40.0);
        gl_PointSize = aSize*uPixel*(1.0 + uLevel*0.7)*(7.0 / -mv.z); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uC; uniform float uIntensity; varying float vTw;
      void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(uC*uIntensity*(0.5 + vTw), a*(0.35 + vTw*0.65)); }`,
  }));
  const points = new THREE.Points(pGeo, pMat);
  root.add(points);

  // ---------------- Scanning arcs (thinking / researching), satellites (researching)
  const arcMat = ringMat(0);
  const arcs = [0, 1, 2].map((i) => { const m = new THREE.Mesh(keep(new THREE.TorusGeometry(1.72 + i * 0.12, 0.014, 6, 80, 1.15)), arcMat); const g = new THREE.Group(); g.rotation.set(i * 1.1, i * 0.7, 0); g.add(m); root.add(g); return { g, m, speed: 2.4 + i * 0.9 }; });
  const satMat = keep(new THREE.MeshBasicMaterial({ color: "#cdeffd", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  const sats = Array.from({ length: 6 }, (_, i) => { const m = new THREE.Mesh(keep(new THREE.SphereGeometry(0.04, 10, 10)), satMat); const g = new THREE.Group(); g.rotation.set(Math.random() * 3, Math.random() * 3, 0); m.position.x = 2.1 + (i % 3) * 0.18; g.add(m); root.add(g); return { g, speed: 0.6 + Math.random() * 0.9 }; });

  // ---------------- Shockwaves (speech onsets, alarm, wake)
  const waveGeo = keep(new THREE.RingGeometry(0.985, 1, 160));
  const waves = Array.from({ length: 8 }, () => { const m = new THREE.Mesh(waveGeo, keep(new THREE.MeshBasicMaterial({ color: "#67e8f9", transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }))); m.visible = false; root.add(m); return { m, life: 0 }; });
  let lastWave = 0;
  const emitWave = (strength = 1) => { const w = waves.find((x) => x.life <= 0); if (!w) return; w.life = 1; w.strength = strength; w.m.visible = true; w.m.scale.setScalar(1.2); };

  // ---------------- Core 808 (Mission Control): a military aerospace build of the same core — gimballed orbital rings
  // with moving nodes, a degree bezel, segmented data arcs, targeting brackets, a radar beam and a wireframe cage around
  // the energy core. Built once, shown only in "808" mode; assemble() choreographs it piece by piece.
  const g808 = new THREE.Group(); g808.visible = false; root.add(g808);
  const lineMat = (color, op) => keep(new THREE.LineBasicMaterial({ color, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false }));
  const segGeo = (pts) => { const g = keep(new THREE.BufferGeometry()); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)); return g; };
  const circlePts = (r, n = 180, z = 0) => { const p = []; for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2, b = ((i + 1) / n) * Math.PI * 2; p.push(Math.cos(a) * r, Math.sin(a) * r, z, Math.cos(b) * r, Math.sin(b) * r, z); } return p; };
  // Inner cage: a dodecahedron wireframe around the energy core
  const cageMat = lineMat("#7fd6e8", 0.5);
  const cage = new THREE.LineSegments(keep(new THREE.EdgesGeometry(keep(new THREE.DodecahedronGeometry(1.22, 0)))), cageMat);
  const cage2 = new THREE.LineSegments(keep(new THREE.EdgesGeometry(keep(new THREE.IcosahedronGeometry(1.5, 0)))), lineMat("#3f7f9e", 0.28));
  g808.add(cage, cage2);
  // Three gimballed orbital rings, each carrying small nodes
  const orbitDefs = [[1.95, [1.2, 0.2, 0]], [2.18, [-0.9, 0.7, 0.3]], [2.42, [0.25, -1.15, 0.6]]];
  const orbits = orbitDefs.map(([r, rot], i) => {
    const pivot = new THREE.Group(); pivot.rotation.set(...rot);
    const ring = new THREE.LineSegments(segGeo(circlePts(r, 200)), lineMat(i === 1 ? "#9fe0ee" : "#5fb8d0", 0.55 - i * 0.1));
    const nodeMat = keep(new THREE.MeshBasicMaterial({ color: "#d9f3f8", transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    const spin = new THREE.Group();
    for (let k = 0; k < 3; k++) { const n = new THREE.Mesh(keep(new THREE.BoxGeometry(0.07, 0.07, 0.07)), nodeMat); const a = (k / 3) * Math.PI * 2 + i; n.position.set(Math.cos(a) * r, Math.sin(a) * r, 0); spin.add(n); }
    pivot.add(ring, spin); g808.add(pivot);
    return { pivot, ring, spin, rest: rot, speed: (i % 2 ? -1 : 1) * (0.35 + i * 0.12), nodeMat };
  });
  // Degree bezel: 360 ticks, major every 10°, long every 30°; rotates slowly against the rings
  const bz = []; for (let i = 0; i < 360; i += 2) { const a = (i / 360) * Math.PI * 2, r0 = 2.86, r1 = r0 + (i % 30 === 0 ? 0.16 : i % 10 === 0 ? 0.09 : 0.04); bz.push(Math.cos(a) * r0, Math.sin(a) * r0, 0, Math.cos(a) * r1, Math.sin(a) * r1, 0); }
  const bezelMat = lineMat("#8fb3c8", 0.42);
  const bezelGeo = segGeo(bz);
  const bezel = new THREE.LineSegments(bezelGeo, bezelMat);
  const bezelRing = new THREE.LineSegments(segGeo(circlePts(2.84, 240)), lineMat("#4f7f9a", 0.35));
  g808.add(bezel, bezelRing);
  // Segmented data arcs: 12 segments that light in sequence (activity), at r 2.62
  const arcSegs = Array.from({ length: 12 }, (_, i) => {
    const p = [], a0 = (i / 12) * Math.PI * 2 + 0.04, a1 = a0 + (Math.PI * 2 / 12) * 0.78;
    for (let k = 0; k < 14; k++) { const a = a0 + (a1 - a0) * (k / 14), b = a0 + (a1 - a0) * ((k + 1) / 14); p.push(Math.cos(a) * 2.62, Math.sin(a) * 2.62, 0, Math.cos(b) * 2.62, Math.sin(b) * 2.62, 0, Math.cos(a) * 2.68, Math.sin(a) * 2.68, 0, Math.cos(b) * 2.68, Math.sin(b) * 2.68, 0); }
    const m = lineMat("#6fd0e4", 0.3); const s = new THREE.LineSegments(segGeo(p), m); g808.add(s); return { s, m };
  });
  // Targeting brackets: four corner marks that close in, then hold
  const brMat = lineMat("#cfe9f2", 0.7);
  const brackets = [0, 1, 2, 3].map((i) => {
    const s = 0.34, R = 3.25, ang = Math.PI / 4 + i * Math.PI / 2, cx = Math.cos(ang) * R, cy = Math.sin(ang) * R;
    const sx = Math.sign(cx), sy = Math.sign(cy);
    const m = new THREE.LineSegments(segGeo([cx, cy, 0, cx - sx * s, cy, 0, cx, cy, 0, cx, cy - sy * s, 0]), brMat);
    g808.add(m); return m;
  });
  // Radar beam: a thin sector sweeping the plane
  const beamMat = keep(new THREE.MeshBasicMaterial({ color: "#7fe0c0", transparent: true, opacity: 0.14, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
  const beam = new THREE.Mesh(keep(new THREE.RingGeometry(1.55, 2.82, 48, 1, 0, 0.42)), beamMat);
  g808.add(beam);
  // Status indicators: eight small markers outside the bezel that follow the core's state
  const indMat = keep(new THREE.MeshBasicMaterial({ color: "#7fd6e8", transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
  const indicators = Array.from({ length: 8 }, (_, i) => { const a = (i / 8) * Math.PI * 2 + Math.PI / 8; const m = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.1, 0.04)), indMat); m.position.set(Math.cos(a) * 3.12, Math.sin(a) * 3.12, 0); m.rotation.z = a; g808.add(m); return m; });
  const classic = [shell, ringA, ringBPivot, dashes, ticks];
  let design = "classic";
  // Assembly: p goes 0 → 1; each element has its own window in the sequence (see assemble()).
  let asm = 1, asmFrom = 0, asmDur = 0, asmResolve = null;
  const win = (a, b) => Math.max(0, Math.min(1, (asm - a) / (b - a)));
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  // Core 808 colours by state: steel cyan at rest, military green while scanning, amber faults, red alarms.
  const P808 = { idle: ["#6ec9dc", "#2f5f80"], listening: ["#9fe8f5", "#4fb3c8"], thinking: ["#d6f0f6", "#3f8fae"], speaking: ["#9fe8f5", "#5cc2d6"], researching: ["#8fdcb8", "#3f8f73"], executing: ["#e8f2f6", "#7f9fb4"], error: ["#f0b070", "#9a5a2c"], alarm: ["#ff7a66", "#a8342a"], offline: ["#52687c", "#2d3c4c"] };

  // Sizing state, declared before the bloom set-up uses it (until 6.9 the set-up's resize hit these before they existed,
  // the error was caught, and bloom was silently never enabled)
  let W = 1, H = 1, visible = true, resizeQ = 0, drawable = false;
  const BLOOM_READY = false;
  // ---------------- Post-processing (bloom) for the high tier
  let composer = null, bloom = null;
  async function setupBloom() {
    // Bloom is not used. Until 6.9 this set-up always failed (it ran before the sizing state existed and the error was
    // caught), so every release's core was designed and tuned without it. Enabled as it stands, the bloom pass makes the
    // canvas background opaque and washes Core 808 out at panel size; it needs an alpha-preserving composer and its
    // own tuning before it can be turned on. Kept off deliberately rather than by accident.
    if (!BLOOM_READY) return;
    if (tier === "low" || composer || bloomLevel === 0) return;
    try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
        import("/vendor/three/postprocessing/EffectComposer.js"), import("/vendor/three/postprocessing/RenderPass.js"),
        import("/vendor/three/postprocessing/UnrealBloomPass.js"), import("/vendor/three/postprocessing/OutputPass.js")]);
      composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));
      bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 1.05, 0.55, 0.08);
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      applySize(true);
    } catch (e) { console.warn("[core] bloom unavailable:", e.message); composer = null; }
  }
  await setupBloom();
  timings.sceneMs = Math.round(performance.now() - T0);

  // ---------------- Sizing / visibility
  // The canvas moves between hosts (Command Centre, activation sequence, Mission Control panel) and is parked, hidden,
  // in between. Reallocating the renderer and bloom targets is the costly part, so: the layout size (not the
  // transformed size the move animations produce), no change while parked at zero size, unchanged sizes skipped, and
  // at most one reallocation per frame however many layout changes there were.
  function resize() { if (!resizeQ) resizeQ = requestAnimationFrame(applySize); }
  function applySize(force = false) {
    if (resizeQ) { cancelAnimationFrame(resizeQ); resizeQ = 0; }
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h || (!force && w === W && h === H)) return;
    W = w; H = h;
    const pr = Math.min(devicePixelRatio || 1, tier === "high" ? 1.75 : tier === "medium" ? 1.25 : 1);
    renderer.setPixelRatio(pr);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    camera.position.z = W / H < 1 ? 7.4 / (W / H) ** 0.6 : 7.4;
    camera.updateProjectionMatrix();
    pUni.uPixel.value = pr * Math.min(W, H) / 520;
    if (composer) { composer.setPixelRatio(pr); composer.setSize(W, H); bloom?.resolution.set(W * pr / 2, H * pr / 2); }
    if (still && drawable) draw(performance.now());
  }
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  applySize();                                                         // the first size, synchronously
  const io = new IntersectionObserver((e) => { visible = e[0]?.isIntersecting ?? true; }); io.observe(canvas);
  let ptrX = 0, ptrY = 0;
  const onPointer = (e) => { ptrX = (e.clientX / innerWidth - 0.5) * 2; ptrY = (e.clientY / innerHeight - 0.5) * 2; };
  addEventListener("pointermove", onPointer, { passive: true });

  // ---------------- State → visuals
  const WHITE = new THREE.Color(1, 1, 1);
  const cur = { c1: new THREE.Color(STATES.idle[0]), c2: new THREE.Color(STATES.idle[1]), intensity: 0.85, spin: 0.25, agit: 0, pspeed: 0.35, scan: 0, sats: 0, spec: 0.25 };
  const tgt = { c1: new THREE.Color(), c2: new THREE.Color() };
  let drawnOnce = false;
  let gone = false, palette = null, boost = 1, boostTarget = 1, asmWaved = false;
  let state = core.state, level = 0, prevLevel = 0, t = 0, lastFrame = performance.now(), raf = 0, slow = 0, frames = 0;
  const offState = core.on((s, _d, same) => {
    touch();
    if (!same && s !== state) {
      if (s === "listening" || s === "alarm") emitWave(1.2);
      state = s;
    }
    if (still) draw(performance.now());
  });

  function draw(now) {
    const dt = Math.min(0.05, (now - lastFrame) / 1000) * (reduced ? 0.35 : 1);
    lastFrame = now;
    t += dt;
    const S = STATES[state] || STATES.idle;
    const P = design === "808" ? (P808[state] || P808.idle) : palette?.[state];
    boost += (boostTarget - boost) * Math.min(1, dt * 4);
    tgt.c1.set(P ? P[0] : S[0]); tgt.c2.set(P ? P[1] : S[1]);
    const k = 1 - Math.pow(0.0015, dt);              // frame-rate independent easing
    cur.c1.lerp(tgt.c1, k); cur.c2.lerp(tgt.c2, k);
    for (const [key, idx] of [["intensity", 2], ["spin", 3], ["agit", 4], ["pspeed", 5], ["scan", 6], ["sats", 7], ["spec", 8]]) cur[key] += (S[idx] - cur[key]) * k;

    // Real audio level when there is one; otherwise a calm breathing motion that never imitates audio.
    const { level: real, freq } = core.levels();
    let target;
    if (real != null) target = real;
    else if (state === "speaking") target = 0.28 + 0.18 * Math.abs(Math.sin(t * 7.3)) * Math.abs(Math.sin(t * 2.1));
    else if (state === "alarm") target = 0.55 + 0.45 * Math.max(0, Math.sin(t * 7));
    else target = 0.03 + 0.03 * Math.sin(t * 0.9);
    level += (target - level) * (target > level ? 0.5 : 0.12);
    document.documentElement.style.setProperty("--level", level.toFixed(3));

    uni.uTime.value = t; uni.uLevel.value = level; uni.uAgit.value = cur.agit;
    uni.uC1.value.copy(cur.c1); uni.uC2.value.copy(cur.c2);
    const strobe = state === "alarm" ? 1 + 0.5 * Math.max(0, Math.sin(t * 8)) : state === "offline" ? 0.8 + 0.2 * Math.sin(t * 13) * (Math.random() > 0.97 ? 1 : 0) : 1;
    uni.uIntensity.value = cur.intensity * strobe * boost;
    coreMesh.scale.setScalar(1 + level * 0.12);
    nucleus.scale.setScalar(0.85 + level * 0.9 + 0.08 * Math.sin(t * 3));
    nucleusMat.color.copy(cur.c1).lerp(WHITE, 0.65);
    nucleusMat.opacity = 0.55 + level * 0.45;

    shell.rotation.y += dt * 0.12 * (0.5 + cur.spin);
    shell.rotation.x += dt * 0.05 * cur.spin;
    shellMat.color.copy(cur.c1); shellMat.opacity = 0.12 + cur.intensity * 0.12 + level * 0.15;
    ringA.rotation.z += dt * 0.35 * cur.spin;
    ringBPivot.rotation.y -= dt * 0.22 * cur.spin;
    ringA.material.color.copy(cur.c1); ringB.material.color.copy(cur.c2);
    ringA.material.opacity = 0.45 + cur.intensity * 0.3; ringB.material.opacity = 0.3 + cur.intensity * 0.25;
    dashes.rotation.z -= dt * 0.12 * (0.4 + cur.spin);
    dashMat.color.copy(cur.c2); dashMat.opacity = 0.25 + cur.intensity * 0.25;
    ticks.rotation.z += dt * 0.02;
    tickMat.opacity = 0.18 + cur.intensity * 0.15;

    // Spectrum: real frequency bins when available; level-shaped otherwise.
    for (let i = 0; i < BARS; i++) {
      const mirror = i < BARS / 2 ? i : BARS - 1 - i;
      const v = freq ? (freq[2 + Math.floor((mirror / (BARS / 2)) * 60)] || 0) / 255 : level * (0.35 + 0.65 * Math.abs(Math.sin(t * 5 + i * 0.6)));
      barVals[i] += ((v * cur.spec) - barVals[i]) * (v * cur.spec > barVals[i] ? 0.55 : 0.18);
      const a = (i / BARS) * Math.PI * 2;
      pos.set(Math.cos(a) * 1.62, Math.sin(a) * 1.62, 0);
      q.setFromAxisAngle(zAxis, a - Math.PI / 2);
      sc.set(1, 0.02 + barVals[i] * 0.62, 1);
      m4.compose(pos, q, sc);
      bars.setMatrixAt(i, m4);
    }
    bars.instanceMatrix.needsUpdate = true;
    barMat.color.copy(cur.c1); barMat.opacity = 0.35 + cur.spec * 0.55;

    points.rotation.y += dt * 0.06 * cur.pspeed * 2;
    points.rotation.x = Math.sin(t * 0.1) * 0.1;
    pUni.uC.value.copy(cur.c1).lerp(cur.c2, 0.35); pUni.uIntensity.value = 0.45 + cur.intensity * 0.45;

    arcMat.opacity = cur.scan * 0.8; arcMat.color.copy(cur.c1);
    arcs.forEach((a) => { a.g.rotation.z += dt * a.speed; a.g.visible = cur.scan > 0.02; });
    satMat.opacity = cur.sats; sats.forEach((s) => { s.g.rotation.z += dt * s.speed; s.g.visible = cur.sats > 0.02; });

    // Shockwaves: on speech onsets (real audio), periodically while listening/alarm.
    if (!reduced) {
      if (state === "speaking" && level > 0.22 && level - prevLevel > 0.04 && now - lastWave > 160) { emitWave(0.5 + level); lastWave = now; }
      if (state === "listening" && now - lastWave > 1400) { emitWave(0.6); lastWave = now; }
      if (state === "alarm" && now - lastWave > 700) { emitWave(1.4); lastWave = now; }
    }
    prevLevel = level;
    for (const w of waves) {
      if (w.life <= 0) continue;
      w.life -= dt * 0.8;
      if (w.life <= 0) { w.m.visible = false; continue; }
      w.m.scale.setScalar(1.25 + (1 - w.life) * 2.4);
      w.m.material.opacity = w.life * 0.6 * (w.strength || 1);
      w.m.material.color.copy(cur.c1);
    }

    // ---------------- Core 808 motion (and its assembly)
    if (design === "808") {
      if (asmDur) { asm = Math.min(1, (now - asmFrom) / asmDur); if (asm >= 1) { asmDur = 0; asmResolve?.(); asmResolve = null; } }
      const busy = cur.scan, lv = level;
      // Nucleus first: a point of light that flares as it forms
      const wN = ease(win(0, 0.12));
      nucleus.scale.multiplyScalar(wN * (1 + (1 - win(0.06, 0.2)) * 1.6));
      // The energy core itself emerges near the end
      const wCore = ease(win(0.68, 0.94));
      coreMesh.scale.multiplyScalar(0.82 * Math.max(0.001, wCore));
      uni.uIntensity.value *= 0.25 + 0.75 * wCore + (asm < 1 ? (1 - Math.abs(asm - 0.9) * 8) * 0.6 * (asm > 0.82 ? 1 : 0) : 0);
      // Cage
      const wCage = ease(win(0.08, 0.34));
      cage.scale.setScalar(Math.max(0.001, wCage)); cage2.scale.setScalar(Math.max(0.001, ease(win(0.14, 0.4))));
      cage.rotation.y += dt * (0.15 + cur.spin * 0.25 + (1 - wCage) * 6); cage.rotation.x += dt * 0.07;
      cage2.rotation.y -= dt * (0.08 + cur.spin * 0.12); cage2.rotation.z += dt * 0.04;
      cageMat.color.copy(cur.c1); cageMat.opacity = (0.3 + cur.intensity * 0.25 + lv * 0.2) * wCage;
      cage2.material.color.copy(cur.c2); cage2.material.opacity = 0.22 * ease(win(0.14, 0.4));
      // Orbital rings twist into their gimbal positions, then keep turning; nodes run along them
      orbits.forEach((o, i) => {
        const w = ease(win(0.2 + i * 0.08, 0.5 + i * 0.08)), twist = 1 - w;
        o.ring.scale.setScalar(Math.max(0.001, 0.35 + 0.65 * w)); o.spin.scale.copy(o.ring.scale);
        o.pivot.rotation.x = o.rest[0] + twist * (2.2 - i * 0.5); o.pivot.rotation.y = o.rest[1] + twist * (1.6 + i * 0.4);
        o.pivot.rotation.z += dt * o.speed * (0.25 + cur.spin * 0.6);
        o.spin.rotation.z += dt * o.speed * (0.6 + cur.spin * 1.4 + lv * 2);
        o.ring.material.color.copy(i === 1 ? cur.c1 : cur.c2).lerp(cur.c1, 0.4); o.ring.material.opacity = (0.32 + cur.intensity * 0.22 - i * 0.05 + (state === "listening" ? lv * 0.5 : 0)) * w;
        o.nodeMat.opacity = 0.85 * w; o.nodeMat.color.copy(cur.c1).lerp(WHITE, 0.5);
      });
      // Bezel draws itself round, then rotates slowly
      const wBz = win(0.4, 0.64);
      bezelGeo.setDrawRange(0, Math.floor(bezelGeo.attributes.position.count * wBz / 2) * 2);
      bezel.rotation.z -= dt * 0.03 * (0.5 + cur.spin); bezelRing.rotation.z = bezel.rotation.z;
      bezelMat.color.copy(cur.c2).lerp(WHITE, 0.35); bezelMat.opacity = (0.22 + cur.intensity * 0.2) * Math.min(1, wBz * 2);
      bezelRing.material.opacity = 0.3 * wBz;
      // Data arcs light in sequence: faster while thinking/researching, all lit while speaking at volume
      const rate = state === "thinking" || state === "researching" ? 9 : state === "executing" ? 6 : state === "listening" ? 4 : 1.2;
      const lead = (t * rate) % 12;
      arcSegs.forEach((a, i) => {
        const on = win(0.52 + i * 0.012, 0.6 + i * 0.012);
        const d = (lead - i + 12) % 12, glow = Math.max(0, 1 - d / 4);
        a.m.color.copy(cur.c1); a.m.opacity = on * (0.14 + glow * (0.35 + busy * 0.3) + (state === "speaking" ? lv * 0.5 : 0));
        a.s.rotation.z = bezel.rotation.z * -0.5;
      });
      // Targeting brackets close in, then breathe with the audio level
      const wBr = ease(win(0.6, 0.78));
      brackets.forEach((b) => b.scale.setScalar(1.7 - 0.7 * wBr + lv * 0.06));
      brMat.opacity = 0.55 * wBr + (state === "listening" ? 0.25 : 0); brMat.color.copy(cur.c1).lerp(WHITE, 0.5);
      // Radar beam sweeps (faster when scanning); hidden when offline
      beam.visible = asm > 0.72 && state !== "offline";
      beam.rotation.z -= dt * (0.7 + busy * 2.4 + (state === "listening" ? 0.8 : 0));
      beamMat.opacity = (0.05 + busy * 0.12 + (state === "listening" ? 0.06 : 0)) * win(0.72, 0.85);
      beamMat.color.copy(state === "researching" || state === "thinking" ? cur.c1 : cur.c2).lerp(WHITE, 0.15);
      // Indicators
      const wInd = win(0.78, 0.92);
      indMat.color.copy(cur.c1); indMat.opacity = wInd * (state === "offline" ? 0.2 : 0.45 + 0.35 * Math.max(0, Math.sin(t * (state === "listening" ? 6 : 1.5))));
      // Particles and spectrum fade in last
      pUni.uIntensity.value *= win(0.8, 1);
      barMat.opacity *= win(0.84, 1);
      if (asm < 1 && asm > 0.86 && !asmWaved) { asmWaved = true; emitWave(1.6); }
    }

    // Dimensional parallax: the core leans gently towards the pointer.
    root.rotation.y += ((ptrX * 0.22) - root.rotation.y) * 0.04;
    root.rotation.x += ((ptrY * 0.14) - root.rotation.x) * 0.04;
    if (bloom) bloom.strength = (0.75 + cur.intensity * 0.45 + level * 0.5) * (0.6 + 0.4 * boost) * bloomLevel;
    if (composer) composer.render(); else renderer.render(scene, camera);
  }

  const inMission = !!canvas.closest("#mission");
  let drawn = 0, fpsAt = performance.now(), evalAt = 0;
  function idleInterval(now) {
    if (state !== "idle" || core.levels().level != null) return 0;
    const quiet = now - lastActivity;
    if (!windowFocused && quiet > 3000) return 1000 / BACKGROUND_FPS;   // JARVIS visible behind another window
    if (quiet > IDLE_AFTER_MS) return 1000 / IDLE_FPS;
    return 0;
  }
  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (!visible || document.hidden || (!inMission && document.documentElement.classList.contains("mission-open"))) { lastFrame = now; return; }
    const minGap = Math.max(reduced ? 32 : 0, idleInterval(now));
    stats.idle = minGap > 32;
    if (minGap && now - lastFrame < minGap - 2) return;
    const ft = now - lastFrame;
    draw(now);
    drawn++; stats.frames = (stats.frames || 0) + 1;   // total frames drawn (used by tests to see a core is live)
    if (now - fpsAt >= 1000) { stats.fps = Math.round((drawn * 1000) / (now - fpsAt)); drawn = 0; fpsAt = now; stats.tier = tier; }
    // Adaptive quality: sustained slow frames on "auto" drop to the light tier (no bloom, fewer particles).
    if (!drawnOnce) { drawnOnce = true; timings.firstDrawMs = Math.round(performance.now() - now); timings.totalMs = Math.round(performance.now() - T0); stats.timings = timings; firstFrameResolve({ ms: Math.round(performance.now() - mountAt), tier, timings }); }
    if (quality === "auto" && tier === "high" && !minGap) {
      frames++; if (ft > 34) slow++;
      if (frames >= 180 || (frames >= 20 && now - (evalAt ||= now) > 6000)) { evalAt = 0; if (slow / frames > 0.5) { tier = "low"; composer = null; bloom = null; applySize(true); console.info("[core] switched to the light quality tier"); } frames = 0; slow = 0; }
    }
  }
  drawable = true;
  applySize(true);
  stats.alive++;
  const tc = performance.now();
  try { if (renderer.compileAsync) await Promise.race([renderer.compileAsync(scene, camera), new Promise((r) => setTimeout(r, 4000))]); } catch {}
  timings.compileMs = Math.round(performance.now() - tc);
  if (gone) return { kind: "3d", tier, firstFrame, pulse() {}, setPalette() {}, setBoost() {}, setDesign() {}, assemble: async () => {}, get design() { return "classic"; }, destroy() {} };
  if (still) { draw(performance.now()); drawnOnce = true; firstFrameResolve({ ms: Math.round(performance.now() - mountAt), tier }); } else raf = requestAnimationFrame(loop);

  return {
    kind: "3d",
    get tier() { return tier; },
    /** Resolves when the first frame has actually been drawn. */
    firstFrame,
    pulse: (strength = 1.2) => emitWave(strength),
    /** "mission" (violet) or null (normal colours); colours blend over about a second. */
    setPalette(name) { palette = PALETTES[name] || null; if (still) draw(performance.now()); },
    /** "808" (Mission Control's Core 808) or "classic" (the Command Centre core). Same instance, same canvas. */
    setDesign(name) {
      design = name === "808" ? "808" : "classic";
      g808.visible = design === "808";
      classic.forEach((o) => { o.visible = design !== "808"; });
      if (design !== "808") { asm = 1; asmDur = 0; asmResolve?.(); asmResolve = null; coreMesh.scale.setScalar(1); }
      if (still) draw(performance.now());
    },
    get design() { return design; },
    /** Build Core 808 piece by piece over `ms` (energy point → cage → rings → bezel → brackets → beam → core). */
    assemble(ms = 2400) {
      if (design !== "808") this.setDesign("808");
      asmResolve?.();
      asmWaved = false; asm = 0; asmFrom = performance.now(); asmDur = Math.max(1, ms);
      if (still || reduced) { asm = 1; asmDur = 0; draw(performance.now()); return Promise.resolve(); }
      return new Promise((r) => { asmResolve = r; setTimeout(() => { if (asmResolve === r) { asm = 1; asmDur = 0; asmResolve = null; r(); } }, ms + 1500); });
    },
    /** Temporary brightness, e.g. 1.6 while Mission Control powers up; eases back when set to 1. */
    setBoost(b) { boostTarget = Math.max(0.3, Math.min(2.5, b)); },
    destroy() {
      if (gone) return; gone = true; stats.alive--;
      cancelAnimationFrame(raf); offState(); ro.disconnect(); io.disconnect();
      removeEventListener("pointermove", onPointer);
      disposables.forEach((d) => d.dispose?.());
      composer?.dispose?.();
      renderer.dispose();
      renderer.forceContextLoss?.();
    },
  };
}
