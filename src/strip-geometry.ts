import * as THREE from 'three';

// One stretch of paper: over `length` cm its top edge turns by `turn`
// degrees, its bottom edge by `bottomTurn` (the same if left out). Positive
// turns roll towards the front face, negative towards the back; 0 is
// straight. A sheet is a list of these, from the anchored end, so it can
// fold, zigzag or spiral as loosely or tightly as real paper does, and where
// the two edges turn differently that stretch stands on a slant, flares or
// draws in, the way a loose roll of paper does. Paper never changes how hard
// it bends all at once, so neighbouring bends blend into each other (see
// curvature) while each still turns by exactly its amount.
//
// A stretch marked `follow` takes its shape from another sheet instead (see
// Follow); its `turn` is ignored. At most one per sheet.
export interface Bend {
  length: number;
  turn: number;
  bottomTurn?: number;
  follow?: boolean;
}

// How a sheet lies against another one. Real paper never keeps an exact
// distance: a stiff flat poster lags behind the other sheet's bends and the
// gap opens there, a poster that was rolled up curls tighter than the sheet
// it leans on, and wherever paper would pass through paper it is pushed
// back and slides along. So the followed stretch is built step by step: the
// sheet turns the way the other sheet turns (corrected for the distance
// between them) blended with the way it curls on its own, is pulled gently
// back towards `gap`, and is stopped by contact.
export interface Follow {
  sheet: string; // id of the sheet followed
  side: 'front' | 'back'; // which face of that sheet this one lies against
  from: number; // cm along that sheet where the followed stretch begins
  gap: number; // cm it likes to keep; it is never pushed closer than CONTACT
  stiffness: number; // 0 = clings to the other sheet's curve, 1 = keeps its own
  restTurn: number; // degrees per cm it curls on its own (+ towards its front face)
  tension: number; // 0..1, how firmly it returns to `gap` after being pushed off it
  reverse?: boolean; // runs the other way along the followed sheet
}

// The followed sheet's edges, in the follower's space, as last built.
export interface Guide {
  bottom: Float32Array; // x, y, z per station
  top: Float32Array;
  ds: number; // cm between stations
  version: number;
  live: number; // stations that exist so far (the rest sit at the tip while it grows)
}

type Edge = 'top' | 'bottom';
const turnOf = (b: Bend, edge: Edge) => (edge === 'bottom' ? (b.bottomTurn ?? b.turn) : b.turn);

export interface StripShape {
  height: number; // cm, the straight edge of the sheet
  bends: Bend[];
}

// Which stretch of the paper pays out when the sheet is pulled, and how. The
// paper straightens from `from` towards `to` (cm along the sheet, either
// way round), leaving the rest of the shape alone, so a roll unwinds from its
// outer layer while the body stands still. A real poster keeps a little of
// its curl along the top as it comes off the roll: `topLag` (0..1) is how
// much longer the top edge holds on to its shape than the bottom edge.
export interface Pull {
  from: number;
  to: number;
  topLag?: number;
}
export const TOP_LAG = 0.3; // when a sheet does not say

// A corner that flops: the last `reach` cm at the anchored end bend about a
// hinge there by up to `turn` degrees (+ towards the front face), the top
// edge fully and the bottom edge less, so the top corner dips forward the
// way a page corner does. How far it has gone at the moment is animated (0..1).
export interface Droop {
  turn: number;
  reach: number;
}
const DROOP_BOTTOM = 0.4; // the bottom edge's share of the turn

// The track a called-out sheet leaves by: its own path, then a way out past
// the frame (see way-out.ts). The paper slides along it lengthwise, every
// point the same distance on, so the end that goes first takes the way out
// and the end that comes last passes through every bend the paper made.
// Both edges, in this geometry's space, a station's length apart, in the
// order the paper travels them.
export interface Rail {
  bottom: Float32Array;
  top: Float32Array;
  lead: 'tip' | 'anchor'; // the end that goes first
}

