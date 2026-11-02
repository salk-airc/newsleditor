// Where a sent email's images load from, when the site keeps them in a public
// bucket: an S3-compatible one (S3_BUCKET with S3_PUBLIC_URL), or on
// Cloudflare its R2 binding (MEDIA_PUBLIC_URL). See astro.config.mjs and
// src/lib/bucket.ts. Server only: the pages hand it to the browser.

/** The images bucket's public address without a trailing slash, or null when images aren't in a public bucket. */
export function publicMediaUrl(): string | null {
  const env = globalThis.process?.env ?? {};
  const url = env.S3_BUCKET ? env.S3_PUBLIC_URL : env.MEDIA_PUBLIC_URL;
  return url?.trim().replace(/\/+$/, "") || null;
}
