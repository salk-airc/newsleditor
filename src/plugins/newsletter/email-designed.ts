import { Marked, type Token, type Tokens } from "marked";
import { type Frame, groupImageRows, imageHints, PLACEHOLDER, signatureHtml } from "./email.ts";
import { DEFAULT_THEME, bannerUrl, FONTS, mix, rgb, ruleUrl, type Theme } from "./theme.ts";

// Markdown edition body -> the designed newsletter email, in the newsletter's
// theme (theme.ts). Same markdown as email.ts, which stays the plain renderer
// that matches sent editions.
//
// The world lives in the frame: a glow banner in the theme's two accents
// across the top, a masthead with the logo, wordmark and tagline, the name on
// one line, and section openers underlined with the accent-to-accent2 rule.
// An "In this edition" list of the sections, for skimmers, is opt-in: a
// `<!-- contents -->` line anywhere in the body adds it under the name. The
// reading column stays calm: 16px text, ~70 characters a line.
//
// Extra markdown it understands, all plain markdown so the other renderers
// still read it:
//
// - "> " blockquotes become a tinted callout card;
// - a paragraph of only [text](url "button") links becomes a button row, the
//   first one filled, the rest outlined;
// - image rows get a frame in the theme's colours ("frame=accent2" etc. in
//   the image's title) and their alt text as a caption.
//
// Styles are inline: pasting into Outlook keeps those and drops <style>.
// Colour that has to survive Outlook on the web (which drops CSS gradients
// from a paste) and phone dark modes (which recolour text but never images)
// is drawn as images by the site: the banner and the rules (/email/art/).

const HIGHLIGHT = "; background:#fff3b0";
const CONTENTS = /^<!--\s*contents\s*-->\s*$/im;

export interface RenderDesignedEmailOptions {
  /** Subject line, e.g. "Field Notes — Oct 2, 2026". Used for the <title>. */
  title: string;
  /** The date in the masthead ("Oct 2, 2026"). Default: what follows " — " in the title. */
  date?: string;
  /** The newsletter's look. Default: DEFAULT_THEME. */
  theme?: Theme;
  /** Maps an image src from the markdown to what the email should load. */
  resolveImage?: (src: string) => string;
  /** The site that serves the logo, the art and media paths: its public address, which the studio uses for previews too. */
  site: string;
  /** The signature in markdown (the newsletter's setting); false or empty for none. */
  signature?: string | false;
}

// Everything the markup needs from a theme, worked out once per render.
interface Style {
  theme: Theme;
  font: string;
  page: string;
  ink: string;
  muted: string;
  rule: string;
  accent: string;
  accent2: string;
  /** accent at opacity a, for shadows and underlines. */
  alpha: (color: string, a: number) => string;
  tint: string;
  tint2: string;
  frames: Record<Frame, string | null>;
  ruleImg: (width: number) => string;
  site: string;
}

/** An image frame's colour in a theme (null: no frame). Solid colours: the accents at ~30% on white, and a stone grey. */
export function frameColors(theme: Theme): Record<Frame, string | null> {
  const { accent, accent2 } = theme.colors;
  return { accent: mix(accent, "#ffffff", 0.3), accent2: mix(accent2, "#ffffff", 0.3), grey: "#dcd8cf", none: null };
}

function style(theme: Theme, site: string): Style {
  const { page, ink, muted, rule, accent, accent2 } = theme.colors;
  const ruleSrc = ruleUrl(theme, site);
  return {
    theme,
    font: `font-family:${FONTS[theme.font].stack}`,
    page,
    ink,
    muted,
    rule,
    accent,
    accent2,
    alpha: (color, a) => `rgba(${rgb(color).join(",")},${a})`,
    tint: mix(accent, "#ffffff", 0.08),
    tint2: mix(accent2, "#ffffff", 0.1),
    frames: frameColors(theme),
    // The rule is an image, not a styled empty <div>: Outlook on the web
    // drops empty divs and CSS gradients from a paste but keeps images.
    ruleImg: (width) =>
      `<img alt="" src="${escapeAttr(ruleSrc)}" width="${width}" height="3" ` +
      `style="display:block; width:${width}px; height:3px; border:0">`,
    site,
  };
}

