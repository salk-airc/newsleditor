// Stands in for "cloudflare:workers" in the Node build (astro.config.mjs
// aliases it here), so code shared by both builds can import `env` and check
// for a Cloudflare binding: on Node there are none.
export const env: Record<string, unknown> = {};
