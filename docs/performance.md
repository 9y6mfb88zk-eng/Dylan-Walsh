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

## JARVIS 6.4: startup sequence and performance pass

Same machine and method as above: a 1000×640 viewport, software WebGL. Raw data:
- `docs/perf-6.4-before.json` and `docs/perf-6.4-after.json`
- `docs/perf-6.4-startup-before.json` and `docs/perf-6.4-startup-after.json`

| Measurement | Before (5.0) | After (6.4) | Verdict |
|---|---|---|---|
| Freeze while converting 5 s of speech (phone/browser) | 380 / 463 / 400 ms | 8 / 16 / 11 ms | **Fixed:** moved to a background worker |
| Launch to usable (checks done, Command Centre loaded), 3 runs | 7.2 / 6.9 / 6.5 s | 8.3 / 6.5 / 5.3 s | About the same, while running 16 real checks plus 8 restore steps instead of 7 |
| Longest main-thread freeze during launch | 3.6 / 3.7 / 2.2 s | 4.6 / 3.2 / 3.7 s | Unchanged: WebGL context creation under software rendering. The async shader compile can't help here; untested on a real GPU |
| Network requests per idle minute | 1 | 1 | Already minimal |
| JS heap before → after 10 page switches | 11.9 → 11.9 MB | 11.2 → 11.2 MB | No leak |
| Server memory | 114 MB | 119 MB | +5 MB for the new routes and checks |
| API latency (median): home / tasks / diagnostics | 8 / 3 / 259 ms | 11 / 3 / 261 ms | Unchanged (diagnostics samples CPU for 250 ms on purpose) |
| Chromium CPU with JARVIS behind another window | 352 % | 315 % | Within run-to-run noise here |

The reload time of the Command Centre (2.1 s → 0.5 s in these two runs) is not claimed. Earlier runs of the same code ranged from 0.8 to 3.5 s.

**On your laptop**, see the real numbers in:
- **Diagnostics → Last startup** (every check with its time)
- **Diagnostics → Performance · live**
- **Settings → Performance** (the 3D core's start-up time)

## JARVIS 6.5: Global Operations

Measurement setup:

- Script: `GOC_AIRCRAFT=12000 GOC_MINUTES=4 node scripts/perf-goc.mjs`.
- Stand-in providers: 12,000 synthetic aircraft, so the real services take no load.
- Same container as above: software rendering, 1600×960.
- Raw data: `docs/perf-6.5-goc-before-fix.json` (first run) and `docs/perf-6.5-goc.json` (after the polling fix).

| Measurement | Result |
|---|---|
| Map redraw, worldwide (9,704 aircraft loaded, drawn as about 190 clusters) | 14.7 / 12.9 ms median in two runs (max 34 ms) |
| Map redraw, Europe (individual aircraft, about 550 drawn) | 1.9 / 1.7 ms median |
| Map redraw, Cyprus (12 aircraft, labels) | 8 ms median |
| JS heap over a 4-minute session with flights polling | 10 MB at every 30 s sample: no growth |
| Heap after leaving Mission Control / Leaflet maps left alive | 10 MB / 0 |
| Provider requests during the 4-minute session | OpenSky 2, ADSB.lol 4 (including the 3 privacy lists), one per view change; nothing per aircraft |
| Window hidden for 90 s | 0 provider requests |
| Server memory / event-loop lag | 140 MB / 0.2 ms |
| Mission Control activation to "active" | about 10 s here (software rendering; includes the real checks) |

**Change made from the measurement:** Mission Control kept polling diagnostics for its panel views even while Global
Operations, which reads diagnostics itself, was on screen. Each `/api/diagnostics` call samples CPU on the server for
250 ms. After the fix, measured over the same 4 minutes:

| | Before | After |
|---|---|---|
| `/api/diagnostics` calls | 24 | 12 |
| All API requests per minute | 22 | 18.8 |
| API requests while hidden (90 s) | 5 | 1 |

Not improved, and not claimed:

- **Chromium CPU:** 378 % in both runs, and 375 % with flights switched off. Here the cost is the software-rendered
  3D core and compositor, not the map or the aircraft (turning flights off changed nothing measurable).
- **Panning:** 6–8 fps while dragging, for the same reason.
- Neither number says anything about a real GPU, which this container lacks.

## JARVIS 6.6: Mission Control operations

Measured with `node scripts/perf-ops.mjs` (stand-in providers, 3,000 synthetic satellites; same container, software
rendering). Raw data: `docs/perf-6.6-ops.json`.

| Measurement | Result |
|---|---|
| Orbit: full map redraw with 3,000 satellites loaded (941 in view) | 17.6 ms median |
| Orbit: main-thread stalls > 50 ms over 6.5 s of 2-second position updates | none |
| API requests per idle minute (Orbit / Blackbox / Wayfinder / Sentinel open) | 18 / 20 / 18 / 20 — of which 12 are the existing live system readings. The operations themselves add ≤ 2 (records and events refresh) |
| CelesTrak downloads during the whole 5-minute run | 2 (one per group; then served from the 2-hour cache) |
| JS heap before → after 20 operation switches | 15.2 → 15.2 MB (no leak); one Leaflet map throughout |
| Server memory | 140 MB (unchanged from 6.5) |

No optimisation was made because nothing measured needed it. Very large satellite groups are limited to 1,500
objects on the map by design.
