import type { Guide, Rail } from './strip-geometry.ts';

// The way a called-out sheet leaves the poster (PosterScene.callOut). The
// paper slides out lengthwise along its own path, so all there is to find is
// the way on from the end that goes first: a smooth line, carrying on from
// that end's own direction, out through the left or right edge of the frame
// and clear of every other sheet, so the paper passes between the others and
// never through them (nor through itself). Each end is tried, through each
// edge, at a range of depths and holding its own direction for a range of
// lengths; of the clear ones, the shortest and least turning wins. Past the
// edge, out of sight, it runs straight on for as long as the paper is.
//
// Everything is in plan (x, z), in world space: the sheets stand upright on
// the floor, and the camera is not turned, so x is across the frame.

const CLEAR = 2; // cm the way out keeps from other paper, and from its own away from the end
const OWN_NEAR = 6; // cm of its own paper next to the end that the way out may run close to
const START = 1; // cm from the end before the way out is checked at all
const PAST = 4; // cm past the frame's edge where the way out straightens
const LANES = [0, 3, -3, 6, -6, 10, -10, 15, -15, 22, -22, 30, -30, 40, -40]; // cm, depth at the edge, from the end's
const REACHES = [6, 14, 28]; // cm the way out holds the end's own direction
const TURNING = 12; // cm of length a radian of turning weighs as much as
const DRIFT = 0.4; // cm of length a cm of depth weighs as much as
const UPRIGHT = 15; // cm over which a slanted end straightens up on the way out
const SAMPLES = 160; // per curve, for checking and measuring
const GRID = 2; // cm, the cells other paper is filed in

type Edges = Pick<Guide, 'bottom' | 'top'>;
type Point = [number, number];

// Paper in plan, filed by cell, so the paper near a point is quick to find.
class Plan {
  private readonly cells = new Map<number, number[]>();
  readonly x: number[] = [];
  readonly z: number[] = [];
  readonly tag: number[] = [];
  private key = (i: number, j: number) => i * 92821 + j;
  add(x: number, z: number, tag: number) {
    const k = this.key(Math.floor(x / GRID), Math.floor(z / GRID));
    let cell = this.cells.get(k);
    if (!cell) this.cells.set(k, (cell = []));
    cell.push(this.x.length);
    this.x.push(x);
    this.z.push(z);
    this.tag.push(tag);
  }
  // Distance to the nearest paper within `reach` (or `reach` if none), not counting what `skip` rules out.
  nearest(x: number, z: number, reach: number, skip?: (tag: number) => boolean) {
    const r = Math.ceil(reach / GRID);
    const [ci, cj] = [Math.floor(x / GRID), Math.floor(z / GRID)];
    let best = reach * reach;
    for (let i = ci - r; i <= ci + r; i++) {
      for (let j = cj - r; j <= cj + r; j++) {
        for (const p of this.cells.get(this.key(i, j)) ?? []) {
          if (skip?.(this.tag[p])) continue;
          const d = (this.x[p] - x) ** 2 + (this.z[p] - z) ** 2;
          if (d < best) best = d;
        }
      }
    }
    return Math.sqrt(best);
  }
}

const bezier = (p: Point[], t: number): Point => {
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0], a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1]];
};

