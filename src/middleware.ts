import { defineMiddleware } from "astro:middleware";

// Who can see what:
//
// - /newsletter and everything under it: anyone signed in to EmDash.
// - / goes to the newsletter.
// - EmDash's public site search: off. Nothing here uses it, and it returns
//   published content, editions included, to anyone who asks.
// - Everything else (EmDash's admin, API and media) as EmDash decides.

const SEARCH = /^\/_emdash\/api\/search(\/|$)/;
const LOGIN = "/_emdash/admin/login";

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = context.url;

  if (SEARCH.test(pathname)) return new Response("Not found", { status: 404 });
  if (pathname === "/") return context.redirect("/newsletter");

  const gated = /^\/newsletter(\/|$)/.test(pathname);
  if (!gated) return next();

  const user = context.locals.user;
  if (!user) return context.redirect(`${LOGIN}?redirect=${encodeURIComponent(pathname + search)}`);

  const response = await next();
  // Pages for signed-in people only: never from a shared cache.
  try {
    response.headers.set("Cache-Control", "private, no-store");
  } catch {
    // Immutable headers (a redirect).
  }
  return response;
});
