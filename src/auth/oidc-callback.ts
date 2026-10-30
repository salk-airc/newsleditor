import { acceptInviteViaOAuth, findOrCreateOAuthUser, OAuthError, Role, type RoleLevel } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { APIRoute } from "astro";
import { finalizeSetup, getPublicOrigin, OptionsRepository } from "emdash/api/route-utils";
import { FLOW_KEY, type Flow, finishSignIn, oidcConfig, PROVIDER, SignInError } from "./oidc.ts";

// GET /_emdash/api/auth/oidc/callback: where the provider sends the browser
// back. Who may in, as EmDash's own GitHub and Google sign-in decides:
//
// - Before EmDash's setup has run, the first sign-in makes the Admin, and
//   only OIDC_FIRST_ADMIN's address may, when it's set.
// - An invite (Users > Invite in the admin) makes an account for the address
//   it was sent to.
// - Anyone with an account signs in to it; a new address signs up only if
//   its domain is one an Admin allows (Users > Allowed domains).
//
// The provider must vouch for the address (email_verified) for any of these.

export const prerender = false;

const ROLES: Record<number, RoleLevel> = {
  50: Role.ADMIN,
  40: Role.EDITOR,
  30: Role.AUTHOR,
  20: Role.CONTRIBUTOR,
  10: Role.SUBSCRIBER,
};

export const GET: APIRoute = async ({ url, locals, session, redirect }) => {
  const cfg = oidcConfig();
  const db = locals.emdash?.db;
  const fail = (message: string) => redirect(`/_emdash/admin/login?error=oidc&message=${encodeURIComponent(message)}`);
  if (!cfg || !db || !session) return fail("Sign-in isn't set up on this server.");

  const flow = (await session.get(FLOW_KEY)) as Flow | undefined;
  session.delete(FLOW_KEY);
  try {
    const profile = await finishSignIn(cfg, url, getPublicOrigin(url, locals.emdash?.config), flow);
    if (!profile.emailVerified) throw new SignInError("The sign-in provider didn't confirm your email address, so it can't be matched to an account.");

    const options = new OptionsRepository(db);
    const setUp = String(await options.get("emdash:setup_complete")) === "true";
    // EmDash's database has the auth tables; its own sign-in routes pass it the same way.
    const adapter = createKyselyAdapter(db as unknown as Parameters<typeof createKyselyAdapter>[0]);
    const user = flow?.invite
      ? await acceptInviteViaOAuth(adapter, PROVIDER, profile, flow.invite)
      : await findOrCreateOAuthUser(adapter, PROVIDER, profile, async (email) => {
          if (!setUp) return !cfg.firstAdmin || email === cfg.firstAdmin ? { allowed: true, role: Role.ADMIN } : null;
          const domain = email.split("@")[1];
          const entry = domain
            ? await db.selectFrom("allowed_domains").selectAll().where("domain", "=", domain).where("enabled", "=", 1).executeTakeFirst()
            : undefined;
          return entry ? { allowed: true, role: ROLES[entry.default_role] ?? Role.CONTRIBUTOR } : null;
        });
    if (!setUp) await finalizeSetup(db);

    session.set("user", { id: user.id });
    return redirect(flow!.next);
  } catch (err) {
    if (err instanceof SignInError) return fail(err.message);
    if (err instanceof OAuthError) {
      if (err.code === "signup_not_allowed")
        return fail("You don't have an account on this newsletter. Ask its Admin to invite you.");
      if (err.code === "invite_invalid") return fail("This invite link is invalid or has expired. Ask for a new one.");
      if (err.code === "invite_email_mismatch") return fail("This invite was sent to a different email address.");
    }
    console.error("Sign-in failed:", err);
    return fail("Sign-in failed. Try again.");
  }
};
