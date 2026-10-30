import { definePlugin, PluginRouteError } from "emdash";
import { z } from "zod";
import { editionTitle, nextOpenEditionDate, starterBody, weekdayName } from "./editions.ts";
import { fetchPageMeta } from "./page-meta";
import {
  applySettingsPatch,
  checkSettings,
  DEFAULT_SETTINGS,
  type Settings,
  settingsPatchSchema,
  settingsSchema,
} from "./settings.ts";
import { publicMediaUrl } from "./media.ts";
import { applyPatch, checkTheme, DEFAULT_THEME, type Theme, themePatchSchema, themeSchema } from "./theme.ts";

// The newsletter plugin: the team's inbox for the next edition, the
// newsletter's settings and theme, and what Claude needs to start an edition.
//
// - add_item / list_items: "add this to the newsletter", and what's waiting.
// - mark_used: items that went into an edition leave the inbox (kept, with
//   the edition they went into).
// - list-used (not a Claude tool): the items marked used for one edition, for
//   the studio's read-only Inbox tab.
// - next_edition: the date, slug, subject line and starter text of the next
//   edition, and its studio link. It doesn't create the edition: EmDash gives
//   plugins no way to set a slug, and an edition's slug is its date, so Claude
//   creates it with the core content_create tool.
// - settings_get / settings_update: name, schedule, subject format, starter,
//   signature, sender and voice, filled in by first-run setup.
// - theme_get / theme_update: the look of the email.
//
// Items, settings and the theme live in plugin storage. Editions are the
// "editions" collection (.emdash/seed.json).

// Section kinds: numbered main sections, quick-hit bullets, and
// events/reminders (workshops, recordings).
const KINDS = ["main", "quick_hit", "event", "reminder"] as const;

const addItemInput = z
  .object({
    url: z.url().optional().describe("Link to the thing worth sharing"),
    note: z
      .string()
      .max(4000)
      .optional()
      .describe(
        "The user's note, kept in their own words. Don't rewrite or summarize it; drafting happens later.",
      ),
    kind: z
      .enum(KINDS)
      .optional()
      .describe(
        "main: a numbered section (the user's own announcements). quick_hit: a short bullet that ends on a punchline. event: a workshop or event. reminder: a recording, deadline or nudge. Leave unset unless the user says.",
      ),
  })
  .refine((v) => v.url || v.note, { message: "Give a url, a note, or both" });

const STATUSES = ["inbox", "used"] as const;

const itemOutput = z.object({
  id: z.string(),
  url: z.string().nullable(),
  note: z.string().nullable(),
  kind: z.enum(KINDS).nullable(),
  status: z.enum(STATUSES),
  // Set by mark_used: the edition's slug (its date) and when.
  usedIn: z.string().nullable(),
  usedAt: z.string().nullable(),
  addedVia: z.literal("claude"),
  addedBy: z.string().nullable(),
  addedAt: z.string(),
  // Fetched from the url when the item is added; null when there's no url or
  // the page couldn't be read.
  title: z.string().nullable(),
  source: z.string().nullable(),
  publishedAt: z.string().nullable(),
});

type Item = z.infer<typeof itemOutput>;

// What's stored: the item plus urlKey, the normalized link used to spot
// duplicates. urlKey stays out of tool output.
type StoredItem = Item & { urlKey: string | null };

const addItemOutput = itemOutput.extend({
  duplicate: z
    .boolean()
    .describe("True when the link was already in the inbox; the existing item is returned"),
});

// Strips what makes one link look like two: #fragments and tracking params.
// This is what gets stored and, later, what readers click.
function cleanUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (/^utm_|^(fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) u.searchParams.delete(key);
  }
  return u.href;
}

// Match key on top of cleanUrl: also ignores www., a trailing slash and
// http vs https, which change the text of a link but not where it goes.
function urlKey(cleaned: string): string {
  const u = new URL(cleaned);
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
  return `${u.hostname.replace(/^www\./, "")}${path}${u.search}`;
}

// Output shape for a stored item. Items saved before page fetching or dedupe
// existed lack some fields.
function toItem(data: StoredItem): Item {
  const { urlKey: _, ...item } = data;
  return {
    ...item,
    title: item.title ?? null,
    source: item.source ?? null,
    publishedAt: item.publishedAt ?? null,
    usedIn: item.usedIn ?? null,
    usedAt: item.usedAt ?? null,
  };
}

const SLUG = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "An edition's slug is its date, YYYY-MM-DD");

