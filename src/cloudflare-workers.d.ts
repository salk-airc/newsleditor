// What code shared by the Node and Cloudflare builds sees of
// "cloudflare:workers": `env`, the Worker's bindings (on Node, aliased to an
// empty object by astro.config.mjs). The Cloudflare-only files, src/worker.ts
// and src/worker/edition-room.ts, are type-checked with Cloudflare's own
// types instead (src/worker/tsconfig.json).
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
