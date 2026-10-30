# newsleditor

A studio for writing an email newsletter together, which you run yourself, on your own computer or your own server.

- **Write together, live.** Several people edit the same edition at once and see each other's cursors. Everyone writes markdown on one side and sees the real email, the Slack post and the archive page on the other.
- **Paste straight into Outlook and Slack.** "Copy for Outlook" puts the designed email on the clipboard, ready to paste into a new message. "Copy for Slack" does the same for a short Slack version.
- **Emails that survive real inboxes.** The design is built around what Outlook, Gmail and phone dark modes actually do to an email (see [Why the email looks the way it does](#why-the-email-looks-the-way-it-does)).
- **Your look.** A theme (name, logo, colours, font) set up from your logo, checked so it stays readable.
- **Claude as a co-writer.** Connect Claude Code and it can collect links for the next edition, start a draft in your newsletter's voice, and change the theme.
- **An archive** of every edition sent, for the people signed in.

It's built on [Astro](https://astro.build) and [EmDash](https://emdashcms.com), and stores everything in a SQLite file and a folder of images by default. There's no service to sign up for: your newsletter lives wherever you run it.

## Quickstart

You need [Node.js](https://nodejs.org) 22.18 or newer.

```bash
git clone https://github.com/salk-airc/newsleditor.git
```

```bash
cd newsleditor
```

```bash
npm install
```

```bash
npm start
```

Then open **http://localhost:4321**. The first start builds the site, which takes a minute.

The first visit walks you through two short setups:

1. **EmDash's setup**: a site title and your account. You sign in with a [passkey](https://passkeys.dev) (your computer's fingerprint reader, face unlock or password manager), so there's no password to remember. The first person to do this becomes the Admin.
2. **The newsletter's setup**: its name, who it comes from, when it goes out, the signature under every email, a look taken from your logo's colours, how it sounds (for Claude), and where images live. At the end you can [connect Claude](#connect-claude).

Then go to **Drafts** and start the first edition.

Everything you make lives in the `data/` folder: the database, uploaded images, and the live copies of editions being edited. Back that folder up.

To use Claude Code to set this up, open Claude Code in this folder and say "help me set up newsleditor". It follows the skill in [`.claude/skills/newsleditor`](.claude/skills/newsleditor/SKILL.md).

## People and sign-in

- **The first person** through EmDash's setup is the Admin.
- **Invite others** from the admin (the **Admin** link at the top of every page, then **Users**). Without an email provider, the invite gives you a link to send them yourself. Each person signs up with their own passkey.
- **Roles.** Editors and Admins can write editions, change the theme and the settings. Anyone with an account can read the archive. Only Admins can connect Claude.
- **Email sign-in links** need an email provider plugin for EmDash. Without one, everyone uses passkeys, which is the simpler setup on a laptop anyway.
- **Passkeys need a secure address**: `http://localhost` works, and so does any `https://` address. A server reached over plain `http://` from another computer won't let anyone sign in, so put it [behind HTTPS](#on-a-server).

## Writing an edition

**Drafts** lists the editions being written and starts the next one, dated for your next edition day, with your starter text and subject line. Open one to edit it.

The left side is markdown. The right side shows it as the email, the Slack post, the archive page, and the **Inbox**: the links and notes collected for this edition. Edits save by themselves.

Markdown the email understands:

| Write | You get |
|---|---|
| `### 1. A section title 🎉` | A section heading with a coloured rule under it (the number is dropped) |
| `- **Bold start.** One or two sentences.` | A bullet |
| `![Caption](image.png "w=320")` | An image 320px wide, framed, with the caption under it. Paste an image to upload it |
| Two image lines in a row | Images side by side |
| `![Caption](image.png "w=240 frame=accent2")` | A frame in the second accent colour (`accent`, `accent2`, `grey`, `none`) |
| `> Something to notice` | A tinted callout |
| `[Sign up](https://… "button")` | A button (the first in a row is filled) |
| `<!-- contents -->` | An "In this edition" list of the sections under the name |
| `[ZOOM LINK]` | A placeholder, highlighted until you replace it |

Put the cursor on an image's line to size, caption, frame, crop or rotate it.

**Sending**: click **Copy for Outlook**, paste into a new message, add recipients and send. Then publish the edition in the admin to put it in the archive. For Slack, write the short version in the **Slack post** tab and use **Copy for Slack**. Read [Images in sent emails](#images-in-sent-emails) before the first send.

## Connect Claude

Claude Code can work on the newsletter through this site's MCP server:

- "add this to the newsletter: https://…" files a link (with its title) in the inbox for the next edition.
- "start the next edition" drafts it from the inbox, in the voice you described in setup, and gives you the studio link.
- "make the accent colour darker" or "use our new logo" changes the theme, checked for readability.

To connect, an Admin opens **Settings**, scrolls to **Connect Claude**, makes a connection, and runs the command it shows in a terminal. From a terminal on the server you can instead run `npm run connect-claude` (with `ADMIN_TOKEN` set to an admin API token, unless you're on `npm run dev`).

The key it makes can read and change all of the site's content and media, as an Admin can. Making a new connection replaces the previous one. After updating newsleditor, connect again: EmDash hides a plugin's tools until an Admin approves their new definitions.

The [skill](.claude/skills/newsleditor/SKILL.md) in this repo tells Claude how this newsletter works: the edition format, the tools, and to write in your voice and never invent facts. Claude Code picks it up when it runs in this folder; to use it elsewhere, copy the folder to `~/.claude/skills/`.

## Images in sent emails

A pasted email keeps links to its images, and each reader's mail app loads them when the email is opened. That includes the banner, the coloured rules and the logo, which newsleditor draws or serves itself. So the images have to be at an address the readers' mail apps can reach:

- **On a laptop** (`http://localhost:4321`) they aren't. That setup is for drafting and previewing. Some mail apps copy pasted images into the message itself, which would get around this; we haven't confirmed which Outlook versions do, so send yourself a test (and open it on a phone, off your network) before relying on it.
- **On a server with a public address** (see below) they are, as long as the images at `/email/art/` and `/_emdash/api/media/file/` can be loaded without signing in, which is how newsleditor serves them.
- **An S3-compatible bucket** (below) puts uploaded and pasted images at the bucket's public address. The banner, rules and logo still come from the site itself, so the site needs a public address for those too.

## Hosting

newsleditor is one Node process. Settings come from environment variables, which a `.env` file next to `package.json` can set:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4321` | The port it listens on |
| `HOST` | `localhost` | `0.0.0.0` to accept connections from other computers |
| `DATA_DIR` | `./data` | Where the database, images and live edits go |
| `SITE_URL` | | The address people reach it at, like `https://newsletter.example.org` |
| `DATABASE_URL` | | A `postgres://` connection string, to use Postgres instead of SQLite |
| `S3_BUCKET` | | Store images in an S3-compatible bucket instead of `data/media` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_URL` | | The bucket's details; `S3_PUBLIC_URL` is the public address its images are read from |

Changing these takes a restart. The database and storage settings are built into the site, so after changing `.env`, `npm start` rebuilds before starting. If you set them some other way (in the shell, a container), run `npm run build` after changing them.

### On a server

Run it under a process manager (systemd, pm2, a container) with `npm start`, behind a reverse proxy that gives it HTTPS. The proxy must pass WebSocket upgrades through, for live editing. [Caddy](https://caddyserver.com) does both with no extra settings:

```
newsletter.example.org {
    reverse_proxy localhost:4321
}
```

With nginx, add the upgrade headers to the `location` block:

```
proxy_pass http://localhost:4321;
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Host $host;
```

Set `SITE_URL` to the public address.

### Postgres and buckets

SQLite and the local `data/media` folder are fine for a team. To keep the data elsewhere, set `DATABASE_URL` for Postgres and the `S3_*` variables for any S3-compatible storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2). The bucket needs public read access for its images to show in emails.

## Why the email looks the way it does

Every choice in the designed email comes from something a real inbox did to an earlier version:

- **Art is drawn as images.** Outlook on the web drops CSS gradients and empty `<div>`s from a pasted email, so the glow banner and the coloured rules are PNGs that newsleditor draws from the theme's colours.
- **Text is near-black, and bullets are text.** Phone dark modes turn near-black text near-white but never change images, so anything that has to flip with the text is text. The banner is a transparent PNG, so it sits on whatever background dark mode chooses.
- **Image frames are padded table cells.** Outlook drops borders on a pasted `<img>` but keeps a cell's background.
- **The page colour is a clear stone**, not near-white, so the email reads as a page in every client.
- **Slack gets markdown as its plain text.** Slack sometimes pastes the plain-text version, and its composer formats markdown as it's pasted.
- **Pasted images are uploaded**, never kept as data in the text.
- **Logos from other sites are refused.** An image loaded from someone else's site tells that site who opened the email.
- **No SVG logos.** Gmail and Outlook don't show SVG images.

## Development

```bash
npm run dev
```

Runs the development server with live reload at http://localhost:4321. On a fresh database, http://localhost:4321/_emdash/api/setup/dev-bypass?redirect=/newsletter signs you in as a dev Admin without a passkey (development only).

- `npm run typecheck` checks the types.
- `npm run check:neutral` checks that no organization's names have crept in. newsleditor began as one organization's newsletter studio.

Where things are:

| Path | What |
|---|---|
| `src/plugins/newsletter/` | The EmDash plugin (inbox, settings, theme, Claude's tools) and the email, Slack and web renderers |
| `src/pages/newsletter/` | The archive, the studio (`edit/`), the Theme page and setup |
| `src/scripts/` | The browser side of the studio, Theme page and setup |
| `src/rooms/` | The live-editing server ([Yjs](https://yjs.dev) over WebSockets) |
| `server.mjs` | The production server: the site plus the live-editing rooms |
| `.emdash/seed.json` | The editions collection, created on first run |

## License

[MIT](LICENSE)
