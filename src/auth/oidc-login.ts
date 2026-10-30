import type { APIRoute } from "astro";
import { getPublicOrigin } from "emdash/api/route-utils";
import { FLOW_KEY, oidcConfig, SignInError, startSignIn } from "./oidc.ts";

// GET /_emdash/api/auth/oidc/login: the "Sign in with …" button on EmDash's
// login, setup and invite pages (oidc-admin.tsx). Remembers the attempt in
// the session and sends the browser to the provider (oidc.ts).

export const prerender = false;

/** EmDash's invite tokens are base64url. */
const INVITE = /^[A-Za-z0-9_-]{1,256}$/;

export const GET: APIRoute = async ({ url, locals, session, redirect }) => {
  const cfg = oidcConfig();
  const fail = (message: string) => redirect(`/_emdash/admin/login?error=oidc&message=${encodeURIComponent(message)}`);
  if (!cfg) return fail("Sign-in isn't set up on this server (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET).");
  if (!session) return fail("Sessions aren't available on this server.");
  const invite = url.searchParams.get("invite");
  try {
    const { location, flow } = await startSignIn(cfg, getPublicOrigin(url, locals.emdash?.config), {
      invite: invite && INVITE.test(invite) ? invite : null,
      next: url.searchParams.get("next"),
    });
    session.set(FLOW_KEY, flow);
    return redirect(location);
  } catch (err) {
    console.error("Sign-in couldn't start:", err);
    return fail(err instanceof SignInError ? err.message : "Sign-in couldn't start. Try again.");
  }
};
