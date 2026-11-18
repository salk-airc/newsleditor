// Counting opens of a sent edition. Pure: no EmDash, no I/O, so the studio
// (which adds the image to the copy for Outlook) and the server (which counts,
// src/lib/opens.ts) share it.
//
// The copy for Outlook ends with a 1x1 transparent image,
// /email/o/<slug>.gif, on this site. Each time a mail app loads it is an
// open. The edition goes to mailing lists, so every reader gets the same
// email and the same image: the counts say how many, never who. Links aren't
// tracked.
//
// It's rough, and the dashboard says so:
//
// - Mail apps that block images don't count. Apps that fetch images without
//   anyone reading (Apple Mail's privacy protection, mail scanners) would
//   overcount, so they're sorted out by their user agent and left out.
// - The image is served by the computer the newsletter runs on, so opens
//   while it's off or asleep aren't counted. Readers never notice: a 1x1
//   image that doesn't load shows nothing.
// - Test sends to yourself before the real one count as opens too. They're
//   left out once the send can be told from the counts (detectSend).
//
// The preview in the studio doesn't carry the image, so editing doesn't
// count as opening.

export const OPEN_PATH = /^\/email\/o\/([a-z0-9-]{1,100})\.gif$/;

export const openImageUrl = (site: string, slug: string) => `${site.replace(/\/$/, "")}/email/o/${slug}.gif`;

/** The open image's tag, for the end of the copied email. */
export function openImageTag(site: string, slug: string): string {
  return `<img src="${openImageUrl(site, slug)}" alt="" width="1" height="1" style="display:block; width:1px; height:1px; border:0">`;
}

export interface OpenEvent {
  /** About which device: a keyed hash of its address and mail app (src/lib/opens.ts). */
  visitor: string;
  /** ISO time. */
  at: string;
  source: Source;
}

export type Source = "people" | "webmail" | "apple" | "scanner";

export const SOURCES: Array<{ source: Source; label: string; counted: boolean; about: string }> = [
  { source: "people", label: "Mail apps", counted: true, about: "Outlook, phones, browsers" },
  { source: "webmail", label: "Gmail and Yahoo", counted: true, about: "fetch the image when someone opens the email" },
  { source: "apple", label: "Apple Mail privacy", counted: false, about: "loads every image on arrival, read or not" },
  { source: "scanner", label: "Scanners and bots", counted: false, about: "mail security and other automated fetches" },
];

const WEBMAIL = /GoogleImageProxy|YahooMailProxy/i;
const BOT =
  /bot\b|bot\/|crawl|spider|scan|preview|fetch|python|curl|wget|httpclient|http-client|okhttp|axios|undici|node|java\/|go-http|libwww|headless|phantom|proofpoint|mimecast|barracuda|symantec|forcepoint|zscaler|trend ?micro|sophos|fortinet|cisco|ironport/i;

/**
 * Who loaded the image, from its user agent. Gmail and Yahoo fetch images
 * through their own proxies, but only when someone opens the email, so those
 * count. Apple Mail's privacy protection fetches through a proxy whose user
 * agent is just "Mozilla/5.0", whether or not anyone reads. Scanners mostly
 * name themselves or the library they're built on.
 */
export function sourceOf(userAgent: string): Source {
  const ua = userAgent.trim();
  if (WEBMAIL.test(ua)) return "webmail";
  if (ua === "Mozilla/5.0") return "apple";
  if (!ua || BOT.test(ua)) return "scanner";
  return "people";
}

const counted = (s: Source) => SOURCES.find((x) => x.source === s)!.counted;

export interface SourceCount {
  source: Source;
  label: string;
  about: string;
  counted: boolean;
  opens: number;
  openers: number;
}

export interface TimeBucket {
  /** ISO start of the bucket. */
  start: string;
  opens: number;
}

export interface Summary {
  /** Counted opens: people's mail apps and webmail, after the send. */
  opens: number;
  /** About how many devices opened. */
  openers: number;
  firstOpen: string | null;
  lastOpen: string | null;
  /** Every source, in SOURCES order, counted or not. */
  sources: SourceCount[];
  /** Left out: Apple's prefetching and scanners, after the send. */
  left: number;
  /** Counted opens over time. */
  timeline: { bucketMinutes: number; buckets: TimeBucket[] };
  /** When it went out, worked out from the opens, or null if it can't be told. */
  sent: string | null;
  /** Opens from before the send (test sends), left out. */
  beforeSend: number;
}

// A send to a list makes many devices fetch the image within a minute of
// arriving (Apple's proxy, scanners, people), which a test send to a few
// people doesn't.
const SEND_DEVICES = 8;

/** The start of the first minute in which SEND_DEVICES different devices loaded the image, or null. */
export function detectSend(events: OpenEvent[]): string | null {
  const opens = events.map((e) => ({ t: Date.parse(e.at), v: e.visitor })).sort((a, b) => a.t - b.t);
  for (let i = 0, j = 0; j < opens.length; j++) {
    while (opens[j]!.t - opens[i]!.t > 60_000) i++;
    if (new Set(opens.slice(i, j + 1).map((o) => o.v)).size >= SEND_DEVICES) {
      return new Date(Math.floor(opens[i]!.t / 60_000) * 60_000).toISOString();
    }
  }
  return null;
}

export function summarize(all: OpenEvent[]): Summary {
  const sent = detectSend(all);
  const sentMs = sent ? Date.parse(sent) : -Infinity;
  const after = all.filter((e) => Date.parse(e.at) >= sentMs);
  const kept = after.filter((e) => counted(e.source));
  const times = kept.map((e) => e.at).sort();

  return {
    opens: kept.length,
    openers: new Set(kept.map((e) => e.visitor)).size,
    firstOpen: times[0] ?? null,
    lastOpen: times.at(-1) ?? null,
    sources: SOURCES.map(({ source, label, about, counted }) => {
      const mine = after.filter((e) => e.source === source);
      return { source, label, about, counted, opens: mine.length, openers: new Set(mine.map((e) => e.visitor)).size };
    }),
    left: after.length - kept.length,
    timeline: timeline(kept),
    sent,
    beforeSend: all.length - after.length,
  };
}

// Bucket size by how long the opens span: minutes in the first hour after a
// send, then longer, up to days. At most ~60 buckets.
const STEPS = [1, 2, 5, 10, 30, 60, 180, 360, 720, 1440];

export function timeline(events: OpenEvent[]): Summary["timeline"] {
  if (!events.length) return { bucketMinutes: 10, buckets: [] };
  const times = events.map((e) => Date.parse(e.at));
  const first = Math.min(...times);
  const last = Math.max(...times);
  const spanMin = (last - first) / 60_000;
  const bucketMinutes = STEPS.find((m) => spanMin / m <= 60) ?? 1440;
  const size = bucketMinutes * 60_000;
  const start = Math.floor(first / size) * size;
  const count = Math.floor((last - start) / size) + 1;
  const buckets: TimeBucket[] = Array.from({ length: count }, (_, i) => ({
    start: new Date(start + i * size).toISOString(),
    opens: 0,
  }));
  for (const t of times) buckets[Math.floor((t - start) / size)]!.opens++;
  return { bucketMinutes, buckets };
}
