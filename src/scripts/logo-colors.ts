import { contrast, DEFAULT_THEME, hex, luminance, mix, rgb, type Theme } from "../plugins/newsletter/theme.ts";

// Setup's "suggest a theme from your logo": the logo's two main colours,
// made deep enough to read on the page as links (accent) and to show as
// rules and glow (accent2). The result still goes through checkTheme before
// it's saved, like any theme.

type RGB = [number, number, number];

/** The logo's main colours, most used first: saturated pixels only, so white, black and grey backgrounds don't count. */
export async function logoColors(src: string): Promise<string[]> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  await img.decode();
  const size = 64;
  const scale = size / Math.max(img.naturalWidth, img.naturalHeight, 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // Pixels bucketed by hue (24 buckets), each bucket keeping its average colour.
  const buckets = new Map<number, { n: number; sum: RGB }>();
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
    if (a < 128) continue;
    const { h, s, l } = hsl([r, g, b]);
    if (s < 0.25 || l < 0.08 || l > 0.92) continue;
    const key = Math.round(h / 15) % 24;
    const bucket = buckets.get(key) ?? { n: 0, sum: [0, 0, 0] };
    bucket.n++;
    bucket.sum = [bucket.sum[0] + r, bucket.sum[1] + g, bucket.sum[2] + b];
    buckets.set(key, bucket);
  }
  const ranked = [...buckets.entries()].sort((a, b) => b[1].n - a[1].n);
  const colors: string[] = [];
  const hues: number[] = [];
  for (const [key, { n, sum }] of ranked) {
    // Skip a hue right next to one already taken: it's the same colour, anti-aliased.
    if (hues.some((h) => Math.min(Math.abs(h - key), 24 - Math.abs(h - key)) < 2)) continue;
    hues.push(key);
    colors.push(hex([sum[0] / n, sum[1] / n, sum[2] / n]));
    if (colors.length === 3) break;
  }
  return colors;
}

/** A theme from a logo's colours: the first as the accent, the second (or a neighbour of the first) as accent2. */
export function themeFromColors(colors: string[], base: Theme = DEFAULT_THEME): Theme {
  const page = base.colors.page;
  if (!colors.length) return base;
  const accent = deepen(colors[0]!, page, 4.6);
  const second = colors[1] ?? rotate(colors[0]!, 40);
  const accent2 = deepen(second, page, 2.2);
  return { ...base, colors: { ...base.colors, accent, accent2 } };
}

/** The colour, darkened just enough to reach the contrast ratio on the page. */
function deepen(color: string, page: string, ratio: number): string {
  let c = color;
  for (let k = 0.05; contrast(c, page) < ratio && k <= 0.9; k += 0.05) c = mix(color, "#000000", 1 - k);
  // Very dark logo colours vanish in phone dark mode: lift them a little.
  if (luminance(c) < 0.01) c = mix(c, "#ffffff", 0.85);
  return c;
}

function rotate(color: string, degrees: number): string {
  const { h, s, l } = hsl(rgb(color));
  return hex(fromHsl((h + degrees) % 360, s, l));
}

function hsl([r, g, b]: RGB): { h: number; s: number; l: number } {
  const [x, y, z] = [r / 255, g / 255, b / 255];
  const max = Math.max(x, y, z);
  const min = Math.min(x, y, z);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === x ? ((y - z) / d + (y < z ? 6 : 0)) * 60 : max === y ? ((z - x) / d + 2) * 60 : ((x - y) / d + 4) * 60;
  return { h, s, l };
}

function fromHsl(h: number, s: number, l: number): RGB {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}
