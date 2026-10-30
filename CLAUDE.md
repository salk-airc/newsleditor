# newsleditor

A self-hosted studio for writing an email newsletter together: Astro + EmDash + the newsletter plugin, run as a Node app. Start with README.md; working on a newsletter through its tools is in `.claude/skills/newsleditor/SKILL.md`.

## Related repos

How Salk AIRC runs newsleditor for Salk teams lives in other repos. They're Salk's, not part of the open-source app: keep Salk-specific settings out of this repo and put them there. When a task spans them, look for each checked out next to this one (`../<name>`) and clone it there if it's missing.

| Repo | What it is | How newsleditor uses it |
|---|---|---|
| [salk-airc/hosting](https://github.com/salk-airc/hosting) (private) | How AIRC hosts apps for Salk teams: `signin/` (Sign in with Salk at `https://signin.salk.sh`), `tunnel/` (Quick Tunnels), and `site/`, the one front page where teams ask for an app (next) | A newsletter's `OIDC_*` settings point at `signin/` ("Sign in with Salk", `src/auth/oidc.ts`). newsleditor's setup on the front page (what the form asks, what approving creates, its setup code) is `site/apps/newsleditor.ts` there, not here |
| [salk-airc/airc-landing](https://github.com/salk-airc/airc-landing) (private) | AIRC's own site, with the "News & Vibes" studio newsleditor was generalised from (Cloudflare Workers, D1, R2, Durable Objects) | Reference only: don't change it for newsleditor |

How the Salk pieces fit, for a team that runs its newsletter on its own computer:

- **Address:** a Cloudflare tunnel to `https://<name>-news.salk.sh` (outbound only; not the `-t` Quick Tunnels, which put Cloudflare Access in front).
- **Sign-in:** hosting's `signin/`; the newsletter's Admin invites its writers (EmDash's Users > Invite), and nobody else gets in.
- **Images in sent emails:** a public R2 bucket per newsletter (`S3_*`, with `S3_PUBLIC_URL`), so they load when the computer is off.
- **Setup code:** hosting's front page hands a team one code with all of the above; newsleditor's installer (still to come, and generic: any setup code works) takes it.
