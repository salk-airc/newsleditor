import type { APIRoute } from "astro";
import { publishArt } from "../../lib/bucket.ts";
import { canEdit, getTheme } from "../../lib/newsletter";
import { artSpecs } from "../../plugins/newsletter/theme.ts";

// POST /newsletter/art: puts the saved theme's banner and rule drawings into
// the images bucket, so a copied email can load them from there rather than
// from this site (src/lib/bucket.ts). The studio calls it when it opens an
// edition, before anything is copied. Without a public bucket it does
// nothing.

export const prerender = false;

export const POST: APIRoute = async ({ locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  if (!canEdit(locals.user)) return new Response(null, { status: 403 });
  try {
    const keys = await publishArt(artSpecs(await getTheme()));
    return Response.json({ keys }, { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    console.error("Couldn't put the email art in the images bucket:", err);
    return Response.json({ error: "Couldn't put the email art in the images bucket." }, { status: 502 });
  }
};
