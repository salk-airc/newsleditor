// How an edition's body is written, for Claude through the connector: the
// claude.ai app has only the tools, not this repo's skill
// (.claude/skills/newsleditor/SKILL.md), so next_edition and edition_format
// hand this over. Keep the two in step.

export const EDITION_FORMAT = `An edition's body is markdown, which newsleditor turns into the designed email, the plain email and the archive page.

- "### 1. Title" makes a section. The number orders the sections and isn't shown.
- Paragraphs, **bold**, *italics*, [links](https://example.org) and "- " bullets as usual.
- ![What the picture shows](/_emdash/api/media/file/ID.png "w=320") is an image: upload it with media_upload and use the path it returns, never an image from another site. "w=NNN" sets its width in pixels; "frame=accent", "accent2", "grey", "none" or a color like "#c0392b" its frame. The alt text is its caption. Images on consecutive lines sit side by side.
- "> text" makes a tinted callout card in the theme's colors.
- [Register](https://example.org "button") alone on a line makes a button.
- [words]{…} styles words on one line: a color (accent, accent2, muted, #rrggbb), a highlight (mark, mark-accent, mark-accent2), big or small, underline, any together: [Deadline Friday]{accent mark}. Sparingly.
- <!-- contents --> on its own line adds an "In this edition" list.
- A look for every edition (a top bar, a nameplate, a footer) belongs in the theme, not the edition: theme_update with headerHtml and footerHtml. Editions then only hold their content.
- <!-- bare --> on its own line drops the frame for one edition (the banner or the theme's header, the masthead, and the lines under headings), for a special issue that draws its whole look itself in HTML boxes: start it with its own top bar and nameplate. The page color, the signature and the footer stay.
- [CAPITALS IN BRACKETS] is a placeholder for something missing; the studio highlights it until someone fills it in. Never invent facts, names, dates or links: use a placeholder.

HTML boxes, for what markdown can't do (a colored box, two columns, an event card): a fenced block whose language is html.

\`\`\`html
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate">
  <tr>
    <td style="padding:20px 24px; background:#eef3fb; border:1px solid #c9d6ee; border-radius:12px; font-family:Arial,Helvetica,sans-serif; font-size:16px; line-height:1.6; color:#1a1a1a">
      <p style="margin:0 0 6px; font-size:18px; font-weight:bold">A title</p>
      <p style="margin:0">What the box says.</p>
    </td>
  </tr>
</table>
\`\`\`

It goes into the email pasted into Outlook, so write it for Outlook: tables for layout (no flex, grid or float), every style inline (no <style>), plain colors (no gradients or background images), widths in pixels or percent. Allowed: tables, div, span, p, a, img, br, hr, h1 to h4, b, strong, i, em, u, s, small, sup, sub, ul, ol, li, blockquote and center, with style, align, valign, width, height, bgcolor, colspan, rowspan, cellpadding, cellspacing, border, alt and title. Links must be http(s) or mailto. Images must be this site's uploads (/_emdash/api/media/file/…). Anything else is taken out: scripts, forms, embeds, event handlers, url() in styles and positioning.

To change an edition: content_get it from the editions collection, change the body, and content_update it with the whole new body. Change only what was asked and keep the rest as it is; the team may be editing it in the studio at the same time, and the studio merges your change in.`;
