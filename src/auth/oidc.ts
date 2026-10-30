import type { OAuthProfile } from "@emdash-cms/auth";

// Sign-in with any OpenID Connect provider: a Microsoft Entra or Google app,
// or a sign-in service in front of one (at Salk, AIRC's, which holds the
// Entra app so the newsletter's own computer never has its secret).
//
// Set in the environment (see README, "Sign in with your organisation"):
//
// - OIDC_ISSUER: the provider's issuer, e.g. https://signin.example.org or
//   https://login.microsoftonline.com/<tenant>/v2.0. Its endpoints come from
//   <issuer>/.well-known/openid-configuration.
// - OIDC_CLIENT_ID, OIDC_CLIENT_SECRET: this newsletter's client.
// - OIDC_LABEL: the button's name ("Salk", "Microsoft"). Built in.
// - OIDC_FIRST_ADMIN: the email that may make the first account, the Admin.
//   Without it, whoever signs in first does, as with a passkey.
//
// Standard authorization code flow with PKCE and a nonce. The attempt is kept
// in the server-side session (Astro's), so nothing about it is in the
// browser but the session cookie. The id_token comes straight from the
// provider's token endpoint over TLS, in exchange for the client secret, so
// its claims are checked but its signature isn't (OIDC Core 3.1.3.7 allows
// this for the code flow).
//
// Who may sign in is EmDash's, as for its GitHub and Google sign-in: people
// with an account (an Admin invites them, under Users), or anyone from a
// domain an Admin allows. A valid sign-in from anyone else is turned away.

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  firstAdmin: string | null;
}

/** Null when sign-in isn't set up. */
export function oidcConfig(): OidcConfig | null {
  const env = process.env;
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) return null;
  return {
    issuer: env.OIDC_ISSUER.replace(/\/+$/, ""),
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    firstAdmin: env.OIDC_FIRST_ADMIN?.trim().toLowerCase() || null,
  };
}

/** EmDash's name for these accounts (its oauth_accounts table). */
export const PROVIDER = "oidc";
export const LOGIN_PATH = "/_emdash/api/auth/oidc/login";
export const CALLBACK_PATH = "/_emdash/api/auth/oidc/callback";
/** The Astro session key for a sign-in in progress. */
export const FLOW_KEY = "oidcFlow";
const FLOW_MINUTES = 10;

export interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  /** An EmDash invite this sign-in accepts. */
  invite: string | null;
  /** Where to go afterwards: a path on this site. */
  next: string;
  exp: number;
}

/** Only paths on this site, so the sign-in can't be used to send people elsewhere. */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/newsletter/edit";
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

let discovered: { issuer: string; doc: Discovery } | null = null;

async function discover(cfg: OidcConfig): Promise<Discovery> {
  if (discovered?.issuer === cfg.issuer) return discovered.doc;
  const res = await fetch(`${cfg.issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new SignInError(`The sign-in provider didn't answer (${res.status}).`);
  const doc = (await res.json()) as Discovery;
  if (doc.issuer?.replace(/\/+$/, "") !== cfg.issuer) throw new SignInError("The sign-in provider names a different issuer.");
  discovered = { issuer: cfg.issuer, doc };
  return doc;
}

export class SignInError extends Error {}

/** Where to send the browser to sign in, and the attempt to keep until it comes back. */
export async function startSignIn(
  cfg: OidcConfig,
  origin: string,
  options: { invite: string | null; next: string | null },
): Promise<{ location: string; flow: Flow }> {
  const { authorization_endpoint } = await discover(cfg);
  const flow: Flow = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(48),
    invite: options.invite,
    next: safeNext(options.next),
    exp: Date.now() + FLOW_MINUTES * 60_000,
  };
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(flow.verifier))));
  const authorize = new URL(authorization_endpoint);
  for (const [k, v] of Object.entries({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: origin + CALLBACK_PATH,
    scope: "openid email profile",
    state: flow.state,
    nonce: flow.nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    authorize.searchParams.set(k, v);
  return { location: authorize.href, flow };
}

/** Who signed in, from the provider's redirect back. */
export async function finishSignIn(cfg: OidcConfig, url: URL, origin: string, flow: Flow | undefined): Promise<OAuthProfile> {
  const error = url.searchParams.get("error");
  if (error) throw new SignInError(url.searchParams.get("error_description") ?? error);
  if (!flow || flow.exp < Date.now()) throw new SignInError("The sign-in took too long or started in another browser. Try again.");
  if (url.searchParams.get("state") !== flow.state) throw new SignInError("Sign-in state didn't match. Try again.");
  const code = url.searchParams.get("code");
  if (!code) throw new SignInError("The sign-in provider didn't return a code.");

  const { token_endpoint } = await discover(cfg);
  const res = await fetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: origin + CALLBACK_PATH,
      code_verifier: flow.verifier,
    }),
  });
  const tokens = (await res.json().catch(() => null)) as { id_token?: string; error_description?: string } | null;
  if (!res.ok || !tokens?.id_token) throw new SignInError(tokens?.error_description ?? `The sign-in provider refused the code (${res.status}).`);

  const claims = decodeJwtPayload(tokens.id_token);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    String(claims.iss ?? "").replace(/\/+$/, "") !== cfg.issuer ||
    !aud.includes(cfg.clientId) ||
    claims.nonce !== flow.nonce ||
    typeof claims.exp !== "number" ||
    claims.exp < Date.now() / 1000
  ) {
    throw new SignInError("The sign-in provider's answer didn't check out. Try again.");
  }
  // Entra puts the address in preferred_username unless the app asks for the
  // email claim; there, an organisation's own accounts are its addresses.
  const email = String(claims.email ?? claims.preferred_username ?? "").toLowerCase();
  if (!email.includes("@") || typeof claims.sub !== "string") throw new SignInError("The sign-in provider didn't say who you are.");
  return {
    id: claims.sub,
    email,
    name: typeof claims.name === "string" ? claims.name : null,
    avatarUrl: null,
    // Required to sign in to an account an Admin made for this address.
    emailVerified: claims.email_verified === true || (claims.email_verified === undefined && process.env.OIDC_TRUST_EMAIL === "1"),
  };
}

// ------------------------------------------------------------- helpers --

function randomToken(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new SignInError("The sign-in provider sent a malformed token.");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}
