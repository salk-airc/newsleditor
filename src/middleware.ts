import { defineMiddleware } from "astro:middleware";
import { canEdit, getSettings } from "./lib/newsletter";

// Who can see what:
//
// - /newsletter and everything under it: anyone signed in to EmDash. The
//   studio, the Theme page and setup also need the Editor role, checked by
//   their own pages (canEdit).
// - Until setup has run, editors are sent to /newsletter/setup.
// - /newsletter/edit/<slug>/sync: the co-editing rooms' login check, which
//   answers 401 itself rather than redirecting.
// - / goes to the newsletter.
// - EmDash's public site search: off. Nothing here uses it, and it returns
//   published content, editions included, to anyone who asks.
// - Everything else (EmDash's admin, API and media) as EmDash decides.

const SEARCH = /^\/_emdash\/api\/search(\/|$)/;
const LOGIN = "/_emdash/admin/login";
// The same pattern src/rooms/server.ts takes; the route checks sign-in itself.
const SYNC = /^\/newsletter\/edit\/[a-z0-9-]{1,100}\/sync$/;

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = context.url;

  if (SEARCH.test(pathname)) return new Response("Not found", { status: 404 });
  if (pathname === "/") return context.redirect("/newsletter");

  const gated = /^\/newsletter(\/|$)/.test(pathname);
  if (!gated || SYNC.test(pathname)) return next();

  const user = context.locals.user;
  if (!user) return context.redirect(`${LOGIN}?redirect=${encodeURIComponent(pathname + search)}`);

  if (canEdit(user) && pathname !== "/newsletter/setup" && !(await getSettings()).configured) {
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