const markUsedInput = z.object({
  ids: z.array(z.string()).min(1).max(50).describe("ids of inbox items from list_items"),
  edition: SLUG.describe("The edition they went into: its slug, the date (YYYY-MM-DD)"),
});

const markUsedOutput = z.object({
  marked: z.array(z.string()).describe("ids now marked used"),
  notFound: z.array(z.string()).describe("ids that don't exist or weren't in the inbox"),
});

const listUsedInput = z.object({ edition: SLUG });

const nextEditionInput = z.object({
  date: SLUG.optional().describe(
    "A specific edition date, when the user names one. Leave unset for the next edition day with no edition yet.",
  ),
});

const nextEditionOutput = z.object({
  slug: z.string().describe("Use as the slug in content_create"),
  exists: z.boolean().describe("True if an edition with this slug already exists (draft or published): don't create another"),
  status: z.string().nullable().describe("The existing edition's status, if any"),
  data: z
    .object({ title: z.string(), edition_date: z.string(), body: z.string() })
    .describe("Starter field values for content_create in the editions collection; replace body with the draft"),
  studioUrl: z.string().describe("Where the team edits it: hand this link over"),
  editionDay: z.string().nullable().describe("The day editions go out, or null with no fixed day"),
  voice: z.string().describe("How the newsletter sounds, in the editors' words: write the draft in this voice"),
});

const listItemsInput = z.object({
  limit: z.number().int().min(1).max(100).optional().describe("Max items to return (default 50)"),
  cursor: z
    .string()
    .optional()
    .describe("Pass nextCursor from a previous call to get the next page"),
});

const listItemsOutput = z.object({
  items: z.array(itemOutput),
  nextCursor: z.string().nullable(),
});

// One newsletter per site: its settings and theme are stored under this key.
const NEWSLETTER = "default";

// Tools that take nothing.
const noInput = z.object({});

const themeUpdateInput = z.object({
  patch: themePatchSchema.describe(
    "Only the fields to change; colors and banner merge into the current ones. Colours are 6-digit hex (#3557a0).",
  ),
});

const themeCheckOutput = z.object({
  errors: z.array(z.string()).describe("Why the theme can't be saved"),
  warnings: z.array(z.string()).describe("Worth telling the user; saved anyway"),
});