export function wayOut(own: Edges, others: Edges[], half: number, ds: number) {
  const n = own.bottom.length / 3 - 1;
  const at = (edge: Float32Array, i: number): Point => [edge[3 * i], edge[3 * i + 2]];
  const span = (e: Edges) => {
    let [lo, hi] = [Infinity, -Infinity];
    for (const edge of [e.bottom, e.top])
      for (let i = 1; i < edge.length; i += 3) [lo, hi] = [Math.min(lo, edge[i]), Math.max(hi, edge[i])];
    return [lo, hi];
  };

  // Other paper at the height this sheet stands at; and its own, tagged by station.
  const [lo, hi] = span(own);
  const plan = new Plan();
  for (const other of others) {
    const [olo, ohi] = span(other);
    if (ohi < lo || olo > hi) continue;
    for (const edge of [other.bottom, other.top]) for (let i = 0; i < edge.length; i += 6) plan.add(edge[i], edge[i + 2], -1);
  }
  for (const edge of [own.bottom, own.top]) for (let i = 0; i <= n; i += 2) plan.add(edge[3 * i], edge[3 * i + 2], i);

  type Option = { cost: number; lead: Rail['lead']; side: 1 | -1; curve: Point[]; clear: number };
  let best: Option | null = null;
  let roomiest: Option | null = null;
  for (const lead of ['tip', 'anchor'] as const) {
    const end = lead === 'tip' ? n : 0;
    const near = Math.round(OWN_NEAR / ds);
    const skip = (tag: number) => tag >= 0 && Math.abs(tag - end) <= near;
    // The end's own direction, outwards, over its last few stations.
    const back = lead === 'tip' ? Math.max(0, n - 10) : Math.min(n, 10);
    const [ex, ez] = at(own.bottom, end);
    const [bx, bz] = at(own.bottom, back);
    const dl = Math.hypot(ex - bx, ez - bz) || 1;
    const [tx, tz] = [(ex - bx) / dl, (ez - bz) / dl];

    for (const side of [1, -1] as const) {
      const x3 = side * Math.max(half + PAST, side * ex + 4);
      for (const lane of LANES) {
        for (const reach of REACHES) {
          const z3 = ez + lane;
          const pull = Math.max(6, Math.abs(x3 - ex) * 0.45);
          const control: Point[] = [
            [ex, ez],
            [ex + tx * reach, ez + tz * reach],
            [x3 - side * pull, z3],
            [x3, z3],
          ];
          const curve: Point[] = [];
          for (let s = 0; s <= SAMPLES; s++) curve.push(bezier(control, s / SAMPLES));

          let length = 0;
          let turning = 0;
          let clear = Infinity;
          let heading = Math.atan2(tz, tx);
          for (let s = 1; s <= SAMPLES; s++) {
            const [x0, z0] = curve[s - 1];
            const [x1, z1] = curve[s];
            const step = Math.hypot(x1 - x0, z1 - z0);
            length += step;
            if (step > 1e-6) {
              const h = Math.atan2(z1 - z0, x1 - x0);
              turning += Math.abs(Math.atan2(Math.sin(h - heading), Math.cos(h - heading)));
              heading = h;
            }
            if (length < START || Math.abs(x1) > half + 1) continue;
            clear = Math.min(clear, plan.nearest(x1, z1, CLEAR * 3, skip));
          }
          const cost = length + TURNING * turning + DRIFT * Math.abs(lane);
          const option: Option = { cost, lead, side, curve, clear };
          if (clear >= CLEAR && (!best || cost < best.cost)) best = option;
          if (!roomiest || clear > roomiest.clear || (clear === roomiest.clear && cost < roomiest.cost)) roomiest = option;
        }
      }
    }
  }
  const { lead, side, curve } = (best ?? roomiest)!;

  // The way out, a station's length apart, then straight on past the edge.
  const end = lead === 'tip' ? n : 0;
  const [x3, z3] = curve[curve.length - 1];
  const along: Point[] = [...curve, [x3 + side * (n * ds + 2 * PAST), z3]];
  const out: Point[] = [];
  let edgeAt = 0; // stations of the way out until it is past the frame's edge
  {
    let s = 0;
    let want = ds;
    for (let k = 1; k < along.length; k++) {
      const [x0, z0] = along[k - 1];
      const [x1, z1] = along[k];
      const step = Math.hypot(x1 - x0, z1 - z0);
      while (want <= s + step) {
        const f = (want - s) / step;
        out.push([x0 + (x1 - x0) * f, z0 + (z1 - z0) * f]);
        if (!edgeAt && side * out[out.length - 1][0] > half + PAST) edgeAt = out.length;
        want += ds;
      }
      s += step;
    }
  }

  // Both edges: the paper's own stations in the order it travels them, then
  // the way out, the top edge straightening up over its first stretch.
  const m = out.length;
  const bottom = new Float32Array((n + 1 + m) * 3);
  const top = new Float32Array((n + 1 + m) * 3);
  for (let i = 0; i <= n; i++) {
    const from = lead === 'tip' ? i : n - i;
    bottom.set(own.bottom.subarray(3 * from, 3 * from + 3), 3 * i);
    top.set(own.top.subarray(3 * from, 3 * from + 3), 3 * i);
  }
  const yb = own.bottom[3 * end + 1];
  const yt = own.top[3 * end + 1];
  const [ox, oz] = [own.top[3 * end] - own.bottom[3 * end], own.top[3 * end + 2] - own.bottom[3 * end + 2]];
  out.forEach(([x, z], k) => {
    const t = Math.min(1, ((k + 1) * ds) / UPRIGHT);
    const lean = 1 - t * t * (3 - 2 * t);
    bottom.set([x, yb, z], 3 * (n + 1 + k));
    top.set([x + ox * lean, yt, z + oz * lean], 3 * (n + 1 + k));
  });

  // How far it travels: until the end that comes last is past the edge.
  const travel = (n + (edgeAt || m)) * ds;
  const rail: Rail = { bottom, top, lead };
  return { rail, travel, side };
}
