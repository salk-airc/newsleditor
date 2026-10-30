---
name: newsleditor
description: Set up and run newsleditor, a self-hosted studio for writing an email newsletter together, connect Claude Code to it, and work on the newsletter through its MCP tools - drafting editions in the newsletter's own voice, filing links for the next edition, and changing its theme. Use for "help me set up newsleditor", "start the next edition", "draft this week's newsletter", "add this to the newsletter", "what's in the newsletter inbox?", or "change the newsletter's colours/logo".
---

# newsleditor

newsleditor is an Astro + EmDash site that the user runs themselves. Editions are written in markdown in its studio (`/newsletter/edit/<date>`), where the team edits together live and copies the finished email into Outlook. Claude works on it through the site's MCP server. The README in the repo has the full detail; this is what you need to act.

Two jobs: **setting it up** and **working on the newsletter**.

## Setting it up

Do the steps in order. Run commands yourself where you can; the user has to do anything in the browser that signs them in.

1. **Node.js 22.18 or newer**: `node -v`. If it's older or missing, tell the user to install the current LTS from nodejs.org and stop until they have.
2. **Get the code**, if the user isn't already in a clone: `git clone https://github.com/salk-airc/newsleditor.git`, then work in that folder.
3. **Install**: `npm install`.
4. **Start**: `npm start` (builds on first run, then serves at http://localhost:4321). Run it in the background or ask the user to run it in a terminal they keep open; it has to keep running.
5. **First visit** (the user, in a browser): open http://localhost:4321. EmDash's setup asks for a site title and makes their account with a passkey; the first person becomes the Admin. Then the newsletter's setup asks for its name, sender, schedule, signature, logo (for the colours), voice, and where images live.
   - Help with the **voice** if they want: ask how the newsletter should sound, words they use or avoid, how long sections run, and write that up in their words. Don't invent a voice for them.
   - If they plan to send from a laptop, point them to the README's "Images in sent emails" section: readers' mail apps can't load images from `localhost`.
6. **Connect Claude**: on the Settings page (`/newsletter/setup`), step 5, an Admin makes a connection and gets a `claude mcp add …` command to run in a terminal. Or run `npm run connect-claude` (needs `ADMIN_TOKEN`, an admin API token, unless the server is `npm run dev`). Either way, a new Claude Code session is needed before the tools appear.
7. **Check**: in the new session, call `newsletter__settings_get`. If `isDefault` is true, setup hasn't been saved yet: send them back to step 5.

When things go wrong:

- **Blank pages during development**: `npm run dev` clears old build files first. Use it rather than `astro dev` directly.
- **Can't sign in from another computer**: passkeys need `https://` (or `localhost`). Put the server behind HTTPS (README, "On a server").
- **The newsletter tools are missing in Claude Code**: after an update, EmDash hides the plugin's tools until an Admin approves them again. Connect again (step 6).
- **Port 4321 is taken**: `PORT=4322 npm start`.
- **Changed `.env` but nothing changed**: settings for the database and storage are built in; `npm start` rebuilds when `.env` changes, `npm run build` does it otherwise.

## Working on the newsletter

### The tools

From the newsletter plugin (in Claude Code their names end in `newsletter__add_item` and so on):

| Tool | Use it for |
|---|---|
| `settings_get` | The newsletter's name, schedule, subject format, starter text, signature, sender and **voice** |
| `settings_update` | Changing those, when the user asks |
| `add_item` | Filing a link and/or note for the next edition |
| `list_items` | What's waiting in the inbox |
| `next_edition` | The next edition's date, slug, subject, starter body, studio link and voice. Creates nothing |
| `mark_used` | Taking the items a draft used out of the inbox |
| `theme_get` / `theme_update` | The email's look: name, logo, colours, font, banner |

And EmDash's own tools: `content_create`, `content_get`, `content_update`, `content_list` (collection `editions`) and `media_upload`.

### Drafting an edition

1. Call `next_edition` (pass `date` if the user names one). If `exists` is true, there's already a draft: `content_get` it and work on that instead of making another.
2. Read the **voice** it returns, and follow it closely. If it's empty, ask the user how the newsletter should sound before writing, and offer to save the answer with `settings_update`.
3. Call `list_items` for what the team collected. Read the user's notes on each item as their words: build on them, don't replace them. Open links to understand them when you need to; never describe a page you haven't read.
4. Write the body in the newsletter's markdown (below), starting from the starter body `next_edition` returned, unless the user asks for something else.
5. Create it with `content_create` in the `editions` collection, using the `slug` and `data` from `next_edition` (`title`, `edition_date`, and your `body`). It's created as a draft; never publish.
6. Optionally write a short Slack version in the `slack` field (a few lines and bullets, markdown).
7. Call `mark_used` with the ids of the items the draft actually uses, and the slug. Leave the rest for next time.
8. Give the user the `studioUrl`. The team finishes it there, then copies it into Outlook to send. You don't send anything.

Rules for the writing:

- **Never invent facts, names, dates, numbers, quotes or links.** When something is missing, put a placeholder in capitals in square brackets, like `[ZOOM LINK]` or `[DATE]`; the studio highlights it until someone fills it in.
- Every link should be one you were given or have opened.
- Don't add a signature or sign-off name: the signature is added to every email from the settings.
- Keep the user's own announcements first, as numbered sections.

### The edition format

```markdown
Hi everyone,

One or two lines of intro.

### 1. The lead story 🎉

A paragraph or two. [Links](https://example.org) inline.

![What the picture shows](/_emdash/api/media/file/ABC123.png "w=320")

[Register](https://example.org/register "button")

### 2. The next story

…

### Quick hits

- **A short bold lead.** One or two sentences that end on the useful fact.
- **Another.** With a [link](https://example.org).
```

- `### N. Title` makes a section; the number is dropped in the email but orders the sections.
- `![alt](src "w=NNN")` sets an image's width in pixels; `frame=accent2` (or `accent`, `grey`, `none`) its frame. The alt text is shown as the caption. Images must be uploaded to the site (`media_upload`) and linked by the path it returns, never hotlinked from another site.
- `> text` makes a callout; `[text](url "button")` alone on a line makes a button.
- `<!-- contents -->` anywhere adds an "In this edition" list.

### Filing things for later

"Add this to the newsletter" means `add_item` with the `url`, the user's `note` in their own words, and `kind` only if they say what it is (`main`, `quick_hit`, `event`, `reminder`). It fetches the page's title itself. If the result has `duplicate: true`, the link was already there; say so.

### Changing the theme

Call `theme_get` first, then `theme_update` with only what changes. If `saved` is false, tell the user the errors and suggest a fix (usually a darker colour). Mention any warnings. A logo must be a PNG uploaded with `media_upload`, ideally transparent; SVGs and images from other sites don't work in email.
