import * as THREE from 'three';

// The label a sheet shows when pointed at: its title with its year under
// it, set small in a grotesque like the original's. It is drawn once on a
// canvas sized to the paper (DENSITY px per cm) and turned into a signed
// distance field: each texel holds how far it is from the nearest edge of
// a letter, so the shader can redraw the edges sharp at any size and angle,
// and knows where the halo (HALO cm out from the letters, where a dot
// screen gives way) ends. Horizontal, the lines run along the paper;
// vertical, they read up the paper (the title then stands as the left
// column).
export const CAP = 1.4; // cm, cap height of both lines
const GAP = 0.7; // cm between the title and the year
export const HALO = 0.45; // cm around the text kept free of dots (more than the dot pitch)
const PAD = 0.6; // cm of clear paper around the text, beyond the halo's reach
const DENSITY = 32; // texture px per cm
export const SPREAD = 1.2; // cm of distance a texel can tell, either side of an edge (paper.frag.glsl agrees)
const CAP_RATIO = 0.72; // cap height over font size, for Helvetica
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

export interface LabelPrint {
  texture: THREE.DataTexture;
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
  ctx.fillStyle = '#fff';
  ctx.fillText(title, px(PAD), px(PAD + CAP));
  ctx.fillText(String(year), px(PAD), px(PAD + CAP + GAP + CAP));

  const field = distanceField(ctx.getImageData(0, 0, canvas.width, canvas.height));
  const texture = new THREE.DataTexture(field, canvas.width, canvas.height, THREE.RedFormat, THREE.UnsignedByteType);
  texture.flipY = true; // like a canvas: the first row at the top
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return { texture, ...labelSize(title, year, vertical), vertical };
}

// The signed distance to the letters' edges, from their coverage: 0.5 at an
// edge, towards 1 inside, towards 0 outside, a full SPREAD either way
// (Felzenszwalb & Huttenlocher's transform, as tiny-sdf applies it).
const INF = 1e20;
function distanceField({ data, width, height }: ImageData) {
  const size = width * height;
  const outer = new Float64Array(size);
  const inner = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const a = data[4 * i + 3] / 255;
    outer[i] = a === 1 ? 0 : a === 0 ? INF : Math.max(0, 0.5 - a) ** 2;
    inner[i] = a === 1 ? INF : a === 0 ? 0 : Math.max(0, a - 0.5) ** 2;
  }
  const longest = Math.max(width, height);
  const scratch = { f: new Float64Array(longest), v: new Int32Array(longest), z: new Float64Array(longest + 1) };
  transform(outer, width, height, scratch);
  transform(inner, width, height, scratch);
  const field = new Uint8Array(size);
  const spread = SPREAD * DENSITY; // px
  for (let i = 0; i < size; i++) {
    const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]); // px, positive outside
    field[i] = Math.round(255 * Math.min(1, Math.max(0, 0.5 - d / spread)));
  }
  return field;
}

type Scratch = { f: Float64Array; v: Int32Array; z: Float64Array };

// Squared distances to the nearest zero, in place, column by column then row by row.
function transform(grid: Float64Array, width: number, height: number, scratch: Scratch) {
  for (let x = 0; x < width; x++) transform1d(grid, x, width, height, scratch);
  for (let y = 0; y < height; y++) transform1d(grid, y * width, 1, width, scratch);
}

function transform1d(grid: Float64Array, offset: number, stride: number, length: number, { f, v, z }: Scratch) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    grid[offset + q * stride] = f[r] + (q - r) * (q - r);
  }
}
