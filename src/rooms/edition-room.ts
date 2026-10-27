import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

// One room per edition being edited at /newsletter/edit/<slug>: it holds the
// live Yjs document and relays edits and cursors between the editors'
// browsers over WebSockets.
//
// The document has two texts, "body" and "slack", and a "meta" map the
// editors use to coordinate saving: the EmDash revision the text was last
// saved as ("rev") and that text ("base"), whether it has edits not yet saved
// ("unsaved", "savedAt") and whether EmDash has moved on since ("behind"),
// which the saver resolves by merging. EmDash stays the store of record: the
// editors' browsers save the text there (one of them at a time; see
// src/scripts/edition-editor.ts), and the room only keeps the live copy, in a
// file in the rooms folder so it survives restarts.
//
// The wire format is y-websocket's (y-protocols sync and awareness messages),
// so the browser uses y-websocket's provider as it is. Requests reach a room
// only through src/rooms/server.ts, which checks the editor's EmDash login
// first.

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

const PERSIST_AFTER_MS = 1000;
export const MAX_SEED_BYTES = 512 * 1024;

/** The edition as EmDash has it, sent when an editor opens the page. */
export interface Seed {
  body: string;
  slack: string;
  rev: string | null;
}

export class EditionRoom {
  private doc = new Y.Doc();
  private awareness = new awarenessProtocol.Awareness(this.doc);
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Each socket and the awareness client ids it has announced, dropped when it closes. */
  private sockets = new Map<WebSocket, Set<number>>();
  private file: string;

  constructor(slug: string, dir: string) {
    this.file = join(dir, `${slug}.ydoc`);
    // The server is not an editor: no presence of its own. Awareness's own
    // timer drops presence not renewed within 30s (editors renew every 15s).
    this.awareness.setLocalState(null);

    try {
      Y.applyUpdate(this.doc, readFileSync(this.file));
    } catch {
      // No saved copy yet.
    }

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
        // Remember which awareness clients came in on which socket, so they
        // can be dropped when it closes.
        const clients = origin instanceof WebSocket ? this.sockets.get(origin) : undefined;
        if (clients) {
          added.forEach((id) => clients.add(id));
          removed.forEach((id) => clients.delete(id));
        }
        const changed = [...added, ...updated, ...removed];
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        this.broadcast(encoding.toUint8Array(encoder));
      },
    );
  }

  /** Nobody connected: the room can be closed. */
  get empty(): boolean {
    return this.sockets.size === 0;
  }

  // ------------------------------------------------------------ sockets --

  join(ws: WebSocket): void {
    this.sockets.set(ws, new Set());
    ws.binaryType = "arraybuffer";
    ws.on("message", (data, isBinary) => {
      if (isBinary) this.message(ws, new Uint8Array(data as ArrayBuffer));
    });
    ws.on("close", () => this.drop(ws));
    ws.on("error", () => this.drop(ws));

    // Start the sync (the browser answers with what we're missing) and say
    // who else is here.
    const sync = encoding.createEncoder();
    encoding.writeVarUint(sync, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(sync, this.doc);
    ws.send(encoding.toUint8Array(sync));

    const present = [...this.awareness.getStates().keys()];
    if (present.length) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, present));
      ws.send(encoding.toUint8Array(encoder));
    }
  }

  private message(ws: WebSocket, message: Uint8Array) {
    try {
      const decoder = decoding.createDecoder(message);
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

  private drop(ws: WebSocket) {
    const clients = this.sockets.get(ws);
    if (!clients) return;
    this.sockets.delete(ws);
    if (clients.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...clients], null);
    if (this.editing() === 0) this.persist();
  }

  // How many editors are here, by presence rather than by open sockets: a
  // browser that goes away without a clean close (sleep, lost network, some
  // proxies) leaves its socket open, but its presence stops being renewed
  // and Awareness drops it after 30s.
  private editing(): number {
    return this.awareness.getStates().size;
  }

  private broadcast(message: Uint8Array, except?: unknown) {
    for (const ws of this.sockets.keys()) {
      if (ws === except || ws.readyState !== WebSocket.OPEN) continue;
      ws.send(message);
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
  seed(raw: string): { status: number; body: unknown } {
    if (raw.length > MAX_SEED_BYTES) return { status: 413, body: "Too large" };
    let seed: Seed;
    try {
      seed = JSON.parse(raw);
      if (typeof seed.body !== "string" || typeof seed.slack !== "string") throw new Error();
    } catch {
      return { status: 400, body: "Expected { body, slack, rev }" };
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
    return { status: 200, body: { replaced: replace, editing: this.editing() } };
  }

  // ------------------------------------------------------------ storage --

  private schedulePersist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), PERSIST_AFTER_MS);
  }

  /** Writes the live copy to its file, through a temporary one so a crash never leaves half a file. */
  persist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, Y.encodeStateAsUpdate(this.doc));
    renameSync(tmp, this.file);
  }

  close() {
    this.persist();
    this.awareness.destroy();
    this.doc.destroy();
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
