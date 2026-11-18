import type { APIRoute } from "astro";
import { getEditions, getSettings } from "../../../lib/newsletter";
import { clientAddress, recordOpen } from "../../../lib/opens.ts";

// /email/o/<slug>.gif: the open image at the end of a copied edition
// (src/plugins/newsletter/opens.ts). Public, like everything under /email,
// because sent emails load it. Always the same transparent pixel, never
// cached, so each open reaches here; counting happens after the answer, and
// a failure to count never stops the image.

export const prerender = false;

// A 1x1 transparent GIF.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const SLUG = /^[a-z0-9-]{1,100}$/;

// The editions there are, so opens of made-up editions aren't stored. Looked
// up again for a slug it doesn't know, at most every 10 seconds.
let known: { slugs: Set<string>; at: number } | null = null;
async function isEdition(slug: string): Promise<boolean> {
  if (known?.slugs.has(slug)) return true;
  if (known && Date.now() - known.at < 10_000) return false;
  const [published, drafts] = await Promise.all([getEditions(), getEditions("draft")]);
  known = { slugs: new Set([...published, ...drafts].map((e) => e.slug)), at: Date.now() };
  return known.slugs.has(slug);
}

async function count(slug: string, address: string, userAgent: string) {
  if (!(await getSettings()).settings.countOpens) return;
  if (!(await isEdition(slug))) return;
  await recordOpen(slug, address, userAgent);
}

export const GET: APIRoute = ({ params, request, clientAddress: connection }) => {
  const slug = params.slug ?? "";
  if (SLUG.test(slug)) {
    let fallback = "";
    try {
      fallback = connection;
    } catch {
      // No connection address (some adapters): the headers have to do.
    }
    count(slug, clientAddress(request, fallback), request.headers.get("User-Agent") ?? "").catch((err) =>
      console.error("[opens]", slug, err),
    );
  }
  return new Response(GIF, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, private, max-age=0" },
  });
};
