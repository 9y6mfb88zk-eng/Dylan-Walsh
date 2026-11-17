# Global Operations (JARVIS 6.5)

Mission Control now opens on **Global Operations**:

- **Left:** the living JARVIS core and live system readings.
- **Centre:** a world map with layers, public civil flights and event markers.
- **Right:** the Global Events feed.
- **Bottom:** six status panels.

Everything shown comes from a real source. When a source is unavailable, the panel says so.

Navigation, the first six sections:

| Section | What it shows |
|---|---|
| Global Operations | The full layout: core, map with flights and events, events feed, status panels |
| World Explorer | Map layers (satellite, terrain, relief, radar, 3D globe) and your places with live time and weather |
| Intelligence | Your research reports (unchanged) |
| Global Events | The events feed, with the map showing event locations only |
| Flight Tracking | Search, filters, an aircraft list and the aircraft card |
| System Diagnostics | Existing diagnostics (unchanged) |

The earlier Mission Control views (Overview, Architecture, Processes, Communications, Projects, Personal) are still
there, below those six.

## Data sources: what each one costs, needs and allows

Every provider was checked on 17 Nov 2026 (pricing, limits, licence, registration) and tested from JARVIS. No source
needs a payment method.

| Source | Used for | Key needed? | Free limit | Licence / terms | Tested live here |
|---|---|---|---|---|---|
| **ADSB.lol** | Aircraft in views up to 250 nm across; search; aircraft details | No (optional free key) | 500 requests/day per IP; 1,000 with a free key | ODbL 1.0, attribution shown | **Yes**: 14 aircraft around Cyprus, search, details |
| **OpenSky Network** | Continental and worldwide aircraft | No (optional free account) | 400 credits/day anonymous (a world view costs 4); 4,000 with a free account | Non-commercial use | **Yes**: about 2,500 over Europe, about 6,000 worldwide |
| **GDACS** (UN / European Commission) | Disaster alerts with alert level | No | Not published | Attribution | **Yes**: 87 current events |
| **USGS** | Earthquakes M4.5+ (past week) | No | Not published | Public domain | **Yes**: 107 earthquakes |
| **GDELT** | News reports of conflict, attacks, unrest, humanitarian, diplomacy, ceasefires | No | One request every 5 s | Attribution | **No**: GDELT refused every request from this cloud container (HTTP 429), even when spaced out. It should work from a home connection; tested with a stand-in |
| **ReliefWeb** (UN OCHA) | Disasters and humanitarian situations | **Approved appname** (free, by form) | — | Attribution | Confirmed it refuses requests without an approved appname (HTTP 403); tested with a stand-in |
| **UCDP** (Uppsala) | Researcher-coded conflict events | **Token** (free, by email) | 5,000 requests/day | CC BY 4.0 | Confirmed it refuses requests without a token (HTTP 401); tested with a stand-in |
| **OpenStreetMap** tiles | Standard map (darkened) and the OSM layer | No | Fair use; JARVIS caches for 7+ days, never bulk-downloads | ODbL, attribution shown | **Yes** |
| **OpenTopoMap** | Terrain layer | No | Fair use | CC-BY-SA | **Yes** |
| **EOX Sentinel-2 cloudless** | Satellite layer (2023 composite) | No | — | CC BY-NC-SA 4.0 (non-commercial) | **Yes** |
| **NASA GIBS** | Satellite, latest day (MODIS); Blue Marble relief | No | — | No restrictions, attribution requested | **Yes** |
| **RainViewer** | Weather radar | No | No hard limit; cache required | Free for personal use, attribution required | **Yes** |

The **Global Operations** tab in Settings is where you enter the optional keys and see each source's state.

**Not used, and why:**

- **CARTO dark basemap:** its tiles now come back stamped "API KEY REQUIRED". A key means creating an account, so
  JARVIS uses OpenStreetMap darkened in the browser instead.
- **Esri World Imagery:** its terms for use without an ArcGIS account are unclear.
- **GDELT GEO API:** retired (HTTP 404).

## Flight tracking

- **One request per map view, never one per aircraft.**
  - Views up to 250 nm across use ADSB.lol's point query.
  - Wider views use OpenSky's bounding box.
  - The world view uses OpenSky's single global query.
- **Caching:** a fresh wider result also serves any smaller view inside it.
- **Allowance:** cache lifetimes stretch as each provider's daily allowance runs down, read from their own rate-limit
  headers.
- **Backoff:** a 429 or an error backs off, using Retry-After when the provider sends it.
- **Polling:** happens only while the flight layer is visible and the window isn't hidden. The server never polls
  on its own.
- **Privacy:** aircraft that ADSB.lol flags as **military**, **LADD** (the owner asked not to be shown) or **PIA**
  (privacy address) are removed from every result, OpenSky's included.
  - JARVIS fetches ADSB.lol's own lists every 6 hours and uses them only to hide those aircraft.
  - There is no military filter, search or follow.
- **Freshness:** every position carries its age.
  - Positions older than 60 s are drawn faded and marked stale.
  - Positions older than 5 minutes are dropped.
- **Trails:** drawn only from positions JARVIS actually received. Nothing is interpolated or predicted.
- **Coverage:** depends on volunteer receivers. Many aircraft are not visible, and JARVIS says so on screen and when
  answering questions.

## Global Events

- **Links:** every item links to its original publication.
- **Dates:** each item shows the event date, the publication date and the retrieval date.
- **Verification labels:**
  - **Coded by UCDP researchers:** UCDP.
  - **Official monitoring body:** GDACS, ReliefWeb.
  - **Reviewed by seismologists:** USGS. The alternative label is "Automatic solution, not yet reviewed".
  - **Reported by several independent outlets (not independently verified):** a GDELT story carried by two or more
    different outlets.
  - **Single report — unconfirmed:** a GDELT story from one outlet.
- **Location accuracy is always stated:**
  - USGS epicentres are exact.
  - GDACS gives the affected-area centre.
  - UCDP gives town-level locations, rounded to about 10 km.
  - GDELT news is placed at **country level only, inferred from the headline**, and drawn as a hollow marker. A
    headline that names no country gets no map marker.
- **Not tactical intelligence:** this is public information for general awareness. There are no troop positions, no
  targeting and no live military movements.

## Voice

These work instantly and answer from what was retrieved:

- "Show me aircraft around Cyprus" (also Europe, the Mediterranean and other regions)
- "Zoom out to the worldwide air traffic map"
- "Select the nearest visible aircraft"
- "Hide flight tracking" / "Show flight tracking"
- "Find flight BA123"
- "Show me conflicts"

Anything needing a lookup goes to the AI's `global_operations` tool, which only answers from returned data. Examples:
"show me aircraft around Paphos airport" and "find this flight by its callsign". If a flight isn't found, JARVIS says
it isn't visible in the available data.

## Measured performance

Run `GOC_AIRCRAFT=12000 node scripts/perf-goc.mjs out.json`. Results are in `docs/perf-6.5-goc.json`, summarised in
`docs/performance.md`.

## Not verified

- **GDELT live:** blocked from this container (429).
- **ReliefWeb and UCDP live:** they need your free credentials.
- **Your laptop's GPU and the map frame rate there:** this container renders in software.
- **The Windows installer build:** verified by CI, not on a real laptop.
