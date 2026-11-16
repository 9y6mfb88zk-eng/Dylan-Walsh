import { config } from "./config.js";

const WMO = {
  0: "clear skies", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "heavy freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers", 85: "snow showers", 86: "heavy snow showers",
  95: "thunderstorms", 96: "thunderstorms with hail", 99: "severe thunderstorms with hail",
};
export const describeCode = (c) => WMO[c] ?? "unsettled weather";

const cache = new Map(); // key -> { at, data }
const TTL_MS = 10 * 60 * 1000;

export async function getWeather(lat = config.defaultLat, lon = config.defaultLon, place = null) {
  lat = Number(lat); lon = Number(lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) { lat = config.defaultLat; lon = config.defaultLon; }
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.data, place: place || hit.data.place };

  const url = new URL(config.openMeteoUrl);
  url.search = new URLSearchParams({
    latitude: String(lat), longitude: String(lon),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset,uv_index_max",
    hourly: "temperature_2m,weather_code,precipitation_probability",
    forecast_days: "2", timezone: "auto", wind_speed_unit: "kmh",
  }).toString();

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const j = await res.json();
  const c = j.current, d = j.daily;
  const nowIdx = Math.max(0, (j.hourly?.time || []).findIndex((t) => t >= c.time));
  const hourly = (j.hourly?.time || []).slice(nowIdx, nowIdx + 12).map((t, i) => ({
    time: t, temp: Math.round(j.hourly.temperature_2m[nowIdx + i]),
    code: j.hourly.weather_code[nowIdx + i], rain: j.hourly.precipitation_probability?.[nowIdx + i] ?? null,
  }));
  const data = {
    place: place || (lat === config.defaultLat && lon === config.defaultLon ? config.defaultPlace : "your location"),
    lat, lon, timezone: j.timezone,
    current: {
      temp: Math.round(c.temperature_2m), feels: Math.round(c.apparent_temperature),
      humidity: c.relative_humidity_2m, wind: Math.round(c.wind_speed_10m),
      code: c.weather_code, summary: describeCode(c.weather_code), isDay: !!c.is_day,
    },
    today: {
      high: Math.round(d.temperature_2m_max[0]), low: Math.round(d.temperature_2m_min[0]),
      rain: d.precipitation_probability_max?.[0] ?? null, uv: d.uv_index_max?.[0] ?? null,
      sunrise: d.sunrise?.[0], sunset: d.sunset?.[0], summary: describeCode(d.weather_code[0]),
    },
    tomorrow: {
      high: Math.round(d.temperature_2m_max[1]), low: Math.round(d.temperature_2m_min[1]),
      rain: d.precipitation_probability_max?.[1] ?? null, summary: describeCode(d.weather_code[1]),
    },
    hourly,
    fetchedAt: new Date().toISOString(),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

export function weatherSentence(w) {
  if (!w) return "Weather unavailable.";
  const c = w.current, t = w.today;
  return `${w.place}: ${c.temp}°C now (feels ${c.feels}°C), ${c.summary}, wind ${c.wind} km/h, humidity ${c.humidity}%. ` +
    `Today ${t.summary}, high ${t.high}°C, low ${t.low}°C, rain chance ${t.rain ?? "?"}%, UV ${t.uv ?? "?"}. ` +
    `Tomorrow ${w.tomorrow.summary}, ${w.tomorrow.low}–${w.tomorrow.high}°C.`;
}