const SEGMENTS = 600;
const RAMP = 0.45; // share of the shorter of two neighbouring bends over which they blend
const BLEND = 3; // cm over which the flattened part eases into the curled part
const CONTACT = 0.3; // cm; paper pushed against paper stops here
const RETURN_RATE = 0.025; // per cm², pull back towards `gap` at tension 1
const RETURN_DAMPING = 0.31; // per cm, so the return settles instead of swinging
const SEARCH = 8; // stations either way the nearest-point cursor may jump per step

// Radians per cm at `s` cm along the paper. Within a bend the paper turns at
// an even rate; across each join it eases from one rate to the next over
// RAMP of the shorter bend on either side. The ease is symmetric, so every
// bend still turns by exactly its own amount. A followed stretch gets its
// curvature elsewhere and does not blend with its neighbours.
function curvature(bends: Bend[], edge: Edge, s: number) {
  const rate = (b: Bend) => (b.follow ? 0 : THREE.MathUtils.degToRad(turnOf(b, edge)) / b.length);
  const blend = (a: Bend, b: Bend, at: number) => {
    const w = RAMP * Math.min(a.length, b.length);
    return THREE.MathUtils.lerp(rate(a), rate(b), THREE.MathUtils.smoothstep(s, at - w, at + w));
  };

  let start = 0;
  for (let i = 0; i < bends.length; i++) {
    const bend = bends[i];
    const end = start + bend.length;
    if (s < end || i === bends.length - 1) {
      if (bend.follow) return 0;
      const before = bends[i - 1]?.follow ? undefined : bends[i - 1];
      const after = bends[i + 1]?.follow ? undefined : bends[i + 1];
      if (before && s < start + RAMP * Math.min(bend.length, before.length)) return blend(before, bend, start);
      if (after && s > end - RAMP * Math.min(bend.length, after.length)) return blend(bend, after, end);
      return rate(bend);
    }
    start = end;
  }
  return 0;
}

export const paperLength = (shape: StripShape) => shape.bends.reduce((sum, b) => sum + b.length, 0);

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// A sheet anchored at x = 0, heading along +x, its anchored end standing
// straight up along +y. Front face = +z at the anchor. The paper runs in
// straight lines from each point of its bottom edge to the same point (same
// distance along) of its top edge.
//
// Both edges are built by integrating curvature along the paper, so neither
// ever changes length. Unrolling flattens the paper from the anchored end
// outwards, and the shape travels towards the tip, the way a roll does as
// you pull it out.
//
// A sheet that follows another is built in that sheet's space instead (its
// mesh carries no transform): the followed stretch is traced against the
// guide, the bends after it continue forwards from where it ends and the
// bends before it are traced backwards from where it starts.
//
// Each segment has its own four corners so it can carry a `face` index of
// its own, without blending into the next segment.
export class StripGeometry extends THREE.BufferGeometry {
  shape: StripShape;
  follow: Follow | null = null;
  pull: Pull | null = null;
  droop: Droop | null = null;
  baseY = 0; // height of the bottom edge; only followers set it
  version = 0; // bumped every rebuild, so followers know when to re-trace
  // Leaving along a rail, this many cm along it so far; the shape, curl and
  // the rest are set aside until the rail is taken away.
  rail: Rail | null = null;
  travelled = 0;

  private curl = NaN;
  private extent = 1;
  private drooped = 0;
  private relax = 0;
  private slid = NaN;
  private stale = true;
  private builtAgainst = -1;
  private readonly view = new THREE.Vector3();
  private readonly bottom = new Float32Array((SEGMENTS + 1) * 3);
  private readonly top = new Float32Array((SEGMENTS + 1) * 3);
  private readonly positions = new Float32Array(SEGMENTS * 4 * 3);
  private readonly faces = new Float32Array(SEGMENTS * 4);

  constructor(shape: StripShape) {
    super();
    this.shape = shape;

    const uvs = new Float32Array(SEGMENTS * 4 * 2);
    const index: number[] = [];
    for (let i = 0; i < SEGMENTS; i++) {
      const [u0, u1] = [i / SEGMENTS, (i + 1) / SEGMENTS];
      uvs.set([u0, 0, u0, 1, u1, 0, u1, 1], i * 8);
      const v = i * 4; // bottom start, top start, bottom end, top end
      index.push(v, v + 2, v + 3, v, v + 3, v + 1);
    }

    this.setIndex(index);
    this.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    this.setAttribute('face', new THREE.BufferAttribute(this.faces, 1));
  }

