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

**On Windows, with a setup code** (from whoever hosts newsletters for your organisation): download [`installer/windows/Install newsleditor.cmd`](installer/windows/), double-click it, choose **Yes** to let it make changes, and paste the code. It installs Node.js and newsleditor, connects the address in the code, makes newsleditor start with the computer, and opens it. Run it again later, with the code box empty, to update. See [Setup codes](#setup-codes).

**On a Mac, with a setup code:** paste this into Terminal (or double-click [`installer/mac/Install newsleditor.command`](installer/mac/); if macOS says it's from an unidentified developer, right-click it and choose **Open**), then paste the code into the window that appears:

```bash
curl -fsSL https://raw.githubusercontent.com/salk-airc/newsleditor/main/installer/mac/install.sh | bash
```

It needs no admin password: Node.js, newsleditor, cloudflared and the newsletter's data all go in `~/Library/Application Support/newsleditor`, and it runs while you're logged in (it starts at login, and restarts if it stops). Keep that Mac logged in, and set it not to sleep while your team writes. Run it again to update; `installer/mac/uninstall.sh` removes it.

**Without a setup code**, on a Mac or Linux, paste this into a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/salk-airc/newsleditor/main/install.sh | bash
```

It checks for git and [Node.js](https://nodejs.org) 22.18 or newer (installing Node with [Homebrew](https://brew.sh) if you have it), downloads newsleditor into `~/newsleditor`, installs it, starts it and opens **http://localhost:4321**. Run it again later to update. `NEWSLEDITOR_DIR` installs somewhere else, `PORT` picks another port, and `NO_START=1` installs without starting.

Or by hand, with Node.js 22.18 or newer:

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
- **Or sign in with your organisation's accounts** (below), alongside passkeys.

### Sign in with your organisation

newsleditor can add a **Sign in with …** button for any OpenID Connect provider: your organisation's Microsoft Entra, Google, or a sign-in service in front of one. It's still invite-only: a valid sign-in from someone without an account here is turned away. An Admin invites each writer under **Users > Invite**, and they accept with the button. An Admin can also let in everyone from a domain under **Users > Allowed domains**, but nothing is let in that way unless they do.

Make an app (a "client") with the provider, with the redirect URL `https://<your address>/_emdash/api/auth/oidc/callback`, then set:

| Variable | What it is |
|---|---|
| `OIDC_ISSUER` | The provider's issuer. Microsoft Entra: `https://login.microsoftonline.com/<tenant id>/v2.0`. Google: `https://accounts.google.com` |
| `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | The app's id and secret |
| `OIDC_LABEL` | The button's name: "Sign in with *Salk*" |
| `OIDC_FIRST_ADMIN` | The email that may make the first account, the Admin. Without it, whoever signs in first does |
| `OIDC_TRUST_EMAIL` | `1` to accept addresses the provider doesn't mark as verified. Microsoft Entra doesn't, so set it for an Entra app that only your organisation can sign in to (single tenant) |

The button is built in, so `npm start` rebuilds after these change in `.env`.

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
- **On a server with a public address** (see below) they are, as long as the images at `/email/art/` and `/_emdash/api/media/file/` can be loaded without signing in, which is how newsleditor serves them. The server has to stay up for as long as anyone might open an old email.
- **With an S3-compatible bucket that has a public address** (below), everything the copied email shows loads from the bucket: uploaded and pasted images, the logo, and the banner and rules, which newsleditor puts in the bucket (under `email-art/`) when an edition is opened in the studio. The site itself can then be anywhere, a laptop included, and switched off: sent emails don't need it.

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

### Setup codes

An organisation that hosts newsletters for its teams can hand each one a single **setup code** instead of a list of settings. The Windows and Mac installers take it. A code is `setup1.` followed by base64url-encoded JSON:

```json
{
  "app": "newsleditor",
  "url": "https://news.example.org",
  "env": { "SITE_URL": "https://news.example.org", "OIDC_ISSUER": "…", "S3_BUCKET": "…" },
  "tunnelToken": "…"
}
```

- `env`: the settings above, written to the installed newsleditor's `.env`. The installer adds `DATA_DIR`, `PORT` and `HOST` itself.
- `tunnelToken` (optional): a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) token. The installer installs `cloudflared` and connects it as a service, so `url` reaches newsleditor on that computer with no inbound ports.

It holds keys, so send it to the person setting up the computer, not to a channel.

On Windows, the installer puts newsleditor in `C:\Program Files\newsleditor` and its settings and data in `C:\ProgramData\newsleditor`, where only administrators can read them. Back up `C:\ProgramData\newsleditor\data`: that's the newsletter. It runs as a scheduled task, **newsleditor**, at startup, and restarts if it stops. The installer's log is `C:\ProgramData\newsleditor\install.log`.

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

SQLite and the local `data/media` folder are fine for a team. To keep the data elsewhere, set `DATABASE_URL` for Postgres and the `S3_*` variables for any S3-compatible storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2). The bucket needs public read access, and `S3_PUBLIC_URL` set to the address it's read at, for its images to show in emails. The access key needs to read and write objects in that bucket only (on Cloudflare R2, an API token with Object Read & Write, limited to the one bucket).

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
