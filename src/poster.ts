// The print: its format, as the original's, and the inks this interactive
// edition is printed in, which are its own.

// F4 (Swiss "Weltformat") in centimetres. One scene unit = 1 cm.
export const POSTER_SIZE = { width: 89.5, height: 128 } as const;

export const PAPER = '#ffffff';

// A second edition from the same screens in other inks: two of them, so it
// reads as a variation beside the photo of the original on the wall, not a
// copy of it. (The original's five, sampled from the 100 Beste Plakate scan:
// pink #ff1e56, violet #7b4cd0, beige #bfa896, green #00542b, yellow #ffe001;
// its dots were violet, 25% on paper and 80% over green.)
export const INK = {
  teal: '#007c8c',
  vermilion: '#ff4a2a',
} as const;

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

// How light a colour reads, 0..1.
export function lightness(hex: string) {
  const [r, g, b] = channels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Ink printed on top of ink. Multiplying the sRGB values reproduces the scan's
// darks: green × violet = #001923 against the scanned #021927.
export function overprint(a: string, b: string): string {
  const [ca, cb] = [channels(a), channels(b)];
  return '#' + ca.map((v, i) => Math.round(v * cb[i] * 255).toString(16).padStart(2, '0')).join('');
}

// What one face of a sheet can be printed as. The dots are not shading:
// they are how two inks make every other flat colour, as tints on bare paper
// and, printed over the other ink, as darks with that ink showing through.
// `tone` is the share of the face the dots cover.
export interface Surface {
  label: string;
  ground: string;
  dots?: string;
  tone?: number;
  ink: string; // what text printed on this surface is set in
  halo?: boolean; // the dots give way around text, so small type stays readable on the screen
}

// The names are the original's colours, which composition.json gives every
// face by. Each is reprinted here at about the original's lightness (OKLCH:
// paper 1, lavender .92, yellow .90, beige .79, pink .67, violet .54, green
// .42, darkGreen .33), because with no shading that ladder is what the depth
// is read from, and it is the grey scene the other sheets drain to on hover.
export const SURFACES = {
  paper: { label: '종이', ground: PAPER, ink: INK.vermilion },
  lavender: { label: '청록 망점 25%', ground: PAPER, dots: INK.teal, tone: 0.25, ink: INK.teal, halo: true },
  yellow: { label: '주홍 망점 40%', ground: PAPER, dots: INK.vermilion, tone: 0.4, ink: INK.teal, halo: true },
  beige: { label: '청록 망점 60%', ground: PAPER, dots: INK.teal, tone: 0.6, ink: INK.teal, halo: true },
  pink: { label: '주홍', ground: INK.vermilion, ink: PAPER },
  violet: { label: '청록', ground: INK.teal, ink: PAPER },
  green: { label: '청록 + 주홍 망점 55%', ground: INK.teal, dots: INK.vermilion, tone: 0.55, ink: PAPER, halo: true },
  darkGreen: { label: '주홍 + 청록 망점 92%', ground: INK.vermilion, dots: INK.teal, tone: 0.92, ink: PAPER },
} satisfies Record<string, Surface>;

export type SurfaceName = keyof typeof SURFACES;
