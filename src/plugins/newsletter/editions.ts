import type { Settings } from "./settings.ts";

// Rules for editions, shared by the site (the studio's "Start the next
// edition") and the newsletter EmDash plugin (its next_edition tool for
// Claude), so both pick the same date, subject line and starter text, from
// the newsletter's settings (settings.ts). Pure functions: no EmDash, no I/O.

/** "Oct 2, 2026". Edition dates are stored at noon UTC, so UTC keeps the day right. */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The edition's subject line, from the settings' subject format: "Field Notes — Oct 30, 2026". */
export function editionTitle(settings: Settings, date: Date): string {
  return settings.subject.replaceAll("{name}", settings.name).replaceAll("{date}", formatDate(date));
}

/** "Monday", for a weekday number (Jan 7, 2024 was a Sunday); null with no fixed day. */
export function weekdayName(weekday: number | null): string | null {
  if (weekday === null) return null;
  return new Date(Date.UTC(2024, 0, 7 + weekday)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

/**
 * The first edition day from today (in the newsletter's time zone, today
 * included) that has no edition yet, as the slug and the noon-UTC date
 * editions are stored at. With no fixed weekday, every day is an edition day.
 */
export function nextOpenEditionDate(
  settings: Settings,
  taken: Set<string>,
  now = new Date(),
): { slug: string; date: Date } {
  const today = now.toLocaleDateString("en-CA", { timeZone: settings.timeZone }); // YYYY-MM-DD
  const date = new Date(`${today}T12:00:00.000Z`);
  const step = settings.weekday === null ? 1 : 7;
  if (settings.weekday !== null) date.setUTCDate(date.getUTCDate() + ((settings.weekday - date.getUTCDay() + 7) % 7));
  while (taken.has(date.toISOString().slice(0, 10))) date.setUTCDate(date.getUTCDate() + step);
  return { slug: date.toISOString().slice(0, 10), date };
}

/** What a new edition starts as: the settings' starter, {day} filled in. [PLACEHOLDERS] are flagged until replaced. */
export function starterBody(settings: Settings, date: Date): string {
  const day = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return settings.starter.replaceAll("{day}", day);
}
