# newsleditor

A self-hosted studio for writing an email newsletter together: Astro + EmDash + the newsletter plugin, run as a Node app. Start with README.md; working on a newsletter through its tools is in `.claude/skills/newsleditor/SKILL.md`.

## Related repos

How Salk AIRC runs newsleditor for Salk teams lives in other repos. They're Salk's, not part of the open-source app: keep Salk-specific settings out of this repo and put them there. When a task spans them, look for each checked out next to this one (`../<name>`) and clone it there if it's missing.

| Repo | What it is | How newsleditor uses it |
|---|---|---|
| [salk-airc/salk-signin](https://github.com/salk-airc/salk-signin) (private) | Salk sign-in at `https://signin.salk.sh`: an OpenID Connect provider in front of the "AIRC Sign-in" Microsoft Entra app, for any AIRC service | A newsletter's `OIDC_*` settings point at it ("Sign in with Salk", `src/auth/oidc.ts`). Its `scripts/register-client.sh` registers a newsletter and prints those settings |
| [salk-airc/airc-landing](https://github.com/salk-airc/airc-landing) (private) | AIRC's own site, with the "News & Vibes" studio newsleditor was generalised from (Cloudflare Workers, D1, R2, Durable Objects) | Reference only: don't change it for newsleditor |
| salk-tunnel (not in a repo yet) | Salk Quick Tunnel: `cloudflared` from a lab machine to `<name>-t.salk.sh`, behind Cloudflare Access | A newsletter on a lab machine gets a tunnel like these, but at `<name>-news.salk.sh` without Access (sign-in is salk-signin's) |

How the Salk pieces fit, for a team that runs its newsletter on its own computer:

- **Address:** a Cloudflare tunnel to `https://<name>-news.salk.sh`.
- **Sign-in:** salk-signin; the newsletter's Admin invites its writers (EmDash's Users > Invite), and nobody else gets in.
- **Images in sent emails:** a public R2 bucket per newsletter (`S3_*`, with `S3_PUBLIC_URL`), so they load when the computer is off.
- Still to come: the `newsleditor.salk.sh` front page (requests, approved in Slack) and the installers that take one setup code.
