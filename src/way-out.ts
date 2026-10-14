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
// first point, through its points as one rounded line, and on in its last
// direction until out of the frame.
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
const TURN_IN = 12; // cm more it carries on before a drawn way turning square from it
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

// A rounded line through the points (centripetal Catmull-Rom), a point
// about every cm.
function spline(points: Point[]): Point[] {
  const at = (i: number): Point =>
    i < 0
      ? [2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]]
      : i >= points.length
        ? [2 * points[points.length - 1][0] - points[points.length - 2][0], 2 * points[points.length - 1][1] - points[points.length - 2][1]]
        : points[i];
  const knot = (a: Point, b: Point) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-4;
  const mix = (a: Point, b: Point, ta: number, tb: number, t: number): Point => {
    const [u, v] = [(tb - t) / (tb - ta), (t - ta) / (tb - ta)];
    return [u * a[0] + v * b[0], u * a[1] + v * b[1]];
  };
  const line: Point[] = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const steps = Math.max(1, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1])));
    for (let k = 1; k <= steps; k++) {
      const t = t1 + ((t2 - t1) * k) / steps;
      const a1 = mix(p0, p1, 0, t1, t);
      const a2 = mix(p1, p2, t1, t2, t);
      const a3 = mix(p2, p3, t2, t3, t);
      const b1 = mix(a1, a2, 0, t2, t);
      const b2 = mix(a2, a3, t1, t3, t);
      line.push(mix(b1, b2, t1, t2, t));
    }
  }
  return line;
}

function turningOf(line: Point[]) {
  let turning = 0;
  for (let i = 2; i < line.length; i++) {
    const a = Math.atan2(line[i - 1][1] - line[i - 2][1], line[i - 1][0] - line[i - 2][0]);
    const b = Math.atan2(line[i][1] - line[i - 1][1], line[i][0] - line[i - 1][0]);
    turning += Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
  }
  return turning;
}

export function wayOut(own: Edges, others: Edges[], frame: Frame, ds: number, only?: Exit, drawn?: Point[]) {
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

  // Drawn by hand: from the end nearer its first point, in its own direction
  // and through the points as one rounded line, then on the way it last went
  // until out of the frame.
  if (drawn && drawn.length > 0) {
    const [x0, z0] = drawn[0];
    const [tip, anchor] = [at(own.bottom, n), at(own.bottom, 0)];
    const lead = Math.hypot(x0 - tip[0], z0 - tip[1]) <= Math.hypot(x0 - anchor[0], z0 - anchor[1]) ? 'tip' : 'anchor';
    const { ex, ez, tx, tz, out } = endOf(lead);
    // The sharper the turn from the end's own direction onto the drawing,
    // the longer the paper carries on first, so it bends round, not over.
    const from = drawn.find(([x, z]) => Math.hypot(x - ex, z - ez) >= 4) ?? drawn[drawn.length - 1];
    const turn = Math.abs(Math.atan2(tx * (from[1] - ez) - tz * (from[0] - ex), tx * (from[0] - ex) + tz * (from[1] - ez)));
    const lead_in = LEAD_IN + TURN_IN * Math.min(1, turn / (Math.PI / 2));
    const onward = drawn.filter(([x, z]) => Math.hypot(x - ex, z - ez) >= lead_in + LEAD_IN);
    const line = spline([[ex, ez], [ex + tx * lead_in, ez + tz * lead_in], ...(onward.length ? onward : drawn.slice(-1))]);
    let at0 = line.findIndex(([x, z]) => out(x, z));
    if (at0 >= 0) line.length = at0 + 1;
    const [qx, qz] = line[line.length - 2];
    let [lx, lz] = line[line.length - 1];
    const step = Math.hypot(lx - qx, lz - qz) || 1;
    const [dx, dz] = [(lx - qx) / step, (lz - qz) / step];
    for (let k = 0; at0 < 0 && k < LONGEST; k++) {
      [lx, lz] = [lx + dx, lz + dz];
      line.push([lx, lz]);
      if (out(lx, lz)) at0 = line.length - 1;
    }
    line.push([lx + dx * 10, lz + dz * 10]);
    best = { cost: 0, lead, exit: out(...line[line.length - 2]) ?? 'top', line };
  }

  for (const lead of best ? [] : (['tip', 'anchor'] as const)) {
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
