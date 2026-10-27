// npm run dev: the Astro dev server, after clearing what a production build
// leaves behind. With dist/, .astro/ and Vite's cache from `npm start`
// around, `astro dev` resolves page scripts against the old build and serves
// blank pages ("Unable to resolve ...?astro&type=script"). npm start rebuilds
// when dist/ is missing, so nothing is lost.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

for (const dir of ["dist", ".astro", "node_modules/.vite"]) rmSync(dir, { recursive: true, force: true });

const result = spawnSync("npx", ["astro", "dev", ...process.argv.slice(2)], { stdio: "inherit", shell: process.platform === "win32" });
process.exit(result.status ?? 0);
