# JARVIS — Project status

_Last updated: 2026-11-16 — JARVIS 4.0 (Ultimate Upgrade & Redesign complete)_

This file is the hand-over document for the "JARVIS — Ultimate Upgrade & Redesign" specification. It lists what is done,
what remains, known problems, technical decisions and exactly how to continue.

## Existing architecture (inspected before the upgrade)

| Layer | Technology | Where |
|---|---|---|
| Backend | Node 22, Express 5, `ws`, SQLite via `node:sqlite`, numbered SQL migrations | `server/` |
| AI | Anthropic Claude (Messages API, tool use, web search, structured output) | `server/brain.js` |
| Speech | Local Whisper base.en (sherpa-onnx) → OpenAI Whisper fallback; ElevenLabs/OpenAI TTS → system voice fallback | `server/local-asr.js`, `server/voice.js` |
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

## Test results (latest run)

| Suite | Result |
|---|---|
| `npm test` — backend end-to-end (stand-in services), finance engine, local Whisper, upgrade services, voice commands | 61 / 61 pass |
| `cd desktop && npm test` — wake word accuracy/false triggers, laptop actions (incl. new ones) | 13 / 13 pass |
| `npm run test:ui` — Chromium at laptop and iPhone size: setup, Command Centre, 3D core, streamed reply + speaking core, palette, all 21 sections, alarm dialog + ringing, notification centre, QR pairing, cross-device sync, mobile nav, offline queue | 49 / 49 pass |
| `xvfb-run node desktop/test/electron-e2e.js` — Windows app under Electron with a recorded microphone | 28 / 28 pass |
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
5. Push to branch `claude/jarvis-prototype-spec-lpz2sl`. CI builds `JARVIS-Setup-<version>.exe` and publishes it to the `desktop-latest` release.

## Known issues / notes

- **Monzo/Google sign-in now opens in the default browser.** The callback shows a clear result page when that browser isn't signed in to JARVIS, and a notification tells the app.
- **Live transcription** in the Windows app re-transcribes the audio so far every 1.5 s with the on-device model. It never uses a paid cloud service.
- **The Linux test runner has no window manager,** so "always on top" can only be asserted on Windows.
