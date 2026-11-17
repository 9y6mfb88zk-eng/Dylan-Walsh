# JARVIS 6.4

JARVIS is your personal AI system. It runs **entirely on your Windows laptop**, with no cloud server and no hosting bill.
- **On the laptop** it listens for **"Hey JARVIS"** (or just **"JARVIS"**), keeps the conversation going without the wake word, rings alarms even with the window closed, and sits in the system tray.
- **On your iPhone** you reach it privately through **Tailscale**. Phone and laptop share one account: conversations, alarms, tasks, money, projects and memory.

![Command Centre](docs/screenshots/laptop-home.png)

```
                Windows laptop (JARVIS-Setup.exe)
 ┌───────────────────────────────────────────────────────────────────┐
 │ JARVIS app (tray)                                                  │
 │  ├─ wake word + speech recognition (on the laptop)                 │
 │  ├─ background agent: alarms, laptop actions (works window-closed) │
 │  ├─ Windows Task Scheduler task: wakes the laptop for alarms       │
 │  └─ JARVIS server (bundled, 127.0.0.1 only) ── SQLite + backups    │──► Claude, Open-Meteo, Monzo, Google,
 └───────────────┬───────────────────────────────────────────────────┘    ElevenLabs, Home Assistant (all optional
                 │ Tailscale (free, private, HTTPS)                         except Claude)
             iPhone home-screen app
```

**What it costs.** The software is free. You pay only for AI usage on your Anthropic account. With the default Claude Haiku 5.5, everyday use costs pennies a month.
- **Speech recognition** is free and runs on the laptop (NVIDIA Parakeet: 2.6 % word errors vs 11.4 % for the previous model in our benchmark — `docs/performance.md`).
- **ElevenLabs voice** is optional and has a free tier.
- **Weather** is free (Open-Meteo).

## What's new in 4.0

