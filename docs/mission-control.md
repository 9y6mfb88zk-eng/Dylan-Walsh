# Mission Control: the command centre (JARVIS 6.9)

Mission Control is the same JARVIS application in a second operating mode. Everything that worked before 6.9 still
works and uses the same data:
- the map, Global Events, flight tracking, intelligence and diagnostics;
- the four operations (Blackbox, Wayfinder, Sentinel, Orbit);
- World Explorer and the situation report;
- voice and conversation.

6.9 redesigns how it looks, how it is laid out and how it comes online.

Rollback point: commit `6be51e2` (local tag `pre-mc-military-redesign`).

## Layout

```
┌ Command bar: J.A.R.V.I.S. · Mission Control · Core 808 │ DTG │ local time │ active operation │ AI / network / systems │ situation report ┐
├ Core 808 ─────────┬ Tactical map ────────────────────────────────────────────────┬ Intelligence feed ─┤
│ state · caption   │ layers · region · global view · 3D · expand                   │ global situation   │
│ command / mic     │ tactical frame, corner references, radar sweep, scan line,    │ filters · sources  │
├ System readiness ─┤ cursor coordinates and zoom                                   │ every report,      │
│ live checks       │                                                                │ scrolling, newest  │
├ Mission log ──────┤                                                                │ highlighted        │
├ Status strip: flight tracking · satellite & imagery · global event activity · system activity · network ┤                    │
└───────────────────────────────────────────────────────────────────────────────────┴────────────────────┘
```

- **Command bar:**
  - the date-time group (`181942Z NOV 26`, which is UTC) and local time;
  - the active operation, which changes with the section;
  - live AI, network and system status;
  - the situation report.
- **Core 808 column:** the core panel (state, live caption, command line, microphone); system readiness (real
  readings for AI, voice, database, background services, map, events feed, flight data, CPU, RAM, GPU and frame rate);
  and the mission log (recent JARVIS operations).
- **Tactical map:** the existing Leaflet map with all its layers and controls, inside a frame with:
  - corner references showing the area in view;
  - a cursor latitude/longitude and zoom readout;
  - a slow radar sweep and scan line. These pause when JARVIS is idle and are off with reduced motion or reduced visual effects.
- **Intelligence feed:** Global Events, full height, with its filters, sources and timestamps. Reports that arrive
  while you watch are briefly highlighted.
- **Status strip:** five compact cells, each showing one live value (aircraft in view, base map, reports, CPU/RAM,
  link). Click a cell, or press Enter on it, to open the full panel above it. Esc or a click elsewhere closes it.
- **Navigation:** the sidebar becomes coded, grouped navigation (Command, Operations, Systems) with every earlier
  destination, plus Exit.
- **Other sections:** Overview, Architecture, Processes, Communications, Projects and Personal Operations keep their
  panels, in the same military theme.

Colours: deep navy, near-black and charcoal, with steel and tactical blue and a restrained cyan. Military green marks
healthy, amber marks degraded, and red appears only for genuine faults.

## Core 808

The same single core instance the Command Centre uses, the same canvas and the same WebGL context, in a second
design (`public/js/core3d.js`):
- gimballed orbital rings carrying moving nodes;
- a degree bezel;
- twelve segmented data arcs that light in sequence;
- targeting brackets;
- a radar beam;
- a wireframe cage around the energy core;
- the audio-reactive ring.

It switches to Core 808 when Mission Control opens and back when it closes. It is never duplicated or rebuilt.

| JARVIS state | Core 808 |
|---|---|
| Standby | slow movement, low illumination |
| Listening | rings brighten, brackets lit, radar beam active, reacts to your microphone level |
| Processing / researching | data arcs run fast, scanning arcs, more light (military green while researching) |
| Responding | controlled pulse driven by JARVIS's real voice level |
| Executing | white-steel, arcs active |
| Fault | amber |
| Alarm | red |
| Offline | dimmed, beam off |
| Initialising | assembles piece by piece (activation sequence) |

## Activation sequence

Settings → Interface → Mission Control activation:

| Setting | What happens |
|---|---|
| Full sequence (default) | About 7 s, described below |
| Short | About 2.5 s: the same sequence, quicker, without waiting for slow checks |
| Off | The earlier quick transition (the core still becomes Core 808) |

With reduced motion, or transitions turned off, it uses the instant transition.

**The full sequence:**
1. **System activation:** the screen darkens. The tactical grid, a scanning line, the frame and the readouts appear.
   The readouts are all real: date-time group, your home grid reference, area of operations, node, build and link.
   "J.A.R.V.I.S." and "INITIALISING MISSION CONTROL" are typed out.
2. **Core 808 deployment:** the living core moves from the Command Centre to the centre of the screen and assembles
   inside a reticle of range rings, bearings and rotating arcs:
   - an energy point;
   - the cage;
   - three rings twisting into place;
   - the bezel drawing round;
   - the brackets closing in;
   - the beam starting to sweep;
   - the core igniting.
3. **Initialisation:** "MISSION CONTROL · JARVIS CORE 808 · PREPARING FOR OPERATIONS", then the real checks, one row
   each, with a progress bar and the actual result:
   - architecture;
   - AI link;
   - voice;
   - live link;
   - flight tracking;
   - global situation data;
   - global mapping;
   - satellite systems (an ISS position calculated from published orbital elements);
   - operational data.

   A check that hasn't finished is shown as "continuing", and completes in the background.
4. **Confirmation:** "CORE 808 ONLINE · MISSION CONTROL INITIALISED · ALL AVAILABLE OPERATIONAL SYSTEMS READY", followed
   by the number of systems that are unavailable or degraded, if any.
5. **Reveal:** the overlay irises open from the core. The core flies to its panel while the command bar, map, side
   columns and status strip deploy around it.

The sequence only plays when you deliberately open Mission Control, never when changing sections. Mission Control is
built behind it, and every background service keeps running. Skip it at any time with the Skip button, Esc, Enter or
Space.

**Sounds:** all original, synthesised on the device through the interface sound settings (on/off, volume, reduced,
silent):
- a power-up swell;
- readout ticks;
- a click and blip as each ring locks;
- a rising sweep;
- a chord when the core comes online;
- a chirp per check (lower if it's degraded);
- a confirmation figure (in a minor key if anything is down);
- a whoosh as the command centre deploys;
- a quiet tick when navigating;
- the stand-down sound on exit.

## Honesty

Every value on screen comes from JARVIS's own data or the public sources it already uses. The sequence never shows a
system as online without a real result. The interface makes no claim of military capability, classified access or
military-grade security. The military styling is design language only.
