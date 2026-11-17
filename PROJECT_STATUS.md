# JARVIS — Project status

_Last updated: 2026-11-17 — JARVIS 6.6 (Mission Control operations: Blackbox, Wayfinder, Sentinel, Orbit and the Global Situation Report; includes every earlier upgrade)_

This file is the hand-over document for the "JARVIS — Ultimate Upgrade & Redesign" specification. It lists what is done,
what remains, known problems, technical decisions and exactly how to continue.

## Existing architecture (inspected before the upgrade)

| Layer | Technology | Where |
|---|---|---|
| Backend | Node 22, Express 5, `ws`, SQLite via `node:sqlite`, numbered SQL migrations | `server/` |
| AI | Anthropic Claude (Messages API, tool use, web search, structured output) | `server/brain.js` |
| Speech | Local Parakeet TDT 0.6B v2 (sherpa-onnx; Whisper base.en still supported) → OpenAI Whisper fallback; ElevenLabs/OpenAI TTS → system voice fallback | `server/local-asr.js`, `server/voice.js` |
| Web app / PWA | Vanilla ES modules, no build step, strict CSP | `public/` |
| Windows app | Electron 33: tray, bundled Node 22 + server, wake word (openWakeWord ONNX + sherpa-onnx KWS), allowlisted actions | `desktop/` |
| Data | `%APPDATA%\JARVIS\data\jarvis.db` (laptop) or `/data/jarvis.db` (cloud) | |
| Tests | `node --test` backend/finance/ASR, Playwright UI, Electron E2E (dev + packaged) | `test/`, `desktop/test/` |
| CI | GitHub Actions: Linux tests, Windows tests, bundle smoke test, installer build + release | `.github/workflows/ci.yml` |

## Technical decisions for the upgrade

1. **Stay on Electron (not Tauri).** Electron already ships, is tested end-to-end, and its main process is a natural
   always-running background agent (alarms, wake word, actions) independent of the visible window. Tauri would need a
   Rust rewrite of the desktop agent with no functional gain for this project.
2. **Stay on SQLite + numbered SQL migrations (not Prisma).** The migration runner works and needs no native query
   engine. Added: automatic database backup before any pending migration is applied.
3. **The desktop agent is the Electron main process**, separate from the UI window: it owns alarm scheduling/ringing,
   wake word + conversation audio, computer actions, Windows notifications, Windows Task Scheduler wake tasks, and keeps
   its own authenticated WebSocket to the backend.
4. **3D rendering with Three.js (vendored, no CDN)** so the app works offline and under the strict CSP. 2D fallback
   when WebGL is unavailable; animation quality setting (high / balanced / low / off).
5. **The backend stays the single source of truth** (alarms, tasks, memory, routines…) so laptop and iPhone always agree.

## Phase plan and status

| Phase | Scope | Status |
|---|---|---|
| 1 | Inspect app, plan, pre-migration backups | ✅ done |
| 1b | Backend for every section: migration 007, services, routes, scheduler, AI tools, streaming chat (`/api/chat/stream`) | ✅ done |
| 2 | Design system (navy/cyan HUD, vendored fonts), shell, collapsible sidebar (21 sections), Ctrl+K palette, mobile nav | ✅ done |
| 3 | 3D JARVIS core (Three.js r170, bloom, 8 event-driven states, quality tiers, 2D fallback) + dimensional UI (parallax, tilt) | ✅ done |
| 4 | Command Centre homepage + live diagnostics (real checks, test buttons, history, logs, laptop mic/speaker tests) | ✅ done |
| 5 | Alarm engine + Windows background agent + full-screen alarm window (verified audio, gradual volume, speech) + Task Scheduler wake task | ✅ done (Task Scheduler verified in CI only) |
| 6 | Continuous conversation, streamed replies spoken per sentence, barge-in, local voice commands, live (partial) transcription, Whisper silence filter | ✅ done |
| 7 | AI tools for every section + Intelligence Centre (folders, comparisons, saved sources) + documents | ✅ done |
| 8 | Computer control (create folder, screenshot, windows, clipboard, lock, system status, action log; close needs confirmation) | ✅ done |
| 9 | Calendar (day/week/month, recurring, search, Google confirmation), tasks (categories, progress), reminders (repeat, snooze) | ✅ done |
| 10 | Money (manual entries reconciled with the bank feed, goals, debts, reports, projections) + Monzo/Google connect fix | ✅ done |
| 11 | Business (pipeline, clients, interactions, proposals with AI drafts, invoices, expenses) + project workspaces | ✅ done |
| 12 | Memory + notes + conversation history | ✅ done |
| 13 | World (3D globe, local times, weather comparison) | ✅ done |
| 14 | Automations (built-in morning/evening/weekly + custom routines, run history) + Home Assistant (allowlist, read-back) | ✅ done |
| 15 | Focus (Pomodoro), goals with milestones, habits with streaks | ✅ done |
| 16 | Notification centre (read, snooze, dismiss, history, per-kind phone settings) + mobile layouts | ✅ done |
| 17 | Settings (profile, personality, voice & conversation, appearance, alarms & focus, your data: export / delete with backup) | ✅ done |
| 18–20 | Full test pass, fixes, installer build, docs | ✅ done (installer built by CI) |

