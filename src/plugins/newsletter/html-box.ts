import { Parser } from "htmlparser2";

// HTML boxes: a fenced ```html block in an edition is the team's (or Claude's)
// own HTML, put into the email as written, for what markdown can't do: a
// colored box, a two-column table, an event card.
//
// It's cleaned first, by an allowlist, and rebuilt from the parsed tags, so
// only what's listed here gets out: the archive puts it on the open web, and
// it's pasted into Outlook. No scripts, forms, embeds or event handlers; links
// only to http(s) and mailto; images only from this site's media (uploaded
// with media_upload), sent through the same resolver as markdown images; and
// styles without url(), expressions or positioning. Pure functions, so the
// studio's previews run them in the browser too.

/** The fence's language: ```html. */
export const HTML_BOX_LANG = "html";

const KEEP = new Set([
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "div", "span", "p", "a", "img", "br", "hr", "h1", "h2", "h3", "h4",
  "strong", "b", "em", "i", "u", "s", "small", "sup", "sub", "ul", "ol", "li", "blockquote", "center",
]);
const VOID = new Set(["br", "hr", "img", "col"]);
// Taken out with everything inside them. Other unknown tags are unwrapped:
// their contents stay.
const DROP = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "form", "input", "button",
  "select", "option", "textarea", "svg", "math", "template", "noscript", "head", "title", "link", "meta",
  "base", "video", "audio", "canvas", "picture", "source", "portal", "dialog",
]);
const ATTRS = new Set([
  "style", "align", "valign", "width", "height", "bgcolor", "colspan", "rowspan", "cellpadding",
  "cellspacing", "border", "role", "dir", "lang", "title", "alt",
]);
const MEDIA = /^\/_emdash\/api\/media\/file\/[^\s"'<>]+$/;
const LINK = /^(https?:\/\/|mailto:|#)/i;
// Styles that could reach outside the box (url(), old IE expressions,
// bindings) or lay it over the rest of the page.
const BAD_VALUE = /url\s*\(|expression\s*\(|javascript:|vbscript:|@import|\\|<|>/i;
const BAD_PROP = new Set(["position", "behavior", "-moz-binding", "z-index"]);
// Outlook on Windows lays out with Word, which ignores these: use a table.
const OUTLOOK_LAYOUT = /(^|;)\s*display\s*:\s*(flex|inline-flex|grid|inline-grid)|(^|;)\s*(float|gap)\s*:/i;

export interface CleanHtml {
  html: string;
  /** What was taken out, for the studio's checks: "<script>", "an image from another site", … */
  removed: string[];
  /** Things Outlook won't show as meant (flex, grid, float). */
  outlook: string[];
}

/**
 * Cleans an HTML box. resolveImage maps a media path to the address the
 * render loads (the bucket when sending), as for markdown images.
 */
export function cleanHtml(
  source: string,
  resolveImage: (src: string) => string = (s) => s,
  /** Placeholders to highlight in the text, as the emails do outside boxes. */
  placeholder?: RegExp,
): CleanHtml {
  const mark = placeholder && new RegExp(placeholder.source, "g");
  const out: string[] = [];
  const removed = new Set<string>();
  const outlook = new Set<string>();
  // One entry per open element: whether its tags are written.
  const stack: Array<{ name: string; kind: "keep" | "unwrap" | "drop" }> = [];
  const dropping = () => stack.some((e) => e.kind === "drop");

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (dropping()) return void stack.push({ name, kind: "drop" });
        if (DROP.has(name)) {
          removed.add(`<${name}>`);
          return void stack.push({ name, kind: "drop" });
        }
        if (!KEEP.has(name)) {
          removed.add(`<${name}>`);
          return void stack.push({ name, kind: "unwrap" });
        }
        const attrs: string[] = [];
        for (const [key, raw] of Object.entries(attribs)) {
          const value = raw.trim();
          if (key === "href" && name === "a") {
            if (LINK.test(value)) attrs.push(`href="${escapeAttr(value)}"`);
            else removed.add("a link that isn't http(s) or mailto");
          } else if (key === "src" && name === "img") {
            if (MEDIA.test(value)) attrs.push(`src="${escapeAttr(resolveImage(value))}"`);
            else removed.add("an image from another site (upload it first)");
          } else if (key === "style") {
            const css = cleanStyle(value, removed);
            if (OUTLOOK_LAYOUT.test(css)) outlook.add("flex, grid or float (Outlook ignores them: use a table)");
            if (css) attrs.push(`style="${escapeAttr(css)}"`);
          } else if (ATTRS.has(key)) {
            attrs.push(`${key}="${escapeAttr(value)}"`);
          } else if (key.startsWith("on")) {
            removed.add("event handlers");
          }
        }
        if (name === "img" && !attrs.some((a) => a.startsWith("src="))) {
          return void stack.push({ name, kind: "drop" });
        }
        if (name === "a" && attrs.some((a) => a.startsWith("href="))) attrs.push(`target="_blank"`, `rel="noopener"`);
        out.push(`<${name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`);
        stack.push({ name, kind: "keep" });
      },
      ontext(text) {
        if (dropping()) return;
        const safe = escapeHtml(text);
        out.push(mark ? safe.replace(mark, (m) => `<span style="background:#fff3b0; color:#1a1a1a">${m}</span>`) : safe);
      },
      onclosetag(name) {
        // htmlparser2 closes every element, implied ones included, in order.
        const i = stack.map((e) => e.name).lastIndexOf(name);
        if (i < 0) return;
        for (const e of stack.splice(i).reverse()) {
          if (e.kind === "keep" && !VOID.has(e.name)) out.push(`</${e.name}>`);
        }
      },
    },
    { decodeEntities: true },
  );
  parser.write(source);
  parser.end();
  return { html: out.join(""), removed: [...removed], outlook: [...outlook] };
}

function cleanStyle(css: string, removed: Set<string>): string {
  return css
    .split(";")
    .map((decl) => decl.trim())
    .filter((decl) => {
      if (!decl) return false;
      const m = /^([a-z-]+)\s*:\s*([\s\S]+)$/i.exec(decl);
      if (!m) return false;
      if (BAD_PROP.has(m[1]!.toLowerCase()) || BAD_VALUE.test(m[2]!)) {
        removed.add(`the style ${m[1]!.toLowerCase()}`);
        return false;
      }
      return true;
    })
    .join("; ");
}

/** Every HTML box in an edition's markdown, for the studio's checks. */
export function htmlBoxes(markdown: string): string[] {
  const boxes: string[] = [];
  const fence = /^(`{3,}|~{3,})[ \t]*html[ \t]*\n([\s\S]*?)\n\1[ \t]*$/gim;
  for (const m of markdown.matchAll(fence)) boxes.push(m[2]!);
  return boxes;
}

/** A starting box for the studio's button: Outlook-safe (a table, inline styles), in the given colors. */
export function starterBox(colors: { tint: string; border: string; accent: string; ink: string }): string {
  return [
    "```html",
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate; margin:8px 0 24px">`,
    "  <tr>",
    `    <td style="padding:20px 24px; background:${colors.tint}; border:1px solid ${colors.border}; border-radius:12px; font-family:Arial,Helvetica,sans-serif; font-size:16px; line-height:1.6; color:${colors.ink}">`,
    `      <p style="margin:0 0 6px; font-size:18px; font-weight:bold; color:${colors.accent}">A title</p>`,
    `      <p style="margin:0">What the box says.</p>`,
    "    </td>",
    "  </tr>",
    "</table>",
    "```",
  ].join("\n");
}

/** A header to start a theme's own from: a stripe in its colors, then {name} and {date}. Outlook-safe. */
export function exampleHeader(colors: { ink: string; muted: string; accent: string; accent2: string }): string {
  const stripe = [colors.accent, colors.accent2, colors.ink]
    .map((c) => `    <td width="33%" height="10" bgcolor="${c}" style="background:${c}; font-size:0; line-height:0">&nbsp;</td>`)
    .join("\n");
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">`,
    "  <tr>",
    stripe,
    "  </tr>",
    "</table>",
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">`,
    "  <tr>",
    `    <td valign="bottom" style="padding:20px 0 12px; border-bottom:4px solid ${colors.ink}; font-family:Georgia,'Times New Roman',serif; font-size:40px; line-height:1; font-weight:bold; color:${colors.ink}">{name}</td>`,
    `    <td valign="bottom" align="right" style="padding:20px 0 14px; border-bottom:4px solid ${colors.ink}; font-family:'Courier New',Courier,monospace; font-size:12px; letter-spacing:2px; color:${colors.muted}; text-transform:uppercase">{date}</td>`,
    "  </tr>",
    "</table>",
  ].join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