export function renderDesignedEmail(markdown: string, options: RenderDesignedEmailOptions): string {
  const resolveImage = options.resolveImage ?? ((src) => src);
  const s = style(options.theme ?? DEFAULT_THEME, options.site);
  const P = `${s.font}; font-size:16px; line-height:1.7; color:${s.ink}; margin:0 0 18px`;
  const md = new Marked();

  md.use({
    renderer: {
      heading({ tokens }) {
        const title = this.parser.parseInline(tokens).replace(/^\d+\.\s*/, "");
        return (
          `<div style="margin:52px 0 20px">` +
          `<p style="${s.font}; font-size:24px; font-weight:600; line-height:1.25; letter-spacing:-0.5px; color:${s.ink}; margin:0 0 14px">${title}</p>` +
          `${s.ruleImg(44)}</div>\n`
        );
      },
      paragraph(token) {
        const buttons = buttonLinks(token);
        if (buttons) return buttonRow(s, buttons, (t) => this.parser.parseInline(t));
        return `<p style="${P}${PLACEHOLDER.test(token.text) ? HIGHLIGHT : ""}">${this.parser.parseInline(token.tokens)}</p>\n`;
      },
      blockquote({ tokens }) {
        return (
          `<div style="margin:26px 0 30px; padding:22px 24px 4px; border-radius:16px; background:${s.tint}; ` +
          `background-image:linear-gradient(135deg,${s.tint} 0%,${s.tint2} 100%); border:1px solid ${s.alpha(s.accent, 0.22)}; ` +
          `box-shadow:0 10px 28px ${s.alpha(s.accent, 0.13)}">` +
          `${this.parser.parse(tokens)}</div>\n`
        );
      },
      list(token) {
        const rows = token.items
          .map((item, i) => {
            const marker = token.ordered
              ? `<span style="${s.font}; font-size:14px; font-weight:600; color:${s.accent}">${Number(token.start || 1) + i}.</span>`
              : // A text bullet, not a dot image: dark modes recolour text
                // but never images, which stayed dark blue on dark.
                `<span style="${s.font}; font-size:20px; line-height:27px; color:${s.accent}">&bull;</span>`;
            return (
              `<tr><td style="width:24px; vertical-align:top; padding:0">${marker}</td>` +
              `<td style="${s.font}; font-size:16px; line-height:1.7; color:${s.ink}; padding:0 0 16px; vertical-align:top${PLACEHOLDER.test(item.text) ? HIGHLIGHT : ""}">` +
              `${listItemInner(item, this.parser)}</td></tr>`
            );
          })
          .join("");
        return `<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse; margin:4px 0 16px; width:100%">${rows}</table>\n`;
      },
      strong({ tokens }) {
        return `<b style="color:${s.ink}; font-weight:600">${this.parser.parseInline(tokens)}</b>`;
      },
      link({ href, tokens }) {
        return (
          `<a href="${escapeAttr(href)}" style="color:${s.accent}; text-decoration:underline; ` +
          `text-decoration-color:${s.alpha(s.accent, 0.4)}; text-underline-offset:3px">${this.parser.parseInline(tokens)}</a>`
        );
      },
      codespan({ text }) {
        return `<code style="font-family:'Geist Mono',Menlo,Consolas,monospace; font-size:14px; background:${s.tint}; color:${s.ink}; padding:1px 5px; border-radius:4px">${text}</code>`;
      },
      del({ tokens }) {
        return `<del style="text-decoration:line-through">${this.parser.parseInline(tokens)}</del>`;
      },
      hr() {
        return `<div style="margin:40px 0">${s.ruleImg(56)}</div>\n`;
      },
      image({ href, text }) {
        return `<img alt="${escapeAttr(text)}" src="${escapeAttr(resolveImage(href))}" style="max-width:100%; border-radius:10px">`;
      },
    },
  });

  const tokens = md.lexer(markdown);
  const sections = CONTENTS.test(markdown)
    ? tokens
        .filter((t): t is Tokens.Heading => t.type === "heading")
        .map((h) => md.parseInline(h.text.replace(/^\d+\.\s*/, "")) as string)
    : [];
  const body = groupImageRows(tokens)
    .map((part) => (Array.isArray(part) ? imageRow(s, part, resolveImage) : md.parser([part as Token])))
    .join("");

  const signature = options.signature
    ? `<div style="margin:40px 0 0; padding:22px 0 0; border-top:1px solid ${s.rule}">` +
      `${signatureHtml(options.signature, { color: s.muted, font: s.font, site: s.site })}</div>`
    : "";
  // The reading column, centred at up to 640px.
  const column = (padding: string, inner: string) =>
    `<table cellpadding="0" cellspacing="0" role="presentation" style="width:100%; max-width:640px">` +
    `<tr><td style="padding:${padding}">${inner}</td></tr></table>`;
  const banner = bannerUrl(s.theme, s.site);
  const fontLink = FONTS[s.theme.font].link;

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">` +
    `<title>${escapeHtml(options.title)}</title>` +
    (fontLink ? `<link href="${fontLink}" rel="stylesheet">` : "") +
    `</head><body style="margin:0; padding:0; background:${s.page}">` +
    // No card: the page colour runs edge to edge, as in Bloom's emails, and
    // the text sits in a centred column.
    `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color:${s.page}">` +
    `<tr><td align="center" style="padding:0 12px">` +
    // The glow is a picture at the top of the column, faded to the page
    // colour at its edges; the masthead under it stays real text.
    (banner
      ? column(
          "0",
          `<img alt="" src="${escapeAttr(banner)}" width="640" height="100" ` +
            `style="display:block; width:100%; max-width:640px; height:auto; border:0">`,
        )
      : "") +
    `${column(banner ? "0 28px 30px" : "34px 28px 30px", masthead(s, options, sections, banner !== null))}</td></tr>` +
    `<tr><td align="center" style="padding:0 12px">` +
    `${column("8px 28px 32px", `\n${body}${signature}\n`)}` +
    (s.theme.footer
      ? column(
          "0 28px 28px",
          `<p style="${s.font}; font-size:12px; line-height:1.6; color:${s.muted}; margin:0">${escapeHtml(s.theme.footer)}</p>`,
        )
      : "") +
    `</td></tr></table></body></html>`
  );
}

