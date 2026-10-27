import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { joinedToBullet, placeholders, wordCount } from "../plugins/newsletter/checks.ts";
import { type Frame, imageHints } from "../plugins/newsletter/email.ts";
import { frameColors, renderDesignedEmail } from "../plugins/newsletter/email-designed.ts";
import { formatDate } from "../plugins/newsletter/editions.ts";
import { DEFAULT_SETTINGS, type Settings } from "../plugins/newsletter/settings.ts";
import { DEFAULT_THEME, type Theme } from "../plugins/newsletter/theme.ts";
import { plugin, uploadImage as upload } from "./emdash-api.ts";
import { renderSlack } from "../plugins/newsletter/slack.ts";
import { renderWeb } from "../plugins/newsletter/web.ts";
import editionCss from "../styles/edition-body.css?inline";
import { merge, setText } from "./merge.ts";
import siteCss from "../styles/global.css?inline";

// Browser side of /newsletter/edit/<slug>. Everyone who opens the page edits
// one shared Yjs document, held by the edition's room on the server
// (src/rooms/edition-room.ts) and reached through ./sync, with live cursors
// and names. Its two texts are the edition's markdown fields, the email body
// and the Slack post; the preview re-renders from them on every change.
//
// On open, the page reads the edition from EmDash's content API and offers it
// to the room, which takes it only if it has nothing newer (see seed() there).
//
// Saving back to EmDash is done by one editor at a time, the "saver": whoever
// in the room has the lowest Yjs client id. Their browser saves the shared
// text with their own session, a moment after anyone stops typing, so
// EmDash's permissions and revisions apply as in the admin. Saves go to the
// edition's draft revision, so a published edition's archive page doesn't
// change until it's published again. What the saver needs to know is shared
// in the document's "meta" map: the EmDash revision the text was last saved
// as ("rev") and the text itself ("base"), whether anything is unsaved
// ("unsaved", "savedAt") and whether EmDash has moved on ("behind").
//
// EmDash moves on when the edition is changed outside the studio (the admin,
// Claude), or when two tabs briefly both save. The saver then merges: it
// fetches EmDash's version and applies what changed there since "base" on top
// of the live text (src/scripts/merge.ts), and saves the result. Nobody has
// to choose between versions.

type Doc = "body" | "slack";
/** The right pane: one of the three renders, or the newsletter inbox. */
type View = "email" | "slack" | "web" | "inbox";

/** What the Inbox tab shows of an item from the newsletter plugin. */
interface InboxItem {
  url: string | null;
  note: string | null;
  title: string | null;
  addedBy: string | null;
  addedAt: string;
}

interface EditionData {
  title?: string;
  body?: string;
  slack?: string;
}

interface Presence {
  name: string;
  color: string;
  colorLight: string;
}

const API = "/_emdash/api/content/editions";

// Cursor colours for the people in the room, picked by Yjs client id.
const COLORS = ["#2d46b9", "#007e3b", "#b3261e", "#8a5a00", "#6b3fa0", "#00708a"];

