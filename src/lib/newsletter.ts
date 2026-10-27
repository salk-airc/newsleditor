import { Role, type User } from "@emdash-cms/auth";
import { getEmDashCollection, PluginStorageRepository } from "emdash";
import { getDb } from "emdash/runtime";
import { formatDate } from "../plugins/newsletter/editions.ts";
import { applySettingsPatch, DEFAULT_SETTINGS, type Settings } from "../plugins/newsletter/settings.ts";
import { applyPatch, DEFAULT_THEME, type Theme } from "../plugins/newsletter/theme.ts";
import { renderWeb, type Section } from "../plugins/newsletter/web.ts";

export {
  editionTitle,
  formatDate,
  nextOpenEditionDate,
  starterBody,
  weekdayName,
} from "../plugins/newsletter/editions.ts";

// Reading the newsletter from EmDash: editions from the "editions"
// collection (.emdash/seed.json), and the settings and theme the newsletter
// plugin keeps in its storage.

export interface Edition {
  id: string;
  slug: string;
  title: string;
  date: Date;
  summary: string | null;
  body: string;
}

interface EditionData {
  slug?: string;
  title?: string;
  edition_date?: string | Date;
  summary?: string | null;
  body?: string;
}

/**
 * Who may use the studio (/newsletter/edit), the Theme page and setup:
 * EmDash Editors and Admins. Reading the archive takes any sign-in
 * (src/middleware.ts).
 */
export function canEdit(user: User | undefined): boolean {
  return !!user && user.role >= Role.EDITOR;
}

/** Published editions, newest first. With status "draft", the never-published ones instead. */
export async function getEditions(status: "published" | "draft" = "published"): Promise<Edition[]> {
  const { entries, error } = await getEmDashCollection("editions", { status, limit: 500 });
  if (error) throw error;
  return entries
    .map(({ id, data }) => {
      const d = data as EditionData;
      const date = new Date(d.edition_date ?? 0);
      return {
        id,
        slug: d.slug ?? id,
        title: d.title ?? formatDate(date),
        date,
        summary: d.summary ?? null,
        body: d.body ?? "",
      };
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

// The plugin's storage, read the way the plugin itself does (its routes in
// src/plugins/newsletter/index.ts write it). One newsletter per site.
async function stored<T>(collection: "settings" | "themes"): Promise<T | null> {
  const repo = new PluginStorageRepository<T>(await getDb(), "newsletter", collection, []);
  return repo.get("default");
}

/** The newsletter's settings, and whether first-run setup has saved them yet. */
export async function getSettings(): Promise<{ settings: Settings; configured: boolean }> {
  const row = await stored<{ settings: Settings }>("settings");
  return {
    settings: row ? applySettingsPatch(DEFAULT_SETTINGS, row.settings) : DEFAULT_SETTINGS,
    configured: !!row,
  };
}

/** The newsletter's theme. */
export async function getTheme(): Promise<Theme> {
  const row = await stored<{ theme: Theme }>("themes");
  return row ? applyPatch(DEFAULT_THEME, row.theme) : DEFAULT_THEME;
}

export function readingMinutes(markdown: string): number {
  const words = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\]\([^)]*\)/g, "]")
    .split(/\s+/)
    .filter((w) => /\w/.test(w)).length;
  return Math.max(1, Math.round(words / 230));
}

/** The edition's sections, in order. The first one is its lead story. */
export function sectionsOf(markdown: string): Section[] {
  return renderWeb(markdown).sections.filter((s) => !/^quick hits/i.test(s.title));
}
