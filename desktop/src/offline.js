// Retries the server with back-off and returns to the app as soon as it answers.
const q = new URLSearchParams(location.search);
const url = q.get("url");
let delay = 2000;
async function tryAgain() {
  try {
    const r = await fetch(new URL("/api/health/ping", url), { cache: "no-store" });
    if (r.ok) { location.href = url; return; }
  } catch {}
  delay = Math.min(30000, delay * 1.6);
  setTimeout(tryAgain, delay);
}
addEventListener("online", () => { delay = 1000; tryAgain(); });
setTimeout(tryAgain, delay);
