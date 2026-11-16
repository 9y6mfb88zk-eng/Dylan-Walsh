# JARVIS 3.1

JARVIS is your personal AI assistant, and it runs **entirely on your Windows laptop**. There is no cloud server and no hosting bill.
- **On the laptop** it listens for **"Hey JARVIS"**, speaks back and sits in the system tray.
- **On your iPhone** you can reach it privately through **Tailscale**, a free private-network app. Phone and laptop share conversations, tasks, reminders, projects, money and memory.

![Laptop](docs/screenshots/laptop-home.png)

```
                Windows laptop (JARVIS-Setup.exe)
 ┌──────────────────────────────────────────────────────────────┐
 │ JARVIS app (tray) ── local “Hey JARVIS” wake word (on-device) │
 │      │                                                        │
 │      └── JARVIS server (bundled, 127.0.0.1 only) ── SQLite     │──► Claude, Whisper, ElevenLabs,
 │               ▲                                               │    Monzo, Google, Open-Meteo
 └───────────────┼───────────────────────────────────────────────┘
                 │ Tailscale (free, private, HTTPS)
             iPhone home-screen app
```

**What it costs:** the software is free.
- **AI:** you pay only for usage. With the default Claude Haiku 5.5, everyday use is pennies a month; you can switch to Sonnet or Opus any time.
- **Voice input:** free. Whisper runs on your laptop; an OpenAI key is optional and only used as a backup.
- **ElevenLabs voice:** has a free tier. Without it JARVIS uses the Windows voice.

## 1. Install on your laptop (about 5 minutes)

