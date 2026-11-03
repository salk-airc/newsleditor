import type { MarkedExtension, Tokens } from "marked";
import { mix } from "./theme.ts";

// Styled words in an edition: [the words]{accent mark big}, which the
// editor's text bar writes around a selection (src/scripts/edition-editor.ts).
// Readable as markdown, and no HTML, so nothing but these styles gets in.
// Inside the braces, any of:
//
// - a color: accent, accent2, muted, or #rrggbb
// - a highlight: mark (yellow), mark-accent or mark-accent2 (the accents, light)
// - a size: big or small
// - underline
//
// The designed email paints them in the theme's colors (email-designed.ts);
// renders without a theme (Slack, the plain email, the web archive) keep just
// the words.

export type TextColor = "accent" | "accent2" | "muted" | `#${string}`;
export type TextMark = "mark" | "mark-accent" | "mark-accent2";
export type TextSize = "big" | "small";

export interface Styling {
  color: TextColor | null;
  mark: TextMark | null;
  size: TextSize | null;
  underline: boolean;
}

export const NO_STYLING: Styling = { color: null, mark: null, size: null, underline: false };

const COLORS = new Set(["accent", "accent2", "muted"]);
const MARKS = new Set(["mark", "mark-accent", "mark-accent2"]);
const SIZES = new Set(["big", "small"]);
const HEX = /^#[0-9a-f]{6}$/i;

/** [words]{styles}, on one line. Its words may hold other markdown (bold, links). */
export const STYLED = /\[([^\]\n]+)\]\{([a-z0-9#\- ]*)\}/gi;

/** The styles in a {…}; unknown words are dropped. */
export function parseStyling(spec: string): Styling {
  const s: Styling = { ...NO_STYLING };
  for (const word of spec.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (COLORS.has(word) || HEX.test(word)) s.color = word as TextColor;
    else if (MARKS.has(word)) s.mark = word as TextMark;
    else if (SIZES.has(word)) s.size = word as TextSize;
    else if (word === "underline") s.underline = true;
  }
  return s;
}

/** The {…} for some styles, or "" for none. */
export function stylingSpec(s: Styling): string {
  return [s.color, s.mark, s.size, s.underline && "underline"].filter(Boolean).join(" ");
}

type Palette = { accent: string; accent2: string; muted: string };

/** A color word's color in a theme. */
export function textColor(color: TextColor, p: Palette): string {
  return color === "accent" ? p.accent : color === "accent2" ? p.accent2 : color === "muted" ? p.muted : color;
}

/** A highlight's color in a theme: solid, not rgba, because Outlook drops transparency. */
export function markColor(mark: TextMark, p: Palette): string {
  return mark === "mark-accent" ? mix(p.accent, "#ffffff", 0.18) : mark === "mark-accent2" ? mix(p.accent2, "#ffffff", 0.22) : "#fff3b0";
}

/** The inline CSS for some styles in a theme's colors. */
export function stylingCss(s: Styling, p: Palette): string {
  return [
    s.color && `color:${textColor(s.color, p)}`,
    s.mark && `background:${markColor(s.mark, p)}; padding:0 2px; border-radius:3px`,
    s.size && `font-size:${s.size === "big" ? "20px" : "13px"}`,
    s.underline && "text-decoration:underline; text-underline-offset:3px",
  ]
    .filter(Boolean)
    .join("; ");
}

interface StyledToken extends Tokens.Generic {
  type: "styled";
  styling: Styling;
  tokens: Tokens.Generic[];
}

/**
 * A marked extension for [words]{styles}. paint gives the inline CSS for
 * some styles; without it, only the words are kept.
 */
export function styledText(paint?: (s: Styling) => string): MarkedExtension {
  return {
    extensions: [
      {
        name: "styled",
        level: "inline",
        start: (src) => src.match(/\[[^\]\n]+\]\{/)?.index,
        tokenizer(src) {
          const m = /^\[([^\]\n]+)\]\{([a-z0-9#\- ]*)\}/i.exec(src);
          if (!m) return undefined;
          return { type: "styled", raw: m[0], styling: parseStyling(m[2]!), tokens: this.lexer.inlineTokens(m[1]!) } as StyledToken;
        },
        renderer(token) {
          const t = token as StyledToken;
          const inner = this.parser.parseInline(t.tokens);
          const css = paint?.(t.styling);
          return css ? `<span style="${css}">${inner}</span>` : inner;
        },
      },
    ],
  };
}
