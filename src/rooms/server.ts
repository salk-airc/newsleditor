import { mkdirSync } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { EditionRoom, MAX_SEED_BYTES } from "./edition-room.ts";

// The way into an edition's live document (edition-room.ts), wired onto the
// Node HTTP server by server.mjs (npm start) and by the dev server's Vite
// plugin in astro.config.mjs (npm run dev):
//
//   GET  /newsletter/edit/<slug>/sync with Upgrade: websocket   join the edit session
//   POST /newsletter/edit/<slug>/sync { body, slack, rev }       fill it from EmDash if it needs to be
//
// Same gate as the editor page. Rooms live in this process, outside Astro, so
// the login is checked by asking the site itself: the request's cookies are
// passed to GET /newsletter/edit/<slug>/sync, which answers 204 only for
// someone who may edit (src/pages/newsletter/edit/[slug]/sync.ts).

const SYNC = /^\/newsletter\/edit\/([a-z0-9-]{1,100})\/sync$/;
/** How long an empty room stays in memory, in case someone reloads. */
const CLOSE_AFTER_MS = 60_000;

export interface RoomsOptions {
  /** Folder for the live copies (one .ydoc file per edition). */
  dir: string;
  /** Where this server answers, for the login check: http://127.0.0.1:4321. */
  self: () => string;
}

export interface Rooms {
  /** Handles a WebSocket upgrade to a sync path. False: not ours, leave it to others. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  /** Handles a seed POST to a sync path. False: not ours. */
  request(req: IncomingMessage, res: ServerResponse): boolean;
  /** Saves every open room. */
  close(): void;
}

export function createRooms({ dir, self }: RoomsOptions): Rooms {
  mkdirSync(dir, { recursive: true });
  const rooms = new Map<string, { room: EditionRoom; closing?: ReturnType<typeof setTimeout> }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  function room(slug: string): EditionRoom {
    let entry = rooms.get(slug);
    if (!entry) {
      entry = { room: new EditionRoom(slug, dir) };
      rooms.set(slug, entry);
    }
    if (entry.closing) clearTimeout(entry.closing);
    entry.closing = undefined;
    return entry.room;
  }

  function closeLater(slug: string) {
    const entry = rooms.get(slug);
    if (!entry || !entry.room.empty) return;
    if (entry.closing) clearTimeout(entry.closing);
    entry.closing = setTimeout(() => {
      if (!entry.room.empty) return;
      entry.room.close();
      rooms.delete(slug);
    }, CLOSE_AFTER_MS);
  }

  // Browsers send the session cookie on a WebSocket upgrade from any site,
  // and nothing like CORS stops it, so check the page that opened it is ours.
  function sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    if (!origin || !host) return false;
    try {
      return new URL(origin).host === String(host).split(",")[0]!.trim();
    } catch {
      return false;
    }
  }

  async function allowed(req: IncomingMessage, slug: string): Promise<number> {
    if (!sameOrigin(req)) return 403;
    try {
      const res = await fetch(`${self()}/newsletter/edit/${slug}/sync`, {
        headers: { cookie: req.headers.cookie ?? "" },
        redirect: "manual",
      });
      return res.status === 204 ? 200 : res.status === 401 ? 401 : 403;
    } catch (err) {
      console.error("edition rooms: login check failed", err);
      return 503;
    }
  }

  return {
    upgrade(req, socket, head) {
      const slug = SYNC.exec(new URL(req.url ?? "/", "http://x").pathname)?.[1];
      if (!slug) return false;
      allowed(req, slug).then((status) => {
        if (status !== 200) {
          socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Forbidden"}\r\nConnection: close\r\n\r\n`);
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          room(slug).join(ws);
          ws.on("close", () => closeLater(slug));
        });
      });
      return true;
    },

    request(req, res) {
      if (req.method !== "POST") return false;
      const slug = SYNC.exec(new URL(req.url ?? "/", "http://x").pathname)?.[1];
      if (!slug) return false;
      const send = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("cache-control", "private, no-store");
        if (typeof body === "string") res.end(body);
        else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(body));
        }
      };
      allowed(req, slug).then(async (status) => {
        if (status !== 200) return send(status, status === 401 ? "Sign in first" : "Not allowed");
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > MAX_SEED_BYTES) return send(413, "Too large");
        }
        const r = room(slug);
        const result = r.seed(raw);
        closeLater(slug);
        send(result.status, result.body);
      });
      return true;
    },

    close() {
      for (const { room, closing } of rooms.values()) {
        if (closing) clearTimeout(closing);
        room.close();
      }
      rooms.clear();
    },
  };
}

/** Wires rooms onto a Node HTTP server's upgrade event; requests are wired by the caller. */
export function attachUpgrades(server: Server, rooms: Rooms) {
  server.on("upgrade", (req, socket, head) => {
    rooms.upgrade(req, socket, head);
  });
}

/** The data folder: DATA_DIR, or ./data. */
export function dataDir(): string {
  return process.env.DATA_DIR ?? join(process.cwd(), "data");
}