1. Download **`JARVIS-Setup-3.1.0.exe`** from **[Releases → "JARVIS for Windows (latest)"](https://github.com/9y6mfb88zk-eng/Dylan-Walsh/releases/tag/desktop-latest)** and run it.
   - SmartScreen may warn because it isn't code-signed. Click **More info → Run anyway**.
2. JARVIS opens a **keys** window:
   - **Anthropic API key** (required). Get it at console.anthropic.com → API Keys → Create key, and add a little credit.
   - **OpenAI API key:** optional. JARVIS understands speech on the laptop for free.
   - **ElevenLabs** (optional) for the British butler voice.
   - The AI model is **Claude Haiku 5.5 (cheapest)** by default.
   - Keys are encrypted with your Windows account and kept on the laptop.
3. **Choose a password.** No setup code is needed; the app handles it.
4. Allow the microphone. If Windows blocks it, go to **Settings → Privacy & security → Microphone** and turn on "Let desktop apps access your microphone".
5. Say **"JARVIS"** or **"Hey JARVIS"** followed by your request, e.g. "JARVIS, what's the weather tomorrow?". You can also press **Ctrl+Shift+Space**.

Everyday use:
- **Close to tray:** closing the window keeps JARVIS in the system tray.
- **Starts with Windows:** on by default.
- **Exit JARVIS** (tray menu) stops the app *and* its server completely.
- **Change keys or model:** tray menu → **API keys & AI model…**.
- **Your data:** stored in `%APPDATA%\JARVIS\data`, with daily backups in `%APPDATA%\JARVIS\data\backups`.

## 2. Add your iPhone (free, private)

1. **On the laptop:** install **Tailscale** from tailscale.com/download/windows and sign in (a free personal account).
2. In JARVIS, go to **Settings → Devices & pairing → Turn on iPhone access**.
   - The first time, Tailscale may ask you to approve HTTPS for your network. JARVIS shows the link: open it, click approve, then press **Try again**.
3. **On the iPhone:** install **Tailscale** from the App Store, sign in with the **same account** and leave it connected.
4. On the laptop, tap **Show pairing code** and scan the QR code with the iPhone camera.
5. In Safari, tap **Share → Add to Home Screen**. Open JARVIS from the icon, then go to **Settings → Notifications → Turn on**.

Only devices signed in to your Tailscale account can reach JARVIS. Nothing is opened to the public internet.

What happens when the laptop is off:
- The phone can't reach JARVIS while the laptop is off or asleep.
- Reminders due in that time are sent as soon as the laptop is back on.
- For reminders to reach your phone while the laptop is off, you'd need the optional cloud server (§11).

## 3. Connect Monzo (read-only, optional)

1. Sign in at **developers.monzo.com** and approve the login in the Monzo app.
2. Go to **Clients → New OAuth Client** and set:
   - **Name:** JARVIS
   - **Redirect URL:** `http://localhost:47823/oauth/monzo/callback`
   - **Confidential:** yes
3. In JARVIS, go to tray menu → **API keys & AI model** and paste the Monzo **Client ID** and **Client secret**.
4. Go to **Money → Connect Monzo**. Sign in on Monzo's own page; JARVIS never sees your password, PIN or card.
5. **Approve "JARVIS" in the Monzo app.** Monzo requires this extra step. Then tap **Sync now**.

You can pick which accounts JARVIS may use, and **Disconnect** revokes access and deletes the stored data.

For an accurate "money left", add your bills, planned savings and debt repayments under **Money → Still to pay**. Mark each **confirmed** or **estimated**; JARVIS labels estimates as estimates.

Two Monzo limits to know:
- The developer API is for personal use with your own account, and Monzo can change it.
- After the first 5 minutes of a connection, Monzo only returns the last 90 days of transactions.

## 4. Google Calendar (optional)

1. In console.cloud.google.com, create a project and enable the **Google Calendar API**.
2. Under **OAuth consent screen**, choose External and add yourself as a test user.
3. Under **Credentials**, create an OAuth client ID (Web application) with the redirect URI `http://localhost:47823/oauth/google/callback`.
4. Paste the ID and secret in **API keys & AI model**.
5. In JARVIS, go to **Agenda → Connect Google Calendar**. Without Google, JARVIS's own calendar still works.

## 5. Credentials

You enter all of these in the app's **keys** window (tray → API keys & AI model). The setup code and the encryption key for bank/calendar tokens are generated automatically.

| Key | Needed for | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Required.** Conversation, tools, web research, briefings, ideas | console.anthropic.com → API Keys |
| `OPENAI_API_KEY` | **Voice input in the Windows app and on iPhone** (Whisper), backup voice, semantic memory search | platform.openai.com → API keys |
| `ELEVENLABS_API_KEY` | Natural British butler voice (recommended) | elevenlabs.io → Profile → API keys |
| `MONZO_CLIENT_ID` / `MONZO_CLIENT_SECRET` | Monzo | developers.monzo.com (see §3) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Calendar (optional) | See §4 |

You don't need keys for:
- **Weather** (Open-Meteo).
- **Push notifications.** The keys are generated automatically.
- **The wake word.** The free openWakeWord `hey_jarvis` model ships inside the app.

## 6. Configure the wake word

All of this is on the laptop under **Settings → Voice & laptop**:
- **Listen for "Hey JARVIS"** (on/off) and **Mute microphone**.
- **Microphone:** pick a device. If it's unplugged, the service retries automatically and recovers.
- **Detection threshold** (default 0.5): raise it if JARVIS wakes by mistake, lower it if he misses you.
- **Consecutive frames** (default 2, about 160 ms above the threshold): this is the false-trigger protection, together with a 2.5-second cooldown.
- **Speech sensitivity:** how loud you must be once a command has started.
- **Live score meter:** say "Hey JARVIS" and watch it peak.

**Two wake detectors, both on the laptop:**
- The openWakeWord `hey_jarvis` model listens for "Hey JARVIS".
- A sherpa-onnx keyword spotter listens for "JARVIS" on its own. You can switch this one off in Settings → Voice & laptop.

**Your command is recorded by the same always-on listener** from the instant after the wake word, so saying it in one breath works. It is transcribed locally by Whisper base.en.

**Privacy:** wake-word detection, speech recognition and the server all run on the laptop.
- Uses the openWakeWord `hey_jarvis_v0.1` ONNX model, executed in the app via onnxruntime-web.
- Idle audio never leaves the computer. After the wake phrase, only your command is recorded and sent for transcription.
- While a conversation is running, the wake word pauses so JARVIS can't wake himself.

## 7. What JARVIS can do

| Ask | What happens |
|---|---|
| "Good morning, JARVIS" / "Brief me" | Briefing from real data: weather, calendar, tasks, reminders, money, projects (news optional). Also pushed daily at your chosen time |
| "How much money have I got?" | Live Monzo balance, minus remaining commitments, with the working shown. Credit/overdraft limits never count |
| "How much have I spent this month / on food?", "Can I afford £300?", "Show my subscriptions", "Compare with last month" | Finance engine over your real transactions. Transfers between your own accounts are excluded |
| "What's the weather tomorrow?" | Open-Meteo forecast for your home location |
| "Remind me to call my mum at six" | Server-side reminder. Arrives on your phone even with every app closed; the laptop also speaks it |
| "Schedule a gym session tomorrow", "Move my dentist to Friday" | Creates events. Clashes and changes to existing events wait for your **yes** |
| "I want to start a business" | Creates a project with milestones and first tasks; "continue working on my website business" picks it up |
| "Research the best businesses to start in Larnaca" | Web search across several sources, with citations; longer reports run in the background |
| "Open Chrome", "Open my downloads", "Open my JARVIS project", "Create a document", "Find my latest CV" | Allowlisted laptop actions. Name your own shortcuts in Settings |
| "Remember that I prefer tea" | Saved to memory. Sensitive facts wait for approval; passwords, PINs and card numbers are refused |

## 8. Security

- **Sign-in and devices.**
  - One owner account (scrypt-hashed password) with a one-time setup code.
  - Every device has its own session and can be signed out from **Settings → Devices**.
  - Session tokens are random 256-bit values stored only as hashes. They rotate daily and expire after 30 idle days (180 days maximum).
- **Request protection.** CSRF protection, rate limits (login lock-out after 8 failures in 15 minutes), a strict CSP and security headers, and an **audit log** of sign-ins, pairings, finance and calendar changes, laptop actions and memory exports.
- **Bank and calendar access.**
  - Tokens are encrypted with AES-256-GCM, stay on the server and are never sent to devices. Bank passwords are never seen or stored.
  - OAuth uses single-use, expiring state values. Finance access is read-only.
- **Laptop actions.**
  - Only a fixed allowlist of actions is possible, validated on the server and again on the laptop.
  - There is no shell, no delete, no install, no settings changes and no running programs.
  - Actions are logged to `%APPDATA%\JARVIS\actions.log` and to the audit log.
- **Desktop app hardening.**
  - Context isolation and sandboxing are on. The desktop bridge exists only for pages from your JARVIS server.
  - Microphone permission is granted only to JARVIS's own windows, and Windows privacy settings are respected, never bypassed.
- **Backups.** A daily SQLite backup goes to `/data/backups` and the last 7 are kept.

## 9. Tests and results

```bash
npm ci && npm test                  # 32 tests: backend end-to-end against stand-in services, plus the finance engine
cd desktop && npm ci && npm test    # 12 tests: real hey_jarvis model accuracy and false triggers, laptop action allowlist
npm run test:ui                     # 14 checks: real UI in Chromium at laptop and iPhone size
npm run test:electron               # 18 checks: the Windows app under Electron, with "Hey JARVIS" fed in as microphone audio
cd desktop && npm run dist:linux-dir && xvfb-run -a node test/electron-local-e2e.js   # 14 checks: the PACKAGED app running its own server (laptop mode)
```

Latest run: **all 90 checks pass.** CI runs the unit tests on Linux and Windows, then builds the installer.

Your 8 acceptance scenarios:

| Scenario | Status |
|---|---|
| 1. Restart Windows → JARVIS starts in the tray and shows real status | Start-with-Windows (`--hidden`) starts the app, which starts its own server. This was tested under Electron on Linux with the packaged app; **not run on a real Windows reboot** |
| 2. "Hey JARVIS" starts a voice session | **Passed end to end in Electron**: a recording of the phrase fed in as the microphone was detected locally, then the command was transcribed, answered, spoken and synced. **Not yet tried with your microphone and voice** |
| 3. "What's the weather tomorrow?" | Passes against Open-Meteo's real response format. **Live Open-Meteo calls were blocked by this build environment's network**, so the first live call happens on your server |
| 4. "How much money have I got?" | Full OAuth, pending in-app approval, sync and answer tested against a Monzo API stand-in. **Needs your Monzo client to run live** |
| 5. "How much have I spent this month?" | Same as 4. Transfers to pots and declined payments are correctly excluded |
| 6. "Remind me to call my mum at six" | Passes: persistent, delivered by web push and live to the laptop, and survives a server restart |
| 7. Open JARVIS on iPhone and see the same account | QR pairing, shared conversation, tasks and reminders pass in the iPhone-sized browser test. Tailscale's `serve` step was tested against a stand-in for the Tailscale command, **not the real Tailscale app** |
| 8. Disconnect and reconnect the internet | Passes: offline actions queue on the device and sync exactly once on reconnect. The app shows a reconnecting screen and retries with back-off |

## 10. Limitations (honest list)

- **Not yet tested with your real accounts, voice or microphone.** All external services were exercised against faithful stand-ins. No live Anthropic, Monzo, Google, ElevenLabs or OpenAI calls were made during development, because no keys were available.
- **The Windows installer is built by GitHub Actions.** The same layout was packaged and tested here for Linux; the Windows build itself happens in CI.
- **The phone needs the laptop on.** Because the server runs on the laptop, the phone can only reach JARVIS while the laptop is awake and Tailscale is connected on both. Reminders that fall due while it's asleep are sent when it wakes.
- **Monzo developer API** access is Monzo's decision. It covers your own account; Monzo doesn't expose standing orders or direct debits, so upcoming bills come from what you enter plus detected repeating payments (labelled as estimates). **TrueLayer isn't implemented yet.**
- **The iPhone can't listen for a wake word in the background** (an iOS rule). Push notifications on iPhone need iOS 16.4+ and the home-screen app.
- **Voice input in the Windows app needs `OPENAI_API_KEY`.** Electron has no built-in speech recognition, so Whisper is used.
- **Laptop actions run only while the Windows app is running and online.** Anything destructive (deleting, installing, purchases, emails, settings, payments) is deliberately not possible.
- **Single-user design.** One owner account, one server instance (SQLite). That's right for a personal assistant, not for a shared service.

## 11. Optional: run the server in the cloud instead

If you'd rather have JARVIS reachable while the laptop is off, the same server deploys to Render. That costs about $7/month for the persistent disk. Click **[Deploy to Render](https://render.com/deploy?repo=https://github.com/9y6mfb88zk-eng/Dylan-Walsh)** and paste your keys. Then, in the Windows app, choose tray → Change server… and enter the Render address. The `Dockerfile` works on any host; mount `/data` and set the variables from `.env.example`.

## Project layout

```
server/                 Backend (Node 22, Express, SQLite via node:sqlite, WebSocket)
  migrations/           Numbered SQL migrations, applied automatically at start-up
  security/             Auth, sessions, pairing, crypto, rate limits, audit
  finance/              Monzo sync service, categorisation, calculation engine
  integrations/         Monzo, Google Calendar, Open-Meteo clients
  services/             Tasks/projects, conversations, memory, calendar, confirmations, health, laptop actions
  brain.js              JARVIS persona, tools, research, briefing, ideas (Claude)
public/                 iPhone/desktop web app (PWA): views, holographic core, voice, live sync
desktop/                Windows app (Electron): tray, local server manager, keys window, Tailscale, wake word, actions
  scripts/prepare-server.js  Bundles a checksum-verified Node 22 + the JARVIS server into the installer
  models/               openWakeWord ONNX models (melspectrogram, embedding, hey_jarvis_v0.1)
test/, desktop/test/    Automated tests
render.yaml, Dockerfile Optional cloud deployment
scripts/windows/        Run-from-source scripts for developers (setup.ps1, start-dev.ps1)
```
