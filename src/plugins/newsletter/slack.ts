import { Marked } from "marked";

// Markdown Slack TL;DR -> rich HTML for pasting into a Slack channel.
//
// The Slack version is its own short text, written alongside the email, not
// derived from it. This only formats it: pasting rich text from a browser
// into Slack keeps bold, italics, links and bullets, while markdown
// [text](url) doesn't link in the Slack composer. So the HTML uses:
//
// - only <p>, <b>, <i>, <s>, <a>, <ul>/<li> and <br>; nothing Slack drops;
// - single line breaks inside a paragraph are kept;
// - headers become bold lines (Slack has no headings);
// - images are left out: screenshots are dragged into the message by hand,
//   so their filenames are listed in a note at the top instead.

export interface RenderSlackOptions {
  /** Shown as the page title, e.g. "Slack post — Oct 2, 2026". */
  title: string;
  /** Image files to drag into the Slack message after pasting. */
  images?: string[];
}

export function renderSlack(markdown: string, options: RenderSlackOptions): string {
  const md = new Marked({ breaks: true });
  md.use({
    renderer: {
      heading({ tokens }) {
        return `<p><b>${this.parser.parseInline(tokens)}</b></p>\n\n`;
      },
      paragraph({ tokens }) {
        const inner = this.parser.parseInline(tokens).trim();
        return inner ? `<p>${inner}</p>\n\n` : "";
      },
      strong({ tokens }) {
        return `<b>${this.parser.parseInline(tokens)}</b>`;
      },
      em({ tokens }) {
        return `<i>${this.parser.parseInline(tokens)}</i>`;
      },
      del({ tokens }) {
        return `<s>${this.parser.parseInline(tokens)}</s>`;
      },
      br() {
        return "<br>\n";
      },
      image() {
        return "";
      },
      html() {
        return ""; // comments and raw HTML don't survive a Slack paste anyway
      },
      hr() {
        return "";
      },
    },
  });

  const images = options.images?.length
    ? ` Then drag ${options.images.join(" + ")} into the message.`
    : "";
  return (
    `<html><head><meta charset="utf-8"><title>${escapeHtml(options.title)}</title></head>\n` +
    `<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:15px; line-height:1.45; max-width:640px; margin:24px">\n` +
    `<!-- Open in a browser, Cmd+A, Cmd+C, paste into the Slack channel.${escapeHtml(images)} -->\n\n` +
    `${md.parse(markdown)}</body></html>\n`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