// Markdown colours from the site's tokens, so they read in light and dark.
const highlight = HighlightStyle.define([
  { tag: t.heading, color: "var(--blue)", fontWeight: "700" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--green-ink)" },
  { tag: [t.quote], color: "var(--ink-soft)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.meta, t.monospace, t.string], color: "var(--ink-soft)" },
]);
const SAVE_AFTER_MS = 1200;
const RENDER_AFTER_MS = 120;
const CONNECT_TIMEOUT_MS = 10_000;

export async function startEditor(root: HTMLElement): Promise<void> {
  const slug = root.dataset.slug!;
  const $ = <T extends Element>(sel: string) => root.querySelector<T>(sel)!;
  const status = $<HTMLElement>("[data-status]");
  const preview = $<HTMLIFrameElement>("[data-preview]");
  const copyButton = $<HTMLButtonElement>("[data-copy]");
  const checks = $<HTMLUListElement>("[data-checks]");
  const people = $<HTMLUListElement>("[data-people]");

  const setStatus = (text: string, state: "ok" | "busy" | "error" = "ok") => {
    status.textContent = text;
    status.dataset.state = state;
  };

  // ---------------------------------------------------------------- load --

  const loadFromEmDash = async () => {
    const res = await fetch(`${API}/${encodeURIComponent(slug)}`, { credentials: "same-origin" });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
    const data = json.data.item.data as EditionData;
    return { title: data.title, body: data.body ?? "", slack: data.slack ?? "", rev: (json.data._rev as string) ?? null };
  };

  const offerToRoom = async (edition: { body: string; slack: string; rev: string | null }) => {
    const res = await fetch(sync, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(edition),
    });
    if (!res.ok) throw new Error(`the live session refused it (HTTP ${res.status})`);
  };

  const sync = `/newsletter/edit/${encodeURIComponent(slug)}/sync`;
  let title = slug;
  try {
    const edition = await loadFromEmDash();
    title = edition.title ?? title;
    await offerToRoom(edition);
  } catch (err) {
    setStatus(`Couldn't open ${slug}: ${(err as Error).message}`, "error");
    return;
  }
  $<HTMLElement>("[data-title]").textContent = title;
  document.title = `Edit: ${title}`;

  // ---------------------------------------------------------------- room --

  const ydoc = new Y.Doc();
  const texts: Record<Doc, Y.Text> = { body: ydoc.getText("body"), slack: ydoc.getText("slack") };
  const meta = ydoc.getMap<unknown>("meta");
  const provider = new WebsocketProvider(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${sync.replace(/\/sync$/, "")}`, "sync", ydoc, {
    // Everything goes through the room. y-websocket would also sync tabs of
    // one browser directly (BroadcastChannel), and presence shared that way
    // never reaches the room, so it couldn't remove it when the tab closes.
    disableBc: true,
  });
  const awareness = provider.awareness;
  const color = COLORS[ydoc.clientID % COLORS.length];
  awareness.setLocalStateField("user", { name: root.dataset.user ?? "Editor", color, colorLight: `${color}33` } satisfies Presence);

  setStatus("Connecting…", "busy");
  const synced = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), CONNECT_TIMEOUT_MS);
    provider.on("sync", (isSynced: boolean) => {
      if (!isSynced) return;
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!synced) {
    provider.destroy();
    setStatus("Couldn't reach the live session. Reload to try again.", "error");
    return;
  }

  // -------------------------------------------------------------- editor --

  let doc: Doc = "body";
  let view: View = "email";

  // CodeMirror's basicSetup minus its own undo history: Yjs's undo manager
  // (yUndoManagerKeymap) undoes only your own edits, never a co-editor's.
  const base = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([...yUndoManagerKeymap, ...defaultKeymap, ...searchKeymap]),
    markdown(),
    syntaxHighlighting(highlight),
    placeholder("Nothing here yet. Write it in markdown."),
    EditorView.lineWrapping,
    EditorView.domEventHandlers({
      paste: (e, v) => insertImages(v, e.clipboardData?.files, v.state.selection.main.head, e),
      drop: (e, v) => insertImages(v, e.dataTransfer?.files, v.posAtCoords({ x: e.clientX, y: e.clientY }), e),
    }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged || u.selectionSet) showImageBar(u.view);
    }),
    EditorView.theme({
      "&": { backgroundColor: "transparent", color: "var(--ink)" },
      ".cm-gutters": { backgroundColor: "transparent", border: "0", color: "var(--ink-soft)" },
      ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "color-mix(in oklab, var(--haze) 45%, transparent)" },
      ".cm-cursor": { borderLeftColor: "var(--ink)" },
      ".cm-ySelectionInfo": { fontFamily: "var(--font-body)", fontSize: "11px", padding: "1px 4px", borderRadius: "3px", opacity: "1" },
    }),
  ];
  // A fresh editor state from the shared text each time a tab is shown: the
  // binding only follows co-editors' changes while its state is on screen, so
  // a state kept for the hidden tab would go stale. The undo history lives in
  // one UndoManager per text, so it survives switching.
  const undo: Record<Doc, Y.UndoManager> = { body: new Y.UndoManager(texts.body), slack: new Y.UndoManager(texts.slack) };
  const stateFor = (d: Doc) =>
    EditorState.create({
      doc: texts[d].toString(),
      extensions: [...base, yCollab(texts[d], awareness, { undoManager: undo[d] })],
    });
  const editor = new EditorView({ state: stateFor("body"), parent: $("[data-source]") });
  const text = (d: Doc) => texts[d].toString();

  // -------------------------------------------------------------- images --

  // Pasting or dropping an image uploads it to EmDash's media library, then
  // writes it into the text as ![](url) where it was pasted, as one edit, so
  // one undo takes it out again. Where it was pasted is kept as a Yjs
  // relative position, which stays put while co-editors type during the
  // upload.
  function insertImages(v: EditorView, files: FileList | undefined, at: number | null, e: Event): boolean {
    const images = [...(files ?? [])].filter((f) => f.type.startsWith("image/"));
    if (!images.length) return false;
    e.preventDefault();
    const d = doc;
    const where = Y.createRelativePositionFromTypeIndex(texts[d], at ?? v.state.selection.main.head);
    setStatus(images.length > 1 ? `Uploading ${images.length} images…` : "Uploading image…", "busy");
    // Uploads run side by side; the images go in in the order they were pasted.
    let inserted = Promise.resolve();
    for (const upload of images.map(uploadImage)) {
      inserted = inserted.then(() =>
        upload.then(
          (url) => insertImage(d, where, `![](${url})`),
          (err) => setStatus(`Image not uploaded: ${(err as Error).message}`, "error"),
        ),
      );
    }
    inserted.then(() => {
      if (status.dataset.state === "busy") showSaveState();
    });
    return true;
  }

  // On its own line, with a blank line around it.
  function insertImage(d: Doc, where: Y.RelativePosition, image: string) {
    const at = Y.createAbsolutePositionFromRelativePosition(where, ydoc)?.index ?? texts[d].length;
    const all = text(d);
    const before = at === 0 || all.slice(Math.max(0, at - 2), at) === "\n\n" ? "" : all[at - 1] === "\n" ? "\n" : "\n\n";
    const after = all.slice(at, at + 2) === "\n\n" ? "" : all[at] === "\n" ? "\n" : "\n\n";
    // Its own undo step, not merged into whatever was typed just before.
    undo[d].stopCapturing();
    texts[d].insert(at, `${before}${image}${after}`);
    undo[d].stopCapturing();
  }

  const uploadImage = (file: File) => upload(file, slug);

  // ---------------------------------------------------------- image bar --

  // With the cursor on an image's markdown, a bar over the editor sets its
  // size and caption, or opens it for cropping and rotating. Everything is
  // written back into the markdown as ![caption](url "w=NNN frame=accent2"),
  // which every render already understands: the caption is the alt text
  // (shown under the image in the email), w= the width in pixels (none: the
  // full column), frame= the frame in the theme's colours (none: accent).

  // The newsletter's look, for the email preview and the frame swatches, and
  // its settings, for the signature: the defaults until the stored ones load
  // (loadTheme, below).
  let theme: Theme = DEFAULT_THEME;
  let settings: Settings = DEFAULT_SETTINGS;

  interface ImageRef {
    from: number;
    to: number;
    alt: string;
    src: string;
    width: number | null;
    frame: Frame | null;
  }

  const IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g;
  const FULL_WIDTH = 560;
  const imageBar = $<HTMLElement>("[data-imagebar]");
  const widthInput = $<HTMLInputElement>("[data-image-width]");
  const widthOut = $<HTMLOutputElement>("[data-image-width-out]");
  const captionInput = $<HTMLInputElement>("[data-image-caption]");
  let current: ImageRef | null = null;

  // The image the cursor is in, or the first one on the cursor's line.
  function imageAt(v: EditorView): ImageRef | null {
    const head = v.state.selection.main.head;
    const line = v.state.doc.lineAt(head);
    let first: ImageRef | null = null;
    for (const m of line.text.matchAll(IMAGE)) {
      const from = line.from + m.index!;
      const ref = { from, to: from + m[0].length, alt: m[1], src: m[2], ...imageHints(m[3]) };
      if (head >= ref.from && head <= ref.to) return ref;
      first ??= ref;
    }
    return first;
  }

  function showImageBar(v: EditorView) {
    current = imageAt(v);
    imageBar.hidden = !current || current.src.startsWith("data:");
    if (imageBar.hidden || !current) return;
    const width = current.width ?? FULL_WIDTH;
    if (document.activeElement !== widthInput) widthInput.value = String(width);
    widthOut.value = current.width ? `${current.width}px` : "Full";
    if (document.activeElement !== captionInput) captionInput.value = current.alt;
    imageBar.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((b) => {
      b.setAttribute("aria-pressed", String((Number(b.dataset.size) || null) === current!.width));
    });
    imageBar.querySelectorAll<HTMLButtonElement>("[data-frame]").forEach((b) => {
      b.setAttribute("aria-pressed", String(b.dataset.frame === (current!.frame ?? "accent")));
    });
  }

  // Rewrites the image under the bar, as one ordinary (undoable) edit.
  function writeImage(next: Partial<Omit<ImageRef, "from" | "to">>) {
    if (!current) return;
    const img = { ...current, ...next };
    const alt = img.alt.replace(/[[\]]/g, "");
    const hints = [
      img.width && img.width < FULL_WIDTH ? `w=${img.width}` : "",
      img.frame && img.frame !== "accent" ? `frame=${img.frame}` : "",
    ].filter(Boolean);
    const title = hints.length ? ` "${hints.join(" ")}"` : "";
    editor.dispatch({ changes: { from: current.from, to: current.to, insert: `![${alt}](${img.src}${title})` } });
  }

  // The swatches show the frames in the newsletter's theme (paintSwatches
  // runs again once the theme has loaded).
  function paintSwatches() {
    const colors = frameColors(theme);
    imageBar.querySelectorAll<HTMLButtonElement>("[data-frame]").forEach((b) => {
      const color = colors[b.dataset.frame as Frame];
      if (color) b.style.setProperty("--swatch", color);
    });
  }
  imageBar.querySelectorAll<HTMLButtonElement>("[data-frame]").forEach((b) => {
    b.addEventListener("click", () => {
      writeImage({ frame: b.dataset.frame as Frame });
      editor.focus();
    });
  });
  paintSwatches();

  imageBar.querySelectorAll<HTMLButtonElement>("[data-size]").forEach((b) =>
    b.addEventListener("click", () => {
      writeImage({ width: Number(b.dataset.size) || null });
      editor.focus();
    }),
  );
  widthInput.addEventListener("input", () => writeImage({ width: Number(widthInput.value) }));
  captionInput.addEventListener("input", () => writeImage({ alt: captionInput.value }));
  captionInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") editor.focus();
  });

  // ------------------------------------------------------------ cropper --

  // Crop and rotate in the browser: the image is drawn rotated onto a canvas,
  // a drag marks the part to keep, and Save uploads that as a new image and
  // points the markdown at it. Media files are on this origin, so the canvas
  // can be read back.
  const cropper = $<HTMLDialogElement>("[data-cropper]");
  const canvas = $<HTMLCanvasElement>("[data-crop-canvas]");
  const box = $<HTMLElement>("[data-crop-box]");
  let source: HTMLImageElement | null = null;
  let turn = 0; // quarter turns clockwise
  let crop: { x: number; y: number; w: number; h: number } | null = null; // in canvas pixels
  let editing: ImageRef | null = null;

  function drawCrop() {
    if (!source) return;
    const sideways = turn % 2 === 1;
    canvas.width = sideways ? source.naturalHeight : source.naturalWidth;
    canvas.height = sideways ? source.naturalWidth : source.naturalHeight;
    const g = canvas.getContext("2d")!;
    g.save();
    g.translate(canvas.width / 2, canvas.height / 2);
    g.rotate((turn * Math.PI) / 2);
    g.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2);
    g.restore();
    crop = null;
    box.hidden = true;
  }

  $<HTMLButtonElement>("[data-image-edit]").addEventListener("click", async () => {
    if (!current) return;
    editing = current;
    const img = new Image();
    img.src = new URL(current.src, location.origin).href;
    try {
      await img.decode();
    } catch {
      setStatus("Couldn't open that image for editing", "error");
      return;
    }
    source = img;
    turn = 0;
    drawCrop();
    cropper.showModal();
  });

  // Pointer position -> canvas pixels.
  const toCanvas = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    return {
      x: Math.min(Math.max(e.clientX - r.left, 0), r.width) * sx,
      y: Math.min(Math.max(e.clientY - r.top, 0), r.height) * sx,
    };
  };
  let dragFrom: { x: number; y: number } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    dragFrom = toCanvas(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragFrom) return;
    const p = toCanvas(e);
    crop = { x: Math.min(dragFrom.x, p.x), y: Math.min(dragFrom.y, p.y), w: Math.abs(p.x - dragFrom.x), h: Math.abs(p.y - dragFrom.y) };
    const r = canvas.getBoundingClientRect();
    const stage = canvas.parentElement!.getBoundingClientRect();
    const k = r.width / canvas.width;
    Object.assign(box.style, {
      left: `${r.left - stage.left + crop.x * k}px`,
      top: `${r.top - stage.top + crop.y * k}px`,
      width: `${crop.w * k}px`,
      height: `${crop.h * k}px`,
    });
    box.hidden = false;
  });
  canvas.addEventListener("pointerup", () => {
    dragFrom = null;
    // A click without a drag clears the crop.
    if (crop && (crop.w < 8 || crop.h < 8)) {
      crop = null;
      box.hidden = true;
    }
  });

  cropper.querySelectorAll<HTMLButtonElement>("[data-crop-rotate]").forEach((b) =>
    b.addEventListener("click", () => {
      turn = (turn + (Number(b.dataset.cropRotate) > 0 ? 1 : 3)) % 4;
      drawCrop();
    }),
  );
  $<HTMLButtonElement>("[data-crop-reset]").addEventListener("click", () => {
    turn = 0;
    drawCrop();
  });
  $<HTMLButtonElement>("[data-crop-cancel]").addEventListener("click", () => cropper.close());

  $<HTMLButtonElement>("[data-crop-save]").addEventListener("click", async () => {
    if (!source || !editing) return;
    const ref = editing;
    if (turn === 0 && !crop) return cropper.close();
    const area = crop ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
    const out = document.createElement("canvas");
    out.width = Math.round(area.w);
    out.height = Math.round(area.h);
    out.getContext("2d")!.drawImage(canvas, area.x, area.y, area.w, area.h, 0, 0, out.width, out.height);
    const jpeg = /\.jpe?g$/i.test(ref.src);
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, jpeg ? "image/jpeg" : "image/png", 0.9));
    cropper.close();
    if (!blob) return setStatus("Couldn't save the edited image", "error");
    setStatus("Uploading image…", "busy");
    try {
      const url = await uploadImage(new File([blob], `${slug}-edited-${Date.now()}.${jpeg ? "jpg" : "png"}`, { type: blob.type }));
      // Find the image again: co-editors may have typed while this was open.
      const at = text(doc).indexOf(`](${ref.src}`);
      if (at < 0) return setStatus("The image moved or was removed while you edited it", "error");
      editor.dispatch({ changes: { from: at + 2, to: at + 2 + ref.src.length, insert: url } });
      showSaveState();
    } catch (err) {
      setStatus(`Image not uploaded: ${(err as Error).message}`, "error");
    }
  });

  // ------------------------------------------------------------- preview --

  const resolveImage = (src: string) => new URL(src, location.origin).href;

  function rendered(v: Exclude<View, "inbox">): string {
    if (v === "email") {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(slug) ? formatDate(new Date(`${slug}T12:00:00.000Z`)) : undefined;
      return renderDesignedEmail(text("body"), {
        title,
        date,
        theme,
        resolveImage,
        site: location.origin,
        signature: settings.signature,
      });
    }
    if (v === "slack") {
      const slack = text("slack");
      if (!slack.trim()) return note("No Slack post yet. Switch to “Slack post” on the left to write one.");
      return renderSlack(slack, { title: `Slack post — ${title}` });
    }
    return webPage(renderWeb(text("body"), { resolveImage }).html, title);
  }

  // The preview frame loads a render once (srcdoc), then follows typing by
  // swapping the new render's <body> (and <head>, if it changed) into the
  // page already there. Reloading it on every keystroke made it flash and
  // reload its fonts and images. A full load happens only for a different
  // render (Email, Slack, Archive page), or while the last load is still
  // under way; its scroll position is kept by hand.
  let frameLoading = false;
  let loadedView: View | null = null;
  let scrollY = 0;
  preview.addEventListener("load", () => {
    frameLoading = false;
    preview.contentWindow?.scrollTo(0, scrollY);
  });

  function render() {
    // The inbox isn't a render of the text; the frame catches up when a
    // render tab is shown again.
    if (view !== "inbox") {
      // Links in the preview open in a new tab: most sites refuse to load
      // inside the frame. (The copied email keeps plain links.)
      const html = rendered(view).replace(/<html>/i, '$&<base target="_blank">');
      const page = preview.contentDocument;
      if (!frameLoading && loadedView === view && page?.body) {
        const next = new DOMParser().parseFromString(html, "text/html");
        if (page.head.innerHTML !== next.head.innerHTML) page.head.innerHTML = next.head.innerHTML;
        page.documentElement.replaceChild(page.importNode(next.body, true), page.body);
      } else {
        if (!frameLoading) scrollY = preview.contentWindow?.scrollY ?? 0;
        frameLoading = true;
        loadedView = view;
        preview.srcdoc = html;
      }
    }
    renderChecks();
  }

  function renderChecks() {
    const md = text(doc);
    const items: Array<[string, boolean]> = [];
    if (doc === "body") {
      items.push([`${wordCount(md)} words`, false]);
    }
    const todo = placeholders(md);
    if (todo.length) items.push([`Placeholders left: ${todo.join(", ")}`, true]);
    for (const line of joinedToBullet(md)) items.push([`Joins the bullet above (add a blank line): “${line}”`, true]);
    checks.replaceChildren(
      ...items.map(([label, warn]) => {
        const li = document.createElement("li");
        li.textContent = label;
        if (warn) li.className = "warn";
        return li;
      }),
    );
  }

  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRender = () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, RENDER_AFTER_MS);
  };

  // ---------------------------------------------------------------- save --

  let saving: Promise<void> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  // Edits made while the connection is down live only in this tab until it
  // reconnects.
  let offlineEdits = false;

  const unsaved = () => meta.get("unsaved") === true;
  // Edits the merge makes aren't anyone's typing: they're not undoable, and
  // don't by themselves mark the text unsaved.
  const MERGE = "merge";
  let merging: Promise<void> | null = null;
  let mergeNote: string | null = null;

  // The saver: the lowest client id among the editors in the room.
  function saverId(): number {
    let min = ydoc.clientID;
    awareness.getStates().forEach((state, id) => {
      if (state.user && id < min) min = id;
    });
    return min;
  }
  const isSaver = () => saverId() === ydoc.clientID;

  function scheduleSave(ms: number) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(), ms);
  }

  // Network blip or server error: try again on our own, backing off from 2s
  // to a minute, so a draft isn't left unsaved after typing stops.
  function retry(message: string) {
    const wait = Math.min(2000 * 2 ** failures++, 60_000);
    setStatus(`Not saved: ${message}. Retrying in ${Math.round(wait / 1000)}s`, "error");
    scheduleSave(wait);
  }

  // One save in flight at a time; edits made during it trigger another. Only
  // the saver saves, and not while a merge is under way.
  async function save(): Promise<void> {
    if (saving) return saving.then(() => (unsaved() ? save() : undefined));
    if (!isSaver() || !unsaved() || merging) return;
    const sent = { body: text("body"), slack: text("slack") };
    setStatus("Saving…", "busy");
    let behind = false;
    saving = (async () => {
      try {
        const res = await fetch(`${API}/${encodeURIComponent(slug)}`, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-emdash-request": "1" },
          body: JSON.stringify({ data: sent, _rev: meta.get("rev") }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          // EmDash has a version we haven't seen: merge it, then save again.
          if (json?.error?.code === "CONFLICT") {
            behind = true;
            return;
          }
          const message = json?.error?.message ?? `HTTP ${res.status}`;
          // Only a server error might go away by itself. A 403 or a rejected
          // field won't, so say so once and wait for the next edit.
          if (res.status >= 500) retry(message);
          else setStatus(`Not saved: ${message}`, "error");
          return;
        }
        failures = 0;
        ydoc.transact(() => {
          meta.set("rev", json.data._rev);
          meta.set("base", sent);
          meta.set("savedAt", Date.now());
          // Typing during the save leaves it unsaved, and saved again next.
          if (text("body") === sent.body && text("slack") === sent.slack) meta.set("unsaved", false);
        });
      } catch (err) {
        // fetch rejects only when the request never got a response.
        retry((err as Error).message);
      } finally {
        saving = null;
      }
    })();
    await saving;
    if (behind) await mergeFromEmDash();
  }

  // EmDash moved on: take what changed there since the text we last agreed on
  // ("base") and apply it on top of the live text, then save that. When the
  // change is only our own save seen late (two tabs saving at once), there is
  // nothing to apply and it just catches up on the revision.
  function mergeFromEmDash(): Promise<void> {
    merging ??= (async () => {
      try {
        const theirs = await loadFromEmDash();
        const base = (meta.get("base") as { body?: string; slack?: string } | undefined) ?? {};
        let clean = true;
        let changed = false;
        ydoc.transact(() => {
          for (const key of ["body", "slack"] as const) {
            // No base (a room from before merging): what's on screen wins.
            const result = merge(base[key] ?? text(key), text(key), theirs[key]);
            clean &&= result.clean;
            if (result.text !== text(key)) {
              setText(texts[key], result.text);
              changed = true;
            }
          }
          meta.set("rev", theirs.rev);
          meta.set("base", { body: theirs.body, slack: theirs.slack });
          meta.set("behind", false);
          meta.set("unsaved", text("body") !== theirs.body || text("slack") !== theirs.slack);
        }, MERGE);
        if (changed) {
          mergeNote = clean
            ? "Merged in a change made outside the studio"
            : "Merged in a change made outside the studio (where it overlapped this text, this text was kept)";
          setTimeout(() => {
            mergeNote = null;
            showSaveState();
          }, 8000);
        }
      } catch (err) {
        setStatus(`Couldn't check EmDash's version: ${(err as Error).message}`, "error");
      } finally {
        merging = null;
      }
    })();
    return merging.then(() => {
      showSaveState();
      if (unsaved()) scheduleSave(SAVE_AFTER_MS);
    });
  }

  // Every change, yours or a co-editor's, re-renders; your own also marks the
  // document unsaved. Whoever is the saver saves after a pause in typing.
  ydoc.on("afterTransaction", (tr: Y.Transaction) => {
    const changed: unknown[] = [...tr.changed.keys()];
    const textChanged = changed.includes(texts.body) || changed.includes(texts.slack);
    if (textChanged) {
      scheduleRender();
      if (tr.local && tr.origin !== MERGE) {
        if (!unsaved()) meta.set("unsaved", true);
        if (!provider.wsconnected) offlineEdits = true;
      }
      failures = 0;
      if (isSaver()) scheduleSave(SAVE_AFTER_MS);
    }
    // The room marks the document behind when someone opens it and EmDash
    // has a newer version; the saver merges it in.
    if (meta.get("behind") === true && isSaver()) mergeFromEmDash();
    showSaveState();
  });

  // The saver left: the next one picks up anything still unsaved.
  awareness.on("change", () => {
    renderPeople();
    if (isSaver() && meta.get("behind") === true) mergeFromEmDash();
    else if (isSaver() && unsaved()) scheduleSave(SAVE_AFTER_MS);
  });

  provider.on("status", ({ status }: { status: string }) => {
    if (status === "connected") offlineEdits = false;
    showSaveState();
  });

  function showSaveState() {
    if (!provider.wsconnected) return setStatus("Offline. Your edits will sync when you reconnect.", "error");
    if (merging) return setStatus("Merging in a change made outside the studio…", "busy");
    if (mergeNote) return setStatus(mergeNote);
    if (unsaved()) return setStatus(isSaver() ? "Edited" : "Edited, saving soon", "busy");
    const at = meta.get("savedAt");
    setStatus(
      typeof at === "number"
        ? `Saved draft ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : "Up to date",
    );
  }

  function renderPeople() {
    const here: Presence[] = [];
    awareness.getStates().forEach((state) => {
      if (state.user) here.push(state.user as Presence);
    });
    people.replaceChildren(
      ...here.map((p) => {
        const li = document.createElement("li");
        li.textContent = p.name;
        li.style.setProperty("--who", p.color);
        return li;
      }),
    );
  }

  addEventListener("beforeunload", (e) => {
    if (offlineEdits || (isSaver() && (unsaved() || saving))) e.preventDefault();
  });
  addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      clearTimeout(saveTimer);
      save();
    }
  });

  // ---------------------------------------------------------------- tabs --

  const select = (attr: string, value: string) =>
    root.querySelectorAll<HTMLButtonElement>(`[${attr}]`).forEach((b) => b.setAttribute("aria-selected", String(b.getAttribute(attr) === value)));

  // Where the cursor was in each text, so switching back picks up there.
  const lastPos: Record<Doc, number> = { body: 0, slack: 0 };

  function showDoc(next: Doc) {
    if (next === doc) return;
    lastPos[doc] = editor.state.selection.main.head;
    doc = next;
    select("data-doc", doc);
    editor.setState(stateFor(doc));
    editor.dispatch({ selection: { anchor: Math.min(lastPos[doc], editor.state.doc.length) }, scrollIntoView: true });
    // Editing the Slack post shows the Slack preview, and back (the inbox
    // stays open if that's what's showing).
    if (view !== "inbox") showView(doc === "slack" ? "slack" : view === "slack" ? "email" : view);
    else renderChecks();
    editor.focus();
  }

  root.querySelectorAll<HTMLButtonElement>("[data-doc]").forEach((b) =>
    b.addEventListener("click", () => showDoc(b.dataset.doc as Doc)),
  );

  function showView(next: View) {
    view = next;
    select("data-view", view);
    const inbox = view === "inbox";
    preview.hidden = inbox;
    inboxPanel.hidden = !inbox;
    copyButton.hidden = inbox || view === "web";
    copyButton.textContent = view === "slack" ? "Copy for Slack" : "Copy for Outlook";
    if (inbox) {
      loadInbox();
      return;
    }
    // A different preview starts at its top.
    scrollY = 0;
    frameLoading = true;
    render();
  }

  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) =>
    b.addEventListener("click", () => showView(b.dataset.view as View)),
  );

  // --------------------------------------------------------------- inbox --

  // The newsletter inbox, read-only, as a tab next to the renders: what the
  // team saved this week, and older leftovers nobody has used yet. Whether an
  // item made it in shows in the Email tab, not here. Adding happens through
  // Claude ("add this to the newsletter"), which also marks items used when it
  // drafts. Read through the newsletter EmDash plugin's routes, as the
  // signed-in admin.

  const inboxPanel = $<HTMLElement>("[data-inbox]");
  const currentList = $<HTMLUListElement>("[data-inbox-current]");
  const earlier = $<HTMLElement>("[data-inbox-earlier]");
  const earlierList = $<HTMLUListElement>("[data-inbox-earlier-list]");
  // This week = added since the previous edition (the page works out its
  // date). Waiting items from before it are leftovers, shown separately.
  const since = root.dataset.inboxSince ? new Date(root.dataset.inboxSince).getTime() : 0;
  const thisWeek = (item: InboxItem) => new Date(item.addedAt).getTime() >= since;
  const badge = $<HTMLElement>("[data-inbox-badge]");

  async function waitingItems(): Promise<InboxItem[]> {
    const items: InboxItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await plugin<{ items: InboxItem[]; nextCursor: string | null }>("list-items", { limit: 100, cursor });
      items.push(...res.items);
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return items;
  }

  async function loadTheme() {
    try {
      [theme, settings] = await Promise.all([
        plugin<{ theme: Theme }>("theme-get", {}).then((r) => r.theme),
        plugin<{ settings: Settings }>("settings-get", {}).then((r) => r.settings),
      ]);
      paintSwatches();
      render();
    } catch {
      // Keeps the defaults: the preview still works, just not in the saved theme.
    }
  }

  async function loadInbox() {
    try {
      const [waiting, used] = await Promise.all([
        waitingItems(),
        plugin<{ items: InboxItem[] }>("list-used", { edition: slug }).then((r) => r.items),
      ]);
      // This week: everything saved since the last edition, whether it's still
      // waiting or already went into this one.
      const current = [...waiting.filter(thisWeek), ...used].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
      const leftovers = waiting.filter((item) => !thisWeek(item));
      badge.textContent = current.length ? String(current.length) : "";
      renderItems(currentList, current, "Nothing saved since the last edition.");
      earlier.hidden = leftovers.length === 0;
      renderItems(earlierList, leftovers, "");
    } catch (err) {
      renderItems(currentList, [], `Couldn't load the inbox: ${(err as Error).message}`);
    }
  }

  // One bullet per item, like the old inbox.md: the link (by its title), the
  // note, then who added it and when.
  function renderItems(list: HTMLUListElement, items: InboxItem[], empty: string) {
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "inbox__empty";
      li.textContent = empty;
      list.replaceChildren(li);
      return;
    }
    list.replaceChildren(
      ...items.map((item) => {
        const li = document.createElement("li");
        if (item.url) {
          const a = document.createElement("a");
          a.href = item.url;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = item.title ?? item.url;
          li.append(a);
        }
        if (item.note) {
          const note = document.createElement("span");
          note.className = "inbox__note";
          note.textContent = item.url ? `: ${item.note}` : item.note;
          li.append(note);
        }
        const who = document.createElement("span");
        who.className = "inbox__who";
        const added = new Date(item.addedAt).toLocaleDateString([], { month: "short", day: "numeric" });
        who.textContent = ` (${item.addedBy ? `${item.addedBy.split("@")[0]}, ` : ""}${added})`;
        li.append(who);
        return li;
      }),
    );
  }


  // ---------------------------------------------------------------- copy --

  // Rich text on the clipboard, so it pastes straight into an Outlook message
  // or the Slack composer: the rendered <body>, without the page around it.
  copyButton.addEventListener("click", async () => {
    if (view === "inbox" || (view === "slack" && !text("slack").trim())) return;
    const page = new DOMParser().parseFromString(rendered(view), "text/html");
    const walker = page.createTreeWalker(page.body, NodeFilter.SHOW_COMMENT);
    const comments: Node[] = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((c) => c.parentNode?.removeChild(c));

    const html = page.body.innerHTML.trim();
    // Slack sometimes pastes the plain text instead of the rich text. Its
    // composer formats markdown (bold, links, bullets) as it's pasted, so
    // the Slack post's plain text is its markdown, not a flattened render.
    const plain = view === "slack" ? text("slack").trim() : (page.body.textContent?.trim() ?? "");
    const label = copyButton.textContent;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      copyButton.textContent = "Copied";
    } catch {
      // No clipboard permission (some embedded browsers): the old copy
      // command still carries rich text through the copy event.
      copyButton.textContent = copyViaEvent(html, plain) ? "Copied" : "Copy failed";
    }
    setTimeout(() => (copyButton.textContent = label), 1500);
  });

  renderPeople();
  showSaveState();
  // Fills the Inbox tab's count (and its lists, ready for when it's opened).
  loadInbox();
  loadTheme();
  // A room from before merging may still hold an open conflict: merge it.
  if (meta.has("conflict")) ydoc.transact(() => {
    meta.delete("conflict");
    meta.set("behind", true);
  }, MERGE);
  if (isSaver() && meta.get("behind") === true) mergeFromEmDash();
  else if (isSaver() && unsaved()) scheduleSave(SAVE_AFTER_MS);
  render();
}

function copyViaEvent(html: string, plain: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault();
    e.clipboardData?.setData("text/html", html);
    e.clipboardData?.setData("text/plain", plain);
  };
  document.addEventListener("copy", onCopy, { once: true });
  try {
    return document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", onCopy);
  }
}

function note(message: string): string {
  return `<!doctype html><html><body style="font:15px/1.5 system-ui,sans-serif; color:#5f6670; margin:2rem">${message}</body></html>`;
}

// The archive page's reading column, from the same stylesheets as
// /newsletter/<date> (the site's tokens and type, then the edition's text), so
// the preview follows any change to the real page. The page itself shows the
// published version.
function webPage(html: string, title: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title>` +
    `<style>${siteCss}\n${editionCss}\n.issue { max-width: 40rem; padding-block: 2.5rem 4rem; }</style>` +
    `</head><body><main class="issue shell"><div class="issue__body">${html}</div></main></body></html>`
  );
}
