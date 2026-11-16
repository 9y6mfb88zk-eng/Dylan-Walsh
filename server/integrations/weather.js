// Real weather from Open-Meteo (no key needed). Never simulated.
import { config } from "../config.js";

const WMO = {
  0: "clear skies", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers", 85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorms", 96: "thunderstorms with hail", 99: "severe thunderstorms with hail",
};
export const describeCode = (c) => WMO[c] ?? "unsettled weather";

const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

export async function getWeather({ lat, lon, place, units = "metric" } = {}) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { lat = config.defaultLat; lon = config.defaultLon; place ||= config.defaultPlace; }
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${units}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.data, place: place || hit.data.place, cached: true };

  const imperial = units === "imperial";
  const url = new URL(config.openMeteoUrl);
  url.search = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,is_day,precipitation",
    hourly: "temperature_2m,weather_code,precipitation_probability,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset,uv_index_max",
    forecast_days: "7", timezone: "auto", wind_speed_unit: imperial ? "mph" : "kmh", temperature_unit: imperial ? "fahrenheit" : "celsius",
  }).toString();

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Weather service error (${res.status})`);
  const j = await res.json();
  const c = j.current, d = j.daily, h = j.hourly || { time: [] };
  const startIdx = Math.max(0, h.time.findIndex((t) => t >= c.time.slice(0, 13)));
  const data = {
    place: place || "your location", lat, lon, timezone: j.timezone, units,
    unitTemp: imperial ? "°F" : "°C", unitWind: imperial ? "mph" : "km/h",
    current: {
      time: c.time, temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature),
      humidity: c.relative_humidity_2m, wind: Math.round(c.wind_speed_10m), gusts: Math.round(c.wind_gusts_10m ?? c.wind_speed_10m),
      code: c.weather_code, summary: describeCode(c.weather_code), isDay: !!c.is_day, precipitation: c.precipitation ?? 0,
    },
    hourly: h.time.slice(startIdx, startIdx + 24).map((t, i) => ({
      time: t, temp: Math.round(h.temperature_2m[startIdx + i]), code: h.weather_code[startIdx + i],
      rain: h.precipitation_probability?.[startIdx + i] ?? null, wind: Math.round(h.wind_speed_10m?.[startIdx + i] ?? 0),
    })),
    daily: d.time.map((date, i) => ({
      date, code: d.weather_code[i], summary: describeCode(d.weather_code[i]),
      high: Math.round(d.temperature_2m_max[i]), low: Math.round(d.temperature_2m_min[i]),
      rain: d.precipitation_probability_max?.[i] ?? null, rainMm: d.precipitation_sum?.[i] ?? null,
      wind: Math.round(d.wind_speed_10m_max?.[i] ?? 0), uv: d.uv_index_max?.[i] ?? null, sunrise: d.sunrise?.[i], sunset: d.sunset?.[i],
    })),
    source: "Open-Meteo",
    fetchedAt: new Date().toISOString(),
  };
  data.today = data.daily[0];
  data.tomorrow = data.daily[1];
  cache.set(key, { at: Date.now(), data });
  return data;
}

export function weatherSentence(w) {
  if (!w) return "Weather unavailable.";
  const c = w.current, t = w.today, m = w.tomorrow, u = w.unitTemp;
  return `${w.place} (source ${w.source}, fetched ${w.fetchedAt}): now ${c.temp}${u} (feels ${c.feels}${u}), ${c.summary}, wind ${c.wind} ${w.unitWind}, humidity ${c.humidity}%. ` +
    `Today ${t.summary}, ${t.low}–${t.high}${u}, rain chance ${t.rain ?? "?"}%, UV ${t.uv ?? "?"}. ` +
    (m ? `Tomorrow ${m.summary}, ${m.low}–${m.high}${u}, rain chance ${m.rain ?? "?"}%, wind up to ${m.wind} ${w.unitWind}. ` : "") +
    `Week: ${w.daily.slice(2).map((d) => `${d.date} ${d.summary} ${d.low}–${d.high}${u} rain ${d.rain ?? "?"}%`).join("; ")}.`;
}

/** Place search for changing the home location. */
export async function geocode(q) {
  const u = new URL(config.geocodeUrl);
  u.search = new URLSearchParams({ name: String(q).slice(0, 80), count: "6", language: "en", format: "json" }).toString();
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Place search failed (${r.status})`);
  const j = await r.json();
  return (j.results || []).map((p) => ({ name: [p.name, p.admin1, p.country].filter(Boolean).join(", "), lat: p.latitude, lon: p.longitude, timezone: p.timezone }));
}
