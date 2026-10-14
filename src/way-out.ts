import type { Guide, Rail } from './strip-geometry.ts';

// The way a called-out sheet leaves the poster (PosterScene.callOut). The
// paper slides out lengthwise along its own path, so all there is to find is
// the way on from the end that goes first: a smooth line, carrying on from
// that end's own direction, out of the frame and clear of every other sheet,
// so the paper passes between the others and never through them (nor through
// itself). It may leave by a side; by the top, going back, away from the
// viewer, until it has risen out of the frame (the camera looks down on the
// floor, so what is further back stands higher in the frame); or by the
// bottom, coming forward until it has sunk below it. It crosses the edge at
// whatever slant the line has; it need not turn square to it.
//
// The line is one that simply carries on: from the end in its own direction,
// turning evenly for a while (or not at all) and then evenly again, or
// straight, until it is out of the frame. Of many such lines, the one that
// is seen least, shows itself over other paper least and turns least wins.
// Only if every one would touch paper is the way found across a grid
// instead, pulled taut and rounded off, a route that winds if it must.
//
// A way may also be drawn by hand (a sheet's `way`): from the end nearer its
// first point, as one curve rounding the drawing off (or a few meeting
// smoothly, where one would touch other paper), and on in its last direction
// until out of the frame. A sheet may also be told which end goes first (its
// `lead`).
//
// The poster is flat and has no shadows, so paper seen sliding in front of
// other paper reads as passing through it, while paper sliding behind other
// paper simply goes behind it, and what matters is how much of its going is
// seen. So the way is the cheapest across a fine grid over the floor: every
// cm travelled costs BASE, and every cm the frame shows the paper moving
// costs 1 more, OVER more where it is seen over another sheet, nothing more
// where it is hidden behind one or out of the frame (going back a cm moves
// the paper only sin(elevation) of a cm up the frame). Going straight back in
// sight costs EDGE_ON more a cm: the paper would show only its edge, a line
// shooting up, where going back at a slant it rises in an arc, its face to
// the viewer. Closer than CLEAR to other paper all but bars the way. So a sheet near an edge slips out by it, and one
// further in goes back through the gaps behind and rises out of the top, out
// of sight most of the way. A sheet may also be told which way to leave
// (its spec's `exit`), and then leaves only that way. The route, tried from
// both ends, is pulled taut and rounded off, and out of sight it runs straight
// on for as long as the paper is.
//
// Everything is in plan (x, z), in world space: the sheets stand upright, and
// the camera is not turned, so x is across the frame and further back is
// higher up it.

const CLEAR = 2; // cm the way out keeps from other paper, and from its own away from the end
const OWN_NEAR = 6; // cm of its own paper next to the end that the way out may run close to
const LEAD_IN = 3; // cm the way out first carries on in the end's own direction
const SPLIT_FROM = 8; // cm from the end within which a drawn way is not split, so it turns off the paper's own direction roundly
const TIGHTEST = 0.4; // radians a cm a drawn way split to clear paper may turn at most (or as much as unsplit), else it stays whole
const REACH_SHARES = [0.12, 0.2, 0.3, 0.4, 0.5, 0.65, 0.8, 1, 1.3]; // of a drawn way's span, tried for its curve's two reaches
const WAVER = 80; // cm a drawn way's curve may run further from the drawing to save a radian of turning back
const TIGHT = 150; // cm it may run further to turn a radian a cm less tightly at its tightest
const PAST = 4; // cm past the frame's edge where the way out straightens
const CELL = 1; // cm, the grid the way is found on
const BASE = 0.4; // cost of a cm travelled, seen or not
const OVER = 10; // cost of a cm the frame shows the paper moving over another sheet, against 1 for one it simply shows
const EDGE_ON = 2.5; // cost of a cm going straight back, in sight
const BARRED = 400; // cost of a cm too close to other paper: only when there is no other way
const TURNING = 12; // cm of length a radian of turning weighs as much as, choosing between the ends
const ROUNDING = 3; // times the taut route is rounded off (fewer where rounding would touch paper)
const UPRIGHT = 15; // cm over which a slanted end straightens up on the way out
const BENDS = [0, 0.006, -0.006, 0.014, -0.014, 0.025, -0.025, 0.04, -0.04, 0.06, -0.06]; // radians a cm the line turns
const SPANS = [6, 15, 30, 50, 80]; // cm of the line's first, even turn, before its second
const LONGEST = 450; // cm a line may run before it has to be out
const GRID = 2; // cm, the cells other paper is filed in for nearness