| Area | What you get |
|---|---|
| **Design** | Black / navy / metallic-blue / electric-cyan HUD design with depth and parallax. The purple is gone. |
| **3D core** | A Three.js JARVIS core, driven only by real events. It has eight states: idle, listening (moves with your real microphone level), thinking, speaking (moves with JARVIS's real voice audio), researching, executing, alarm and offline. A 2D fallback is used where 3D isn't available. Animation can be set to Full, Reduced or Off. |
| **Command Centre** | Live clock, date, location, AI status, notifications and system status. A greeting ("Good morning, Sir."), a status line taken from real diagnostics, and panels for weather (UV, sunrise and sunset), schedule, alarms, tasks, notifications, priorities, projects, activity and diagnostics. Quick commands run real actions. |
| **21 sections** | Collapsible sidebar, a **Ctrl+K** command palette (search plus actions) and a compact phone layout with a bottom bar. |
| **Continuous conversation** | After one "Hey JARVIS", follow-up questions need no wake word. Replies are streamed and spoken sentence by sentence. Say "JARVIS" to interrupt. Local voice commands: "Stop listening", "End conversation", "Go back to standby", "Stay with me", "Listen again", "Stop speaking", "Repeat that". Live transcription shows your words as you speak. |
| **Alarm Centre** | One-off, daily, weekday, weekend and custom-day alarms. Labels, 5 built-in sounds or your own uploads, volume, gradually louder, snooze, dismiss, history, countdown and a Test button. The full-screen alarm checks that sound is really playing and speaks "Good morning, Sir. It is 7 AM. Time to wake up." It works with the window closed, and Windows wakes the laptop from sleep for it. |
| **Briefings & automations** | Morning (07:00), afternoon, evening review (21:00) and weekly review (Sunday 18:00), all built from real data. You can also create your own routines from safe steps. Every run is logged. |
| **Diagnostics** | Live checks for AI (latency, errors), voice, microphone, database, backups, every integration, background services, CPU, RAM, storage and network. **Test** buttons make real requests, and there's a history and logs. Nothing shows green without evidence. |
| **Everything else** | Calendar (day/week/month, recurring events, search); tasks with categories and progress; repeating, snoozable reminders; Intelligence (research folders, comparisons, saved sources, ideas); documents (PDF and text analysis on request); notes; Money (record spending by voice, savings goals, debts, reports, labelled projections); Business (pipeline, clients, proposals drafted by JARVIS, invoices, expenses); World (3D globe, local times, weather comparison); Focus timer; goals and habits with streaks; Smart Home (Home Assistant, allowlisted devices only); Computer control (folders, screenshots, windows, clipboard); notification centre with snooze and history. |

## The 15 things to know

### 1. Install or update to 6.4
Download **`JARVIS-Setup-6.4.exe`** from **[Releases → "JARVIS for Windows (latest)"](https://github.com/9y6mfb88zk-eng/Dylan-Walsh/releases/tag/desktop-latest)** and run it.
- **Updating from 3.x:** your data, keys and settings are kept.
  - Before the database is upgraded, JARVIS saves a full copy to `%APPDATA%\JARVIS\data\backups\pre-migration-007-….db`.
- **SmartScreen or Smart App Control** may block the unsigned installer:
  - SmartScreen: choose **More info → Run anyway**.
  - Smart App Control: it has to be turned off in Windows Security → App & browser control.

### 2. Launch JARVIS
- **First run:** the **keys** window opens. Paste your **Anthropic API key** (console.anthropic.com → API Keys) and choose a password. No setup code is needed.
- **After that:** JARVIS starts with Windows (in the tray), and the Command Centre opens when you click the tray icon.
- **Microphone:** allow it when asked. If Windows blocks it, go to Settings → Privacy & security → Microphone → **Let desktop apps access your microphone**.

### 3. Background services (what keeps running)
- **Closing the window** keeps JARVIS running in the tray, along with:
  - the server
  - the wake word
  - the background agent (alarms and laptop actions)
  - the scheduler (reminders, routines, briefings, backups, diagnostics)
- **Tray → Exit JARVIS** stops everything except the next-alarm wake-up task in Windows Task Scheduler (see §8).
- **Start with Windows** is on by default (tray menu checkbox).

### 4. "Hey JARVIS"
- **Say it:** "Hey JARVIS" or just "JARVIS", then your request, in one breath. For example: "JARVIS, what's the weather tomorrow?"
- **Without your voice:** **Ctrl+Shift+Space** (push-to-talk), or click the core.
- **Mute:** **Ctrl+Shift+M**, or the mic button in the top bar or the tray.
- **Where it runs:** wake-word detection and speech recognition run on the laptop. Idle audio never leaves it.
- **Tuning:** Settings → **Wake word & laptop** (threshold, microphone, live meter).

### 5. Continuous conversation
After the first answer, JARVIS keeps listening for a follow-up. No wake word is needed.
- **It returns to standby** after the silence timeout (default 8 s, set in Settings → **Voice & conversation**), or when you say "End conversation", "Stop listening", "Go back to standby" or "That's all".
- **"Stay with me"** keeps listening for 2 minutes. **"Listen again"** restarts listening.
- **"Repeat that"** replays the last answer. **"Stop speaking"** (or saying "JARVIS" while it talks) interrupts.
- **When the microphone is on:** only after a wake word, a key press or a tap. It is never recording while idle. Turn continuous mode off in Settings → Voice & conversation if you prefer single questions.

### 5a. What JARVIS knows about you, voice commands and Mission Control
- **Your personal profile:** **Memory & Notes → Memory → Profile** shows everything JARVIS knows about you, grouped by category (career, ambitions, businesses, creative projects, preferences…).
  - It starts with only the facts you gave. Edit, pin, delete or add anything there.
  - **Memory** at the top of that page sets the mode: *Ask before remembering* (default), *Automatic* or *Off*.
  - JARVIS asks "Would you like me to remember that for future conversations, Sir?" before saving anything new.
  - Passwords, PINs and bank details are never stored.
- **Instant commands** (handled on the laptop, no AI round trip):
  - "Activate Mission Control" / "Deactivate Mission Control" (also the **Mission Control** button in the top bar, or Esc to leave). See below.
  - "Switch to cinematic / concise / professional / focus / standard mode".
  - "Run a full system diagnostic", or a quick, voice, AI, network, security, performance, hardware or integration diagnostic.
  - "Status report".
  - Every spoken diagnostic line comes from a real check.
- **Command macros:** "Start my working session" and "Prepare my morning" come ready-made. Create your own in **Automations** (When → *Only when asked*, plus a voice trigger). Steps that change your laptop or home ask for a spoken yes first.
- **Microphone:** **Settings → Microphone & speech** offers:
  - microphone choice and a live level meter
  - a background-noise test
  - a calibration sentence that shows how accurately you were understood
  - sensitivity and pause settings
- **Session history:** **Memory & Notes → Session history** is one searchable timeline of conversations, commands, completed tasks, diagnostics, errors, automations and decisions.

### 5b. Mission Control
Mission Control is a second operating mode of JARVIS, not a separate app. Say **"JARVIS, activate Mission Control"** or press the **Mission Control** button in the top bar.

**How it switches on:**
1. **Activating:** the screen dims, the core brightens and turns violet, an energy pulse goes out, and the banner reads "ACTIVATING MISSION CONTROL".
2. **Transformation:** the panels move away and the sidebar becomes Mission Control navigation. The same living core travels into the centre, the architecture diagram unfolds, diagnostics slide in and the map expands.
3. **Initialisation:** real checks run and are shown as they finish: system architecture, AI core (a real test call), voice interface, local connections and operational overview. A line only turns green if that check actually passed.
4. **Active.**

**Sections:**
- **Operational Overview:** all ten areas on one screen.
- **Global Information:** a map of your places with live local times, weather and the real day/night line.
- **System Architecture:** a live diagram of every component, with test buttons.
- **Diagnostics:** every check, plus the spoken diagnostic levels.
- **Active Processes:** your laptop's programs (Windows app only), JARVIS's background services, and what's running right now.
- **Intelligence:** research and briefings.
- **Communications:** notifications, connected devices and the latest conversation.
- **Projects:** progress and next tasks.
- **Personal Operations:** tasks you can tick off, today's events, reminders, alarms and focus.

You can say "show system architecture" (or any section name) while Mission Control is open. Buttons inside sections open the full normal page.

**What Mission Control never invents:** threat levels, incidents, locations, activity, network traffic or system health. If something isn't available, it says so.

**What carries on as normal:** alarms ring over it, conversations carry on, and background services aren't touched.

**Switching off:** say **"JARVIS, deactivate Mission Control"**, press the button or Esc, or use **Exit** in the sidebar. The transformation runs in reverse back to the Command Centre.

With "reduce motion" on (Windows setting or Settings → Appearance), the same stages and checks run without the movement.

### 5c. Startup (initialisation screen)
Every time you launch JARVIS, it opens on a black initialisation screen that shows its real start-up:

1. **Power on:** branding, a purple energy pulse and the start-up sound.
2. **System check:** 16 checks, each shown with a status light as its result arrives:
   - application runtime, operating system, hardware (CPU and memory), database, local storage
   - AI provider (a real call to Anthropic), voice input, speech synthesis, microphone (device and permission shown separately)
   - background scheduler, notifications, weather (a real request), calendar
   - World Explorer, 3D rendering (your graphics card), neural core (ready only once it has drawn)
3. **AI initialisation:** memory, preferences, tasks and reminders are restored, the voice interface and core start, and the Command Centre is prepared underneath.
4. **System status:** one of four results, worked out from the actual checks:
   - SYSTEM OPERATIONAL
   - … LIMITED SERVICES
   - … ATTENTION REQUIRED
   - … INITIALISATION FAILED

   Any problem is listed in plain words, with an **Open diagnostics** button.
5. **"Tap anywhere to wake JARVIS"** fades straight into the Command Centre, with no reload.

How long it takes depends only on the real work; nothing is padded. The sounds are generated on your laptop, with nothing downloaded or paid for. JARVIS says "playing" only when it has measured real sound leaving it; if sound was blocked or silent, it says so.

Change any of this in **Settings → Startup**:
- Cinematic, Minimal or Off
- Skip animation (the checks still run)
- Show full diagnostics
- Open automatically
- Startup sounds, silent startup, reduced audio and volume, with a Test sound button
- Start with Windows

**Settings → Diagnostics** shows the last startup report.

**Performance** settings (**Settings → Performance**):
- graphics quality: Auto, High, Medium, Low or 2D
- particle density
- bloom intensity (0 turns it off)
- animation quality
- background update frequency
- map quality

### 6. Talking and typing
- **Typing:** use the box under the core, or the **Conversation** section (history follows you between laptop and phone).
- **Ctrl+K** finds anything or runs an action. Anything else you type there is sent to JARVIS.
- **Things JARVIS does for you:** "Wake me at seven on weekdays", "I just spent £12.50 on food", "What time is it in Tokyo?", "Start a 25-minute focus session", "Tick off reading", "Draft an invoice for Sea View Villas", "Take a note: …", "Run my evening review", "Take a screenshot".

### 7. The Command Centre
Everything on it is real and live.
- **Status line:** says "All available systems are ready" only when diagnostics find no problems. Otherwise it says how many systems need attention.
- **Quick commands:** each one performs a real action.

### 8. Alarms: test them
1. Open **Alarm Centre** and press **Test alarm**.
   - A full-screen alarm appears and plays sound, and JARVIS checks that audio is actually playing.
   - The Reliability panel then shows "Alarm audio verified".
   - If it says it couldn't confirm sound, check the Windows volume and output device.
2. Set a real alarm 2 minutes ahead, close the JARVIS window, and wait. It rings.
3. **Sleep test:** set an alarm, put the laptop to sleep (not shut down) and leave it plugged in.
   - JARVIS registers a Windows Task Scheduler task called **"JARVIS NextAlarm"** with "wake the computer to run this task".
   - Windows must allow wake timers: Control Panel → Power Options → Change plan settings → Change advanced power settings → **Sleep → Allow wake timers → Enable**. This is on by default when plugged in; turn it on for battery too if you want.
4. **Limits (honest):**
   - No software alarm can ring if the laptop is **shut down, hibernating or out of battery**. Your phone still gets the alarm notification if it's connected.
   - If JARVIS was off and an alarm is more than 15 minutes late, it is recorded as **missed** instead of ringing late.
   - Unanswered alarms snooze themselves after 10 minutes.

### 9. Briefings and automations
- **Built-in routines:** **Automations** has Morning briefing (07:00 daily), Evening review (21:00) and Weekly review (Sunday 18:00). Switch them on or off, change the times, or **Run now**.
- **Briefings:** read aloud and pushed to your phone. Change what goes into them under **Briefings**.
- **Your own routines:** combine briefing, notify, speak, sync, backup and focus steps.

### 10. Google Calendar (optional)
1. In console.cloud.google.com, create a project and enable the **Google Calendar API**.
2. Set the **OAuth consent screen** to External and add yourself as a test user.
3. Under **Credentials**, create an OAuth client ID (Web application). Use the redirect URI shown in the keys window (`http://localhost:47823/oauth/google/callback`).
4. Paste the ID and secret in tray → **API keys & AI model**.
5. Go to **Calendar → Connect Google Calendar**. Sign-in opens in your normal browser; when it says "connected", go back to JARVIS.

JARVIS always asks before changing or deleting anything in Google Calendar.

### 11. Monzo (read-only, optional): finding your client ID and secret
1. Go to **developers.monzo.com** and sign in with your Monzo email. Monzo emails you a login link: open it, then **approve the login in the Monzo app**.
2. Click **Clients → New OAuth Client** and fill in:
   - **Name:** JARVIS
   - **Logo URL:** leave blank
   - **Redirect URLs:** `http://localhost:47823/oauth/monzo/callback` (the keys window shows the exact address)
   - **Description:** anything
   - **Confidentiality:** **Confidential**
3. Click **Submit**. The client page shows the **Client ID** (starts with `oauth2client_`) and the **Client secret**.
4. In JARVIS, open tray → **API keys & AI model**, paste both into the Monzo fields and press **Save**.
5. Go to **Money → Connect Monzo**.
   1. Monzo's sign-in opens in your browser; enter your email and open the link Monzo sends.
   2. The browser shows "Nearly there". **Approve JARVIS in the Monzo app.**
   3. Back in JARVIS, press **Sync now**.

**What JARVIS can and can't do with Monzo.** JARVIS never sees your password, PIN or card, and it can never move money.
- **"Disconnect"** revokes access and deletes the stored bank data.
- **Monzo's limit:** after the first 5 minutes of a connection, Monzo only returns the last 90 days of transactions.

### 12. Smart home (optional, Home Assistant)
1. In Home Assistant, go to your profile → Security → **Long-lived access tokens** → Create.
2. Paste the token and the address (e.g. `http://homeassistant.local:8123`) in **API keys**.
3. Go to **Smart Home → Find devices**, then allow only the devices JARVIS may control.

Locks and doors ask for confirmation every time. JARVIS reads each device's state back from Home Assistant before saying it's done.

### 13. Your iPhone
There's no App Store download. Apple only allows downloadable iPhone apps through the App Store, which needs a paid Apple developer account and a Mac to build. Instead, JARVIS installs straight from Safari onto your Home Screen. It gets its own icon, opens full-screen like an app, and can send notifications. It's the same JARVIS, connected to your laptop, with all your data.

**One-time setup (about 5 minutes):**
1. **Laptop:** install **Tailscale** (tailscale.com, free) and sign in.
2. **Laptop, in JARVIS:** **Settings → Devices & pairing → Turn on iPhone access**. You can also press **Ctrl+K** and choose "Set up JARVIS on my iPhone".
3. **iPhone:** install **Tailscale** from the App Store and sign in with the **same account**. Leave it connected.
4. **Laptop:** press **Show pairing code**.
5. **iPhone:** point the **Camera** at the code and tap the link. It opens JARVIS in Safari, already signed in.
6. **iPhone:** JARVIS shows how to install itself: tap **Share** at the bottom of Safari, then **Add to Home Screen**, then **Add**.
7. **iPhone:** open **JARVIS from the new icon**. It offers to turn on **notifications**; tap **Turn on**. Apple only allows notifications for apps on the Home Screen.

**On the iPhone:**
- **What works:** everything except the wake word. That covers the Command Centre, Mission Control, voice (tap the core or the mic), alarms, reminders, money, projects, memory and every other section.
- **"Hey JARVIS":** iPhones don't let any app listen in the background, so tap to talk instead.
- **Speech recognition** runs on your laptop, the same as at the desk.
- **Speed:** the phone reaches JARVIS only while the laptop is **on and awake**. If it isn't, the app opens offline, queues what you type, and sends it when the laptop is back.

### 14. Diagnostics and troubleshooting
- **Diagnostics** shows every check with when it ran. **Test** makes a real request; history and logs (errors, API calls, security audit) are at the bottom. On the laptop you can also test the **microphone** and **speakers**.
- **Log files:** in `%APPDATA%\JARVIS\`: `jarvis.log` (app, wake word, alarms), `server.log` (server), `actions.log` (laptop actions).

### 15. Backups, your data and updating
- **Daily backups:** kept in `%APPDATA%\JARVIS\data\backups` (last 7).
  - A copy is also made before every database upgrade and before any "Delete" in **Settings → Your data**.
- **Export:** **Settings → Your data → Download my data** (JSON). It never contains passwords or bank tokens.
- **Restore:**
  1. Exit JARVIS.
  2. Copy a backup over `%APPDATA%\JARVIS\data\jarvis.db`.
  3. Start JARVIS again.
- **Updating:** download the newest `JARVIS-Setup-<version>.exe` from Releases and run it over the top. Data, keys and settings are kept, and the database upgrades itself (with a backup first).

## Credentials

All are entered in the app's keys window (tray → API keys & AI model). They're encrypted with your Windows account (DPAPI). The setup code and the bank/calendar token encryption key are generated automatically.

| Key | Needed for | Where |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Required.** Conversation, tools, research, briefings, documents | console.anthropic.com → API Keys |
| `ELEVENLABS_API_KEY` | Optional British butler voice | elevenlabs.io → API keys |
| `OPENAI_API_KEY` | Optional backup speech recognition / voice, semantic memory search | platform.openai.com |
| `MONZO_CLIENT_ID` / `MONZO_CLIENT_SECRET` | Monzo (read-only) | §11 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Calendar | §10 |
| `HOME_ASSISTANT_URL` / `HOME_ASSISTANT_TOKEN` | Smart home | §12 |

## Security

- **Your account and devices.**
  - One owner account (scrypt-hashed password); every device has its own revocable session.
  - Session tokens are stored only as hashes, rotated daily and expire after 30 idle days.
  - CSRF protection, rate limits, a strict CSP and an audit log.
- **Bank and calendar access.** Tokens are encrypted with AES-256-GCM and never sent to devices. Finance is read-only, and JARVIS can't make payments.
- **Laptop actions.**
  - Only a fixed allowlist is possible, validated on the server and again on the laptop.
  - **No shell, no deleting files, no installing, no settings changes.** Closing a window asks first.
  - Window control uses fixed scripts; the window name is passed as data, never as code.
- **What leaves the laptop.**
  - Documents go to the AI only when you press Analyse or ask a question.
  - Screenshots stay on the laptop.
  - Idle microphone audio is never sent anywhere.
- **Smart home:** devices are allowlisted, and security devices need a "yes" every time.

## Tests

```bash
npm ci && npm test                  # backend end-to-end against stand-in services, finance, alarms, automations, diagnostics, voice commands
cd desktop && npm ci && npm test    # wake-word accuracy and false triggers, laptop-action allowlist incl. new actions
npm run test:ui                     # real UI in Chromium: Command Centre, 3D core, all 21 sections, alarms, palette, iPhone pairing, offline sync
cd desktop && xvfb-run -a node test/electron-e2e.js        # the Windows app under Electron: wake word → conversation → follow-up without wake word, alarm window with verified audio, agent with window closed
cd desktop && npm run dist:linux-dir && xvfb-run -a node test/electron-local-e2e.js   # the packaged app running its own server
node desktop/scripts/schtasks-smoke.js   # Windows only (CI): Task Scheduler accepts the alarm wake task
```

See `PROJECT_STATUS.md` for the latest results and what has and hasn't been verified on real hardware.

## Limitations (honest list)

- **Not yet run with your accounts, voice or microphone.** Every external service was exercised against faithful stand-ins.
- **Windows-specific behaviour is verified by CI, not on your laptop.** That covers: the installer build, the Task Scheduler wake task being accepted, always-on-top and window control. Real wake-from-sleep depends on your power settings, so **test it once (§8)**.
- **No software alarm rings when the laptop is off, hibernating or flat.**
- **The phone needs the laptop awake.** Alarm and reminder notifications reach the phone only while the laptop is online.
- **Speech recognition:** live transcription uses the on-device model, so partial text appears in steps every 1.5 s rather than word by word. Barge-in uses the wake word ("JARVIS"), not any sound, so JARVIS's own voice can't interrupt itself.
- **Monzo's API** is personal-use and limited to 90 days of history after the first 5 minutes.
- **Single-user design.** One owner, one SQLite database.

## Project layout

```
server/            Backend (Node 22, Express 5, SQLite via node:sqlite, WebSocket hub)
  migrations/      Numbered SQL migrations (automatic backup before upgrading an existing database)
  services/        alarms, notify (notification centre), automations, briefings, diagnostics, money, records
                   (notes, business, goals, habits, focus…), smarthome, calendar, work, memory, computer…
  routes/          core, auth, finance, calendar, upgrade (all new sections + /api/chat/stream SSE)
  brain.js         Persona, tools, streaming replies, research, briefings (Claude)
public/            Web app / iPhone PWA
  js/core3d.js     Three.js core (vendored in public/vendor/three) · js/core.js 2D fallback · js/corestate.js state machine
  js/conversation.js  Streaming + continuous conversation · js/views/  the 21 sections
  sounds/          Built-in alarm sounds (generated by scripts/make-sounds.js)
desktop/           Windows app (Electron): tray, bundled server, wake word, agent.js (alarms, actions, Task Scheduler),
                   alarm/ (full-screen alarm window), windows-control.js, keys window, Tailscale
test/, desktop/test/  Automated tests
```
