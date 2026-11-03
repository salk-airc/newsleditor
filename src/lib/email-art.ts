import { encodePng } from "./png.ts";

// The art in a newsletter email, drawn as PNGs from a theme's colors (see
// bannerUrl and ruleUrl in src/plugins/newsletter/theme.ts): images are the
// one kind of color that survives Outlook on the web and phone dark modes.

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
  /** Colors as 6-digit hex without "#". */
  a: string;
  b: string;
  /** 0..100 */
  strength: number;
  /** 0: the classic two glows; any other number, its own mix of glows. */
  pattern: number;
  /** px, in the 640px column. */
  height: number;
}

// Shown 640 wide at the top of the email's column, at its height. Drawn at
// 1x: the glows are soft enough that a 2x screen's upscaling doesn't show.
export const GLOW_WIDTH = 640;

/** One soft glow: its color (0 the accent, 1 the second), center across, and reach, as fractions of the band. */
type Blob = { color: 0 | 1; cx: number; cy: number; rx: number; ry: number; weight: number };

/** The accent near the top left and the second accent near the top right. */
const CLASSIC: Blob[] = [
  { color: 0, cx: 0.3, cy: 0, rx: 0.42, ry: 1.6, weight: 1 },
  { color: 1, cx: 0.72, cy: 0, rx: 0.38, ry: 1.4, weight: 1 },
];

/** A pattern's glows: 2 to 4 of them, in both accents, from a seeded random sequence so a number always draws the same. */
function blobs(pattern: number): Blob[] {
  if (pattern === 0) return CLASSIC;
  let seed = pattern * 2654435761;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = 2 + Math.floor(random() * 3);
  return Array.from({ length: n }, (_, i) => ({
    // Both colors always show: the first glow is the accent, the second the second accent.
    color: (i < 2 ? i : random() < 0.5 ? 0 : 1) as 0 | 1,
    cx: 0.12 + random() * 0.76,
    cy: random() * 0.5,
    rx: 0.2 + random() * 0.3,
    ry: 0.9 + random() * 0.9,
    weight: 0.65 + random() * 0.35,
  }));
}

/**
 * Soft glows in the two accents on a transparent background, faded out at the
 * sides and the bottom so the band has no visible edges. Transparent rather
 * than drawn on the page color: dark modes darken the page but never recolor
 * images, so a band with the page color in it would stay a light box there.
 */
export function drawGlow({ a, b, strength, pattern, height }: GlowArt): Promise<Uint8Array<ArrayBuffer>> {
  const colors = [rgb(a), rgb(b)];
  const W = GLOW_WIDTH;
  const H = height;
  const max = (strength / 100) * 0.6;
  const glows = blobs(pattern);
  const glow = (x: number, y: number, g: Blob) => {
    const d = Math.hypot((x - g.cx * W) / (g.rx * W), (y - g.cy * H) / (g.ry * H));
    return d >= 1 ? 0 : 1 - smooth(1, d);
  };
  return encodePng(W, H, (x, y) => {
    const fade = smooth(W * 0.18, x) * smooth(W * 0.18, W - x) * smooth(H * 0.75, H - y);
    // Each glow over the ones before it, as one color and one opacity.
    let alpha = 0;
    const px = [0, 0, 0];
    for (const g of glows) {
      const t = max * g.weight * fade * glow(x, y, g);
      if (t === 0) continue;
      const c = colors[g.color]!;
      const out = t + alpha * (1 - t);
      for (let i = 0; i < 3; i++) px[i] = (c[i]! * t + px[i]! * alpha * (1 - t)) / out;
      alpha = out;
    }
    if (alpha === 0) return [0, 0, 0, 0];
    return [Math.round(px[0]!), Math.round(px[1]!), Math.round(px[2]!), Math.round(255 * alpha)];
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
