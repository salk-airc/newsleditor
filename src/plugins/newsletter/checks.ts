import { PLACEHOLDER } from "./email.ts";
import { cleanHtml, htmlBoxes } from "./html-box.ts";

// Pre-send checks on an edition's markdown, shown under the studio's editor.
// Pure functions, so they run in the browser too.

/** Words a reader sees: link URLs and image syntax don't count. */
export function wordCount(markdown: string): number {
  return markdown
    .replace(/<[^>]*>/g, " ")
    .replace(/^(`{3,}|~{3,}).*$/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .split(/\s+/)
    .filter((w) => /\w/.test(w)).length;
}

// A line right after a bullet, with no blank line between, joins that bullet
// (markdown "lazy continuation"). Almost always meant as a new paragraph.
export function joinedToBullet(markdown: string): string[] {
  const lines = markdown.split("\n");
  const hits: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const line = lines[i];
    if (/^\s*[-*+] /.test(prev) && line.trim() && !/^\s*([-*+] |\d+\. )/.test(line) && !/^\s{2,}/.test(line)) {
      hits.push(line.trim().slice(0, 50));
    }
  }
  return hits;
}

/** What the email won't show of the edition's HTML boxes: what cleaning takes out, and what Outlook ignores. */
export function htmlBoxProblems(markdown: string): string[] {
  const removed = new Set<string>();
  const outlook = new Set<string>();
  for (const box of htmlBoxes(markdown)) {
    const clean = cleanHtml(box);
    clean.removed.forEach((r) => removed.add(r));
    clean.outlook.forEach((o) => outlook.add(o));
  }
  return [
    ...(removed.size ? [`HTML box: left out of the email: ${[...removed].join(", ")}`] : []),
    ...(outlook.size ? [`HTML box: ${[...outlook].join(", ")}`] : []),
  ];
}

export function placeholders(markdown: string): string[] {
  return markdown.match(new RegExp(PLACEHOLDER.source, "g")) ?? [];
}