const themeGetOutput = z.object({
  newsletter: z.string(),
  theme: themeSchema,
  check: themeCheckOutput,
  isDefault: z.boolean().describe("True if nobody has changed this newsletter's theme yet"),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const themeUpdateOutput = z.object({
  saved: z.boolean().describe("False when the result had errors; nothing was changed then"),
  theme: themeSchema.describe("The theme now saved, or the one that was refused"),
  check: themeCheckOutput,
});

type StoredTheme = { theme: Theme; updatedBy: string | null; updatedAt: string };

const settingsGetOutput = z.object({
  settings: settingsSchema,
  isDefault: z.boolean().describe("True until first-run setup has saved settings: send the user to /newsletter/setup"),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const settingsUpdateInput = z.object({
  patch: settingsPatchSchema.describe("Only the fields to change; sender merges into the current one."),
});

const settingsUpdateOutput = z.object({
  saved: z.boolean().describe("False when the result had errors; nothing was changed then"),
  settings: settingsSchema,
  errors: z.array(z.string()),
});

type StoredSettings = { settings: Settings; updatedBy: string | null; updatedAt: string };

// What a plugin's storage collection offers, as far as settings and themes need.
interface KeyValue {
  get(id: string): Promise<unknown>;
  put(id: string, data: unknown): Promise<void>;
}

/** The newsletter's settings, fields added since they were saved filled from the defaults. */
async function readSettings(store: KeyValue): Promise<{ settings: Settings; stored: StoredSettings | null }> {
  const stored = (await store.get(NEWSLETTER)) as StoredSettings | null;
  return { settings: stored ? applySettingsPatch(DEFAULT_SETTINGS, stored.settings) : DEFAULT_SETTINGS, stored };
}

// list_items cursor: where the last page stopped, opaque to Claude.
const cursorShape = z.object({ addedAt: z.string(), seen: z.array(z.string()) });
type Cursor = z.infer<typeof cursorShape>;

function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor));
}

function decodeCursor(raw: string): Cursor {
  try {
    return cursorShape.parse(JSON.parse(atob(raw)));
  } catch {
    throw PluginRouteError.badRequest("Invalid cursor; call list_items without one to start over");
  }
}

export function createPlugin() {
  return definePlugin({
    id: "newsletter",
    version: "0.1.0",

    // add_item fetches the page behind any link it's given, so it can't list
    // hosts up front. EmDash still blocks private and internal addresses on
    // every request and redirect.
    capabilities: ["network:request:unrestricted", "content:read"],

    storage: {
      items: { indexes: ["status", "addedAt", "urlKey", "usedIn"] },
      // Keyed by newsletter ("default"): a StoredTheme, a StoredSettings.
      themes: { indexes: [] },
      settings: { indexes: [] },
    },

    routes: {
      // Private routes: MCP tools must point at a route that is not public and
      // declares a permission, or EmDash silently drops the tool.
      "add-item": {
        permission: "content:create",
        input: addItemInput,
        handler: async (ctx) => {
          // EmDash has already validated ctx.input against addItemInput; its
          // route types just don't carry the shape through `routes`.
          const input = ctx.input as z.infer<typeof addItemInput>;
          const url = input.url ? cleanUrl(input.url) : null;
          const key = url ? urlKey(url) : null;

          // Same link already in the inbox: return that item instead of a
          // second copy. A new note is appended and a kind fills in a missing
          // one, so nothing said the second time is lost.
          if (key) {
            const existing = await ctx.storage.items.query({
              where: { status: "inbox", urlKey: key },
              limit: 1,
            });
            const match = existing.items[0];
            if (match) {
              const stored = match.data as StoredItem;
              const isNewNote = input.note && !stored.note?.includes(input.note);
              const updated: StoredItem = {
                ...stored,
                note: isNewNote ? [stored.note, input.note].filter(Boolean).join("\n\n") : stored.note,
                kind: stored.kind ?? input.kind ?? null,
              };
              if (updated.note !== stored.note || updated.kind !== stored.kind) {
                await ctx.storage.items.put(match.id, updated);
              }
              ctx.log.info("newsletter item already in inbox", { id: match.id, url });
              return { ...toItem(updated), duplicate: true };
            }
          }

          const page = url
            ? await fetchPageMeta(ctx.http, url)
            : { title: null, source: null, publishedAt: null };
          const item: StoredItem = {
            id: crypto.randomUUID(),
            url,
            urlKey: key,
            note: input.note ?? null,
            kind: input.kind ?? null,
            status: "inbox",
            usedIn: null,
            usedAt: null,
            addedVia: "claude",
            addedBy: ctx.user?.email ?? null,
            addedAt: new Date().toISOString(),
            ...page,
          };
          await ctx.storage.items.put(item.id, item);
          ctx.log.info("newsletter item added", { id: item.id, url: item.url });
          return { ...toItem(item), duplicate: false };
        },
      },

      // The studio's Inbox tab, read-only. Not a Claude tool, so it doesn't
      // affect EmDash's Agent access approval.
      "list-used": {
        permission: "content:read_drafts",
        input: listUsedInput,
        handler: async (ctx) => {
          const input = ctx.input as z.infer<typeof listUsedInput>;
          const page = await ctx.storage.items.query({
            where: { status: "used", usedIn: input.edition },
            orderBy: { addedAt: "desc" },
            limit: 100,
          });
          return { items: page.items.map((row) => toItem(row.data as StoredItem)) };
        },
      },

      "mark-used": {
        permission: "content:create",
        input: markUsedInput,
        handler: async (ctx) => {
          const input = ctx.input as z.infer<typeof markUsedInput>;
          const marked: string[] = [];
          const notFound: string[] = [];
          const usedAt = new Date().toISOString();
          for (const id of new Set(input.ids)) {
            const stored = (await ctx.storage.items.get(id)) as StoredItem | null;
            if (!stored || stored.status !== "inbox") {
              notFound.push(id);
              continue;
            }
            await ctx.storage.items.put(id, { ...stored, status: "used", usedIn: input.edition, usedAt });
            marked.push(id);
          }
          ctx.log.info("newsletter items marked used", { edition: input.edition, marked: marked.length });
          return { marked, notFound };
        },
      },

      "next-edition": {
        permission: "content:read_drafts",
        input: nextEditionInput,
        handler: async (ctx) => {
          const input = ctx.input as z.infer<typeof nextEditionInput>;
          const content = ctx.content;
          if (!content) throw PluginRouteError.internal("Content access isn't available to this plugin");

          // Every edition's slug and status, drafts included.
          const editions = new Map<string, string>();
          let cursor: string | undefined;
          do {
            const page = await content.list("editions", { limit: 100, cursor });
            for (const item of page.items) if (item.slug) editions.set(item.slug, item.status);
            cursor = page.hasMore ? page.cursor : undefined;
          } while (cursor);

          const { settings } = await readSettings(ctx.storage.settings);
          const next = input.date
            ? { slug: input.date, date: new Date(`${input.date}T12:00:00.000Z`) }
            : nextOpenEditionDate(settings, new Set(editions.keys()));
          const studio = new URL(`/newsletter/edit/${next.slug}`, ctx.site.url).href;
          return {
            slug: next.slug,
            exists: editions.has(next.slug),
            status: editions.get(next.slug) ?? null,
            data: {
              title: editionTitle(settings, next.date),
              edition_date: next.date.toISOString(),
              body: starterBody(settings, next.date),
            },
            studioUrl: studio,
            editionDay: weekdayName(settings.weekday),
            voice: settings.voice,
          };
        },
      },

      // The newsletter's settings, for the studio, setup and Claude.
      "settings-get": {
        permission: "content:read_drafts",
        input: noInput,
        handler: async (ctx) => {
          const { settings, stored } = await readSettings(ctx.storage.settings);
          return {
            settings,
            isDefault: !stored,
            updatedBy: stored?.updatedBy ?? null,
            updatedAt: stored?.updatedAt ?? null,
          };
        },
      },

      // Changes to the settings, merged into the current ones and checked
      // first: settings with errors (checkSettings) aren't saved.
      "settings-update": {
        permission: "content:edit_any",
        input: settingsUpdateInput,
        handler: async (ctx) => {
          const input = ctx.input as z.infer<typeof settingsUpdateInput>;
          const { settings: current } = await readSettings(ctx.storage.settings);
          const settings = settingsSchema.parse(applySettingsPatch(current, input.patch));
          const errors = checkSettings(settings);
          if (errors.length) return { saved: false, settings, errors };
          await ctx.storage.settings.put(NEWSLETTER, {
            settings,
            updatedBy: ctx.user?.email ?? null,
            updatedAt: new Date().toISOString(),
          } satisfies StoredSettings);
          ctx.log.info("newsletter settings updated", { by: ctx.user?.email });
          return { saved: true, settings, errors };
        },
      },

      // The newsletter's theme, for the studio's renders and its Theme page,
      // and for Claude. A newsletter nobody has themed gets DEFAULT_THEME.
      "theme-get": {
        permission: "content:read_drafts",
        input: noInput,
        handler: async (ctx) => {
          const stored = (await ctx.storage.themes.get(NEWSLETTER)) as StoredTheme | null;
          // Fields added to themes later are filled from the default.
          const theme = stored ? applyPatch(DEFAULT_THEME, stored.theme) : DEFAULT_THEME;
          const media = publicMediaUrl();
          return {
            newsletter: NEWSLETTER,
            theme,
            check: checkTheme(theme, media),
            // Where sent emails load their images from: the images bucket's
            // public address, or null for this site.
            media,
            isDefault: !stored,
            updatedBy: stored?.updatedBy ?? null,
            updatedAt: stored?.updatedAt ?? null,
          };
        },
      },

      // Changes to a theme, merged into the current one and checked first:
      // a theme that would be hard to read (checkTheme's errors) isn't saved.
      "theme-update": {
        permission: "content:edit_any",
        input: themeUpdateInput,
        handler: async (ctx) => {
          const input = ctx.input as z.infer<typeof themeUpdateInput>;
          const stored = (await ctx.storage.themes.get(NEWSLETTER)) as StoredTheme | null;
          const current = stored ? applyPatch(DEFAULT_THEME, stored.theme) : DEFAULT_THEME;
          const theme = themeSchema.parse(applyPatch(current, input.patch));
          const check = checkTheme(theme, publicMediaUrl());
          if (check.errors.length) return { saved: false, theme, check };
          await ctx.storage.themes.put(NEWSLETTER, {
            theme,
            updatedBy: ctx.user?.email ?? null,
            updatedAt: new Date().toISOString(),
          } satisfies StoredTheme);
          ctx.log.info("newsletter theme updated", { by: ctx.user?.email });
          return { saved: true, theme, check };
        },
      },

      "list-items": {
        permission: "content:read_drafts",
        input: listItemsInput,
        handler: async (ctx) => {
          // Newest first, paged with our own cursor. EmDash 0.35's storage
          // cursor always pages by (created_at, id) ascending whatever
          // orderBy says, so its later pages are wrong for any other order.
          // Instead each page asks for items added at or before the last one
          // returned, and skips the ids already returned at that instant so
          // items sharing a timestamp are neither repeated nor lost.
          const input = ctx.input as z.infer<typeof listItemsInput>;
          const limit = input.limit ?? 50;
          const after = input.cursor ? decodeCursor(input.cursor) : null;
          const page = await ctx.storage.items.query({
            where: {
              status: "inbox",
              ...(after && { addedAt: { lte: after.addedAt } }),
            },
            orderBy: { addedAt: "desc" },
            limit: Math.min(limit + (after?.seen.length ?? 0) + 1, 100),
          });
          const rows = page.items
            .map((row) => toItem(row.data as StoredItem))
            .filter((item) => !after?.seen.includes(item.id));
          const items = rows.slice(0, limit);
          const last = items.at(-1);
          const hasMore = rows.length > limit;
          return {
            items,
            nextCursor:
              hasMore && last
                ? encodeCursor({
                    addedAt: last.addedAt,
                    seen: [
                      ...items.filter((i) => i.addedAt === last.addedAt).map((i) => i.id),
                      ...(after?.addedAt === last.addedAt ? after.seen : []),
                    ],
                  })
                : null,
          };
        },
      },
    },

    mcp: {
      tools: {
        // Exposed to Claude as `newsletter__add_item` and
        // `newsletter__list_items`. Changing these definitions revokes the
        // admin's MCP consent until it is re-approved.
        add_item: {
          description:
            "Add something to the next edition of the newsletter: a link, a note, or both. Use when the user says to add or save something for the newsletter. Fetches the link's title, source and date. If the link is already in the inbox, returns that item with duplicate: true and adds any new note to it. This only files the item; it doesn't research or draft.",
          route: "add-item",
          input: addItemInput,
          output: addItemOutput,
        },
        list_items: {
          description:
            "List items waiting in the newsletter inbox, newest first. Items already used in an edition (mark_used) aren't listed.",
          route: "list-items",
          input: listItemsInput,
          output: listItemsOutput,
        },
        mark_used: {
          description:
            "Take inbox items out of the newsletter inbox because they went into an edition. Pass their ids and the edition's slug (its date). Call it after creating the draft, for the items the draft actually uses; items left out stay for next time. They're kept, with the edition they went into.",
          route: "mark-used",
          input: markUsedInput,
          output: markUsedOutput,
        },
        next_edition: {
          description:
            "Before starting an edition: the next edition day with no edition yet (or the date given), its slug, subject line, edition_date and starter body, whether it already exists, its studio link, and the newsletter's voice to write in. Doesn't create anything: create the draft with content_create in the editions collection, using this slug and these fields, unless exists is true.",
          route: "next-edition",
          input: nextEditionInput,
          output: nextEditionOutput,
        },
        settings_get: {
          description:
            "The newsletter's settings: name, subject format, schedule (weekday, time zone), starter body, signature, sender and voice notes. isDefault true means setup hasn't run yet: send the user to /newsletter/setup.",
          route: "settings-get",
          input: noInput,
          output: settingsGetOutput,
        },
        settings_update: {
          description:
            "Change the newsletter's settings when the user asks: its name, subject format ({name} and {date} placeholders; {date} required), weekday (0 Sunday to 6 Saturday, or null), time zone, starter body ({day} placeholder), signature (markdown; images only from this site), sender, or voice notes. Pass only what changes. If there are errors nothing is saved: tell the user.",
          route: "settings-update",
          input: settingsUpdateInput,
          output: settingsUpdateOutput,
        },
        theme_get: {
          description:
            "The newsletter's theme: its name, logo, wordmark, tagline, footer, colours, font and glow banner, with any readability problems. Read it before changing the theme.",
          route: "theme-get",
          input: noInput,
          output: themeGetOutput,
        },
        theme_update: {
          description:
            "Change the newsletter's theme when the user asks for new branding. Pass only what changes. Email limits apply: the page must be light, text (ink) near-black so phone dark modes turn it white, and the accents deep enough to read as link text; the glow banner and rules are drawn as images from accent and accent2, so gradients aren't set directly. A logo must be on this site: media_upload it and use the path it returns (/_emdash/api/media/file/...), ideally a transparent PNG; links to other sites are refused. If the result would be hard to read, nothing is saved and saved is false: tell the user the errors and suggest a fix. Tell them any warnings too.",
          route: "theme-update",
          input: themeUpdateInput,
          output: themeUpdateOutput,
        },
      },
    },
  });
}
