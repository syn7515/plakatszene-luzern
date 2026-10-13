import * as THREE from 'three';

// The label a sheet shows when pointed at: its title with its year under
// it, set small in a grotesque like the original's. It is drawn once on a
// canvas sized to the paper (DENSITY px per cm): the text in red, and in
// green a halo around it, within which the shader leaves out the halftone
// dots so that small type stays readable on a dot screen; the shader then
// prints the text on the paper in the face's ink. Horizontal, the lines
// run along the paper; vertical, they read up the paper (the title then
// stands as the left column).
export const CAP = 1.4; // cm, cap height of both lines
const GAP = 0.7; // cm between the title and the year
const HALO = 0.45; // cm around the text kept free of dots (more than the dot pitch)
const PAD = 0.6; // cm of clear paper around the text, beyond the halo's reach
const DENSITY = 24; // texture px per cm
const CAP_RATIO = 0.72; // cap height over font size, for Helvetica
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

export interface LabelPrint {
  texture: THREE.CanvasTexture;
  width: number; // cm along the paper
  height: number; // cm up the paper
  vertical: boolean;
}

const px = (cm: number) => Math.round(cm * DENSITY);
// Light type on a dark ground looks heavier than dark type on a light one,
// so the latter is set one step bolder to read the same.
export const WEIGHT_LIGHT_ON_DARK = 400;
export const WEIGHT_DARK_ON_LIGHT = 500;
const font = (weight: number) => `${weight} ${px(CAP / CAP_RATIO)}px ${FONT}`;

let scratch: CanvasRenderingContext2D | null = null;
const measure = (text: string, font: string) => {
  scratch ??= document.createElement('canvas').getContext('2d')!;
  scratch.font = font;
  return scratch.measureText(text).width / DENSITY; // cm
};

// The block of text, in cm, before any turning: lines along x, read along
// y. Measured at the bolder weight so the size does not depend on the face.
function block(title: string, year: number) {
  const bold = font(WEIGHT_DARK_ON_LIGHT);
  const width = Math.max(measure(title, bold), measure(String(year), bold)) + 2 * PAD;
  const height = CAP + GAP + CAP + 2 * PAD;
  return { width, height };
}

// cm the label takes on the paper: along it and up it.
export function labelSize(title: string, year: number, vertical: boolean) {
  const { width, height } = block(title, year);
  return vertical ? { width: height, height: width } : { width, height };
}

export function printLabel(title: string, year: number, vertical: boolean, weight: number): LabelPrint {
  const { width, height } = block(title, year);
  const canvas = document.createElement('canvas');
  canvas.width = px(vertical ? height : width);
  canvas.height = px(vertical ? width : height);
  const ctx = canvas.getContext('2d')!;
  if (vertical) {
    // Turn the block to read up the paper: its x runs up the canvas.
    ctx.translate(0, canvas.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.textBaseline = 'alphabetic';
  ctx.font = font(weight);
  const lines: [string, number][] = [
    [title, px(PAD + CAP)],
    [String(year), px(PAD + CAP + GAP + CAP)],
  ];
  ctx.strokeStyle = '#0f0';
  ctx.lineJoin = 'round';
  ctx.lineWidth = px(2 * HALO);
  for (const [text, baseline] of lines) ctx.strokeText(text, px(PAD), baseline);
  ctx.fillStyle = '#f00';
  for (const [text, baseline] of lines) ctx.fillText(text, px(PAD), baseline);

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  return { texture, ...labelSize(title, year, vertical), vertical };
}