## Personal Intelligence, Voice Enhancement & Performance upgrade

The existing design, navigation, colours, 3D core and panels are unchanged. Everything below is added to them.

| Phase | Scope | Status |
|---|---|---|
| 1 | Inspect, find real bugs (list below) | ✅ done |
| 2 | Personal profile and memory: 13 categories, editable starting profile (only the facts you gave, marked as possibly out of date), always-available profile block, synonym and category search, ask before remembering, `correct_memory`, memory off switch, Memory page (profile by category, recent updates, search, export, mode) | ✅ done |
| 3 | Microphone recognition: Parakeet replaces Whisper base.en; anti-aliased resampler; hysteresis VAD with adaptive noise floor and longer endpointing; clean-up before decoding; confidence estimate; calibration page; settings for noise suppression, echo cancellation and AGC | ✅ done |
| 4 | Continuous conversation: low-confidence speech gets "could you say that again?", not a guess; duplicate-request guard | ✅ done |
| 5 | Personality: five voice modes, formality/humour/cinematic levels; cinematic wording is decoration only | ✅ done |
| 6 | Diagnostics at nine levels (quick, full, voice, AI, network, security, performance, hardware, integrations), narrated from real results, stored history, system awareness (`system_status`), laptop process list, proactive integration-failure alerts | ✅ done |
| 7 | Mission Control (voice, palette, Esc) and command macros (voice trigger phrase, interface and systems-check steps, spoken confirmation for consequential steps, two examples) | ✅ done |
| 8 | Session history timeline (search, filter, clear); voice modes switchable by voice; Focus mode lets only important notices interrupt | ✅ done |
| 9 | Performance: measured first; idle mode for the core and CSS; faster light-tier switch; Mission Control pauses the home core; live performance view (`docs/performance.md`) | ✅ done |
| 10 | Bug fixes (below) | ✅ done |
| 11 | Tests: +12 backend, +14 UI, unit tests for interface commands | ✅ done |

### Bugs found and fixed

| # | Bug | Effect | Fix |
|---|---|---|---|
| 1 | Microphone resampler had no anti-aliasing and dropped samples at chunk edges | Hiss and high-frequency noise folded into the speech band (12 kHz tone → full-strength alias) | Windowed-sinc streaming resampler (alias 0.200 → 0.0000) |
| 2 | Single fixed VAD threshold | Clicks started recordings; short pauses cut sentences off | Hysteresis plus adaptive noise floor; 1.2 s endpoint (1.8 s for very short speech) |
| 3 | Whisper base.en accuracy | 11.4 % word errors (31.5 % in noise) | Parakeet TDT 0.6B v2: 2.6 % (12 % in noise), faster |
| 4 | Last word often truncated; quiet speech lost | Wrong commands | Tail padding, high-pass, normalisation of quiet speech |
| 5 | No confidence signal | Misheard speech acted on | Confidence estimate; low confidence → asks to repeat |
| 6 | Memory search was keyword-only | "What was that business idea?" found nothing | Profile block always in context, synonyms, category boost |
| 7 | Old humour setting ("dry"/"none") vs new numeric levels | Prompt would have said "Humour: undefined" | Legacy values mapped to 0–3, input clamped |
| 8 | Times shown in the browser's time zone, not JARVIS's | Mission Control and lists disagreed with the clock when they differ | `setDisplayTz` from settings for every formatted time |
| 9 | Memory `updated_at` had one-second resolution | "Recent updates" order wrong for edits in the same second | Millisecond timestamps, id tie-break |
| 10 | Auto light-tier switch needed 180 slow frames | Slow GPU laptops stuttered for over 20 s | Decides after ~6 s |
| 11 | Same request sent twice (double Enter, echoed wake) | Duplicate actions | 4 s duplicate guard in `conversation.ask` |
| 12 | Start-up overlay faded in over the app | The app flashed before the sequence | Opaque from the first frame |
| 13 | Start-up showed the AI as ✓ when only configured | Claimed a check that hadn't run | Amber "configured · not verified yet"; closing line says so |

### Known limitations (honest)

- **Speech accuracy:** benchmarked on synthetic voices, not your voice. Use **Settings → Microphone & speech →
  Calibration** to measure it on your own microphone.
- **Language:** Parakeet v2 is English-only. Other languages fall back to OpenAI Whisper, if a key is set.
- **Confidence:** a heuristic (audio level, clipping, noise, speech length versus words, repetition). The model gives
  no probability, and the UI labels it as an estimate.
- **Not run on Windows here:** the laptop process list (PowerShell `Get-Process`) and Windows audio constraints. The
  Linux path was run and works.
