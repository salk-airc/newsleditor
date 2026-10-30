import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { drawGlow, drawRule } from "./email-art.ts";
import { publicMediaUrl } from "../plugins/newsletter/media.ts";
import { artKey, type ArtSpec } from "../plugins/newsletter/theme.ts";

export { publicMediaUrl };

// The images bucket, when the site has one (S3_* in the environment, the same
// settings EmDash's s3() storage reads; see astro.config.mjs).
//
// A sent email loads its images for as long as anyone opens it, so with a
// public bucket everything in it comes from there, not from this site: the
// uploads, the logo, and the banner and rules drawn from the theme. The
// uploads are already in the bucket; the drawings are put there by
// publishArt, under keys that say everything they draw (artKey), so each is
// written once and never changes.

let client: S3Client | null = null;

function s3(): S3Client {
  client ??= new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "auto",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    },
    // Path-style requests work with every S3-compatible service (MinIO needs them).
    forcePathStyle: true,
  });
  return client;
}

/** Keys known to be in the bucket, so each drawing is checked for once per run. */
const published = new Set<string>();

/**
 * Puts the drawings an email needs into the bucket, if they aren't there yet,
 * and returns their keys. Does nothing without a public bucket.
 */
export async function publishArt(specs: ArtSpec[]): Promise<string[]> {
  if (!publicMediaUrl()) return [];
  const Bucket = process.env.S3_BUCKET!;
  return Promise.all(
    specs.map(async (spec) => {
      const Key = artKey(spec);
      if (published.has(Key)) return Key;
      const there = await s3()
        .send(new HeadObjectCommand({ Bucket, Key }))
        .then(() => true)
        .catch((err: { $metadata?: { httpStatusCode?: number } }) => {
          if (err.$metadata?.httpStatusCode === 404) return false;
          throw err;
        });
      if (!there) {
        const Body = await (spec.kind === "glow" ? drawGlow(spec) : drawRule(spec));
        await s3().send(
          new PutObjectCommand({
            Bucket,
            Key,
            Body,
            ContentType: "image/png",
            CacheControl: "public, max-age=31536000, immutable",
          }),
        );
      }
      published.add(Key);
      return Key;
    }),
  );
}
