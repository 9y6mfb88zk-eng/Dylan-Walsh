# Mission Control operations (JARVIS 6.6)

The four operations are **modules inside Mission Control**: Blackbox, Wayfinder, Sentinel and Orbit. They are not
separate applications or dashboards. Each opens in the right-hand column of Global Operations, and everything else on
screen stays put:

- the living JARVIS core;
- the one shared world map, with its layers;
- the status panels;
- the voice line.

They use JARVIS's existing database (one shared `op_records` table), notification centre, settings, voice and AI.
Return to Global Operations at any time from the same navigation.

| | |
|---|---|
| Navigation | Mission Control sidebar → **Operations**: Blackbox, Wayfinder, Sentinel, Orbit (phone: the tab bar) |
| Shared map layers | Layers → Blackbox research places, Wayfinder routes & places, Sentinel webcams & watch areas, Orbit satellites. Each operation switches its own layer on when opened and off when you leave |
| Shared data model | `op_records` (migration 009): `op`, `kind`, title, status, JSON data, tags, notes, location. The database is backed up automatically before the migration runs |
| Loading | Each workspace loads only when first opened (`public/js/ops/*.js`) |
| Global Situation Report | **Situation report** button on the Global Operations strip, or say "generate a situation report" |

## Operation Blackbox: research dossiers

1. **Question.** You give a subject, a category and an optional question. The 17 categories include companies,
   countries, public figures (public role only), aircraft, airports, space missions, historical events, wars,
   technology and science.
2. **Sources.** JARVIS gathers them from three places:
   - Wikipedia, including its image with the Wikimedia Commons licence and author;
   - public ADS-B data for aircraft (with the same privacy rules as flight tracking);
   - OurAirports for airports.

   It then runs a web search through JARVIS's AI. This uses your Anthropic account.
3. **Extraction and comparison.** The AI reads the sources, extracts facts and lists contradictions.
4. **Citation check.** Every finding must cite numbered sources from the list. A citation number that isn't in the
   list is removed. A finding left without a valid source is labelled **AI interpretation**, with low confidence.
5. **Places.** Locations are looked up with Open-Meteo's geocoder. The AI never supplies coordinates.
6. **The saved dossier** contains:
   - executive summary and overview;
   - key findings (source fact vs AI interpretation, with confidence);
   - timeline and locations;
   - historical context and contradictions;
   - documents, images and limitations;
   - the numbered source list with access times;
   - the research steps.

