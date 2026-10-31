import { defineMiddleware } from "astro:middleware";
import { OptionsRepository } from "emdash/api/route-utils";
import { LOGIN_PATH, oidcConfig } from "./auth/oidc.ts";
import { canEdit, getSettings } from "./lib/newsletter";

// Who can see what:
//
// - /newsletter and everything under it: anyone signed in to EmDash. The
//   studio, the Theme page and setup also need the Editor role, checked by
//   their own pages (canEdit).
// - Until setup has run, editors are sent to /newsletter/setup (the Theme
//   page stays open: setup links to it).
// - /newsletter/edit/<slug>/sync: the co-editing rooms' login check, which
//   answers 401 itself rather than redirecting.
// - / goes to the newsletter.
// - EmDash's public site search: off. Nothing here uses it, and it returns
//   published content, editions included, to anyone who asks.
// - With sign-in through an organisation (OIDC_ISSUER, src/auth/oidc.ts),
//   the first account, the Admin, can only come through it, as
//   OIDC_FIRST_ADMIN when that's set. Until there is one, EmDash's own
//   setup wizard (which makes the Admin with a passkey, for whoever opens
//   the site first) goes to that sign-in instead, and its setup API is
//   refused.
// - Everything else (EmDash's admin, API and media) as EmDash decides.

const SEARCH = /^\/_emdash\/api\/search(\/|$)/;
const LOGIN = "/_emdash/admin/login";
// The same pattern src/rooms/server.ts takes; the route checks sign-in itself.
const SYNC = /^\/newsletter\/edit\/[a-z0-9-]{1,100}\/sync$/;
const BEFORE_SETUP = new Set(["/newsletter/setup", "/newsletter/theme"]);

// EmDash's setup wizard: the page, and the API that makes the first account.
const EMDASH_SETUP_PAGE = /^\/_emdash\/admin\/setup\/?$/;
const EMDASH_SETUP_API = /^\/_emdash\/api\/setup(\/(admin|admin\/verify|dev-bypass|dev-reset))?\/?$/;

// Setup is never undone, so once it has run there's no need to ask the
// database again on every request.
let setUp = false;
async function setupDone(): Promise<boolean> {
  setUp ||= (await getSettings()).configured;
  return setUp;
}

let hasAdmin = false;
async function emdashSetUp(db: ConstructorParameters<typeof OptionsRepository>[0] | undefined): Promise<boolean> {
  if (!hasAdmin && db) hasAdmin = String(await new OptionsRepository(db).get("emdash:setup_complete")) === "true";
  return hasAdmin;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = context.url;

  if (SEARCH.test(pathname)) return new Response("Not found", { status: 404 });
  if (pathname === "/") return context.redirect("/newsletter");

  const setupPage = EMDASH_SETUP_PAGE.test(pathname);
  if ((setupPage || EMDASH_SETUP_API.test(pathname)) && oidcConfig() && !(await emdashSetUp(context.locals.emdash?.db))) {
    if (setupPage) return context.redirect(`${LOGIN_PATH}?next=${encodeURIComponent("/newsletter/setup")}`);
    return new Response("The first account is made by signing in with your organisation.", { status: 403 });
  }

  const gated = /^\/newsletter(\/|$)/.test(pathname);
  if (!gated || SYNC.test(pathname)) return next();

  const user = context.locals.user;
  if (!user) return context.redirect(`${LOGIN}?redirect=${encodeURIComponent(pathname + search)}`);

  if (canEdit(user) && !BEFORE_SETUP.has(pathname) && !(await setupDone())) {
    return context.redirect("/newsletter/setup");
  }

  const response = await next();
  // Pages for signed-in people only: never from a shared cache.
  try {
    response.headers.set("Cache-Control", "private, no-store");
  } catch {
    // Immutable headers (a redirect).
  }
  return response;
});
