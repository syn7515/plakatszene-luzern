// Everything we know about the original print, in one place.

// F4 (Swiss "Weltformat") in centimetres. One scene unit = 1 cm.
export const POSTER_SIZE = { width: 89.5, height: 128 } as const;

export const PAPER = '#ffffff';

// Spot inks, sampled from the 100 Beste Plakate scan.
export const INK = {
  pink: '#ff1e56',
  violet: '#7b4cd0',
  beige: '#bfa896',
  green: '#00542b',
  yellow: '#ffe001',
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
// they are how five inks make two more flat colours. Violet dots on bare
// paper give lavender; violet dots over green give a dark green with green
// showing through. `tone` is the share of the face the dots cover.
export interface Surface {
  label: string;
  ground: string;
  dots?: string;
  tone?: number;
  ink: string; // what text printed on this surface is set in, as the original pairs them
  halo?: boolean; // the dots give way around text, so small type stays readable on the screen
}

export const SURFACES = {
  pink: { label: '분홍', ground: INK.pink, ink: INK.yellow },
  violet: { label: '보라', ground: INK.violet, ink: PAPER },
  beige: { label: '베이지', ground: INK.beige, ink: INK.green },
  green: { label: '초록', ground: INK.green, ink: INK.yellow },
  yellow: { label: '노랑', ground: INK.yellow, ink: INK.green },
  paper: { label: '종이', ground: PAPER, ink: INK.pink },
  lavender: { label: '연보라 (망점)', ground: PAPER, dots: INK.violet, tone: 0.25, ink: '#000000', halo: true },
  darkGreen: { label: '짙은 초록 (망점)', ground: INK.green, dots: INK.violet, tone: 0.8, ink: INK.yellow },
} satisfies Record<string, Surface>;

export type SurfaceName = keyof typeof SURFACES;
