// Full-screen alarm: plays the sound for real (Web Audio, looping, optionally getting louder), verifies that audio
// is actually being produced, speaks the greeting, and reports snooze / dismiss back to the background agent.
(async () => {
  const bridge = window.alarmBridge;
  const a = await bridge.get();
  if (!a) return;
  const $ = (id) => document.getElementById(id);
  const tz = a.timezone || undefined;
  const clock = () => { $("time").textContent = new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }); };
  clock(); setInterval(clock, 1000);
  $("label").textContent = a.label || "Alarm";
  $("msg").textContent = a.message || "";
  $("snooze").textContent = `Snooze ${a.snoozeMinutes || 10} min`;
  $("dismiss").focus();

  // ---------------- Audio (Web Audio so we can verify the signal actually leaves the app)
  const ctx = new AudioContext();
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});
  const gain = ctx.createGain(), analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  gain.connect(analyser); analyser.connect(ctx.destination);
  const target = Math.max(0.05, Math.min(1, (a.volume ?? 80) / 100));
  let src = null, el = null, stopped = false;
  // The sound arrives as bytes from the app (no file access from this page); decode and loop it.
  const bytes = a.audio ? new Uint8Array(a.audio) : null;
  try {
    if (!bytes) throw new Error("no sound data");
    const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(gain);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(a.gradual ? Math.min(target, 0.08) : target, t);
    if (a.gradual) gain.gain.linearRampToValueAtTime(target, t + 30);
    src.start();
  } catch (e) {
    // Fallback: a plain audio element on a same-origin blob URL (still real playback, still measured)
    if (bytes) {
      el = new Audio(URL.createObjectURL(new Blob([bytes], { type: a.mime || "audio/mpeg" }))); el.loop = true;
      ctx.createMediaElementSource(el).connect(gain); gain.gain.value = target;
      el.play().catch(() => {});
    }
  }
  // Verify: measure the output signal level for 2 seconds.
  const d = new Float32Array(analyser.fftSize);
  let peak = 0;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      analyser.getFloatTimeDomainData(d);
      let s = 0; for (const v of d) s += v * v;
      peak = Math.max(peak, Math.sqrt(s / d.length));
      if (peak > 0.004 || performance.now() - t0 > 2000) { clearInterval(iv); resolve(); }
    }, 50);
  });
  const ok = peak > 0.004 && ctx.state === "running";
  bridge.audio(ok, ok ? `Audio playing (RMS ${peak.toFixed(3)}, volume ${Math.round(target * 100)}%)` : `No audio signal (engine ${ctx.state})`);
  if (!ok) { $("hint").innerHTML = '<span class="warn">Sound could not be confirmed — check the Windows volume.</span> S = snooze · Esc or D = dismiss'; }

  // ---------------- Spoken greeting (ducks the alarm, then restores it)
  function speak() {
    if (!a.speak || !a.speech || !("speechSynthesis" in window) || stopped) return;
    const u = new SpeechSynthesisUtterance(a.speech);
    const v = speechSynthesis.getVoices().find((x) => /Ryan|George|Daniel|UK English Male|en-GB/.test(`${x.name} ${x.lang}`));
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-GB";
    u.rate = 0.95;
    const now = ctx.currentTime, cur = gain.gain.value;
    gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(cur, now); gain.gain.linearRampToValueAtTime(Math.min(cur, 0.12), now + 0.4);
    u.onend = u.onerror = () => { if (stopped) return; const n = ctx.currentTime; gain.gain.setValueAtTime(gain.gain.value, n); gain.gain.linearRampToValueAtTime(target, n + (a.gradual ? 8 : 0.5)); };
    speechSynthesis.speak(u);
  }
  setTimeout(speak, 3500);
  const again = setInterval(speak, 120_000);
  // Ringing unanswered for 10 minutes: snooze automatically (so it doesn't ring forever with nobody there).
  const auto = setTimeout(() => finish("snooze"), 10 * 60_000);

  function finish(kind) {
    if (stopped) return; stopped = true;
    clearInterval(again); clearTimeout(auto);
    try { speechSynthesis.cancel(); src?.stop(); el?.pause(); ctx.close(); } catch {}
    if (kind === "snooze") bridge.snooze(a.snoozeMinutes || 10); else bridge.dismiss();
  }
  $("snooze").onclick = () => finish("snooze");
  $("dismiss").onclick = () => finish("dismiss");
  addEventListener("keydown", (e) => { if (e.key === "s" || e.key === "S") finish("snooze"); if (e.key === "Escape" || e.key === "d" || e.key === "D") finish("dismiss"); });
  bridge.onClose(() => { stopped = true; try { speechSynthesis.cancel(); src?.stop(); el?.pause(); ctx.close(); } catch {} });
})();
