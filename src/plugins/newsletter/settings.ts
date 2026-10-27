import { z } from "zod";

// A newsletter's settings: what it's called, when it goes out, how a new
// edition starts, the signature under every email and the voice Claude
// drafts in. Filled in by first-run setup (/newsletter/setup), changed later
// there or through Claude (the plugin's settings tools). Pure: no EmDash, no
// I/O. The look lives separately, in theme.ts.

// No .transform(): these schemas also describe the MCP tools, as JSON Schema.
export const settingsSchema = z.object({
  /** The newsletter's name, as people say it: "Field Notes". */
  name: z.string().min(1).max(80),
  /**
   * Every edition's subject line. {name} is the name, {date} the edition's
   * date ("Oct 2, 2026").
   */
  subject: z.string().min(1).max(160),
  /** The day of the week editions go out, 0 Sunday to 6 Saturday, or null for no fixed day. */
  weekday: z.number().int().min(0).max(6).nullable(),
  /** The time zone that decides what "today" is, like "America/Chicago". */
  timeZone: z.string().min(1).max(64),
  /** What a new edition starts as, in markdown. {day} is the weekday's name. [PLACEHOLDERS] are flagged until replaced. */
  starter: z.string().max(4000),
  /** Under every email, in markdown: names, roles, a link. Images only from this site. */
  signature: z.string().max(2000),
  /** Who it comes from, for the people sending it. */
  sender: z.object({
    name: z.string().max(120),
    email: z.string().max(200),
  }),
  /** How the newsletter sounds, in the editors' words, for Claude when it drafts. */
  voice: z.string().max(4000),
  /**
   * Where images live, as chosen in setup: "local" (this computer's media
   * folder) or "bucket" (an S3-compatible bucket). Informational: the actual
   * storage comes from the server's environment (see README).
   */
  images: z.enum(["local", "bucket"]),
});
export type Settings = z.infer<typeof settingsSchema>;

export const settingsPatchSchema = settingsSchema
  .omit({ sender: true })
  .partial()
  .extend({ sender: settingsSchema.shape.sender.partial().optional() });
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Settings before setup has run. */
export const DEFAULT_SETTINGS: Settings = {
  name: "Newsletter",
  subject: "{name} — {date}",
  weekday: null,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  starter: `Hi everyone,

[INTRO]

### 1. [SECTION TITLE]

[TEXT]

### Quick hits

- [ITEM]
`,
  signature: "",
  sender: { name: "", email: "" },
  voice: "",
  images: "local",
};

export function applySettingsPatch(settings: Settings, patch: SettingsPatch): Settings {
  return { ...settings, ...patch, sender: { ...settings.sender, ...patch.sender } };
}

/** Problems that keep settings from being saved. */
export function checkSettings(settings: Settings): string[] {
  const errors: string[] = [];
  if (!settings.subject.includes("{date}"))
    errors.push('The subject needs {date} in it, so every edition gets its own subject line: like "{name} — {date}".');
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: settings.timeZone });
  } catch {
    errors.push(`"${settings.timeZone}" isn't a time zone. Use a name like "America/New_York" or "Europe/London".`);
  }
  if (settings.sender.email && !/^[^\s@]+@[^\s@]+$/.test(settings.sender.email))
    errors.push(`"${settings.sender.email}" doesn't look like an email address.`);
  if (/!\[[^\]]*\]\((?!\/(?!\/))/.test(settings.signature))
    errors.push("Images in the signature must be on this site: upload them to the media library, not a link to another site.");
  return errors;
}
