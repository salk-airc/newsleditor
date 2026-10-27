import { PLACEHOLDER } from "./email.ts";

// Pre-send checks on an edition's markdown, shown under the studio's editor.
// Pure functions, so they run in the browser too.

/** Words a reader sees: link URLs and image syntax don't count. */
export function wordCount(markdown: string): number {
  return markdown
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

export function placeholders(markdown: string): string[] {
  return markdown.match(new RegExp(PLACEHOLDER.source, "g")) ?? [];
}