- **Rendering CPU:** measured under software WebGL. Real-GPU savings from idle mode are expected but could not be
  measured here (`docs/performance.md`).
- **Installer size:** the Parakeet model makes the installer about 500 MB larger than with Whisper base.en.
- **Intermittent speech test:** `test/local-asr.test.js` ("transcribes speech on this machine") failed once in four full-suite runs. It passed every time when run alone; the cause wasn't captured.
- **Intermittent E2E failure:** the Electron end-to-end test failed once in five runs ("Target page, context or browser
  has been closed") and passed 28/28 on the other four.

## Mission Control transformation mode

| Requirement | How it's done |
|---|---|
| Activation | Voice ("JARVIS, activate Mission Control", local, no AI round trip), the top-bar button, the palette |
| Stage 1 | Command Centre panels dim; the same core switches to the violet palette with a brightness boost and shock-wave; purple energy pulse (transform/opacity only); banner "ACTIVATING MISSION CONTROL" |
| Stage 2 | Panels slide out towards their side; the sidebar swaps to Mission Control navigation (staggered); the core canvas itself moves (FLIP) into the Mission Control layout, so no second WebGL scene; architecture unfolds, diagnostics slide in, map expands, operational panels rise |
| Stage 3 | Five real checks, run in parallel with the animation and shown in order: architecture (`/api/diagnostics`), AI core (real `models.retrieve` test), voice interface (speech recognition, voice output, wake word), local connections (WebSocket, Windows agent, devices online), operational overview (home, notifications, activity). A line is green only if it passed; final line "Mission Control ready" or "active — N need attention" |
| Stage 4 | Live layout; polling only for visible panels (resources 3 s, diagnostics 20 s, processes 15 s in the Windows app, the rest 60 s and on server change events) |
| Layout | Ten areas on the overview: core, operational overview, active operations, architecture, live diagnostics, world map, resources, intelligence, communications, activity. Plus processes, projects and personal operations for their sections |
| Navigation | Nine sections in the sidebar (tab bar on phones). FLIP re-layout between sections. Voice: "show system architecture". "Open …" buttons leave Mission Control (reversed) and open the normal page |
| Real data only | Every panel reads existing endpoints; unavailable data is labelled. New: `/api/devices` reports which devices are online now |
| Deactivation | Voice, button, Esc, sidebar Exit: panels fold away, navigation swaps back, the core flies back to the Command Centre and returns to cyan |
| Not interrupted | Alarms (overlay above), conversations (core and caption keep working; the command box sends to JARVIS), background services, the duplicate guard. Opening any other page leaves Mission Control instantly first |
| Performance | Web Animations API on transform/opacity only; glass blur off while panels move; no new libraries; the map is a 2D canvas redrawn once a minute; CSS animations pause in idle mode |
| Reduced motion | Same stages, checks and layout with no movement (verified: no animations on Mission Control elements) |

Measured here (software WebGL, no GPU):

- JavaScript work during the transformation is small: the longest main-thread task was 64 ms.
- The animation itself is designed to take ~2.3 s, but here frames come at 1–2 fps, so stages 1–4 took 7–8 s, mostly waiting for frames.
- On a real GPU the animations run at display rate. That could not be measured here.

## JARVIS 6.4: startup sequence and performance pass (Parts 9–11)

Only Parts 9–11 of this specification were received. "World Explorer" is treated as the existing World section (3D globe, your places, live times and weather); no map-tile explorer was built.

### Part 9: startup (implemented and tested)

| Requirement | Done |
|---|---|
| Dedicated initialisation screen before the Command Centre | `public/js/startup.js`: black screen, white J.A.R.V.I.S., violet monospace log, scan line, drifting particles (30 fps canvas), purple energy pulse, status lights, progress bar, blinking cursor |
| Stage 1, power on | Fade from black, branding, energy pulse, start-up sound |
| Stage 2, system check | 12 server checks (`server/services/boot.js`, `/api/boot/check/:name`) plus 4 device checks, all started together and shown as each result arrives. Server: runtime, OS, hardware (CPU and memory sampled), database (real query), storage (real write), AI (real Anthropic call), speech recognition (model readiness, then a real test decode), cloud voice (account check), scheduler, notifications, weather (real request), calendar. Device: microphone (device count and permission shown separately; on Windows, the wake-word agent), speech synthesis (system voices plus the cloud result), World Explorer (local map data plus live place data), 3D rendering (WebGL and the real GPU name; software rendering flagged), neural core (ready only after a frame is drawn) |
| Statuses | operational, connected, degraded, not configured, permission required, offline, failed, initialising. "Initialising" is re-checked until ready (up to 45 s) and is never turned into a pass |
| Stage 3, AI initialisation | 8 items, each restoring something real: engine, configuration, memory (fact count), preferences, tasks, reminders and alarms, voice interface, neural core, and the Command Centre (panels loaded underneath) |
| Stage 4, summary | Worked out from the results: a critical failure (runtime, database, storage) gives FAILED; another failure or offline gives ATTENTION REQUIRED; degraded, permission or initialising gives LIMITED SERVICES; otherwise OPERATIONAL. Optional integrations that aren't set up are listed but don't lower the status |
| Stage 5, enter | "ALL AVAILABLE SYSTEMS INITIALISED.", a greeting from the real time of day, "TAP ANYWHERE TO WAKE JARVIS". A tap fades into the already-built Command Centre with no reload (verified: one navigation), and the core pulses |
| Sound | Web Audio synthesis (`public/js/sounds.js`): power-on sweep, check ticks, rising energy tone, activation chord. Original, no files, no paid services. Reported as "playing" only when a real signal is measured leaving JARVIS. Blocked autoplay is reported as blocked and plays on the tap. Launching hidden at Windows sign-in defers sound. The Electron main window allows autoplay. Each sound was rendered offline and measured |
| Failure handling | Each failed component is listed with a plain explanation and an Open diagnostics button. Tested with the server unreachable: SYSTEM INITIALISATION FAILED, runtime marked critical |
| Returning sessions | State is restored by reading only (the server is the single source of truth), so nothing is duplicated. The scheduler cannot be started twice |
| Settings → Startup | Cinematic, Minimal or Off; skip animation (checks still run); full diagnostics; open automatically; sounds; silent startup; reduced audio; volume; Test sound; Start with Windows; run the startup again |
| Consistency | The Command Centre status line counts startup problems. Diagnostics shows the last startup report |

### Part 10: performance (measured first)

See `docs/performance.md` → "JARVIS 6.4" for every number.

- **Baseline:**
  - idle traffic was already 1 request a minute;
  - memory was stable after 10 page switches;
  - server-side diagnostics take 0.27 s even on a cold start.
- **The real startup problem:** a single 2.2–4.2 s main-thread freeze when the 3D core first renders. Most of it is creating the WebGL context under this container's software renderer.
- **Changes, each measured where possible:**
  - Speech audio conversion moved to a background worker. Interface freeze during a 5-second recording dropped from 380–463 ms to 8–16 ms.
  - Core shaders compile asynchronously (`renderer.compileAsync`). There's no benefit under software rendering; it's the standard fix on real GPUs, but not verified on one.
  - Startup checks run in parallel, with per-check timeouts.
  - Per-stage core timings (`window.__jarvisCore.timings`) appear in Diagnostics and Settings → Performance.
  - The scheduler can't run twice.
  - New performance settings: quality (adding Medium), particle density, bloom intensity (0 turns it off), background update frequency, map quality.
- **Not changed:** the app has no React, so React render work doesn't apply; DB queries are already 0.1–0.3 ms, with indexes from migration 008.

### Test results (6.4)

- Backend: 80/80, including 4 new start-up tests (AI outage reported as failed; settings validated).
- Desktop unit: 13/13.
- UI: 111/111. Covers the start-up stages and real statuses, a summary that matches the results, a tap into the Command Centre with no reload, skip plus auto-open, reduced motion, the phone, and the Startup and Performance settings.
- Electron end-to-end: 28/28.
- Sound: each of the four sounds was rendered offline and produced a real signal (peaks −21 to −40 dBFS at 60 % volume before the level increase).

### Not done or not verified

- **Real hardware:** the startup sound on real speakers; real-GPU frame rates and the async-compile benefit; Windows-only checks (wake-word agent status, the Windows 11 name and build, the GPU name on your laptop).
- **Map-tile World Explorer:** not part of the parts received.

## JARVIS 6.8: natural conversation, living personality and visual refinement

No new AI provider, no model change and no paid service. Claude, the app and its layout are unchanged; the
conversation, voice, recognition and look are improved. Full description: `docs/voice.md`. Measurements:
`docs/performance.md` → "JARVIS 6.8".

### Inspected first

| Area | Already there | Changed in 6.8 |
|---|---|---|
| Personality | Prompt with modes, formality, humour and cinematic sliders | Rewritten for natural speech: direct answers, no stock phrases or narration, length matched to the question, varied openings, tone illustrations. "Sir" frequency setting, enforced turn by turn |
| Conversation | Continuous session after "Hey JARVIS"; end/stay/listen/repeat/mute; interrupt by saying "JARVIS" | Interruptions recorded (what was heard); AI request cancelled on interrupt; "Wait…" / "Hold on…" interrupt on the laptop; "speak more slowly / faster", "be brief" |
| Context | Last 20 turns plus a running summary | What was looked up for recent replies; interruption details; "be brief"; no memory search for short remarks |
| Memory | Ask-before-remember, categories, edit/delete UI | Long-conversation summaries no longer copied into long-term memory unless turned on |
| Voice | ElevenLabs/OpenAI/browser, sentence-by-sentence | Free local Piper voice; provider choice (only usable ones offered) with previews; speed; volume; pronunciations; shared text clean-up |
| Recognition | Parakeet on the laptop, VAD endpointing, calibration, confidence | Background gate against other talkers (measured); live microphone status; device-change refresh |
| Look | Mission Control restrained, Command Centre brighter and rounder | Refinement layer: restrained palette, smaller radii, finer borders, no glowing outlines, consistent type, tabular numerals, softer core atmosphere; microphone privacy chip; core "Fault" state; subtle conversation sounds |

### Testing

| Suite | Result |
|---|---|
| Conversation tests (`test/conversation.test.js`) | 15 / 15, including the local voice (run with `JARVIS_TEST_TTS_DIR`) |
| Server and unit tests (`npm test`) | 121 passed, 0 failed, 1 skipped (the local voice test needs the model path) |
| Desktop app tests | 13 / 13 |
| UI checks (`npm run test:ui`) | 156 / 156 on the final run. New checks: an interrupted reply stops in about 1 ms and the heard text is recorded; the core's Fault state appears and clears; Settings offers only usable voices; form of address; the microphone chip |
| Layout audit, every tab at 1536×864 | Clean (Diagnostics honestly reports "no microphone" on this machine) |
| Speech recognition with noise (`scripts/asr-noise.mjs`) | `docs/asr-noise-6.8.json` |
| Earlier recogniser benchmark (`scripts/asr-bench.mjs`, gate off/on) | Identical: 2.6 % overall, 0 % quiet speech |
| "Wait" / "Hold on" keyword spotting on synthesised speech | 8 / 8 detected; "Stop" dropped (0 / 2, plus a false trigger) |

### Not verified

- **Your real Claude account:** the personality and context changes were tested with a stand-in AI. The prompt Claude receives is verified; how natural Claude's replies sound is not.
- **Your voice and microphone:** recognition was measured with synthesised speech and synthetic noise, and the keyword spotter with synthesised speech.
- **Echo of JARVIS's own voice through laptop speakers:** handled by the echo guard and Windows echo cancellation, but not measured on real hardware.
- **Speakers:** sounds and voices were measured as audio data. This machine has no audio output.

## JARVIS 6.7: Mission Control refinement, bug fixes and interaction upgrade

No redesign: the same look, layout, colours and features, with the bugs fixed and the transitions, sounds and map
workspace upgraded. Measurements: `docs/performance.md` → "JARVIS 6.7".

### Reproduced before fixing (1366×768 and 1536×864)

- **Global Events couldn't scroll:** the filters and source list filled the column, leaving the event list a 33 px
  window for 618 px of content. On a laptop at 125 % scaling only one event was visible.
- **The core went missing after Mission Control:** the Command Centre destroyed its core whenever it was left and built
  a new one on return. Exit button: about 0.7 s with no core. Palette and browser Back: 5–6 s while a new 3D core was
  built.
- **Below the window:** the bottom status panels were cut off at the bottom of the screen.
- **Map controls in Leaflet's light theme:** a blank white zoom-out button at minimum zoom and a white attribution box.
- **Status pills read "AI …" and "SYSTEMS …"** until the checks had finished.

### What changed

| Area | Change |
|---|---|
| Core | One core (`public/js/corehost.js`): one canvas and one WebGL context, created once and moved between the Command Centre, Mission Control's core panel and an off-screen holder. It is never rebuilt on navigation and never duplicated, and it pauses when off screen |
| Enter transition | About 1.5 s at normal speed. The Command Centre dims, the core brightens and speeds up, and an energy pulse goes out. The panels slide away and the core travels into its panel. The map expands, the side and bottom panels slide in staggered, and the status indicators light up. It is interactive at that point; the real checks finish in the core panel afterwards |
| Exit transition | The reverse, about 1 s. Panels retract, the map recedes, the core travels back and the Command Centre panels return. Each step has a time budget, so a slow machine can't stretch it |
| Sounds | Original Web Audio synthesis, no files. Enter: low activation tone, three beeps, rising sweep, confirmation tone. Exit: descending tone, two beeps, settling tone. Nothing plays before you've interacted with the page; a blocked audio device is skipped silently |
| Settings → Interface | Transitions on/off; speed (fast, normal, slow); sounds on/off; sound volume with test buttons; reduced sound; silent mode; reduced motion; reduced visual effects; automatic map resize; map animations. All saved on the server and applied immediately |
| Layout | The Global Operations grid is sized from where it starts on the page, so it ends exactly at the bottom of the window. Each column scrolls on its own, with thin scrollbars |
| Global Events | The header, count, Filters and Sources buttons stay at the top. Filters and the source list fold away (open by default only on tall screens). The list takes the remaining space and loads every result in batches of 60 as you scroll |
| Bottom panels | They adapt to narrow widths (container queries) instead of breaking words. CPU, RAM and lag show their current values. Network shows "checking…" instead of an empty box. Between 1025 and 1360 px wide they scroll sideways in their strip rather than taking the map's height |
| Map | Dark zoom and attribution controls. The Layers panel never runs off the map. An Expand map button gives the map the whole workspace (the core keeps running) |
| World Explorer | The same map as a larger workspace with no bottom row. Search countries, cities and places (Open-Meteo geocoding). The selected location shows local time, weather, country facts, UK travel advice and the nearest airports (free sources, each named). Save places and remove saved ones. Click anywhere to identify the country, offline from the Natural Earth boundaries. Saved places appear on the map |
| Transitions | Panels sliding in or out no longer flash a horizontal scrollbar |

### Bugs found while testing (also fixed)

- **A click during an exit was lost:** while Mission Control was still closing, the Mission Control button ignored
  clicks, so it needed a second click. It now reopens once the close finishes. The sidebar swap also has a time
  budget, so a slow frame rate can't hold the close open.
- **Operation commands during loading (6.6 bug):** "Show available public city webcams" sent straight after "Open
  Operation Sentinel" started a second copy of the workspace. The command's results landed in the replaced copy
  (JARVIS said 7 cameras were listed; the panel showed none). One load is now shared.
- **Start-up flight check:** Mission Control's map is now built while hidden, so the first flight request saw a
  zero-size map and the check reported "flight layer off". The check now waits for the real first result.

### Testing

| Suite | Result |
|---|---|
| Server and unit tests (`npm test`) | 107 / 107 |
| Desktop app tests | 13 / 13 |
| UI checks (`npm run test:ui`) | 149 / 150. The one failure, event filters squeezing the list at 1280×800, was fixed afterwards and checked on its own: the list keeps 216 px with filters and sources open |
| Layout audit, every Command Centre and Mission Control tab at 1280×720, 1366×768, 1536×864 and 1920×1080 | No clipped content, unreachable scroll areas or horizontal overflow. Diagnostics honestly reports "no microphone" on this machine |

New UI checks:
- the single core across the Exit button, Mission Control button and palette routes, repeated: one canvas, drawing,
  back in the Command Centre, no second click;
- enter and exit timings;
- enter and exit sounds rendered offline: audible, volume changes the level, reduced is quieter;
- interface settings validation, and transitions off giving an instant switch;
- the Global Events list reaching its last item, and the filters;
- map zoom and the dark controls;
- World Explorer search, save, click-to-identify and expand.

### Not verified

- **Real GPU hardware:** this machine renders WebGL in software (about 5 frames a second). The timings are wall-clock
  and the frame rate is far lower than on your laptop.
- **Sound through speakers:** the sounds are verified by rendering them offline and measuring their level. This machine
  has no audio output.
- **Touch scrolling on a real touchscreen:** the event list uses native scrolling (`touch-action: pan-y`) and was only
  tested with mouse-wheel and programmatic scrolling.

## JARVIS 6.6: Mission Control operations (Blackbox, Wayfinder, Sentinel, Orbit)

Full description, every data source and key, and limitations: `docs/operations.md`.

### Before coding

- **Inspected:** Mission Control, Global Operations, the shared Leaflet map, Global Events, flight tracking, the
  SQLite migrations, the voice and AI tool architecture.
- **Backups:** a full git bundle of the repository was made before any change. The database migration runner copies
  your database before applying migration 009.

### Architecture: one Mission Control

- **The operations are Mission Control sections** (`op-blackbox`, `op-wayfinder`, `op-sentinel`, `op-orbit`) inside
  the existing Global Operations display.
  - They share the core panel, the one Leaflet map, the status panels and the voice line.
  - Each workspace is lazy-loaded into the right-hand column (`public/js/ops/*.js`).
  - There is no second map, dashboard or database.
- **Shared data:** one `op_records` table, used by every operation and the situation reports, behind `/api/ops/*`.
- **Shared map layers:** dossier places, trip routes and places, webcams and watch areas, satellites. Each has its own
  toggle in Layers and is switched off when you leave its operation.

### Stages

| Stage | Result |
|---|---|
| 1. Operations navigation | Mission Control sidebar gains an "Operations" group; the phone gets the same in its tab bar. Returning to Global Operations needs no restart |
| 2. Blackbox | Reference lookups plus AI web research produce a structured dossier. Citations are checked against the source list; uncited claims are labelled interpretation; places are geocoded; private individuals are refused. Notes, tags, extra sources, compare, re-run, delete, PDF |
| 3. Wayfinder | Destination research (forecast, FCDO, airports, country facts), AI-drafted plan (labelled), OSRM routes, manual flights with live ADS-B status, budget, checklist, emergency contacts, check-in reminders, PDF |
| 4. Sentinel | NASA EONET and FAA sources, finer verification labels, watchlists with alerts and quiet hours |
| 5. Webcam registry | 7 operator-published YouTube cameras, verified with the YouTube Data API (free key); Windy timelapse players (free key); conflict countries excluded |
| 6. Orbit | CelesTrak OMM (cached ≥ 2 h), SGP4 positions labelled calculated, ISS, ground tracks, 3D orbits, SWPC and DONKI space weather, Launch Library launches |
| 7. Global Situation Report | Compiled from every operation; each line labelled with its data kind, source and time; saved; PDF |
| 8. Voice | Instant commands for the fixed phrases; the `mission_operations` AI tool for the rest; the chat receives what's on screen |
| 9. Testing | See below |
| 10. Performance | See `docs/performance.md` → "JARVIS 6.6" |

### Not verified

- **Live YouTube camera status:** needs your free key; YouTube refuses this cloud machine.
- **Windy cameras:** need your free key.
- **NASA EONET live:** its server returned HTTP 500 throughout testing.
- **Dossiers with your real Anthropic account:** tested with the stand-in AI here, which has no Anthropic key.
- **Printing to PDF:** checked as the print view only.

## JARVIS 6.5: Global Operations (Mission Control redesign)

Full description, data sources, limits and licences: `docs/global-operations.md`.

### Inspected before building

- **World Explorer:** the existing World section, a 3D globe of your places with live times and weather. It's kept
  unchanged; Global Operations reuses its globe for the 3D view.
- **Global Events / war tracker:** **did not exist.** The brief asked to preserve it, but there was nothing to
  preserve, so it was built new: `server/services/events.js`.
- **Mission Control:** extended rather than replaced. The nine earlier sections remain; Global Operations is the new
  first section.

### What was built

| Part | Implementation |
|---|---|
| 1. Visual identity | `.goc` styles: near-black, navy and graphite, steel-blue lines, little cyan or violet, red and amber only for real alerts (emergency squawks, GDACS red alerts, failures). Fine 1 px borders, compact mono labels, no glow |
| 2. AI core | The same live 3D core moves into a dedicated left panel (about 200 px), with state, caption and command line. It reacts to voice, thinking and Mission Control exactly as before |
| 3. Layout | Top strip (brand, local/UTC/places clocks, AI, network and systems status); left (core plus systems: AI, voice, database, background services, World Explorer, events feed, flight data, CPU, RAM, GPU, frame rate); centre map; right events feed; bottom panels (flights, imagery, event activity, system timeline, network, recent operations) |
| 4. Global Events | GDACS, USGS, GDELT, plus ReliefWeb and UCDP with free credentials. Every item carries its source link, event, publication and retrieval dates, location accuracy and a verification label. Filters: category, country, region, date, source, verification |
| 5. Flights | ADSB.lol for views up to 250 nm, OpenSky for wider ones. Allowance-aware caching, backoff and deduplicated in-flight requests. Military, LADD and PIA aircraft are hidden. Canvas rendering with clustering. Card, search (callsign, ICAO24, registration), filters (type, altitude, region), trails from observed positions, follow |
| 6. Voice | Instant local commands for the phrases in the brief; the AI's `global_operations` tool for anything needing a lookup. Answers come only from retrieved data, and "not visible in the available data" when a flight isn't found |
| 7. Layers | Standard (OSM, darkened), satellite (Sentinel-2 cloudless), satellite latest day (NASA MODIS), terrain (OpenTopoMap), relief (NASA Blue Marble), OSM, country boundaries (Natural Earth), country names, events, conflict-only, flights, trails, weather radar (RainViewer), 3D globe. Tiles go through JARVIS's own disk cache (`server/services/tiles.js`) |
| 8. Activation | The core brightens and speeds up; the screen dims; the map expands; the core column locks in; the events column and status panels follow; real checks for flight data and events. JARVIS says "Mission Control is online, Sir. Global operations interface ready." only if every check passed; otherwise it names the services needing attention |
| 9. Free only | Each provider's pricing, limits, licence and registration was checked. CARTO now needs a key, so it was dropped. Esri was not used (terms unclear). The GDELT GEO API is retired. ReliefWeb and UCDP need free credentials and stay "not configured" without them |
| 10. Testing | See the results and measurements below |

### Test results (6.5)

- **Backend:** 94/94. New tests: 13 Global Operations tests against stand-in providers, the AI flight tool, and the
  voice phrases from the brief.
- **Desktop unit:** 13/13.
- **UI:** 123/123. New checks cover:
  - the Global Operations layout and the core panel;
  - honest activation checks and the announcement;
  - aircraft on the map, the aircraft card, and "not visible" search;
  - "Hide flight tracking", and "Show me aircraft around Cyprus" with the real count;
  - the event detail and its source link;
  - all 12 sections, the phone layout and exit.
- **Live smoke test against the real providers, from this container:**
  - ADSB.lol: 14 aircraft around Cyprus, 2 hidden by privacy rules.
  - OpenSky: about 2,450 over Europe, about 5,950 worldwide.
  - GDACS: 87 events. USGS: 107 earthquakes.
  - All 8 tile layers return images.
  - The aircraft card showed a real A330 (TC-JDR) with registration and type.
- **Performance:** see `docs/performance.md` → "JARVIS 6.5".

### Not verified

- **GDELT live:** this cloud container gets HTTP 429 for every request, even spaced minutes apart. It should work from
  a home connection. Tested with a stand-in.
- **ReliefWeb and UCDP live:** they need your approved appname and token.
- **Real-GPU frame rates and map smoothness on your laptop.**

## iPhone

- **How it's delivered:** an installable Home Screen web app (PWA), served from the laptop over Tailscale with HTTPS. A native or App Store build would need an Apple Developer account and a Mac; it's not possible from here.
- **Added in this round:**
  - In Safari, JARVIS shows how to add itself to the Home Screen (iPhone/iPad detection; separate wording for Chrome/Firefox on iOS). Dismissal is remembered.
  - When opened from the Home Screen icon, a one-tap prompt turns on notifications (Apple requires a tap). Settings uses the same helper.
  - iPhone/browser audio is converted to 16 kHz with an anti-aliasing filter (`public/js/resample.js`). Previously a 12 kHz tone passed at full strength; now it's removed, and speech below 4 kHz passes unchanged. Unit tested.
  - Low-confidence speech on the phone triggers "could you say that again?", as on the laptop.
  - The offline cache (service worker v5) includes every app module, so the installed app opens offline.
  - The laptop's palette has "Set up JARVIS on my iPhone".
- **Tested:** Chromium emulating an iPhone 13. That covers pairing by QR link, the install guide, layout, conversation sync, reminders, Mission Control and offline queueing.
- **Not tested:** real Safari / WebKit isn't available in this environment. Real-iPhone microphone, Home Screen install and push still need checking on the device.

## Test results (latest run)

| Suite | Result |
|---|---|
| `npm test` — backend end-to-end (stand-in services), finance engine, on-device speech recognition, upgrade services, personal intelligence (profile, ask-before-remember, memory off, narrated diagnostics, awareness, macros, history, personality), voice + interface commands | 80 / 80 pass |
| `cd desktop && npm test` — wake word accuracy/false triggers, laptop actions (incl. new ones) | 13 / 13 pass |
| `npm run test:ui` — Chromium at laptop and iPhone size: setup, Command Centre, 3D core, streamed reply + speaking core, palette, all 21 sections, alarm dialog + ringing, notification centre, QR pairing, cross-device sync, mobile nav, offline queue, personal profile page, session history, Mission Control transformation (4 stages in order, real checks, the same core moved, 10 areas, all 9 sections with real data, voice section switching, conversation and an alarm during Mission Control, reverse transition, button, Esc, reduced motion, phone layout), narrated diagnostics, live performance panel, cinematic start-up with real steps | 111 / 111 pass |
| `xvfb-run node desktop/test/electron-e2e.js` — Windows app under Electron with a recorded microphone (new audio pipeline) | 28 / 28 pass (4 of 5 runs; see known limitations) |
| `desktop/test/electron-local-e2e.js` — packaged app running its own server | 16 / 16 pass |
| `desktop/scripts/schtasks-smoke.js` — Windows Task Scheduler accepts the WakeToRun alarm task | passes in CI on Windows |

## Verified vs not yet verified on real hardware

- **Verified here (Linux, Electron, stand-in services):**
  - wake word → command → streamed reply → follow-up without a wake word
  - alarm window opens with audio measured as playing (RMS)
  - a real alarm rings on time with the main window closed; snooze is recorded
  - laptop actions run through the background agent with the window closed
  - every section renders without errors
- **Verified by CI on Windows:** the installer build, the bundled server and models, and Task Scheduler accepting the wake task.
- **Not verified on your laptop yet:**
  - waking from real sleep (depends on "Allow wake timers")
  - always-on-top over other apps
  - window control (PowerShell) and screenshots on Windows
  - your microphone and voice
  - live Anthropic / Monzo / Google / ElevenLabs / Home Assistant calls

## How to continue (for a new session)

1. Run `npm ci && (cd desktop && npm ci)`, then `npm test` and `cd desktop && npm test`.
2. Check the UI with `npm run test:ui` (about 6 minutes; WebGL uses SwiftShader).
3. Run the Electron checks:
   - `cd desktop && xvfb-run -a node test/electron-e2e.js`
   - packaged laptop mode: `npm run dist:linux-dir && xvfb-run -a node test/electron-local-e2e.js`
4. Regenerate assets if needed: `npm run sounds` (alarm sounds) and `npm run icons` (app icons).
   - `desktop/scripts/sync-shared.js` copies the action allowlist and the alarm sounds into the desktop app; `npm run dist` runs it.
5. Push to branch `claude/jarvis-prototype-spec-lpz2sl`. CI builds `JARVIS-Setup-5.0.exe` (the file name is set in `desktop/package.json` → `build.artifactName`; change it with the version) and publishes it to the `desktop-latest` release.

## Known issues / notes

- **Monzo/Google sign-in now opens in the default browser.** The callback shows a clear result page when that browser isn't signed in to JARVIS, and a notification tells the app.
- **Live transcription** in the Windows app re-transcribes the audio so far every 1.5 s with the on-device model. It never uses a paid cloud service.
- **The Linux test runner has no window manager,** so "always on top" can only be asserted on Windows.
