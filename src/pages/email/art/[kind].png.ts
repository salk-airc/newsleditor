import type { APIRoute } from "astro";
import { drawGlow, drawRule } from "../../../lib/email-art.ts";

// /email/art/glow.png?a=3557a0&b=2f8f83&s=60 and
// /email/art/rule.png?a=3557a0&b=2f8f83: a newsletter's banner and rules,
// drawn from its theme's colours (bannerUrl and ruleUrl in
// src/plugins/newsletter/theme.ts). Public, like everything under /email,
// because sent emails load them.
//
// A URL names everything it draws, so a response never changes: browsers and
// mail proxies may keep it forever, and the server keeps what it drew.

/** Drawn images by key. A theme has one glow and one rule, so this stays small. */
const drawn = new Map<string, Uint8Array<ArrayBuffer>>();
const MAX_DRAWN = 200;

export const prerender = false;

const HEX = /^[0-9a-f]{6}$/i;

export const GET: APIRoute = async ({ params, url }) => {
  const q = url.searchParams;
  const color = (key: string) => {
    const v = q.get(key) ?? "";
    return HEX.test(v) ? v.toLowerCase() : null;
  };
  const a = color("a");
  const b = color("b");

  // What to draw, checked first. The cache key is built from it alone, so
  // extra or reordered query parameters can't make the server draw again.
  let draw: () => Promise<Uint8Array<ArrayBuffer>>;
  let key: string;
  if (params.kind === "glow") {
    const strength = Number(q.get("s") ?? 60);
    if (!a || !b || !Number.isInteger(strength) || strength < 0 || strength > 100)
      return new Response("glow.png needs a, b (6-digit hex) and s (0 to 100)", { status: 400 });
    draw = () => drawGlow({ a, b, strength });
    key = `glow.png?a=${a}&b=${b}&s=${strength}`;
  } else if (params.kind === "rule") {
    if (!a || !b) return new Response("rule.png needs a and b (6-digit hex)", { status: 400 });
    draw = () => drawRule({ a, b });
    key = `rule.png?a=${a}&b=${b}`;
  } else {
    return new Response("Not found", { status: 404 });
  }

  let png = drawn.get(key);
  if (!png) {
    png = await draw();
    if (drawn.size >= MAX_DRAWN) drawn.delete(drawn.keys().next().value!);
    drawn.set(key, png);
  }
  return new Response(png, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
