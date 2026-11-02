import { drawGlow, drawRule } from "../lib/email-art.ts";
import { artKey, type ArtSpec, type DrawnArt } from "../plugins/newsletter/theme.ts";

// The banner and rules for the studio's previews, drawn here in the browser
// (the same drawing as /email/art/ and the bucket's copies) as data: URLs,
// so a preview never downloads them. Downloading them failed in a preview
// that re-renders while a color picker is dragged: the browser cancels the
// images of each discarded render, and can hand a later image the cancelled
// result, a broken picture. Copied emails still link to the real images.
//
// drawnArt(onDrawn) returns the DrawnArt to render with. A drawing not drawn
// yet starts drawing, and meanwhile the last drawing of its kind stands in
// (a moment of slightly old color, rather than nothing); onDrawn runs when
// it's ready, to render again.

const drawn = new Map<string, string>();
const drawing = new Set<string>();
const latest: Partial<Record<ArtSpec["kind"], string>> = {};
/** Enough for a session of picking colors; the oldest go first. */
const MAX_DRAWN = 60;
/** A transparent pixel. */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

function dataUrl(png: Uint8Array): string {
  let s = "";
  for (let i = 0; i < png.length; i += 0x8000) s += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(s)}`;
}

export function drawnArt(onDrawn: () => void): DrawnArt {
  return (spec) => {
    const key = artKey(spec);
    const url = drawn.get(key);
    if (url) return (latest[spec.kind] = url);
    if (!drawing.has(key)) {
      drawing.add(key);
      (spec.kind === "glow" ? drawGlow(spec) : drawRule(spec))
        .then((png) => {
          if (drawn.size >= MAX_DRAWN) drawn.delete(drawn.keys().next().value!);
          drawn.set(key, dataUrl(png));
          onDrawn();
        })
        .catch(() => {})
        .finally(() => drawing.delete(key));
    }
    // Nothing drawn of this kind yet (the first render): blank, for the moment it takes.
    return latest[spec.kind] ?? BLANK;
  };
}
