// npm run check:neutral: newsletteditor ships with no organization's names
// or branding. It started as one organization's newsletter studio; this
// keeps that organization's names from creeping back in.

import { execFileSync } from "node:child_process";

const PATTERN = "AIRC|Salk|Talmo|News & Vibes|airc\\.salk";
const paths = ["src", "public", "scripts", ".emdash", "astro.config.mjs", "server.mjs", "README.md", ".claude"];

let out = "";
try {
  out = execFileSync("git", ["grep", "-nIE", PATTERN, "--", ...paths, ":!scripts/check-neutral.mjs"], { encoding: "utf8" });
} catch (err) {
  // git grep exits 1 when nothing matches.
  if (err.status !== 1) throw err;
}
if (out.trim()) {
  console.error("Organization-specific text found:\n" + out);
  process.exit(1);
}
console.log("No organization-specific text found.");