  // The shape changed; rebuild on the next update.
  invalidate() {
    this.stale = true;
  }

  // Put the paper on a rail, at its start, or (null) back on its own shape.
  ride(rail: Rail | null) {
    this.rail = rail;
    this.travelled = 0;
    this.stale = true;
  }

  // Bottom and top edge points (x, y, z) of every station, as last built; the
  // paper runs straight between each pair.
  // The visible face (see countFaces) that the paper belongs to at a station.
  faceAt(station: number) {
    return this.faces[4 * Math.min(Math.max(0, station), SEGMENTS - 1)];
  }

  get edges(): { bottom: Readonly<Float32Array>; top: Readonly<Float32Array> } {
    return { bottom: this.bottom, top: this.top };
  }

  // On a rail, how many segments, counted from the leading end, have passed
  // the end of the paper's own path and are out on the way out.
  get segmentsOut() {
    if (!this.rail) return 0;
    return Math.min(SEGMENTS, Math.max(0, Math.round(this.travelled / this.stationLength)));
  }

  get stationLength() {
    return paperLength(this.shape) / SEGMENTS;
  }

  // curl: 0 = flat, 1 = the shape as drawn, > 1 = rolled tighter (spring overshoot).
  // towardsCamera: unit vector to the viewer, in this sheet's space.
  // guide: the followed sheet's edges, when this sheet follows one.
  // extent: how much of the paper exists yet, 0..1 from the anchored end; the
  // rest is gathered at the tip, so the sheet grows along its own path.
  // drooped: how far the corner has sagged, 0..1 (see Droop).
  // relax: every bend this much looser than drawn (negative: tighter); the
  // breathing of a settled sheet.
  update(curl: number, towardsCamera: THREE.Vector3, guide?: Guide, extent = 1, drooped = 0, relax = 0) {
    if (this.rail) {
      const moved = this.stale || this.travelled !== this.slid;
      if (moved) this.slide(this.rail);
      if (moved || !this.view.equals(towardsCamera)) this.countFaces(towardsCamera);
      return;
    }
    const bent =
      this.stale ||
      curl !== this.curl ||
      extent !== this.extent ||
      drooped !== this.drooped ||
      relax !== this.relax ||
      (guide ? guide.version !== this.builtAgainst : false);
    if (bent) this.bend(curl, guide, extent, drooped, relax);
    if (bent || !this.view.equals(towardsCamera)) this.countFaces(towardsCamera);
  }

