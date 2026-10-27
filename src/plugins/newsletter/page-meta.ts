import type { PluginContext } from "emdash";

// Title, source and date for a link added to the newsletter, so a one-line
// request with a URL makes an item with the page's title and source. Best
// effort: any failure returns nulls and the item is saved
// anyway, since some sites (openai.com, science.org) block bots by design.

export interface PageMeta {
  title: string | null;
  source: string | null;
  publishedAt: string | null;
}

type Http = NonNullable<PluginContext["http"]>;

const TIMEOUT_MS = 5000;
// Titles and meta tags live in <head>; no need to download the whole page.
const MAX_BYTES = 256 * 1024;

export async function fetchPageMeta(http: Http | undefined, url: string): Promise<PageMeta> {
  const fallback: PageMeta = { title: null, source: hostLabel(url), publishedAt: dateFromPath(url) };
  if (!http) return fallback;
  try {
    const res = await http.fetch(url, {
      headers: {
        "user-agent": "newsleditor/0.1 (+https://github.com/salk-airc/newsleditor)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) {
      await res.body?.cancel();
      return fallback;
    }
    const html = await readHead(res);
    return {
      title: meta(html, "og:title") ?? meta(html, "twitter:title") ?? titleTag(html),
      source: meta(html, "og:site_name") ?? fallback.source,
      publishedAt:
        toIsoDate(
          meta(html, "article:published_time") ??
            meta(html, "date") ??
            meta(html, "dc.date") ??
            meta(html, "prism.publicationDate") ??
            meta(html, "citation_publication_date") ??
            jsonLdDate(html),
        ) ?? dateFromPath(url),
    };
  } catch {
    return fallback;
  }
}

async function readHead(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  let bytes = 0;
  while (bytes < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    html += decoder.decode(value, { stream: true });
    if (html.includes("</head>")) break;
  }
  await reader.cancel();
  return html;
}

// <meta property="og:title" content="..."> or name="...", attributes in either order.
function meta(html: string, key: string): string | null {
  const k = key.replace(/[.:]/g, "\\$&");
  const m =
    html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${k}["'][^>]*content=["']([^"']*)["']`, "i")) ??
    html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${k}["']`, "i"));
  return clean(m?.[1]);
}

function titleTag(html: string): string | null {
  return clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
}

// schema.org JSON-LD in <head>: "datePublished":"2026-09-29T00:00:00Z"
function jsonLdDate(html: string): string | null {
  return clean(html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1]);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// Blogs that only date their posts in the URL: /2026/10/06/ or /2026/Oct/6/
function dateFromPath(url: string): string | null {
  const m = new URL(url).pathname.match(/\/(20\d\d)\/(\d{1,2}|[a-z]{3})\/(\d{1,2})\//i);
  if (!m) return null;
  const month = /^\d+$/.test(m[2]) ? Number(m[2]) : MONTHS.indexOf(m[2].toLowerCase()) + 1;
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// "www.nature.com" -> "nature.com"
function hostLabel(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function clean(raw: string | undefined): string | null {
  if (!raw) return null;
  const text = decodeEntities(raw).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 300) : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}
