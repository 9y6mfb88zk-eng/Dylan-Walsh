# JARVIS — Project status

_Last updated: 2026-11-16 (Ultimate Upgrade & Redesign in progress)_

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
| 1b | Backend for every section: migration 007, services, routes, scheduler, AI tools, streaming chat (`/api/chat/stream`), 22 new tests | ✅ done |
| 2 | Design system (navy/cyan HUD), shell, sidebar (21 sections), Ctrl+K palette, mobile nav | ⏳ in progress |
| 3 | 3D JARVIS core (Three.js) with real states + dimensional effects | ⏳ |
| 4 | Command centre homepage + live diagnostics | ⏳ |
| 5 | Alarm engine + desktop background agent + alarm window + Task Scheduler wake | ⏳ |
| 6 | Continuous conversation, streaming replies, barge-in, voice commands, live transcription | ⏳ |
| 7 | AI tools + intelligence centre (folders, saved sources, documents) | ⏳ |
| 8 | Computer control centre (folders, screenshots, running apps, clipboard, logs) | ⏳ |
| 9 | Calendar (recurring, search), tasks (categories), reminders (recurring, snooze) | ⏳ |
| 10 | Finance (manual transactions, goals, debts, reports) + Monzo connect flow fix | ⏳ |
| 11 | Business & client management + project workspaces | ⏳ |
| 12 | Memory (history, notes) | ⏳ |
| 13 | World intelligence (3D globe, world clocks, weather comparisons) | ⏳ |
| 14 | Automations engine + Home Assistant smart home | ⏳ |
| 15 | Focus (Pomodoro), goals, habits | ⏳ |
| 16 | Notification centre + mobile layouts | ⏳ |
| 17 | Security + diagnostics completion | ⏳ |
| 18–20 | Full test pass, fixes, installer build, docs | ⏳ |

## How to continue (for a new session)

1. `npm ci && (cd desktop && npm ci)` — then `npm test`, `cd desktop && npm test`.
2. Read this file's phase table; continue with the first phase not marked ✅.
3. UI check: `npm run test:ui`. Electron checks: `npm run test:electron`;
   packaged laptop mode: `cd desktop && npm run dist:linux-dir && xvfb-run -a node test/electron-local-e2e.js`.
4. Push to branch `claude/jarvis-prototype-spec-lpz2sl`; CI builds `JARVIS-Setup-<version>.exe` and publishes it to the
   `desktop-latest` release.

## Known issues / open questions

- Monzo/Google "Connect" opened the sign-in page inside the app window; Google blocks sign-in in embedded browsers and
  Monzo's email link opens in the default browser. Fix in progress: open these in the default browser and show a
  "connected — return to JARVIS" page.
