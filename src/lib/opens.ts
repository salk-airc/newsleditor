import { createHmac, randomBytes } from "node:crypto";
import { getDb } from "emdash/runtime";
import { sql } from "kysely";
import { type OpenEvent, type Source, type Summary, sourceOf, summarize } from "../plugins/newsletter/opens.ts";

// Opens of sent editions (src/plugins/newsletter/opens.ts says how they're
// counted), in EmDash's database, in a table of our own made on first use:
//
//   newsletter_opens   one row per load of an edition's open image
//
// A row keeps no address or user agent. It keeps a "visitor": an HMAC of the
// address and user agent, keyed with a random secret kept in the same
// database, so the same device counts once in "about this many people" and
// the stored value can't be turned back into an address. It's rough: people
// behind one office address on the same mail app merge, and one person on
// two devices splits. It also keeps the source (sourceOf), worked out when
// the open comes in, since the user agent isn't kept.

type Db = Awaited<ReturnType<typeof getDb>>;

let ready: Promise<Db> | null = null;

function db(): Promise<Db> {
  ready ??= (async () => {
    const db = await getDb();
    await sql`CREATE TABLE IF NOT EXISTS newsletter_opens (
      slug TEXT NOT NULL, visitor TEXT NOT NULL, source TEXT NOT NULL, at TEXT NOT NULL)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS newsletter_opens_slug ON newsletter_opens (slug)`.execute(db);
    await sql`CREATE TABLE IF NOT EXISTS newsletter_opens_key (id INTEGER PRIMARY KEY CHECK (id = 1), key TEXT NOT NULL)`.execute(db);
    await sql`INSERT OR IGNORE INTO newsletter_opens_key (id, key) VALUES (1, ${randomBytes(32).toString("hex")})`.execute(db);
    return db;
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

let key: string | null = null;

async function visitor(device: string): Promise<string> {
  if (!key) {
    const { rows } = await sql<{ key: string }>`SELECT key FROM newsletter_opens_key WHERE id = 1`.execute(await db());
    key = rows[0]!.key;
  }
  return createHmac("sha256", key).update(device).digest("hex").slice(0, 16);
}

/** The address a request came from: Cloudflare's tunnel says, else the connection's. */
export function clientAddress(request: Request, fallback = ""): string {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ?? fallback;
}

/** Counts one open. */
export async function recordOpen(slug: string, address: string, userAgent: string): Promise<void> {
  const row = { slug, visitor: await visitor(`${address}|${userAgent}`), source: sourceOf(userAgent), at: new Date().toISOString() };
  await sql`INSERT INTO newsletter_opens (slug, visitor, source, at) VALUES (${row.slug}, ${row.visitor}, ${row.source}, ${row.at})`.execute(
    await db(),
  );
}

interface Row {
  slug: string;
  visitor: string;
  source: Source;
  at: string;
}

const toEvent = (r: Row): OpenEvent => ({ visitor: r.visitor, at: r.at, source: r.source });

/** Every edition's counts, by slug. Editions nobody opened aren't in it. */
export async function allOpenSummaries(): Promise<Map<string, Summary>> {
  const { rows } = await sql<Row>`SELECT slug, visitor, source, at FROM newsletter_opens`.execute(await db());
  const bySlug = new Map<string, OpenEvent[]>();
  for (const r of rows) {
    const list = bySlug.get(r.slug) ?? [];
    list.push(toEvent(r));
    bySlug.set(r.slug, list);
  }
  return new Map([...bySlug].map(([slug, events]) => [slug, summarize(events)]));
}

/** One edition's counts. */
export async function openSummary(slug: string): Promise<Summary> {
  const { rows } = await sql<Row>`SELECT slug, visitor, source, at FROM newsletter_opens WHERE slug = ${slug}`.execute(await db());
  return summarize(rows.map(toEvent));
}
