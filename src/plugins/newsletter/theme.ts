import { z } from "zod";

// A newsletter's look: its name, logo, colours, font and banner, as data that
// the group running it edits (in the studio's Theme page, or by asking
// Claude through the newsletter plugin's theme tools). The designed email
// (email-designed.ts) renders from it. Pure: no EmDash, no I/O.
//
// What a theme can say is limited to what survives email: solid colours,
// near-black text and art drawn as images by the site (/email/art/), because
// Outlook on the web drops CSS gradients from a pasted email and phone dark
// modes recolour text but never images.

// No .transform(): these schemas also describe the MCP tools, as JSON Schema.
const HEX = z.string().regex(/^#[0-9a-fA-F]{6}$/, "A colour is a 6-digit hex value like #3557a0");

export const FONTS = {
  geist: {
    label: "Geist (web font, falls back to Aptos)",
    stack: "Geist,Aptos,Aptos_EmbeddedFont,Aptos_MSFontService,Calibri,Helvetica,Arial,sans-serif",
    link: "https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono&display=swap",
  },
  sans: {
    label: "System sans (Aptos, Segoe UI, Helvetica)",
    stack: "-apple-system,BlinkMacSystemFont,'Segoe UI',Aptos,Aptos_EmbeddedFont,Aptos_MSFontService,Calibri,Helvetica,Arial,sans-serif",
    link: null,
  },
  serif: {
    label: "Serif (Georgia)",
    stack: "Georgia,Cambria,'Times New Roman',Times,serif",
    link: null,
  },
} as const;
export type FontKey = keyof typeof FONTS;

export const themeSchema = z.object({
  /** The name in the masthead: lead in the text colour, tail in the accent ("Field Notes" + "from the Lab"). */
  nameLead: z.string().min(1).max(60),
  nameTail: z.string().max(40),
  /** Short word next to the logo ("lab"); empty for none. */
  wordmark: z.string().max(24),
  /** One or two lines beside the wordmark; a line break splits them. */
  tagline: z.string().max(120),
  /** Logo image: a path on this site (/email/..., /_emdash/api/media/file/...), never another site. Shown 40px tall. */
  logo: z.string().max(500).nullable(),
  /** The small line under the email. */
  footer: z.string().max(160),
  colors: z.object({
    /** The whole email's background, edge to edge. Must be light. */
    page: HEX,
    /** Headings and body text. Must be near-black so phone dark modes turn it near-white. */
    ink: HEX,
    /** Dates, captions, the tagline. */
    muted: HEX,
    /** Links, bullets, the name's tail, buttons, the first glow and the start of the rules. */
    accent: HEX,
    /** The wordmark, the second glow and the end of the rules. */
    accent2: HEX,
    /** Thin lines (above the signature). */
    rule: HEX,
  }),
  font: z.enum(Object.keys(FONTS) as [FontKey, ...FontKey[]]),
  /** The glow banner across the top, drawn as an image in the accent colours. */
  banner: z.object({
    style: z.enum(["glow", "none"]),
    /** 0 (faint) to 100 (strong). */
    strength: z.number().int().min(0).max(100),
  }),
});
export type Theme = z.infer<typeof themeSchema>;

/** A change to a theme: any fields, colours and banner merged into the current ones. */
export const themePatchSchema = themeSchema
  .omit({ colors: true, banner: true })
  .partial()
  .extend({
    colors: themeSchema.shape.colors.partial().optional(),
    banner: themeSchema.shape.banner.partial().optional(),
  });
export type ThemePatch = z.infer<typeof themePatchSchema>;

/**
 * The look a newsletter starts with until someone themes it (in setup, the
 * Theme page or through Claude): slate blue and teal on stone. The page is a
 * clear stone rather than near-white, which reads as a page in every client.
 */
export const DEFAULT_THEME: Theme = {
  nameLead: "Newsletter",
  nameTail: "",
  wordmark: "",
  tagline: "",
  logo: null,
  footer: "",
  colors: {
    page: "#f1efe9",
    ink: "#1b1f27",
    muted: "#5f6670",
    accent: "#3557a0",
    accent2: "#2f8f83",
    rule: "#e6e2d9",
  },
  font: "sans",
  banner: { style: "glow", strength: 60 },
};

export function applyPatch(theme: Theme, patch: ThemePatch): Theme {
  return {
    ...theme,
    ...patch,
    colors: { ...theme.colors, ...patch.colors },
    banner: { ...theme.banner, ...patch.banner },
  };
}

// ------------------------------------------------------------ colour math --

type RGB = [number, number, number];

export function rgb(hex: string): RGB {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function hex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** a over b at opacity t (0..1), as a solid colour. */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return hex([0, 1, 2].map((i) => x[i]! * t + y[i]! * (1 - t)) as RGB);
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

// ------------------------------------------------------------------ checks --

// Roughly the background phone dark modes give an email.
const DARK = "#1f1f1f";

export interface ThemeCheck {
  /** Problems that make the email hard to read for some readers: a theme with any isn't saved. */
  errors: string[];
  /** Worth a look, but saved anyway. */
  warnings: string[];
}

export function checkTheme(theme: Theme): ThemeCheck {
  const { page, ink, muted, accent, accent2 } = theme.colors;
  const errors: string[] = [];
  const warnings: string[] = [];
  const ratio = (a: string, b: string) => contrast(a, b).toFixed(1);

  if (luminance(page) < 0.6)
    errors.push(`The page colour ${page} is too dark: email clients and dark modes expect a light page. Pick a light colour.`);
  if (contrast(ink, page) < 4.5)
    errors.push(`Text (${ink}) on the page (${page}) is ${ratio(ink, page)}:1, below 4.5:1. Darken the text or lighten the page.`);
  else if (contrast(ink, page) < 7)
    warnings.push(`Text (${ink}) on the page (${page}) is ${ratio(ink, page)}:1; 7:1 or more reads better.`);
  if (luminance(ink) > 0.05)
    errors.push(
      `Text colour ${ink} isn't dark enough for phones: dark modes turn near-black text near-white but leave lighter text grey. Use something near-black, like #1b1f27.`,
    );
  if (contrast(muted, page) < 3)
    errors.push(`Muted text (${muted}) on the page is ${ratio(muted, page)}:1, below 3:1. Darken it.`);
  else if (contrast(muted, page) < 4.5)
    warnings.push(`Muted text (${muted}) on the page is ${ratio(muted, page)}:1; 4.5:1 or more reads better for small text.`);
  if (contrast(accent, page) < 3)
    errors.push(`The accent (${accent}) on the page is ${ratio(accent, page)}:1, below 3:1: links and the name would be hard to read. Use a deeper colour.`);
  else if (contrast(accent, page) < 4.5)
    warnings.push(`The accent (${accent}) on the page is ${ratio(accent, page)}:1; links read better at 4.5:1 or more.`);
  if (contrast(accent2, page) < 1.8)
    warnings.push(`The second accent (${accent2}) is close to the page colour, so the rules and the glow will barely show.`);
  for (const [label, c] of [["accent", accent], ["second accent", accent2]] as const)
    if (contrast(c, DARK) < 1.6)
      warnings.push(`The ${label} (${c}) is very dark: in phone dark mode the rules drawn in it will barely show on the dark background.`);
  // Site paths only: an image from another site would tell that site who
  // opened the email.
  if (theme.logo && !/^\/(?!\/)/.test(theme.logo))
    errors.push("The logo must be an image on this site: upload it (a path like /_emdash/api/media/file/...), not a link to another site.");
  return { errors, warnings };
}

// -------------------------------------------------------------- art links --

const bare = (c: string) => c.slice(1).toLowerCase();

/** The glow banner image for a theme, or null when it has none. Its URL says everything it draws, so it never changes. */
export function bannerUrl(theme: Theme, base: string): string | null {
  if (theme.banner.style === "none") return null;
  const { accent, accent2 } = theme.colors;
  return `${base}/email/art/glow.png?a=${bare(accent)}&b=${bare(accent2)}&s=${theme.banner.strength}`;
}

/** The accent-to-accent2 rule image. */
export function ruleUrl(theme: Theme, base: string): string {
  return `${base}/email/art/rule.png?a=${bare(theme.colors.accent)}&b=${bare(theme.colors.accent2)}`;
}
