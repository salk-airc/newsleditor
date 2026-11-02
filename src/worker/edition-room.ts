import { DurableObject } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

// On Cloudflare (NEWSLEDITOR_TARGET=cloudflare): one Durable Object per
// edition being edited at /newsletter/edit/<slug>. It holds the live Yjs
// document and relays edits and cursors between the editors' browsers over
// WebSockets. src/rooms/edition-room.ts is the same room for Node (npm start):
// keep the two alike.
//
// The document has two texts, "body" and "slack", and a "meta" map the
// editors use to coordinate saving: the EmDash revision the text was last
// saved as ("rev") and that text ("base"), whether it has edits not yet saved
// ("unsaved", "savedAt") and whether EmDash has moved on since ("behind"),
// which the saver resolves by merging. EmDash stays the store of
// record: the editors' browsers save the text there (one of them at a time;
// see src/scripts/edition-editor.ts), and this object only keeps the live
// copy, in its own storage so it survives hibernation and restarts.
//
// The wire format is y-websocket's (y-protocols sync and awareness messages),
// so the browser uses y-websocket's provider as it is. Requests reach this
// object only through src/pages/newsletter/edit/[slug]/sync.ts, which checks
// the editor's EmDash login first.

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

const PERSIST_AFTER_MS = 1000;
const MAX_SEED_BYTES = 512 * 1024;

/** The edition as EmDash has it, sent when an editor opens the page. */
export interface Seed {
  body: string;
  slack: string;
  rev: string | null;
}

interface Attachment {
  /** Awareness client ids this socket has announced, removed when it closes. */
  clients: number[];
  /** Their latest presence, as an awareness update, restored after hibernation. */
  presence?: Uint8Array;
}

// Attachments are capped at 2 KB. A presence (name, colour, cursor) is a few
// hundred bytes; one that somehow isn't just isn't restored.
const MAX_PRESENCE_BYTES = 1500;

export class EditionRoom extends DurableObject {
  private doc = new Y.Doc();
  private awareness = new awarenessProtocol.Awareness(this.doc);
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // The server is not an editor: no presence of its own. Awareness also
    // runs a timer every 3s to expire presence, which would keep this object
    // from ever hibernating; prune() does the same work when something
    // happens instead.
    this.awareness.setLocalState(null);
    clearInterval(this.awareness._checkInterval);