**What you can do with a dossier:** rename it, add notes and tags, add your own sources, search, compare two or more
dossiers side by side, re-run the research, delete it, or export a PDF (your printer's "Save as PDF").

**Refused:**
- private individuals;
- home addresses, personal whereabouts and identifying anonymous people;
- privacy-flagged or military aircraft.

## Operation Wayfinder: travel and expeditions

**Destination research**, from real sources:
- the place itself (Open-Meteo);
- a 7-day forecast (Open-Meteo);
- UK FCDO travel advice with its update date (GOV.UK, Open Government Licence);
- country facts: capital, currency, languages, dialling code;
- the nearest airports (OurAirports).

**Plan a trip or expedition:** hiking, road trip, camping, city exploration, multi-country journey, photography trip
or research visit. JARVIS saves:
- the real research above;
- an itinerary, places and equipment that are clearly labelled **AI draft**, plus cost estimates labelled
  **AI estimate**;
- a checklist for the trip type.

**The dashboard has these tabs:**

| Tab | What it holds |
|---|---|
| Overview | Dates, travellers, weather, advice, airports |
| Itinerary | The day-by-day plan (editable) |
| Flights & transport | Flights you enter (with live ADS-B status by flight number), plus other transport |
| Routes | OSRM driving, walking and cycling routes: the router's distance and time, with the straight-line distance alongside |
| Stay & budget | Accommodation and costs |
| Checklist | Items to prepare or pack |
| Safety & check-ins | Emergency contacts and notes, the FCDO "Getting help" link, and check-in reminders that reach all your devices |
| Notes & documents | Your notes and important documents |

You can export the whole trip as a PDF.

**Not available, so not offered:** airline schedules, fares and booking. No free source provides them. Live status
works once the flight is airborne and visible to public ADS-B. Public transport routing has no free worldwide source.

## Operation Sentinel: situational awareness

- **Global Events gained two sources:**
  - **NASA EONET:** wildfires, severe storms, volcanoes and floods, each at its reported point.
  - **FAA NAS status:** US ground stops, delay programmes and airport closure notices.

  Two new categories: severe weather, and infrastructure/airport disruption.
- **Verification labels:**

  | Label | Meaning |
  |---|---|
  | single | single-source report, unconfirmed |
  | multiple | multiple-source reporting, from outlets in one country |
  | corroborated | independently corroborated, by outlets in several countries; still not verified by JARVIS |
  | contested | conflicting or disputed reporting, detected from denial or dispute wording |
  | official | an official body (GDACS, USGS, EONET, FAA, ReliefWeb) |
  | coded | coded by UCDP researchers |
  | reviewed / automatic | USGS reviewed / automatic |

- **Watchlists** combine:
  - places: countries, regions, or a place with a radius;
  - event categories;
  - a minimum verification level and severity;
  - quiet hours.

  They are checked every 10 minutes, only when an enabled watchlist exists. The first check records what's already
  there without alerting. After that, new matching reports go to the notification centre; during quiet hours they are
  silent (no push or speech).
- **Public webcams.** Only cameras published by their operators for public viewing. Nothing is found by scanning,
  nothing is behind a login, and there are no private cameras.
  - **JARVIS's registry** has 7 operator-published YouTube live cameras: Jackson Town Square, Times Square, Niagara
    Falls, Shibuya Crossing, Monterey Bay Aquarium, Venice and Rome. It was built for JARVIS, not copied from another
    registry; the suggested CityWatch repository has no licence, so none of its data was copied.
    - Each camera is embedded with YouTube's privacy-enhanced player only after the **YouTube Data API** (free key)
      confirms the stream is live and embeddable.
    - Without the key, cameras are listed as "live status not verified", with a link to the operator's page.
    - JARVIS re-checks each camera at most every 6 hours.
  - **Windy Webcams** (free key): cameras near any map area. These are timelapse players and preview images, labelled
    "not live video". Preview links expire after 15 minutes, as Windy's free tier says.
  - **Countries with active armed conflict** (UA, RU, IL, PS, LB, SY, SD, SS, YE, MM, CD, SO, ML, BF, LY, AF, HT) are
    excluded, so the layer can't become a live view of conflict areas.
  - Camera images are kept separate from event verification and never treated as evidence.

## Operation Orbit: space and satellites

- **Satellite data.** CelesTrak GP data in the current **OMM** format, by group or by search (name or NORAD number).
  Each query is cached for at least 2 hours, which is CelesTrak's update interval; it blocks clients that fetch more
  often.
- **Positions.** Calculated in the browser with SGP4 (satellite.js) and labelled **calculated**, with the element
  epoch and its age.
- **Orbit facts:** period, perigee and apogee, inclination, altitude and speed.
- **Map and 3D.** The ground track shows the past quarter-orbit solid and the next orbit dashed (predicted). The 3D
  orbit view shows satellites at true altitude on the World Explorer globe.
- **Space weather:**
  - NOAA SWPC (no key): planetary K index with storm level, GOES X-ray flux and latest flare, and current alerts.
  - NASA DONKI notifications: a free key, or the shared `DEMO_KEY` (about 10 requests an hour).
- **Launches.** Launch Library 2 (free for 15 requests an hour; cached for 30 minutes):
  - provider, mission, site, time and status;
  - times with hour/day/month precision are marked as estimates;
  - "Go" is shown as confirmed only when the source says so.

## Global Situation Report

Compiled on demand from every operation:

- conflict and unrest, disasters and severe weather, airports, diplomacy;
- watchlists;
- home weather;
- upcoming trips with destination forecasts and FCDO advice;
- aviation data status;
- space weather;
- ISS position and launches;
- recent dossiers.

Every line carries a label: **Live**, **Reported**, **Forecast**, **Calculated**, **Scheduled**, **Saved research** or
**Your plan**. It also shows its source, its time and, where it has one, a link.

Sources that were unavailable are listed. The optional executive summary is written by the AI from the report's own
lines and labelled as such. Reports are saved and can be exported to PDF.

## Voice

These work instantly:

- "Initiate / open Operation Blackbox, Wayfinder, Sentinel or Orbit"
- "Track the International Space Station"
- "Show current space weather"
- "Show upcoming launches"
- "Show available public city webcams"
- "Show my watchlists"
- "Show me the latest global events"
- "Generate a situation report"

Everything else goes to JARVIS's AI. The `mission_operations` tool covers, for example:

- "Research this aircraft"
- "Create a dossier on this organisation"
- "Plan a five-day trip to Iceland"
- "Show me flights to London" (answers with the airports and says there are no free schedules)
- "Check the weather for my destination"
- "Save this journey" (trips save automatically)
- "Plan an expedition"
- "Watch Cyprus for disasters"

Each chat request includes what Mission Control is showing: the operation, the open dossier or trip, and the selected
aircraft or satellite. That lets "this aircraft" and "this journey" resolve. Continuous conversation works as before,
with no wake word needed mid-conversation.

## Data sources and keys

Every provider was checked on 17 Nov 2026: pricing, whether a key or payment is needed, limits, licence, attribution,
embedding and caching. None requires payment.

| Source | Used for | Key | Limits / terms | Tested live here |
|---|---|---|---|---|
| CelesTrak | Orbital elements (OMM) | No | Cache ≥ 2 h | **Yes**: ISS, 17 stations, 156 bright satellites |
| NOAA SWPC | Kp, X-ray flares, alerts | No | Public domain | **Yes** |
| NASA DONKI (api.nasa.gov) | Space-weather notifications | Optional free key | DEMO_KEY about 10/hour | **Yes** (12 notifications); the separate flare endpoint returned 404, so flares come from SWPC |
| Launch Library 2 | Launches | No | 15 requests/hour | **Yes** |
| NASA EONET | Natural events | No | Public | Its server returned HTTP 500 throughout; shown as failed. Tested with a stand-in |
| FAA NAS status | US airport disruptions | No | Public domain | **Yes**: 5 current items |
| Wikipedia / Wikimedia Commons | Dossier reference and images | No | CC BY-SA; licence shown per image | **Yes** |
| GOV.UK Content API | FCDO travel advice | No | Open Government Licence v3.0 | **Yes** (Iceland) |
| Open-Meteo | Places and forecasts | No | Free, non-commercial | **Yes**; the forecast timed out intermittently through this container's proxy |
| OSRM (project-osrm.org, FOSSGIS) | Routes | No | Light personal use | **Yes**: car 47.7 km / 47 min; walking 1.1 km / 15 min |
| OurAirports | 3,291 airports, offline | No | Public domain | n/a (offline) |
| OpenFlights | 799 airlines, offline | No | ODbL (data); the repository code is AGPL and isn't used | n/a (offline) |
| ADSB.lol | Live flight status, aircraft dossiers | Optional | As in 6.5 | **Yes** (TK1, a B777) |
| YouTube Data API | Webcam verification | **Free key** | 10,000 units/day; about 2,800 used at most | Not testable without your key; YouTube's pages refuse this cloud machine. Tested with a stand-in |
| Windy Webcams | Webcams by area | **Free key** | Free tier: embed the timelapse player; image links 15 min | Needs your key. Tested with a stand-in |

**Optional free keys.** Enter them in **Settings → Global Operations**; they are stored encrypted:

- **Windy Webcams key:** free account.
- **YouTube Data API key:** free Google Cloud project.
- **NASA API key:** free, by email.

The keys from 6.5 still apply: ADSB.lol, OpenSky, ReliefWeb and UCDP.

**Not used:**
- **The ADSB.lol community route lookup:** it now returns nothing (HTTP 201 with an empty body), so flight status
  shows only the live position.
- **Paid flight-schedule and fare APIs:** none are used.

## Limitations

- **Live YouTube camera status** can't be confirmed without your free YouTube key, so no stream is embedded without it.
- **Dossier quality** depends on what web search finds. Every claim links to its source, but JARVIS does not verify
  facts independently.
- **Forecasts** reach 7 days ahead; trips further out show "check closer to departure".
- **Satellite positions** are calculated, not observed. Very large groups (for example Starlink) are limited to 1,500
  objects on the map for speed.
- **PDF export** uses the system print dialog ("Save as PDF" / "Microsoft Print to PDF").