  private bend(curl: number, guide?: Guide, extent = 1, drooped = 0, relax = 0) {
    this.curl = curl;
    this.extent = extent;
    this.drooped = drooped;
    this.relax = relax;
    this.stale = false;
    this.version++;
    this.builtAgainst = guide?.version ?? -1;

    const { height } = this.shape;
    const length = paperLength(this.shape);
    const ds = length / SEGMENTS;
    const bends = this.shape.bends.filter((b) => b.length > 0);
    const followAt = bends.findIndex((b) => b.follow);
    const following = guide && this.follow && followAt >= 0 ? this.follow : null;
    let s0 = 0;
    for (let i = 0; i < followAt; i++) s0 += bends[i].length;
    const s1 = followAt >= 0 ? s0 + bends[followAt].length : 0;

    // The top edge keeps a share of its curl while the bottom edge unrolls.
    const lag = this.pull?.topLag ?? TOP_LAG;
    const curlOf = (edge: Edge) => (edge === "top" && curl < 1 ? curl + (1 - curl) * lag : curl);

    // How far from `start` the paper has been flattened, over a stretch of
    // `span` cm, at this curl; BLEND cm ease the flat part into the curled part.
    const flattened = (c: number, span: number) => (1 - Math.min(c, 1)) * (span + 2 * BLEND) - BLEND;

    // 0 = flat, 1 = shaped, at s cm along one edge. With a pull stretch the
    // paper straightens from `from` towards `to` and nothing else moves; a
    // follower without one unrolls outwards from the stretch it follows; a
    // free sheet without one unrolls from its anchored end.
    const engaged = (edge: Edge, s: number) => {
      const c = curlOf(edge);
      const pull = this.pull;
      if (pull) {
        const [a, b] = [Math.min(pull.from, pull.to), Math.max(pull.from, pull.to)];
        if (s < a || s > b) return 1;
        const dist = pull.from <= pull.to ? s - pull.from : pull.from - s;
        return THREE.MathUtils.smoothstep(dist, flattened(c, b - a) - BLEND, flattened(c, b - a) + BLEND);
      }
      if (following) {
        const own = Math.max(s0, length - s1);
        const along = s < s0 ? s0 - s : s > s1 ? s - s1 : -Infinity;
        return THREE.MathUtils.smoothstep(along, flattened(c, own) - BLEND, flattened(c, own) + BLEND);
      }
      return THREE.MathUtils.smoothstep(s, flattened(c, length) - BLEND, flattened(c, length) + BLEND);
    };
    // Rolled tighter than drawn (curl > 1): only the pull stretch tightens.
    const tighten = (s: number) => {
      if (curl <= 1) return 1;
      const pull = this.pull;
      if (!pull) return curl;
      return s >= Math.min(pull.from, pull.to) && s <= Math.max(pull.from, pull.to) ? curl : 1;
    };
    const rate = (edge: Edge, s: number) => curvature(bends, edge, s) * engaged(edge, s) * tighten(s) * (1 - relax);

    const trace = (edge: Edge, out: Float32Array, y: number) => {
      const at = { x: 0, z: 0, theta: 0 };
      const forward = (i: number) => {
        // Station i-1 -> i.
        const k = rate(edge, (i - 0.5) * ds);
        const mid = at.theta + (k * ds) / 2;
        at.x += Math.cos(mid) * ds;
        at.z += Math.sin(mid) * ds;
        at.theta += k * ds;
        out.set([at.x, y, at.z], i * 3);
      };
      const backward = (i: number) => {
        // Station i+1 -> i.
        const k = rate(edge, (i + 0.5) * ds);
        const mid = at.theta - (k * ds) / 2;
        at.x -= Math.cos(mid) * ds;
        at.z -= Math.sin(mid) * ds;
        at.theta -= k * ds;
        out.set([at.x, y, at.z], i * 3);
      };

      if (!following) {
        out.set([0, y, 0], 0);
        for (let i = 1; i <= SEGMENTS; i++) forward(i);
        return;
      }

      const i0 = Math.round(s0 / ds);
      const i1 = Math.min(SEGMENTS, Math.round(s1 / ds));
      const rail = edge === 'bottom' ? guide!.bottom : guide!.top;
      const start = this.traceAlong(following, rail, guide!.ds, guide!.live, out, y, i0, i1, ds, at);
      for (let i = i1 + 1; i <= SEGMENTS; i++) forward(i);
      Object.assign(at, start);
      for (let i = i0 - 1; i >= 0; i--) backward(i);
    };
    trace('bottom', this.bottom, this.baseY);
    trace('top', this.top, this.baseY + height);

    // The corner at the anchored end flops: everything before the hinge
    // swings about it, more the nearer the end, towards the front face.
    if (this.droop && drooped > 0) {
      const { turn, reach } = this.droop;
      const hinge = Math.min(SEGMENTS, Math.max(1, Math.round(reach / ds)));
      for (const [edge, share] of [[this.top, 1], [this.bottom, DROOP_BOTTOM]] as const) {
        const [hx, hz] = [edge[3 * hinge], edge[3 * hinge + 2]];
        for (let i = 0; i < hinge; i++) {
          const a = THREE.MathUtils.degToRad(turn) * drooped * share * (1 - i / hinge);
          const [x, z] = [edge[3 * i] - hx, edge[3 * i + 2] - hz];
          edge[3 * i] = hx + x * Math.cos(a) + z * Math.sin(a);
          edge[3 * i + 2] = hz - x * Math.sin(a) + z * Math.cos(a);
        }
      }
    }

    // Paper that is not there yet sits at the tip of what is.
    const live = Math.round(THREE.MathUtils.clamp(extent, 0, 1) * SEGMENTS);
    for (const edge of [this.bottom, this.top]) {
      for (let i = live + 1; i <= SEGMENTS; i++) edge.copyWithin(3 * i, 3 * live, 3 * live + 3);
    }

    this.writePositions();
  }