    ctx.blockConcurrencyWhile(async () => {
      const state = await ctx.storage.get<Uint8Array>("doc");
      if (state) Y.applyUpdate(this.doc, state);
    });

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder), origin);
      this.schedulePersist();
    });

    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        // Remember which awareness clients came in on which socket, and their
        // latest presence, so they can be dropped when it closes and restored
        // after hibernation.
        if (origin instanceof WebSocket) {
          const att = (origin.deserializeAttachment() as Attachment | null) ?? { clients: [] };
          const clients = new Set(att.clients);
          added.forEach((id) => clients.add(id));
          removed.forEach((id) => clients.delete(id));
          const ids = [...clients];
          const presence = ids.length ? awarenessProtocol.encodeAwarenessUpdate(this.awareness, ids) : undefined;
          origin.serializeAttachment({
            clients: ids,
            ...(presence && presence.byteLength <= MAX_PRESENCE_BYTES && { presence }),
          } satisfies Attachment);
        }
        const changed = [...added, ...updated, ...removed];
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        this.broadcast(encoding.toUint8Array(encoder));
      },
    );

    // Presence lives in memory, so after hibernation the room would think
    // nobody is here until each browser renews (every 15s): newcomers would
    // see no one, and seed() could take EmDash's text over theirs. Put back
    // each connected socket's last presence. A socket that is really gone
    // never renews it, so prune() still drops it 30s from now.
    for (const ws of ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.presence) awarenessProtocol.applyAwarenessUpdate(this.awareness, att.presence, ws);
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.prune();
    if (request.headers.get("Upgrade") === "websocket") return this.join();
    if (request.method === "POST") return this.seed(request);
    return new Response("Not found", { status: 404 });
  }

  // ------------------------------------------------------------ sockets --

  // Not connect(): that's DurableObject's own method, for TCP sockets.
  private join(): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ clients: [] } satisfies Attachment);

    // Start the sync (the browser answers with what we're missing) and say
    // who else is here.
    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(sync, this.doc);
    server.send(encoding.toUint8Array(sync));

    const present = [...this.awareness.getStates().keys()];
    if (present.length) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, present));
      server.send(encoding.toUint8Array(encoder));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    this.prune();
    if (typeof message === "string") return;
    try {
      const decoder = decoding.createDecoder(new Uint8Array(message));
      const encoder = encoding.createEncoder();
      switch (decoding.readVarUint(decoder)) {
        case MESSAGE_SYNC:
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
          // Only a sync step 1 needs an answer; anything else leaves just the
          // message type in the encoder.
          if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
          break;
        case MESSAGE_AWARENESS:
          awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws);
          break;
        case MESSAGE_QUERY_AWARENESS: {
          encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
          const all = [...this.awareness.getStates().keys()];
          encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, all));
          ws.send(encoding.toUint8Array(encoder));
          break;
        }
      }
    } catch (err) {
      console.error("edition room: bad message", err);
      ws.close(1003, "Bad message");
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.drop(ws);
    // Finish the closing handshake. Until this end closes too, the socket
    // still reads as open and would count as someone editing.
    try {
      ws.close(code === 1005 ? 1000 : code, "Bye");
    } catch {
      // Already closed.
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.drop(ws);
  }

  private drop(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.clients.length) awarenessProtocol.removeAwarenessStates(this.awareness, att.clients, null);
    if (this.editing() === 0) this.persist();
  }

  // How many editors are here, by presence rather than by open sockets: a
  // browser that goes away without a clean close (sleep, lost network, some
  // proxies) leaves its socket listed, but its presence stops being renewed
  // and prune() drops it after 30s.
  private editing(): number {
    return this.awareness.getStates().size;
  }

  // Drop presence not renewed within y-protocols' timeout (editors renew
  // every 15s), as Awareness's own timer would.
  private prune() {
    const now = Date.now();
    const stale: number[] = [];
    this.awareness.meta.forEach((meta, id) => {
      if (this.awareness.states.has(id) && now - meta.lastUpdated >= awarenessProtocol.outdatedTimeout) stale.push(id);
    });
    if (stale.length) awarenessProtocol.removeAwarenessStates(this.awareness, stale, "timeout");
  }

  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private broadcast(message: Uint8Array, except?: unknown) {
    for (const ws of this.sockets()) {
      if (ws === except) continue;
      try {
        ws.send(message);
      } catch {
        // Closing; webSocketClose cleans up.
      }
    }
  }

  // --------------------------------------------------------------- seed --

  // The first editor to open the page fills the live document from EmDash.
  // After that the live document wins, unless EmDash has a newer revision
  // than the one the live text was saved as, i.e. someone changed the edition
  // outside the studio (the admin, Claude) meanwhile:
  //
  // - nobody is in the room and nothing is unsaved: take EmDash's text, since
  //   nothing can be lost;
  // - otherwise mark the document "behind", and the saver's browser merges
  //   EmDash's change into the live text (see mergeFromEmDash in
  //   src/scripts/edition-editor.ts), so nobody's typing is lost and nobody
  //   has to choose.
  //
  // "Newer" goes by the version number in EmDash's revision token, so an
  // editor who read EmDash just before the saver's latest save (an older
  // version) doesn't roll the room back. A token without one falls back to
  // "different, and nobody is editing", since with people in the room a
  // different revision may just be a save racing this request.
  private async seed(request: Request): Promise<Response> {
    const raw = await request.text();
    if (raw.length > MAX_SEED_BYTES) return new Response("Too large", { status: 413 });
    let seed: Seed;
    try {
      seed = JSON.parse(raw);
      if (typeof seed.body !== "string" || typeof seed.slack !== "string") throw new Error();
    } catch {
      return new Response("Expected { body, slack, rev }", { status: 400 });
    }

    const meta = this.doc.getMap("meta");
    const ours = meta.get("rev");
    const theirs = revVersion(seed.rev);
    const mine = revVersion(typeof ours === "string" ? ours : null);
    const changedElsewhere =
      meta.has("rev") &&
      (theirs !== null && mine !== null ? theirs > mine : ours !== seed.rev && this.editing() === 0);
    const quiet = this.editing() === 0 && meta.get("unsaved") !== true && meta.get("behind") !== true;
    const replace = !meta.has("rev") || (changedElsewhere && quiet);
    if (replace) {
      this.doc.transact(() => {
        for (const key of ["body", "slack"] as const) {
          const text = this.doc.getText(key);
          text.delete(0, text.length);
          text.insert(0, seed[key]);
        }
        meta.set("rev", seed.rev);
        meta.set("base", { body: seed.body, slack: seed.slack });
        meta.set("unsaved", false);
        meta.set("behind", false);
        meta.delete("conflict"); // from before merging
      }, "seed");
      this.persist();
    } else if (changedElsewhere && meta.get("behind") !== true) {
      this.doc.transact(() => meta.set("behind", true), "seed");
      this.persist();
    }
    return Response.json({ replaced: replace, editing: this.editing() });
  }

  // ------------------------------------------------------------ storage --

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), PERSIST_AFTER_MS);
  }

  private persist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.ctx.storage.put("doc", Y.encodeStateAsUpdate(this.doc));
  }
}

/** The version in an EmDash revision token (base64 of "<version>:<updatedAt>"), or null. */
function revVersion(rev: string | null): number | null {
  if (!rev) return null;
  try {
    const version = Number(atob(rev).split(":")[0]);
    return Number.isInteger(version) ? version : null;
  } catch {
    return null;
  }
}
