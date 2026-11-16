// Fixed-window in-memory rate limiter (the backend runs as a single instance).
const buckets = new Map();

export function hit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start >= windowMs) { b = { start: now, count: 0 }; buckets.set(key, b); }
  b.count++;
  return { ok: b.count <= limit, retryAfter: Math.ceil((b.start + windowMs - now) / 1000) };
}

export function rateLimit({ limit, windowMs, key = (req) => req.auth?.deviceId || req.ip, name = "api" }) {
  return (req, res, next) => {
    const r = hit(`${name}:${key(req)}`, limit, windowMs);
    if (r.ok) return next();
    res.setHeader("retry-after", String(r.retryAfter));
    res.status(429).json({ error: "Too many requests. Please slow down.", retryAfter: r.retryAfter });
  };
}

export function resetRateLimits() { buckets.clear(); }

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > 3600_000) buckets.delete(k);
}, 600_000).unref();
