// The Worker's entry point on Cloudflare (NEWSLEDITOR_TARGET=cloudflare):
// Astro's handler for every request, plus the Durable Object class that holds
// each edition's live document. Wrangler's `main` points here, not at
// @astrojs/cloudflare's entrypoint, because a Durable Object class has to be
// exported from the entry module.
import handler from "@astrojs/cloudflare/entrypoints/server";

export { EditionRoom } from "./worker/edition-room.ts";

export default handler;
