// Renders the PWA icons (PNG) from an inline SVG using the preinstalled Playwright Chromium.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";
let chromium;
try { ({ chromium } = await import("playwright")); }
catch { ({ chromium } = createRequire(execSync("npm root -g").toString().trim() + "/")("playwright")); }
const out = path.resolve("public/icons");
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs>
 <radialGradient id="bg" cx="50%" cy="35%" r="75%"><stop offset="0" stop-color="#0a2340"/><stop offset="1" stop-color="#01040a"/></radialGradient>
 <radialGradient id="o" cx="38%" cy="32%" r="70%"><stop offset="0" stop-color="#f2faff"/><stop offset=".2" stop-color="#67e8f9"/><stop offset=".5" stop-color="#22b8d8"/><stop offset=".85" stop-color="#0a3d66"/><stop offset="1" stop-color="#020c18"/></radialGradient>
 <filter id="g"><feGaussianBlur stdDeviation="18"/></filter>
</defs>
<rect width="512" height="512" fill="url(#bg)"/>
<g transform="translate(256 256) scale(${pad})">
 <circle r="150" fill="#00e5ff" opacity=".45" filter="url(#g)"/>
 <circle r="190" fill="none" stroke="#67e8f9" stroke-opacity=".45" stroke-width="4" stroke-dasharray="180 60"/>
 <circle r="168" fill="none" stroke="#2f7fe0" stroke-opacity=".45" stroke-width="3" stroke-dasharray="6 14"/>
 <circle r="130" fill="url(#o)"/>
 <circle r="38" fill="#fff" opacity=".8" filter="url(#g)"/>
 <ellipse cx="-20" cy="-78" rx="62" ry="28" fill="#fff" opacity=".28"/>
</g></svg>`;
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [["icon-192.png", 192, 1], ["icon-512.png", 512, 1], ["apple-touch-icon.png", 180, 1], ["icon-maskable-512.png", 512, 0.78]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:#01040a">${svg(pad).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: path.join(out, name), omitBackground: false });
  console.log("wrote", name);
}
await browser.close();
