import * as THREE from 'three';

// The label a sheet shows when pointed at: its title with its year under
// it, set small, in a medium-weight grotesque like the original's. It is drawn
// once, as an alpha mask on a canvas sized to the paper (DENSITY px per
// cm), and the shader prints it on the paper in the face's ink.
// Horizontal, the lines run along the paper; vertical, they read up the
// paper (the title then stands as the left column).
export const CAP = 1.8; // cm, cap height of both lines
const GAP = 0.9; // cm between the title and the year
const PAD = 0.8; // cm of clear paper around the text
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
const WEIGHT = 500; // medium: lighter than the original's bold, at this size
const font = `${WEIGHT} ${px(CAP / CAP_RATIO)}px ${FONT}`;

let scratch: CanvasRenderingContext2D | null = null;
const measure = (text: string, font: string) => {
  scratch ??= document.createElement('canvas').getContext('2d')!;
  scratch.font = font;
  return scratch.measureText(text).width / DENSITY; // cm
};

// The block of text, in cm, before any turning: lines along x, read along y.
function block(title: string, year: number) {
  const width = Math.max(measure(title, font), measure(String(year), font)) + 2 * PAD;
  const height = CAP + GAP + CAP + 2 * PAD;
  return { width, height };
}

// cm the label takes on the paper: along it and up it.
export function labelSize(title: string, year: number, vertical: boolean) {
  const { width, height } = block(title, year);
  return vertical ? { width: height, height: width } : { width, height };
}

export function printLabel(title: string, year: number, vertical: boolean): LabelPrint {
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
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'alphabetic';
  ctx.font = font;
  ctx.fillText(title, px(PAD), px(PAD + CAP));
  ctx.fillText(String(year), px(PAD), px(PAD + CAP + GAP + CAP));

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  return { texture, ...labelSize(title, year, vertical), vertical };
}
