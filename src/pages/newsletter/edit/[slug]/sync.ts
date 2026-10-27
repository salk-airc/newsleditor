import type { APIRoute } from "astro";
import { canEdit } from "../../../../lib/newsletter";

// The login check for an edition's live document. The rooms themselves run
// outside Astro (src/rooms/server.ts), which takes WebSocket upgrades and
// seed POSTs to this path before Astro sees them, and asks here first,
// passing the browser's cookies: 204 if they belong to someone who may edit.

export const prerender = false;

export const GET: APIRoute = ({ locals }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  if (!canEdit(locals.user)) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
};
