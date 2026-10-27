import { Marked, type Token, type Tokens } from "marked";

// Markdown edition body -> plain Outlook-safe email HTML, the renderer for a
// newsletter that wants no design at all:
//
// - every paragraph and list item carries the inline font style, since
//   Outlook ignores <style> blocks;
// - section headers (### 1. Title 🎉) become bold paragraphs with extra top
//   margin, not <h3>;
// - consecutive image-only paragraphs become one table row, each image at its
//   "w=NNN" title hint (else 320px in a row, 400px alone);
// - [PLACEHOLDERS] are highlighted so they can't be missed in a preview;
// - the newsletter's signature (a setting) is appended here, never stored in the body.
//
// Pure function: no I/O. Callers decide where images come from (the studio's
// own origin in a preview, the public media address when sending).

const FONT =
  "font-family:Aptos,Aptos_EmbeddedFont,Aptos_MSFontService,Calibri,Helvetica,sans-serif; font-size:12pt; color:rgb(0,0,0)";
const HEADER = `${FONT}; margin-top:1.2em`;
const HIGHLIGHT = "; background:#fff3b0";

// Placeholders like [ZOOM LINK] or [SCREENSHOT GOES HERE], plus (?!\() because
// this runs on markdown, where [ACME](https://…) is a link, not a placeholder.
export const PLACEHOLDER = /\[[A-Z][A-Z /]+\](?!\()/;

export interface RenderEmailOptions {
  /** Subject line, used as the HTML <title>. */
  title: string;
  /** Maps an image src from the markdown (e.g. "simon-draeger.jpg") to what the email should load. */
  resolveImage?: (src: string) => string;
  /** The signature in markdown (the newsletter's setting); false or empty for none. */
  signature?: string | false;
}

export function renderEmail(markdown: string, options: RenderEmailOptions): string {
  const resolveImage = options.resolveImage ?? ((src) => src);
  const md = new Marked();

  md.use({
    renderer: {
      heading({ tokens }) {
        return `<p style="${HEADER}"><b>${this.parser.parseInline(tokens)}</b></p>\n`;
      },
      paragraph({ tokens, text }) {
        return `<p style="${style(text)}">${this.parser.parseInline(tokens)}</p>\n`;
      },
      listitem(item) {
        // Tight lists: render the item's inline content directly, no inner <p>.
        const inner = item.tokens
          .map((t) => (t.type === "text" && "tokens" in t && t.tokens ? this.parser.parseInline(t.tokens) : this.parser.parse([t])))
          .join("");
        return `<li style="${style(item.text)}">${inner}</li>\n`;
      },
      del({ tokens }) {
        return `<del style="text-decoration:line-through">${this.parser.parseInline(tokens)}</del>`;
      },
      image({ href, text }) {
        return `<img alt="${escapeAttr(text)}" src="${escapeAttr(resolveImage(href))}">`;
      },
    },
  });

  const tokens = md.lexer(markdown);
  const html = groupImageRows(tokens)
    .map((part) => (Array.isArray(part) ? imageRow(part, resolveImage) : md.parser([part])))
    .join("");

  const signature = options.signature
    ? `<br>${signatureHtml(options.signature, { color: "rgb(109,110,113)", font: "font-family:Arial,sans-serif" })}\n`
    : "";
  return (
    `<html><head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title></head>` +
    `<body dir="ltr"><div style="${FONT}">\n${html}${signature}</div></body></html>`
  );
}

function style(text: string): string {
  return PLACEHOLDER.test(text) ? FONT + HIGHLIGHT : FONT;
}

// A paragraph containing only images (and the whitespace between them).
function imagesOnly(token: Token): Tokens.Image[] | null {
  if (token.type !== "paragraph") return null;
  const inline = (token as Tokens.Paragraph).tokens;
  const images = inline.filter((t): t is Tokens.Image => t.type === "image");
  const onlyImages = inline.every((t) => t.type === "image" || (t.type === "text" && !t.raw.trim()) || t.type === "br");
  return images.length > 0 && onlyImages ? images : null;
}

// Collapse runs of image-only paragraphs (blank lines between them allowed)
// into one array, so they render as a single side-by-side row.
/**
 * The frames an image can have in the designed email, in the newsletter
 * theme's colours: its accent (the default), its second accent, grey or none.
 */
export const FRAMES = ["accent", "accent2", "grey", "none"] as const;
export type Frame = (typeof FRAMES)[number];
// Older names for the frames, still read.
const FRAME_ALIASES: Record<string, Frame> = { lavender: "accent", green: "accent2" };

/**
 * An image's title holds its display hints, space-separated: "w=NNN" for the
 * width in pixels and "frame=accent2" for the frame. Either can be missing.
 */
export function imageHints(title: string | null | undefined): { width: number | null; frame: Frame | null } {
  const width = Number(title?.match(/(?:^|\s)w=(\d+)(?:\s|$)/)?.[1]) || null;
  const name = title?.match(/(?:^|\s)frame=([a-z0-9]+)(?:\s|$)/)?.[1];
  const frame = name ? (FRAME_ALIASES[name] ?? name) : null;
  return { width, frame: frame && (FRAMES as readonly string[]).includes(frame) ? (frame as Frame) : null };
}

export function groupImageRows(tokens: Token[]): Array<Token | Tokens.Image[]> {
  const out: Array<Token | Tokens.Image[]> = [];
  let row: Tokens.Image[] | null = null;
  for (const token of tokens) {
    const images = imagesOnly(token);
    if (images) {
      row = row ?? [];
      row.push(...images);
      continue;
    }
    if (row && token.type === "space") continue;
    if (row) {
      out.push(row);
      row = null;
    }
    out.push(token);
  }
  if (row) out.push(row);
  return out;
}

function imageRow(images: Tokens.Image[], resolveImage: (src: string) => string): string {
  const fallback = images.length > 1 ? 320 : 400;
  const cells = images
    .map((img) => {
      const width = imageHints(img.title).width ?? fallback;
      return (
        `<td style="padding:0 8px 0 0; vertical-align:top">` +
        `<img alt="${escapeAttr(img.text)}" src="${escapeAttr(resolveImage(img.href))}" ` +
        `style="width:${width}px; height:auto; max-width:100%" width="${width}"/></td>`
      );
    })
    .join("");
  return `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin:8px 0"><tr>${cells}</tr></table>\n`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

/**
 * The newsletter's signature (a setting, in markdown) as small email-safe
 * HTML: one paragraph per line, inline styles only. Added at render time so
 * it's never part of a stored body. Images are kept only when they're on this
 * site (a path starting with "/"), resolved against `site`: an image from
 * another site would tell it who opened the email.
 */
export function signatureHtml(markdown: string, { color, font, site }: { color: string; font: string; site?: string }): string {
  const md = new Marked();
  md.use({
    renderer: {
      image({ href, text }) {
        if (!/^\/(?!\/)/.test(href)) return "";
        const src = site ? new URL(href, site).href : href;
        return `<img alt="${escapeAttr(text)}" src="${escapeAttr(src)}" style="height:40px; width:auto; border:0" height="40">`;
      },
    },
  });
  return markdown
    .trim()
    .split(/\n{2,}/)
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split("\n").map((line) => md.parseInline(line.trim()) as string);
      return `<p style="${font}; font-size:12px; line-height:1.5; color:${color}; margin:0 0 10px">${lines.join("<br>")}</p>`;
    })
    .join("");
}
