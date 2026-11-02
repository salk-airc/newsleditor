import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { canEdit } from "../../../../lib/newsletter";

// The way into an edition's live document, behind the same gate as the
// editor page:
//
//   GET with Upgrade: websocket   join the edit session (y-websocket protocol)
//   POST { body, slack, rev }     fill it from EmDash if it needs to be
//
// On Node (npm start) the rooms run outside Astro (src/rooms/server.ts), which
// takes those requests before Astro sees them and asks here first with the
// browser's cookies: a plain GET, answered 204 if they may edit. On
// Cloudflare the room is a Durable Object (src/worker/edition-room.ts), and
// this hands the request to it.

export const prerender = false;

// The Durable Object binding, as much of it as this uses (not Cloudflare's
// types, which clash with the DOM's in the Node build).
interface Rooms {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
const rooms = (env as { EDITION_ROOM?: Rooms }).EDITION_ROOM;

export const ALL: APIRoute = async ({ request, params, locals, url }) => {
  if (!locals.user) return new Response(null, { status: 401 });
  if (!canEdit(locals.user)) return new Response(null, { status: 403 });

  const isUpgrade = request.headers.get("Upgrade") === "websocket";
  if (!rooms || (!isUpgrade && request.method !== "POST")) {
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
  }

  // Browsers send the session cookie on a WebSocket upgrade from any site,
  // and nothing like CORS stops it, so check the page that opened it is ours.
  if (request.headers.get("Origin") !== url.origin) return new Response("Wrong origin", { status: 403 });
  const slug = params.slug ?? "";
  if (!/^[a-z0-9-]{1,100}$/.test(slug)) return new Response("Bad edition", { status: 400 });
  return rooms.get(rooms.idFromName(slug)).fetch(request);
};
