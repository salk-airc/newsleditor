// npm start: build the site if it hasn't been built (or the source changed
// since), then run server.mjs.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const built = join(root, "dist/server/entry.mjs");

function newest(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(stat.mtimeMs, ...readdirSync(path).map((name) => newest(join(path, name))));
}

const sources = ["src", "public", ".emdash", "astro.config.mjs", "package.json"]
  .map((p) => join(root, p))
  .filter(existsSync);
const stale = !existsSync(built) || Math.max(...sources.map(newest)) > statSync(built).mtimeMs;

if (stale) {
  console.log("Building the site (first start, or the code changed)...");
  const result = spawnSync("npx", ["astro", "build"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const server = spawnSync(process.execPath, [join(root, "server.mjs")], { cwd: root, stdio: "inherit" });
process.exit(server.status ?? 0);