type Edges = Pick<Guide, 'bottom' | 'top'>;
type Point = [number, number];
export type Exit = 'left' | 'right' | 'top' | 'bottom';

// The frame the poster is seen in: its half size in cm, and how many degrees
// the camera looks down.
export interface Frame {
  halfWidth: number;
  halfHeight: number;
  elevation: number;
}

// What a sheet may be told about its way out (see SheetSpec): which way to
// leave, a way drawn by hand, which end goes first.
export interface Told {
  exit?: Exit;
  way?: Point[];
  lead?: Rail['lead'];
}

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

// A binary heap of grid cells by cost, for the cheapest-way search.
class Queue {
  private readonly cells: number[] = [];
  private readonly costs: number[] = [];
  get size() {
    return this.cells.length;
  }
  push(cell: number, cost: number) {
    let i = this.cells.length;
    this.cells.push(cell);
    this.costs.push(cost);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.costs[parent] <= cost) break;
      this.cells[i] = this.cells[parent];
      this.costs[i] = this.costs[parent];
      i = parent;
    }
    this.cells[i] = cell;
    this.costs[i] = cost;
  }
  pop() {
    const top = this.cells[0];
    const cell = this.cells.pop()!;
    const cost = this.costs.pop()!;
    if (this.cells.length > 0) {
      let i = 0;
      for (;;) {
        const [l, r] = [2 * i + 1, 2 * i + 2];
        let m = i;
        let mc = cost;
        if (l < this.cells.length && this.costs[l] < mc) [m, mc] = [l, this.costs[l]];
        if (r < this.cells.length && this.costs[r] < mc) [m, mc] = [r, this.costs[r]];
        if (m === i) break;
        this.cells[i] = this.cells[m];
        this.costs[i] = this.costs[m];
        i = m;
      }
      this.cells[i] = cell;
      this.costs[i] = cost;
    }
    return top;
  }
}

// Corners cut off a line, its two ends kept: each pass makes it rounder.
function round(line: Point[], passes: number) {
  let points = line;
  for (let pass = 0; pass < passes; pass++) {
    const next: Point[] = [points[0]];
    for (let i = 0; i < points.length - 1; i++) {
      const [[x0, z0], [x1, z1]] = [points[i], points[i + 1]];
      if (i > 0) next.push([0.75 * x0 + 0.25 * x1, 0.75 * z0 + 0.25 * z1]);
      if (i < points.length - 2) next.push([0.25 * x0 + 0.75 * x1, 0.25 * z0 + 0.75 * z1]);
    }
    next.push(points[points.length - 1]);
    points = next;
  }
  return points;
}

// A point a share t along a cubic Bézier.
const bezier = (p: Point[], t: number): Point => {
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0], a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1]];
};

function turningOf(line: Point[]) {
  let turning = 0;
  for (let i = 2; i < line.length; i++) {
    const a = Math.atan2(line[i - 1][1] - line[i - 2][1], line[i - 1][0] - line[i - 2][0]);
    const b = Math.atan2(line[i][1] - line[i - 1][1], line[i][0] - line[i - 1][0]);
    turning += Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
  }
  return turning;
}

