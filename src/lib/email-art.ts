import { encodePng } from "./png.ts";

// The art in a newsletter email, drawn as PNGs from a theme's colours (see
// bannerUrl and ruleUrl in src/plugins/newsletter/theme.ts): images are the
// one kind of colour that survives Outlook on the web and phone dark modes.

type RGB = [number, number, number];

const rgb = (hex: string): RGB => {
  const n = Number.parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const smooth = (edge: number, x: number) => {
  const t = Math.min(1, Math.max(0, x / edge));
  return t * t * (3 - 2 * t);
};

export interface GlowArt {
  /** Colours as 6-digit hex without "#". */
  a: string;
  b: string;
  /** 0..100 */
  strength: number;
}

// Shown 640 x 100 at the top of the email's column. Drawn at 1x: the glows
// are soft enough that a 2x screen's upscaling doesn't show.
export const GLOW = { width: 640, height: 100 };

/**
 * Two soft glows, the accent near the top left and the second accent near the
 * top right, on a transparent background, faded out at the sides and the
 * bottom so the band has no visible edges. Transparent rather than drawn on
 * the page colour: dark modes darken the page but never recolour images, so a
 * band with the page colour in it would stay a light box there.
 */
export function drawGlow({ a, b, strength }: GlowArt): Promise<Uint8Array<ArrayBuffer>> {
  const [A, B] = [rgb(a), rgb(b)];
  const { width: W, height: H } = GLOW;
  const max = (strength / 100) * 0.6;
  const glow = (x: number, y: number, cx: number, rx: number, ry: number) => {
    const d = Math.hypot((x - cx) / rx, y / ry);
    return d >= 1 ? 0 : 1 - smooth(1, d);
  };
  return encodePng(W, H, (x, y) => {
    const fade = smooth(W * 0.18, x) * smooth(W * 0.18, W - x) * smooth(H * 0.75, H - y);
    const ta = max * fade * glow(x, y, W * 0.3, W * 0.42, H * 1.6);
    const tb = max * fade * glow(x, y, W * 0.72, W * 0.38, H * 1.4);
    // b over a, each at its own opacity, as one colour and one opacity.
    const alpha = 1 - (1 - ta) * (1 - tb);
    if (alpha === 0) return [0, 0, 0, 0];
    const px = [0, 1, 2].map((i) => Math.round((A[i]! * ta * (1 - tb) + B[i]! * tb) / alpha));
    return [px[0]!, px[1]!, px[2]!, Math.round(255 * alpha)];
  });
}

export interface RuleArt {
  a: string;
  b: string;
}

// Drawn at 2x for a crisp edge, stretched to whatever width the email shows
// it at (64px under the name, 44px under headings).
export const RULE = { width: 256, height: 6 };

/** A rounded bar fading from a to b. */
export function drawRule({ a, b }: RuleArt): Promise<Uint8Array<ArrayBuffer>> {
  const [A, B] = [rgb(a), rgb(b)];
  const { width: W, height: H } = RULE;
  const r = H / 2;
  return encodePng(W, H, (x, y) => {
    const t = x / W;
    const cx = Math.min(Math.max(x, r), W - r);
    const cover = Math.min(1, Math.max(0, r - Math.hypot(x - cx, y - r) + 0.5));
    const px = [0, 1, 2].map((i) => Math.round(A[i]! + (B[i]! - A[i]!) * t));
    return [px[0]!, px[1]!, px[2]!, Math.round(255 * cover)];
  });
}