  // Every station `travelled` cm further along the rail than it started.
  private slide(rail: Rail) {
    this.stale = false;
    this.slid = this.travelled;
    this.version++;
    const last = rail.bottom.length / 3 - 1;
    const shift = this.travelled / this.stationLength;
    for (let i = 0; i <= SEGMENTS; i++) {
      const k = Math.min((rail.lead === 'tip' ? i : SEGMENTS - i) + shift, last);
      const k0 = Math.floor(k);
      const k1 = Math.min(k0 + 1, last);
      const f = k - k0;
      for (const [from, to] of [
        [rail.bottom, this.bottom],
        [rail.top, this.top],
      ]) {
        for (let c = 0; c < 3; c++) to[3 * i + c] = from[3 * k0 + c] + (from[3 * k1 + c] - from[3 * k0 + c]) * f;
      }
    }
    this.writePositions();
  }

  private writePositions() {
    const [b, t] = [this.bottom, this.top];
    for (let i = 0; i < SEGMENTS; i++) {
      this.positions.set(b.subarray(3 * i, 3 * i + 3), i * 12);
      this.positions.set(t.subarray(3 * i, 3 * i + 3), i * 12 + 3);
      this.positions.set(b.subarray(3 * i + 3, 3 * i + 6), i * 12 + 6);
      this.positions.set(t.subarray(3 * i + 3, 3 * i + 6), i * 12 + 9);
    }
    this.attributes.position.needsUpdate = true;
    // Both bounds: raycasting and Box3.setFromObject cache them otherwise.
    this.computeBoundingSphere();
    this.computeBoundingBox();
  }

