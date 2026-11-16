// Copies the computer-action allowlist from the backend so both sides validate with identical rules.
import fs from "node:fs";
fs.copyFileSync(new URL("../../server/shared/computer-actions.js", import.meta.url), new URL("../src/shared/computer-actions.js", import.meta.url));
console.log("synced src/shared/computer-actions.js");
