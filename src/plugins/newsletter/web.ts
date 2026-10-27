import { Marked, type Tokens } from "marked";
import { groupImageRows, imageHints } from "./email.ts";

// Markdown edition body -> HTML for the newsletter archive on the site.
//
// Same source as the email (email.ts), different target: semantic HTML that
// the archive page styles, instead of Outlook's inline styles. Section headers
// become <h2>, consecutive images become one <figure> row at their "w=NNN"
// hint, every image links to its full-size original, and there's no
// signature.
//
// The body comes from our own editors and Claude, but it's published on the
// open web, so raw HTML in the markdown is dropped and links are limited to
// http(s), mailto and relative URLs.

export interface RenderWebOptions {
  /** Maps an image src from the markdown to the URL the page loads. */
  resolveImage?: (src: string) => string;
}

export interface Section {
  /** Header text without the "1. " number, e.g. "Meet our new team members! 🎉" */
  title: string;
  id: string;
}

export function renderWeb(markdown: string, options: RenderWebOptions = {}): { html: string; sections: Section[] } {
  const resolveImage = options.resolveImage ?? ((src) => src);
  const sections: Section[] = [];
  const md = new Marked();
  // Images link to their full-size original, except inside a link already.
  let inLink = false;

  md.use({
    renderer: {
      heading({ tokens, text }) {
        const title = text.replace(/^\d+\.\s*/, "").replace(/:$/, "").trim();
        const id = slugify(title) || `section-${sections.length + 1}`;
        sections.push({ title, id });
        return `<h2 id="${id}">${this.parser.parseInline(tokens)}</h2>\n`;
      },
      link({ href, tokens }) {
        inLink = true;
        const inner = this.parser.parseInline(tokens);
        inLink = false;
        if (!safeHref(href)) return inner;
        return `<a href="${escapeAttr(href)}">${inner}</a>`;
      },
      image({ href, text }) {
        const img = `<img src="${escapeAttr(resolveImage(href))}" alt="${escapeAttr(text)}" loading="lazy">`;
        return inLink ? img : zoomLink(resolveImage(href), img);
      },
      html() {
        return "";
      },
      hr() {
        return "";
      },
    },
  });

  const html = groupImageRows(md.lexer(markdown))
    .map((part) => (Array.isArray(part) ? figure(part, resolveImage) : md.parser([part])))
    .join("");
  return { html, sections };
}

// Each image carries its intended width as --w: the "w=NNN" hint, else 320px
// in a row (as in the email). A lone image without a hint has none and fills
// the column. The page's CSS lets row images shrink to part of --w before
// wrapping, so sizing follows what the author chose, whatever the image is.
function figure(images: Tokens.Image[], resolveImage: (src: string) => string): string {
  const imgs = images
    .map((img) => {
      const hint = imageHints(img.title).width;
      const width = hint ?? (images.length > 1 ? 320 : null);
      const src = resolveImage(img.href);
      const tag = `<img src="${escapeAttr(src)}" alt="${escapeAttr(img.text)}" loading="lazy">`;
      return zoomLink(src, tag, width);
    })
    .join("");
  const kind = images.length > 1 ? "figure-row" : "figure-single";
  return `<figure class="${kind}">${imgs}</figure>\n`;
}

// Tap an image to open its full-size original.
function zoomLink(src: string, img: string, width: number | null = null): string {
  const style = width ? ` style="--w:${width}px"` : "";
  if (!safeHref(src)) return `<span class="zoom"${style}>${img}</span>`;
  return `<a class="zoom" href="${escapeAttr(src)}" target="_blank" rel="noopener"${style}>${img}</a>`;
}

function safeHref(href: string): boolean {
  return /^(https?:|mailto:|\/|#)/i.test(href.trim());
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