export function wayOut(own: Edges, others: Edges[], frame: Frame, ds: number, told: Told = {}) {
  const { exit: only, way: drawn, lead: leading } = told;
  const n = own.bottom.length / 3 - 1;
  const half = frame.halfWidth;
  const look = (frame.elevation * Math.PI) / 180;
  // How high in the frame a point stands.
  const up = (y: number, z: number) => y * Math.cos(look) - z * Math.sin(look);
  // How far a move of dx across and dz back goes as the frame shows it.
  const onScreen = (dx: number, dz: number) => Math.hypot(dx, dz * Math.sin(look));
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
  let front = -Infinity; // cm, the foremost paper
  for (const other of others) {
    const [olo, ohi] = span(other);
    for (let i = 2; i < other.bottom.length; i += 3) front = Math.max(front, other.bottom[i]);
    if (ohi < lo || olo > hi) continue;
    for (const edge of [other.bottom, other.top]) for (let i = 0; i < edge.length; i += 6) plan.add(edge[i], edge[i + 2], -1);
  }
  for (const edge of [own.bottom, own.top]) {
    for (let i = 0; i <= n; i += 2) {
      plan.add(edge[3 * i], edge[3 * i + 2], i);
      front = Math.max(front, edge[3 * i + 2]);
    }
  }

  // All other paper as the frame shows it, filed by the cm across: where it
  // stands back and how high it reaches up the frame, bottom edge to top.
  const shown = new Map<number, { z: number; low: number; high: number }[]>();
  for (const other of others) {
    for (let i = 0; i < other.bottom.length; i += 6) {
      const [x, y0, z] = [other.bottom[i], other.bottom[i + 1], other.bottom[i + 2]];
      const [y1, z1] = [other.top[i + 1], other.top[i + 2]];
      const key = Math.round(x);
      let list = shown.get(key);
      if (!list) shown.set(key, (list = []));
      list.push({ z: Math.max(z, z1), low: up(y0, z), high: up(y1, z1) });
    }
  }

  // One end of the paper: where it is, which way it points (outwards, over
  // its last few stations), how high its edges stand, and where, for paper
  // leaving from it, the frame has been left.
  const endOf = (lead: Rail['lead']) => {
    const end = lead === 'tip' ? n : 0;
    const back = lead === 'tip' ? Math.max(0, n - 10) : Math.min(n, 10);
    const [ex, ez] = at(own.bottom, end);
    const [bx, bz] = at(own.bottom, back);
    const dl = Math.hypot(ex - bx, ez - bz) || 1;
    const yb = own.bottom[3 * end + 1];
    const yt = own.top[3 * end + 1];
    const out = (x: number, z: number): Exit | null =>
      up(yb, z) > frame.halfHeight + PAST
        ? 'top'
        : up(yt, z) < -frame.halfHeight - PAST
          ? 'bottom'
          : x > half + PAST
            ? 'right'
            : x < -half - PAST
              ? 'left'
              : null;
    return { end, ex, ez, tx: (ex - bx) / dl, tz: (ez - bz) / dl, yb, yt, out };
  };

  type Option = { cost: number; lead: Rail['lead']; exit: Exit; line: Point[] };
  let best: Option | null = null;

  // Drawn by hand: from the end nearer its first point (or the end it is told
  // to lead with), leaving in its own direction, as one curve to the
  // drawing's last point, arriving the way the drawing last went, then on
  // that way until out of the frame. The curve rounds the drawing off instead
  // of following every wobble of the hand: of cubics with a range of reaches,
  // the one that runs closest to the drawn points wins, but a cubic that
  // bends first one way and then the other (WAVER) or turns tightly anywhere
  // (TIGHT) pays for it, so it turns one way, roundly, even where the end
  // points elsewhere than the drawing. Only where that curve would touch
  // other paper is it split, at the drawn point it strays furthest from, into
  // two that meet there going the way the drawing goes there, and so on: a
  // drawing that threads a gap is followed through it.
  if (drawn && drawn.length > 0) {
    const [x0, z0] = drawn[0];
    const [tip, anchor] = [at(own.bottom, n), at(own.bottom, 0)];
    const lead =
      leading ?? (Math.hypot(x0 - tip[0], z0 - tip[1]) <= Math.hypot(x0 - anchor[0], z0 - anchor[1]) ? 'tip' : 'anchor');
    const { end, ex, ez, tx, tz, out } = endOf(lead);
    const near = Math.round(OWN_NEAR / ds);
    const skip = (tag: number) => tag >= 0 && Math.abs(tag - end) <= near;
    const touches = (curve: Point[]) =>
      curve.some(([x, z]) => Math.hypot(x - ex, z - ez) > LEAD_IN && plan.nearest(x, z, CLEAR, skip) < CLEAR);
    const towards = (p: Point, q: Point): Point => {
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      return [(q[0] - p[0]) / l, (q[1] - p[1]) / l];
    };
    // One cubic from a, leaving along ta, to b, arriving along tb, rounding
    // off the drawn points on the way; and how far it runs from each.
    const fit = (a: Point, ta: Point, b: Point, tb: Point, points: Point[]) => {
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let [line, misses, error] = [[] as Point[], [] as number[], Infinity];
      for (const ra of REACH_SHARES) {
        for (const rb of REACH_SHARES) {
          const control: Point[] = [
            a,
            [a[0] + ta[0] * ra * chord, a[1] + ta[1] * ra * chord],
            [b[0] - tb[0] * rb * chord, b[1] - tb[1] * rb * chord],
            b,
          ];
          const samples = Math.max(2, Math.ceil(chord * 1.5));
          const curve: Point[] = [];
          for (let i = 0; i <= samples; i++) curve.push(bezier(control, i / samples));
          const away = points.map(([x, z]) => Math.min(...curve.map(([cx, cz]) => Math.hypot(cx - x, cz - z))));
          // How it turns: in all, all told one way, and at its tightest.
          let [all, net, tightest] = [0, 0, 0];
          for (let i = 2; i < curve.length; i++) {
            const h0 = Math.atan2(curve[i - 1][1] - curve[i - 2][1], curve[i - 1][0] - curve[i - 2][0]);
            const h1 = Math.atan2(curve[i][1] - curve[i - 1][1], curve[i][0] - curve[i - 1][0]);
            const turn = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0));
            const length = Math.hypot(curve[i][0] - curve[i - 1][0], curve[i][1] - curve[i - 1][1]) || 1e-6;
            [all, net, tightest] = [all + Math.abs(turn), net + turn, Math.max(tightest, Math.abs(turn) / length)];
          }
          const score = Math.max(...away) + WAVER * (all - Math.abs(net)) + TIGHT * tightest;
          if (score < error) [line, misses, error] = [curve, away, score];
        }
      }
      return { line, misses };
    };
    // How tightly a line turns at its tightest, radians a cm.
    const tightness = (line: Point[]) => {
      let tightest = 0;
      for (let i = 2; i < line.length; i++) {
        const h0 = Math.atan2(line[i - 1][1] - line[i - 2][1], line[i - 1][0] - line[i - 2][0]);
        const h1 = Math.atan2(line[i][1] - line[i - 1][1], line[i][0] - line[i - 1][0]);
        const length = Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]) || 1e-6;
        tightest = Math.max(tightest, Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0))) / length);
      }
      return tightest;
    };
    // Through the drawn points from a, split where one curve touches paper
    // (never near the end, where it is still turning off the paper's own way,
    // and not where the pieces would turn more tightly than TIGHTEST).
    const follow = (a: Point, ta: Point, points: Point[], tb: Point): Point[] => {
      const { line, misses } = fit(a, ta, points[points.length - 1], tb, points);
      if (points.length < 2 || !touches(line)) return line;
      let k = -1;
      for (let i = 0; i < points.length - 1; i++) {
        if (Math.hypot(points[i][0] - ex, points[i][1] - ez) < SPLIT_FROM) continue;
        if (k < 0 || misses[i] > misses[k]) k = i;
      }
      if (k < 0) return line;
      const tk = towards(k > 0 ? points[k - 1] : a, points[k + 1]);
      const split = [...follow(a, ta, points.slice(0, k + 1), tk), ...follow(points[k], tk, points.slice(k + 1), tb).slice(1)];
      return tightness(split) <= Math.max(TIGHTEST, tightness(line)) ? split : line;
    };
    const last = drawn[drawn.length - 1];
    const [dx, dz] = towards(drawn.length > 1 ? drawn[drawn.length - 2] : [ex, ez], last);
    const line = follow([ex, ez], [tx, tz], drawn, [dx, dz]);
    let at0 = line.findIndex(([x, z]) => out(x, z));
    if (at0 >= 0) line.length = at0 + 1;
    let [lx, lz] = line[line.length - 1];
    for (let k = 0; at0 < 0 && k < LONGEST; k++) {
      [lx, lz] = [lx + dx, lz + dz];
      line.push([lx, lz]);
      if (out(lx, lz)) at0 = line.length - 1;
    }
    line.push([lx + dx * 10, lz + dz * 10]);
    best = { cost: 0, lead, exit: out(...line[line.length - 2]) ?? 'top', line };
  }

  for (const lead of best ? [] : leading ? [leading] : (['tip', 'anchor'] as const)) {
    const { end, ex, ez, tx, tz, yb, yt, out } = endOf(lead);
    const near = Math.round(OWN_NEAR / ds);
    const skip = (tag: number) => tag >= 0 && Math.abs(tag - end) <= near;
    const zTop = (yb * Math.cos(look) - frame.halfHeight - PAST) / Math.sin(look);
    const zBottom = (yt * Math.cos(look) + frame.halfHeight + PAST) / Math.sin(look);

    // Still in sight there: inside the side edges, not yet risen past the top
    // nor sunk below the bottom.
    const inSight = (x: number, z: number) =>
      Math.abs(x) <= half + 1 && up(yb, z) <= frame.halfHeight + 1 && up(yt, z) >= -frame.halfHeight - 1;
    // How the frame shows the paper there: over another sheet (in front of it
    // and overlapping it), hidden behind one (one in front of it covering most
    // of its height), or just seen.
    const seen = (x: number, z: number) => {
      const [low, high] = [up(yb, z), up(yt, z)];
      let over = false;
      for (let key = Math.round(x) - 1; key <= Math.round(x) + 1; key++) {
        for (const o of shown.get(key) ?? []) {
          if (o.high < low || o.low > high) continue;
          if (o.z > z + 1 && Math.min(o.high, high) - Math.max(o.low, low) >= 0.8 * (high - low)) return 'hidden';
          if (z > o.z + 1) over = true;
        }
      }
      return over ? 'over' : 'seen';
    };

    // The grid: across the frame and a little past its sides, from where the
    // paper has sunk below the bottom back to where it has risen out of the top.
    const [x0, x1] = [-half - PAST - 2 * CELL, half + PAST + 2 * CELL];
    const [z0, z1] = [Math.min(zTop, ez) - 2 * CELL, Math.max(zBottom, front, ez) + 2 * CELL];
    const cols = Math.ceil((x1 - x0) / CELL) + 1;
    const rows = Math.ceil((z1 - z0) / CELL) + 1;
    const xOf = (c: number) => x0 + (c % cols) * CELL;
    const zOf = (c: number) => z0 + Math.floor(c / cols) * CELL;
    const cellAt = (x: number, z: number) =>
      Math.min(rows - 1, Math.max(0, Math.round((z - z0) / CELL))) * cols + Math.min(cols - 1, Math.max(0, Math.round((x - x0) / CELL)));
    // What a cm the frame shows costs in each cell, BARRED added where too
    // close to paper; NaN until asked. Told which way to leave, the paper may
    // not slip round out of sight beyond another edge either.
    const price = new Float32Array(cols * rows).fill(NaN);
    const priceOf = (c: number) => {
      if (!Number.isNaN(price[c])) return price[c];
      const [x, z] = [xOf(c), zOf(c)];
      const beyond =
        Math.abs(x) > half ? (x > 0 ? 'right' : 'left') : up(yb, z) > frame.halfHeight ? 'top' : up(yt, z) < -frame.halfHeight ? 'bottom' : null;
      if (only && beyond && beyond !== only) return (price[c] = BARRED);
      if (!inSight(x, z)) return (price[c] = 0);
      const how = seen(x, z);
      let p = how === 'over' ? OVER : how === 'hidden' ? 0 : 1;
      if (Math.hypot(x - ex, z - ez) > LEAD_IN && plan.nearest(x, z, CLEAR, skip) < CLEAR) p += BARRED;
      return (price[c] = p);
    };
    // A move of dx across and dz back, through cells priced p and q.
    const moveCost = (dx: number, dz: number, p: number, q: number) => {
      const length = Math.hypot(dx, dz);
      const straightBack = p > 0 && q > 0 && length > 0 ? EDGE_ON * Math.abs(dz) * (dz / length) ** 2 : 0;
      return BASE * length + onScreen(dx, dz) * 0.5 * (p + q) + straightBack;
    };

    // What a straight move from a to b costs, the cells along it sampled.
    const lineCost = (a: Point, b: Point) => {
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL / 2)));
      let price = 0;
      for (let s = 0; s < steps; s++) {
        const f = (s + 0.5) / steps;
        price += priceOf(cellAt(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f));
      }
      return moveCost(b[0] - a[0], b[1] - a[1], price / steps, price / steps);
    };
    const paid = (line: Point[]) => line.slice(1).reduce((sum, b, i) => sum + lineCost(line[i], b), 0);

    // A line that carries on from the end: turning `first` radians a cm for
    // `span` cm, then `then` a cm, until it is out of the frame; given up once
    // it touches paper, costs more than `budget`, runs too long, or leaves the
    // wrong way.
    const carryOn = (first: number, span: number, then: number, budget: number) => {
      const points: Point[] = [[ex, ez]];
      let [x, z, heading, cost] = [ex, ez, Math.atan2(tz, tx), 0];
      for (let s = 1; s <= LONGEST; s++) {
        const turn = s <= span ? first : then;
        heading += turn;
        const [px, pz] = [x, z];
        x += Math.cos(heading);
        z += Math.sin(heading);
        points.push([x, z]);
        if (priceOf(cellAt(x, z)) >= BARRED) return null;
        cost += lineCost([px, pz], [x, z]) + TURNING * Math.abs(turn);
        if (cost > budget) return null;
        const exit = out(x, z);
        if (exit) return only && exit !== only ? null : { points, exit, cost };
      }
      return null;
    };
    let smooth: { points: Point[]; exit: Exit; cost: number } | null = null;
    for (const first of BENDS) {
      for (const span of SPANS) {
        for (const then of BENDS) {
          if (then === first && span !== SPANS[0]) continue; // the same line again
          const line = carryOn(first, span, then, smooth?.cost ?? Infinity);
          if (line) smooth = line;
        }
      }
    }
    // The cheapest of them is the way, if there is one that touches no paper.
    if (smooth) {
      const [lx, lz] = smooth.points[smooth.points.length - 1];
      const [px, pz] = smooth.points[smooth.points.length - 2];
      const line: Point[] = [...smooth.points, [lx + (lx - px) * 10, lz + (lz - pz) * 10]];
      if (!best || smooth.cost < best.cost) best = { cost: smooth.cost, lead, exit: smooth.exit, line };
      continue;
    }

    // Otherwise the cheapest way across the grid, from just past the end to
    // anywhere out of the frame.
    const start = cellAt(ex + tx * LEAD_IN, ez + tz * LEAD_IN);
    const spent = new Float64Array(cols * rows).fill(Infinity);
    const from = new Int32Array(cols * rows).fill(-1);
    const queue = new Queue();
    spent[start] = 0;
    queue.push(start, 0);
    let goal = -1;
    while (queue.size > 0) {
      const c = queue.pop();
      const exit = out(xOf(c), zOf(c));
      if (exit && (!only || exit === only)) {
        goal = c;
        break;
      }
      if (exit) continue; // out the wrong way: no going on from there
      const [col, row] = [c % cols, Math.floor(c / cols)];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!dr && !dc) continue;
          const [nc, nr] = [col + dc, row + dr];
          if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const next = nr * cols + nc;
          const cost = spent[c] + moveCost(dc * CELL, dr * CELL, priceOf(c), priceOf(next));
          if (cost < spent[next]) {
            spent[next] = cost;
            from[next] = c;
            queue.push(next, cost);
          }
        }
      }
    }
    if (goal < 0) continue;
    const cells: number[] = [];
    for (let c = goal; c >= 0; c = from[c]) cells.unshift(c);

    // Pulled taut: each point joins the farthest one after it that a straight
    // line reaches for no more than the grid route paid.
    const route: Point[] = cells.map((c) => [xOf(c), zOf(c)]);
    const taut: Point[] = [route[0]];
    for (let i = 0; i < route.length - 1; ) {
      let j = route.length - 1;
      for (; j > i + 1; j--) if (lineCost(route[i], route[j]) <= spent[cells[j]] - spent[cells[i]] + 0.5) break;
      taut.push(route[j]);
      i = j;
    }

    // From the end itself, in its own direction, then the taut route, then
    // on out of sight the way it left; rounded off as much as clears paper.
    const exit = out(...taut[taut.length - 1])!;
    const [lx, lz] = taut[taut.length - 1];
    const [px, pz] = taut.length > 1 ? taut[taut.length - 2] : [ex, ez];
    const away = Math.hypot(lx - px, lz - pz) || 1;
    const raw: Point[] = [[ex, ez], ...taut, [lx + ((lx - px) / away) * 10, lz + ((lz - pz) / away) * 10]];
    let line = raw;
    for (let passes = ROUNDING; passes > 0; passes--) {
      const rounder = round(raw, passes);
      if (paid(rounder) <= paid(raw) * 1.05 + 1) {
        line = rounder;
        break;
      }
    }
    const cost = paid(line) + TURNING * turningOf(line);
    if (!best || cost < best.cost) best = { cost, lead, exit, line };
  }
  const { lead, exit, line } = best!;

  // The way out, a station's length apart, then straight on past the edge.
  const end = lead === 'tip' ? n : 0;
  const yb = own.bottom[3 * end + 1];
  const yt = own.top[3 * end + 1];
  const [lx, lz] = line[line.length - 1];
  const [qx, qz] = line[line.length - 2];
  const reach = Math.hypot(lx - qx, lz - qz) || 1;
  const run: Point = [(lx - qx) / reach, (lz - qz) / reach]; // on as it left
  const gone = ([x, z]: Point) =>
    up(yb, z) > frame.halfHeight + PAST || up(yt, z) < -frame.halfHeight - PAST || Math.abs(x) > half + PAST;
  const straight = n * ds + 2 * PAST;
  const along: Point[] = [...line, [lx + run[0] * straight, lz + run[1] * straight]];
  const outward: Point[] = [];
  let edgeAt = 0; // stations of the way out until it is out of the frame
  {
    let s = 0;
    let want = ds;
    for (let k = 1; k < along.length; k++) {
      const [ax, az] = along[k - 1];
      const [bx, bz] = along[k];
      const step = Math.hypot(bx - ax, bz - az);
      while (want <= s + step) {
        const f = (want - s) / step;
        outward.push([ax + (bx - ax) * f, az + (bz - az) * f]);
        if (!edgeAt && gone(outward[outward.length - 1])) edgeAt = outward.length;
        want += ds;
      }
      s += step;
    }
  }

  // Both edges: the paper's own stations in the order it travels them, then
  // the way out, the top edge straightening up over its first stretch.
  const m = outward.length;
  const bottom = new Float32Array((n + 1 + m) * 3);
  const top = new Float32Array((n + 1 + m) * 3);
  for (let i = 0; i <= n; i++) {
    const from = lead === 'tip' ? i : n - i;
    bottom.set(own.bottom.subarray(3 * from, 3 * from + 3), 3 * i);
    top.set(own.top.subarray(3 * from, 3 * from + 3), 3 * i);
  }
  const [ox, oz] = [own.top[3 * end] - own.bottom[3 * end], own.top[3 * end + 2] - own.bottom[3 * end + 2]];
  outward.forEach(([x, z], k) => {
    const t = Math.min(1, ((k + 1) * ds) / UPRIGHT);
    const lean = 1 - t * t * (3 - 2 * t);
    bottom.set([x, yb, z], 3 * (n + 1 + k));
    top.set([x + ox * lean, yt, z + oz * lean], 3 * (n + 1 + k));
  });

  // How far it travels: until the end that comes last is out of the frame.
  const travel = (n + (edgeAt || m)) * ds;
  const rail: Rail = { bottom, top, lead };
  return { rail, travel, exit };
}
