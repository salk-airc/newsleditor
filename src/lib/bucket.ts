import { env } from "cloudflare:workers";
import { drawGlow, drawRule } from "./email-art.ts";
import { publicMediaUrl } from "../plugins/newsletter/media.ts";
import { artKey, type ArtSpec } from "../plugins/newsletter/theme.ts";

export { publicMediaUrl };

// The images bucket, when the site has one: an S3-compatible bucket (S3_* in
// the environment, the same settings EmDash's s3() storage reads), or on
// Cloudflare the R2 bucket bound as MEDIA. See astro.config.mjs.
//
// A sent email loads its images for as long as anyone opens it, so with a
// public bucket everything in it comes from there, not from this site: the
// uploads, the logo, and the banner and rules drawn from the theme. The
// uploads are already in the bucket; the drawings are put there by
// publishArt, under keys that say everything they draw (artKey), so each is
// written once and never changes.

interface Bucket {
  has(key: string): Promise<boolean>;
  put(key: string, body: Uint8Array<ArrayBuffer>): Promise<void>;
}

const IMMUTABLE = "public, max-age=31536000, immutable";

// R2 as a Cloudflare binding: as much of its API as this uses.
interface R2 {
  head(key: string): Promise<unknown>;
  put(key: string, body: Uint8Array, options: { httpMetadata: { contentType: string; cacheControl: string } }): Promise<unknown>;
}

let bucket: Promise<Bucket> | null = null;

function openBucket(): Promise<Bucket> {
  bucket ??= (async (): Promise<Bucket> => {
    const r2 = (env as { MEDIA?: R2 }).MEDIA;
    if (r2) {
      return {
        has: async (key) => (await r2.head(key)) !== null,
        put: async (key, body) => void (await r2.put(key, body, { httpMetadata: { contentType: "image/png", cacheControl: IMMUTABLE } })),
      };
    }
    // Loaded only for an S3 bucket, so the Cloudflare build doesn't carry it.
    const { HeadObjectCommand, PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || "auto",
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "" },
      // Path-style requests work with every S3-compatible service (MinIO needs them).
      forcePathStyle: true,
    });
    const Bucket = process.env.S3_BUCKET!;
    return {
      has: (Key) =>
        s3.send(new HeadObjectCommand({ Bucket, Key })).then(
          () => true,
          (err: { $metadata?: { httpStatusCode?: number } }) => {
            if (err.$metadata?.httpStatusCode === 404) return false;
            throw err;
          },
        ),
      put: async (Key, Body) => void (await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: "image/png", CacheControl: IMMUTABLE }))),
    };
  })();
  return bucket;
}

/** Keys known to be in the bucket, so each drawing is checked for once per run. */
const published = new Set<string>();

/**
 * Puts the drawings an email needs into the bucket, if they aren't there yet,
 * and returns their keys. Does nothing without a public bucket.
 */
export async function publishArt(specs: ArtSpec[]): Promise<string[]> {
  if (!publicMediaUrl()) return [];
  const b = await openBucket();
  return Promise.all(
    specs.map(async (spec) => {
      const key = artKey(spec);
      if (published.has(key)) return key;
      if (!(await b.has(key))) await b.put(key, await (spec.kind === "glow" ? drawGlow(spec) : drawRule(spec)));
      published.add(key);
      return key;
    }),
  );
}