function masthead(s: Style, options: RenderDesignedEmailOptions, sections: string[], underBanner: boolean): string {
  const { title } = options;
  const { theme } = s;
  // No date given: whatever follows " — " in "Field Notes — Oct 2, 2026".
  const date = options.date ?? (title.split(/\s+—\s+/)[1] ?? "").replace(/\s*Edition\s*$/i, "");
  const logo = theme.logo ? new URL(theme.logo, s.site).href : null;
  const tagline = theme.tagline.split(/\n/).map(escapeHtml).join("<br>");

  const lockup =
    `<table cellpadding="0" cellspacing="0" role="presentation"><tr>` +
    (logo
      ? `<td style="vertical-align:middle; padding:0 12px 0 0"><img alt="" src="${escapeAttr(logo)}" height="40" style="display:block; height:40px; width:auto"></td>`
      : "") +
    (theme.wordmark
      ? `<td style="vertical-align:middle; ${s.font}; font-size:26px; font-weight:700; letter-spacing:-1px; line-height:1; color:${s.accent2}">${escapeHtml(theme.wordmark)}</td>`
      : "") +
    (tagline
      ? `<td style="vertical-align:middle; padding:0 0 0 ${theme.wordmark || logo ? 12 : 0}px"><div style="${s.font}; font-size:11px; font-weight:500; line-height:1.35; color:${s.muted}; ` +
        `${theme.wordmark || logo ? `border-left:1px solid ${s.rule}; padding-left:12px` : ""}">${tagline}</div></td>`
      : "") +
    `</tr></table>`;

  const contents = sections.length
    ? `<div style="margin:22px 0 0; padding:16px 0 0; border-top:1px solid ${s.rule}">` +
      `<p style="${s.font}; font-size:13px; font-weight:600; color:${s.ink}; margin:0 0 8px">In this edition</p>` +
      sections
        .map(
          (section) =>
            `<p style="${s.font}; font-size:14px; line-height:1.55; color:${s.ink}; margin:0 0 4px">` +
            `<span style="color:${s.accent2}; margin:0 8px 0 0">&bull;</span>${section}</p>`,
        )
        .join("") +
      `</div>`
    : "";

  return (
    // Under the banner the lockup sits a little into the glow.
    `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:${underBanner ? "-28px" : "0"} 0 0"><tr>` +
    `<td style="vertical-align:middle">${lockup}</td>` +
    `<td style="vertical-align:middle; text-align:right; ${s.font}; font-size:13px; font-weight:500; color:${s.muted}; white-space:nowrap">${escapeHtml(date)}</td>` +
    `</tr></table>` +
    `<p style="${s.font}; font-size:32px; font-weight:600; line-height:1.15; letter-spacing:-1px; color:${s.ink}; margin:30px 0 16px">` +
    `${escapeHtml(theme.nameLead)}${theme.nameTail ? ` <span style="color:${s.accent}">${escapeHtml(theme.nameTail)}</span>` : ""}</p>` +
    `${s.ruleImg(64)}${contents}`
  );
}

