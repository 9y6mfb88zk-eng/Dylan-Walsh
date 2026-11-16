# JARVIS performance: measured before and after

Every number here was measured with the scripts in this repository on the same machine, before and after the change.
Nothing is estimated. Where a number could not be measured here, this page says so.

## Test machine and its limits

- Linux container: 4 vCPU Intel Xeon @ 2.30 GHz, no GPU.
- Chromium renders WebGL in software (SwiftShader). Every 3D frame is therefore drawn by the CPU, so CPU figures are
  far higher than they would be on your laptop's GPU.
- **Compare these numbers before vs after. Don't read them as what your laptop will use.**
- Reproduce with:
  ```
  PERF_W=1000 PERF_H=640 node scripts/perf-measure.mjs out.json
  ```
  Add `PERF_QUALITY=low` to measure the light tier.

## 1. Speech recognition (the biggest real-world improvement)

`node scripts/asr-bench.mjs <whisperDir> <parakeetDir>` uses:

- 12 real JARVIS commands
- 4 English voices: en-gb, en-gb-x-rp, en-us, en-gb-scotland
- 6 conditions, giving 288 recordings per model

Results: `docs/asr-benchmark.json` and `docs/asr-benchmark-with-cleanup.json`.

| Model (on the laptop, free, private) | Word error rate | Average decode time |
|---|---|---|
| Whisper base.en (before) | 11.4 % | 422 ms |
| **Parakeet TDT 0.6B v2 (now)** | **2.6 %** | **369 ms** |
| Parakeet + new audio clean-up | 2.6 % | 340 ms |

Word error rate by condition, Whisper → Parakeet + clean-up:

| Condition | Whisper (before) | Parakeet + clean-up (now) |
|---|---|---|
| normal | 4.6 % | 0 % |
| fast | 13.9 % | 1.9 % |
| slow | 2.8 % | 0 % |
| quiet (−24 dB) | 8.3 % | 0 % |
| noisy (10 dB SNR) | 31.5 % | 12.0 % |
| clipped | 7.4 % | 1.9 % |

The audio clean-up helps quiet speech (1.9 % → 0 %) but is slightly worse in heavy noise than Parakeet alone
(10.2 % → 12.0 %). It is kept because quiet, distant speech is the more common laptop problem.

Caveats:

- These are synthetic voices, not your voice.
- Use **Settings → Microphone & speech → Calibration** to measure accuracy with your own microphone and voice.
  It reports words correct, latency and confidence.

Microphone pipeline fixes (measured):

- **Resampler aliasing.** The old resampler folded a 12 kHz tone into the speech band at full strength (0.200).
  The new anti-aliased resampler leaves 0.0000.
- **Chunk edges.** Chunk boundaries no longer drop samples.

## 2. Command centre rendering

Viewport 1000×640. CPU is the total for all Chromium processes, so 100 % means one core. "Core fps" is frames the 3D
core actually drew.

| Situation | Before | After (auto) | After (light tier) |
|---|---|---|---|
| Active (pointer moving) | 358 % CPU | 354 % CPU · 8 fps | 349 % CPU · 12 fps |
| Idle on screen, 17 s without input | 381 % CPU | 374 % CPU · capped at 30 fps (drew 15) | 381 % CPU · 23 fps |
| **JARVIS visible behind another window** | **379 % CPU** | **246 % CPU (−35 %) · 10 fps** | **189 % CPU (−50 %) · 10 fps** |
| JS heap after 10 round trips Home ↔ Tasks | 11.2 → 11.2 MB | 11.2 → 11.2 MB (no leak) | 10.0 → 10.0 MB |
| WebGL cores alive after those round trips | not measurable before | 1 (disposed correctly) | 1 |

What changed:

- **Idle mode.** After 15 s without input while JARVIS is idle, the 3D core caps itself at 30 fps. It caps at 10 fps
  when you're working in another window. Decorative CSS animations pause.
  - Anything happening restores full rate at once: speech, a state change, the pointer or a key.
  - On a real GPU running at 60 Hz, this halves the core's frame work when idle on screen. In the background it cuts
    that work by about 6×. That GPU saving could not be measured here.
- **Faster automatic switch to the light tier.** Previously it needed 180 slow frames, which took over 20 s on a slow
  GPU. Now it decides within about 6 s.
- **Mission Control pauses the command-centre core** while it is open, so two WebGL scenes never render at once.
- **Measured finding:** hiding the 3D core alone, or turning off the CSS animations alone, changes nothing. Either one
  keeps the compositor busy. Turning off both drops idle CPU to 4 % (probe: `scratchpad/perf-probe.mjs`, run during
  this work). This is why idle mode handles both.

Not improved, and not claimed:

- **Active rendering cost.** Under software rendering each frame costs about 250 ms of CPU whatever the tier, so the
  frame cap rarely binds.
- **Startup time in this container.** The start-up overlay showed "System diagnostics 4–11 s" here. The server
  answered in 260 ms; the browser's main thread was blocked compiling the 3D core's shaders in software. On a real GPU
  shader compilation is fast. Measured server side, `/api/diagnostics` takes 258–262 ms even with 4 concurrent calls.

## 3. Server and API

Median of 15 calls; the "Before" and "After" columns are both auto quality.

| Endpoint | Before | After |
|---|---|---|
| `/api/home` | 5 ms | 7 ms |
| `/api/diagnostics` | 257 ms | 258 ms |
| `/api/tasks` | 4 ms | 3 ms |
| `/api/memories/profile` (new) | — | 2 ms |
| `/api/performance` (new) | — | 25 ms |
| Server start | 322 ms | 323 ms |
| Event-loop lag / DB query | 0.1 ms / 0.11 ms | 0.1 ms / 0.13 ms |

- `/api/diagnostics` takes 250 ms because it samples CPU use over 250 ms on purpose. The app calls it once a minute.
- Migration 008 adds indexes for the hot queries: open tasks by due date, due reminders, live notifications, alarm
  events, routine runs, API-call metrics and activity. At the current data size they make no measurable difference.
  They exist so queries stay fast as the data grows.

## 4. Live performance view

**Diagnostics → Performance · live** and the **Mission Control** telemetry show real measurements:

- AI response time: median and p95 over 24 h, from recorded calls
- Speech-recognition time: on the laptop vs cloud
- Database query time and event-loop lag
- Server memory, CPU and RAM
- The 3D core's real frame rate, quality tier and idle state