  // Trace stations i0..i1 of one edge against the guide's matching edge (its
  // plan, x and z). Leaves `at` at station i1 and returns the state at i0.
  private traceAlong(
    f: Follow,
    rail: Float32Array,
    dsRail: number,
    liveRail: number,
    out: Float32Array,
    y: number,
    i0: number,
    i1: number,
    ds: number,
    at: { x: number; z: number; theta: number },
  ) {
    const last = Math.max(1, Math.min(rail.length / 3 - 1, liveRail));
    const sigma = f.side === 'front' ? 1 : -1;
    const px = (j: number) => rail[3 * j];
    const pz = (j: number) => rail[3 * j + 2];
    // Heading of the guide at station j, from its neighbours.
    const heading = (j: number) => {
      const a = Math.max(j - 1, 0);
      const b = Math.min(j + 1, last);
      return Math.atan2(pz(b) - pz(a), px(b) - px(a));
    };
    const curvatureAt = (j: number) => {
      const a = Math.max(j - 1, 0);
      const b = Math.min(j + 1, last);
      return b > a ? wrap(heading(b) - heading(a)) / ((b - a) * dsRail) : 0;
    };
    // Front normal of the guide: its heading turned a quarter towards +z.
    const normal = (j: number) => {
      const h = heading(j);
      return [-Math.sin(h), Math.cos(h)];
    };
    // Nearest guide station near the cursor (the stretch being followed), or
    // anywhere along the guide when `span` is wide, for contact with any part.
    const nearest = (x: number, z: number, j: number, span = SEARCH) => {
      let best = j;
      let bestD = Infinity;
      for (let k = Math.max(0, j - span); k <= Math.min(last, j + span); k++) {
        const d = (px(k) - x) ** 2 + (pz(k) - z) ** 2;
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      return best;
    };
    // Signed distance from the guide, positive away from it on the chosen side.
    const distance = (x: number, z: number, j: number) => {
      const [nx, nz] = normal(j);
      return sigma * ((x - px(j)) * nx + (z - pz(j)) * nz);
    };

    // Running the other way, the guide's turns read with the opposite sign.
    const dir = f.reverse ? -1 : 1;
    let j = THREE.MathUtils.clamp(Math.round(f.from / dsRail), 0, last);
    const [nx0, nz0] = normal(j);
    at.x = px(j) + sigma * f.gap * nx0;
    at.z = pz(j) + sigma * f.gap * nz0;
    at.theta = heading(j) + (f.reverse ? Math.PI : 0);
    const start = { ...at };
    out.set([at.x, y, at.z], i0 * 3);

    const rest = THREE.MathUtils.degToRad(f.restTurn);
    for (let i = i0 + 1; i <= i1; i++) {
      j = nearest(at.x, at.z, j);
      const d = distance(at.x, at.z, j);
      const [nx, nz] = normal(j);
      // The guide's curve as it reads at this distance from it. Where the
      // guide bends towards this sheet tighter than the distance between
      // them, no curve can be followed: the sheet goes on and gets pushed.
      const kGuide = curvatureAt(j);
      const bend = 1 - kGuide * sigma * d;
      const kWall = bend <= 0 ? 0 : kGuide / Math.max(bend, 0.5);
      // How fast the distance is growing, per cm travelled.
      const drift = sigma * (Math.cos(at.theta) * nx + Math.sin(at.theta) * nz);
      const k =
        dir * kWall +
        f.stiffness * (rest - dir * kWall) -
        dir * sigma * f.tension * (RETURN_RATE * (d - f.gap) + RETURN_DAMPING * drift);
      const mid = at.theta + (k * ds) / 2;
      at.x += Math.cos(mid) * ds;
      at.z += Math.sin(mid) * ds;
      at.theta += k * ds;

      // Paper cannot pass through paper: push back out and slide along.
      // Any part of the guide may be in the way, not only the stretch followed.
      j = nearest(at.x, at.z, j);
      const c = nearest(at.x, at.z, j, last);
      const dNow = distance(at.x, at.z, c);
      if (Math.abs(dNow) < CONTACT) {
        const [cx, cz] = normal(c);
        const push = sigma * (dNow < 0 ? -1 : 1);
        at.x += push * cx * (CONTACT - Math.abs(dNow));
        at.z += push * cz * (CONTACT - Math.abs(dNow));
        const into = push * (Math.cos(at.theta) * cx + Math.sin(at.theta) * cz) < 0;
        if (into) {
          const h = heading(c);
          at.theta = Math.cos(at.theta - h) >= 0 ? h : h + Math.PI;
        }
      }
      out.set([at.x, y, at.z], i * 3);
    }
    return start;
  }

  // A face is a run of segments showing the same side to the viewer. A new
  // one starts wherever the paper turns edge-on and its other side comes
  // into view, counted from the anchored end. Colour may only change there,
  // so whatever the curl or orientation, a face that looks continuous is.
  private countFaces(towardsCamera: THREE.Vector3) {
    this.view.copy(towardsCamera);
    const [b, t] = [this.bottom, this.top];
    const v = (arr: Float32Array, i: number) => [arr[3 * i], arr[3 * i + 1], arr[3 * i + 2]];
    let face = 0;
    let side = 0;
    for (let i = 0; i < SEGMENTS; i++) {
      const [b0, t0, b1, t1] = [v(b, i), v(t, i), v(b, i + 1), v(t, i + 1)];
      // Along the paper (between mid-height points) and up the paper; their
      // cross product is the segment's front normal.
      const along = [0, 1, 2].map((k) => (b1[k] + t1[k] - b0[k] - t0[k]) / 2);
      const up = [0, 1, 2].map((k) => (t0[k] + t1[k] - b0[k] - b1[k]) / 2);
      const normal = [
        along[1] * up[2] - along[2] * up[1],
        along[2] * up[0] - along[0] * up[2],
        along[0] * up[1] - along[1] * up[0],
      ];
      const facing = Math.sign(normal[0] * towardsCamera.x + normal[1] * towardsCamera.y + normal[2] * towardsCamera.z);
      if (facing !== 0) {
        if (side !== 0 && facing !== side) face++;
        side = facing;
      }
      this.faces.fill(face, i * 4, i * 4 + 4);
    }
    this.attributes.face.needsUpdate = true;
  }
}