// [text](url "button") links, and nothing else, in one paragraph.
function buttonLinks(token: Tokens.Paragraph): Tokens.Link[] | null {
  const links = token.tokens.filter((t): t is Tokens.Link => t.type === "link");
  const only = token.tokens.every((t) => (t.type === "link" && t.title === "button") || (t.type === "text" && !t.raw.trim()) || t.type === "br");
  return links.length > 0 && only ? links : null;
}

function buttonRow(s: Style, links: Tokens.Link[], inline: (tokens: Token[]) => string): string {
  const cells = links
    .map((link, i) => {
      const look =
        i === 0
          ? `background:${s.accent}; color:#ffffff; border:1px solid ${s.accent}; box-shadow:0 6px 16px ${s.alpha(s.accent, 0.32)}`
          : `background:#ffffff; color:${s.ink}; border:1px solid ${s.alpha(s.accent2, 0.55)}; box-shadow:0 6px 16px ${s.alpha(s.accent2, 0.16)}`;
      return (
        `<td style="padding:0 10px 10px 0"><a href="${escapeAttr(link.href)}" style="${s.font}; display:inline-block; font-size:15px; font-weight:600; ` +
        `text-decoration:none; padding:12px 20px; border-radius:10px; ${look}">${inline(link.tokens)}</a></td>`
      );
    })
    .join("");
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:6px 0 20px"><tr>${cells}</tr></table>\n`;
}

function imageRow(s: Style, images: Tokens.Image[], resolveImage: (src: string) => string): string {
  const fallback = images.length > 1 ? 260 : 560;
  const cells = images
    .map((img) => {
      const hints = imageHints(img.title);
      const width = hints.width ?? fallback;
      const frame = s.frames[hints.frame ?? "accent"];
      const tag =
        `<img alt="${escapeAttr(img.text)}" src="${escapeAttr(resolveImage(img.href))}" width="${width}" ` +
        `style="display:block; width:${width}px; max-width:100%; height:auto; border:0; border-radius:10px">`;
      return (
        `<td style="padding:0 20px 0 0; vertical-align:top">` +
        // The frame is a padded, coloured cell around the image: Outlook on
        // the web drops borders on a pasted <img> but keeps cell backgrounds.
        (frame
          ? `<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate"><tr>` +
            `<td style="padding:4px; background-color:${frame}; border-radius:14px">${tag}</td></tr></table>`
          : tag) +
        (img.text
          ? `<p style="${s.font}; font-size:13px; font-weight:500; color:${s.muted}; margin:10px 0 0 4px">${escapeHtml(img.text)}</p>`
          : "") +
        `</td>`
      );
    })
    .join("");
  return `<table cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:separate; margin:16px 0 26px"><tr>${cells}</tr></table>\n`;
}

function listItemInner(item: Tokens.ListItem, parser: { parseInline(t: Token[]): string; parse(t: Token[]): string }): string {
  return item.tokens
    .map((t) => (t.type === "text" && "tokens" in t && t.tokens ? parser.parseInline(t.tokens) : parser.parse([t])))
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
