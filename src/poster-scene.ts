import * as THREE from 'three';
import { collisionsOf, findCollisions } from './collisions.ts';
import type { Composition } from './composition.ts';
import { printUniforms } from './materials.ts';
import { POSTER_SIZE } from './poster.ts';
import { Sheet, type SheetSpec } from './sheet.ts';
import type { Stage } from './stage.ts';
import type { Guide } from './strip-geometry.ts';
import { wayOut, type Exit } from './way-out.ts';

const MIN_DOT_PX = 3; // CSS px; finer than this and the dots blur into a flat tint

// The opening: every sheet grows from its anchored end along its own path,
// back to front, each over GROW seconds, starting STAGGER seconds apart.
// Paper coming off a roll starts shyly, pays out fast and lands slowly, so
// the length follows a slow-in, long-tailed ease. It cannot overshoot, so on
// arrival the sheet instead eases a little unroll in and slowly out: one
// settling movement, no bounce. A sheet with a drooping corner dips that
// corner the same way instead.
const GROW = 1.4; // s
const STAGGER = 0.06; // s
const SETTLE = -0.08; // curl, at the deepest point of the settling unroll
const SETTLE_TIGHTER = 0.035; // curl, when it has to go the other way instead (tightening reads stronger)
const DIP = 0.25; // s, to the deepest point
const RECOVER = 1.2; // s, back to rest
const EASE = [0.55, 0, 0.15, 1] as const; // cubic-bezier control points

// Settled, a sheet never quite holds still: it keeps breathing, every bend
// loosening a little and tightening again, slowly, each sheet to a rhythm
// of its own that never quite repeats; a sheet with a drooping corner dips
// that instead. How deep each one may breathe is decided before the
// opening, all sheets at their deepest together, so that none meets
// another. A sheet holds its breath while it is being pulled.
const BREATH = 0.05; // every bend this much looser at the deepest breath
const BREATH_REACH = 3; // cm; a sheet that would move further than this breathes shallower
const BREATH_TIGHTER = 0.5; // of its breath, the other way, when loosening would hit something
const BREATH_DROOP = 0.5; // of the corner's full droop
const BREATH_PERIOD = 5; // s; each sheet breathes somewhere between this and twice it
const BREATH_SECOND = 1.618; // the second, fainter wave is this much slower

// Once every sheet has grown in, pointing at a sheet drains the colour from
// every other one, so the one under the hand stands out; pointing away
// brings it all back. Colour drains and returns on this time constant.
const FOCUS = 0.12; // s
// The hovered sheet's label fades in on this time constant, quicker than the focus.
const REVEAL = 0.06; // s
// Labels go where the camera actually sees the paper: the scene is drawn
// once, small, with every sheet in an id of its own and its depth.
const SIGHT = 480; // px, the height of that drawing
const SIGHT_DEPTH = 1.5; // cm; a point this close to what shows of its sheet counts as seen
// A pulled (or swinging) sheet that meets paper stops where it meets it:
// the curl is bisected this many times between clear and blocked, unless
// the two are already this close.
const REFINE = 3;
const REFINE_CLOSE = 0.002; // curl

// A sheet called out slides lengthwise along its own path and out of the
// frame (see callOut), at about this speed, on the opening's curve (EASE):
// it starts shyly, is drawn away fast and slips out the last of the way.
const OUT_SPEED = 130; // cm per second, on average
const OUT_TIME = [1, 1.9] as const; // s, at least and at most

// A steady number in 0..1 from a sheet's id, so each sheet keeps its rhythm.
function noise(id: string) {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = (h * 33) ^ id.charCodeAt(i);
  return ((h >>> 0) % 1000) / 1000;
}

// cubic-bezier(x1, y1, x2, y2) as CSS defines it, for x in 0..1.
function ease(x: number) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const [x1, y1, x2, y2] = EASE;
  const bez = (a: number, b: number, s: number) => 3 * a * (1 - s) ** 2 * s + 3 * b * (1 - s) * s ** 2 + s ** 3;
  let s = x;
  for (let i = 0; i < 8; i++) {
    const dx = 3 * x1 * (1 - s) ** 2 + 6 * (x2 - x1) * (1 - s) * s + 3 * (1 - x2) * s ** 2;
    if (dx < 1e-6) break;
    s -= (bez(x1, x2, s) - x) / dx;
  }
  return bez(y1, y2, Math.min(Math.max(s, 0), 1));
}

// Every sheet of the poster, built from a composition and kept in step with it:
// the specs in `composition.sheets` are the same objects the sheets read.
export class PosterScene {
  readonly sheets: Sheet[] = [];
  readonly composition: Composition;
  onUpdate?: () => void;
  // The sheet being pulled, if any: it may not pass through paper or the
  // floor, so each frame it is checked and, where it would, held back. That
  // goes on after it is let go, for as long as its spring still swings.
  get held() {
    return this.heldSheet;
  }
  set held(sheet: Sheet | null) {
    this.heldSheet = sheet;
    // Taken hold of: where it stands now is the last clear curl, unless it
    // already touches something, in which case it is let move.
    if (sheet) {
      sheet.safeCurl = NaN;
      this.holdBack(sheet, sheet.follows ? this.leaderOf(sheet)?.guide() : undefined);
    }
  }
  private heldSheet: Sheet | null = null;
  // The sheet under the pointer, if any: once the sheets are in, the others lose their colour.
  hovered: Sheet | null = null;

  private opened = false; // the opening has played through
  private intro: { time: number; starts: Map<Sheet, number> } | null = null;
  // Per arriving sheet: seconds since arrival and how far it may move.
  private readonly settling = new Map<Sheet, { time: number; amount: number }>();
  // Leaders that have arrived and wait for their followers before breathing,
  // so the room is measured with everyone whole.
  private readonly waiting = new Set<Sheet>();
  // How deep each sheet may breathe (relax, or drooped for a drooping corner).
  private readonly breath = new Map<Sheet, number>();
  // Per settled sheet: seconds breathing, how far it may move, its two periods.
  private readonly breathing = new Map<Sheet, { time: number; amount: number; periods: [number, number] }>();

  // Sheets called out: how far they go, how long it takes and how far along
  // they are; and their edges as they stood, which their followers keep
  // leaning on, so these stay where they were.
  private readonly calledOut = new Map<Sheet, { travel: number; time: number; duration: number; stood: Guide; gone: () => void }>();

  private readonly stage: Stage;
  private readonly towardsCamera = new THREE.Vector3();
  private sightTarget: THREE.WebGLRenderTarget | null = null;
  // The part of a sheet out on its way out, drawn apart to pass behind (see passBehind).
  private readonly beyond = new Map<Sheet, THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>>();
  // Under each sheet passed behind, down to the floor, drawn into the stencil only.
  private readonly skirts = new Map<Sheet, THREE.Mesh<THREE.BufferGeometry>>();
  private readonly skirtMaterial = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  private sightPixels = new Uint8Array(0);
  private readonly idMaterials: THREE.ShaderMaterial[] = [];

  constructor(stage: Stage, composition: Composition) {
    this.stage = stage;
    this.composition = composition;
    for (const spec of composition.sheets) this.mount(spec);
    this.applyGlobals();
  }

  add(spec: SheetSpec) {
    this.composition.sheets.push(spec);
    return this.mount(spec);
  }

  remove(sheet: Sheet) {
    this.sheets.splice(this.sheets.indexOf(sheet), 1);
    this.composition.sheets.splice(this.composition.sheets.indexOf(sheet.spec), 1);
    this.stage.scene.remove(sheet.mesh);
    sheet.dispose();
  }

  // The sheet another one lies against. A sheet never follows itself.
  leaderOf(sheet: Sheet): Sheet | undefined {
    const leader = this.byId(sheet.spec.follow?.sheet);
    return leader === sheet ? undefined : leader;
  }

  byId(id?: string) {
    return id === undefined ? undefined : this.sheets.find((s) => s.spec.id === id);
  }

  // Push view, print and spring settings to every sheet.
  applyGlobals() {
    const { view, print, spring } = this.composition;
    printUniforms.uDotAngle.value = THREE.MathUtils.degToRad(print.dotAngle);
    this.stage.setElevation(view.elevation);
    for (const sheet of this.sheets) {
      sheet.spring.stiffness = spring.stiffness;
      sheet.spring.damping = spring.damping;
      sheet.apply();
    }
  }

  // Play the opening: sheets grow in from nothing, farthest first, followers
  // after the sheet they follow.
  startIntro() {
    this.stage.camera.getWorldDirection(this.towardsCamera).negate();
    this.planBreathing();
    const order = this.inBuildOrder();
    this.placeLabels(order);
    const depth = new Map(order.map((s) => [s, s.spec.position[2]]));
    const sorted = [...order].sort((a, b) => depth.get(a)! - depth.get(b)!);
    const starts = new Map<Sheet, number>();
    sorted.forEach((sheet, i) => starts.set(sheet, i * STAGGER));
    for (const sheet of order) {
      const leader = sheet.follows ? this.leaderOf(sheet) : undefined;
      if (leader) starts.set(sheet, Math.max(starts.get(sheet)!, starts.get(leader)! + 2 * STAGGER));
      sheet.extent = 0;
    }
    this.intro = { time: 0, starts };
  }

  private grow(dt: number) {
    if (!this.intro) return;
    this.intro.time += dt;
    let done = true;
    const hasFollowers = new Set(this.sheets.map((s) => (s.follows ? this.leaderOf(s) : undefined)));
    for (const sheet of this.inBuildOrder()) {
      const x = (this.intro.time - this.intro.starts.get(sheet)!) / GROW;
      let extent = ease(x);
      // A follower never gets ahead of the paper it follows: its followed
      // stretch only exists where the leader already does.
      const leader = sheet.follows ? this.leaderOf(sheet) : undefined;
      if (leader && extent > 0) {
        const have = leader.extent * leader.paperLength() - sheet.spec.follow!.from;
        const allowed = have <= 0 ? 0 : (sheet.followStart + have) / sheet.paperLength();
        extent = Math.min(extent, allowed, 1);
      }
      // Arrived: settle, unless followers would shake along with it; such a
      // leader only breathes, once its followers are there too.
      if (sheet.extent < 1 && extent >= 1) {
        sheet.extent = extent;
        if (sheet.spec.droop || !hasFollowers.has(sheet)) {
          this.settling.set(sheet, { time: 0, amount: this.settleRoom(sheet, leader?.guide()) });
        } else {
          this.waiting.add(sheet);
        }
      }
      sheet.extent = extent;
      if (extent < 1) done = false;
    }
    for (const sheet of this.waiting) {
      if (!this.followersOf(sheet).every((f) => f.extent >= 1)) continue;
      this.waiting.delete(sheet);
      this.startBreathing(sheet);
    }
    if (done) {
      this.intro = null;
      this.opened = true;
    }
  }

  // Every sheet has grown in: the opening is over, bar the last settling.
  get ready() {
    return this.opened;
  }

  private followersOf(sheet: Sheet) {
    return this.sheets.filter((s) => s !== sheet && s.follows && this.leaderOf(s) === sheet);
  }

  // Whether a movement leaves the sheet clear of paper and the floor: tried
  // once at its deepest, then undone. Its followers move along with it, so
  // they are checked too.
  private clear(sheet: Sheet, guide: ReturnType<Sheet['guide']> | undefined, apply: () => void) {
    const followers = this.followersOf(sheet);
    const moving = new Set([sheet, ...followers]);
    const others = this.sheets.filter((s) => !moving.has(s));
    const place = () => {
      sheet.update(0, this.towardsCamera, guide);
      for (const follower of followers) follower.update(0, this.towardsCamera, sheet.guide());
    };
    apply();
    place();
    let hits = collisionsOf(sheet, others, this.composition.floor).length;
    for (const follower of followers) hits += collisionsOf(follower, others, this.composition.floor).length;
    sheet.curlOffset = 0;
    sheet.drooped = 0;
    sheet.relax = 0;
    place();
    return hits === 0;
  }

  // How far a sheet may settle: the full unroll; the other way (a little
  // tighter) if that hits; nothing if both do. A sheet with a drooping
  // corner dips that instead. Checked once, on arrival.
  private settleRoom(sheet: Sheet, guide?: ReturnType<Sheet['guide']>) {
    if (sheet.spec.droop) return this.clear(sheet, guide, () => (sheet.drooped = 1)) ? 1 : 0;
    if (this.clear(sheet, guide, () => (sheet.curlOffset = SETTLE))) return SETTLE;
    if (this.clear(sheet, guide, () => (sheet.curlOffset = SETTLE_TIGHTER))) return SETTLE_TIGHTER;
    return 0;
  }

  // Decide how deep each sheet breathes, with every sheet whole and at rest:
  // BREATH, or less where that would carry any of its paper further than
  // BREATH_REACH (a drooping corner dips BREATH_DROOP regardless). Each is
  // then tried alone at its deepest, everything else at rest, and then all
  // at their deepest together, since the sheets breathe out of step and
  // either moment may bring paper against paper or the floor: wherever it
  // does, the sheet that moves further (alone: that sheet) breathes the
  // other way, and if it still meets, not at all. Followers move with the
  // sheet they follow, so that sheet answers for them.
  private planBreathing() {
    const order = this.inBuildOrder();
    const place = (sheets: Sheet[]) => {
      for (const s of sheets) s.update(0, this.towardsCamera, s.follows ? this.leaderOf(s)?.guide() : undefined);
    };
    const set = (sheet: Sheet, amount: number) => {
      if (sheet.spec.droop) sheet.drooped = Math.max(amount, 0);
      else sheet.relax = amount;
    };
    const group = (sheet: Sheet) => order.filter((s) => s === sheet || this.leads(sheet, s));
    const edges = (sheet: Sheet) => {
      const g = sheet.guide();
      return [g.bottom.slice(), g.top.slice()];
    };
    // How far any point of the sheet moves at this amount.
    const reach = (sheet: Sheet, amount: number) => {
      set(sheet, 0);
      place(group(sheet));
      const [b0, t0] = edges(sheet);
      set(sheet, amount);
      place(group(sheet));
      const [b1, t1] = edges(sheet);
      set(sheet, 0);
      let far = 0;
      for (const [a, b] of [[b0, b1], [t0, t1]]) {
        for (let i = 0; i < a.length; i += 3) far = Math.max(far, Math.hypot(a[i] - b[i], a[i + 1] - b[i + 1], a[i + 2] - b[i + 2]));
      }
      return far;
    };

    this.breath.clear();
    const reaches = new Map<Sheet, number>();
    for (const sheet of order) {
      const full = sheet.spec.droop ? BREATH_DROOP : BREATH;
      const far = reach(sheet, full);
      const amount = !sheet.spec.droop && far > BREATH_REACH ? (full * BREATH_REACH) / far : full;
      this.breath.set(sheet, amount);
      reaches.set(sheet, (far * amount) / full);
    }
    // Whether the sheet, breathing this deep alone, stays clear of everything.
    const floor = this.composition.floor;
    const alone = (sheet: Sheet, amount: number) => {
      const moving = group(sheet);
      const others = order.filter((s) => !moving.includes(s));
      set(sheet, amount);
      place(moving);
      let hits = 0;
      for (const s of moving) hits += collisionsOf(s, others, floor).length;
      set(sheet, 0);
      place(moving);
      return hits === 0;
    };
    // The next shallower breath for a sheet that met something: the other
    // way, then none; each tried alone.
    const relent = (sheet: Sheet) => {
      const amount = this.breath.get(sheet)!;
      let next = amount > 0 && !sheet.spec.droop ? -amount * BREATH_TIGHTER : 0;
      if (next !== 0 && !alone(sheet, next)) next = 0;
      this.breath.set(sheet, next);
      reaches.set(sheet, (reaches.get(sheet)! * Math.abs(next)) / Math.abs(amount));
    };
    for (const sheet of order) if (!alone(sheet, this.breath.get(sheet)!)) relent(sheet);
    // The sheets whose breathing moves `s`: itself, and whatever it follows,
    // however far up, as long as they breathe.
    const movers = (s: Sheet) => {
      const found: Sheet[] = [];
      for (let at: Sheet | undefined = s, i = 0; at && i < order.length; at = at.follows ? this.leaderOf(at) : undefined, i++) {
        if (this.breath.get(at)) found.push(at);
      }
      return found;
    };
    for (let round = 0; round < 2 * order.length; round++) {
      for (const [sheet, amount] of this.breath) set(sheet, amount);
      place(order);
      const hits = findCollisions(this.sheets, this.composition.floor);
      if (hits.length === 0) break;
      const blamed = new Set<Sheet>();
      for (const { a, b } of hits) {
        const culprits = [...new Set([...movers(a), ...movers(b)])];
        if (culprits.length === 0) continue;
        blamed.add(culprits.reduce((x, y) => (reaches.get(y)! > reaches.get(x)! ? y : x)));
      }
      if (blamed.size === 0) break;
      for (const sheet of blamed) relent(sheet);
    }
    for (const sheet of order) set(sheet, 0);
    place(order);
  }

  // Whether `s` follows `leader`, directly or through others.
  private leads(leader: Sheet, s: Sheet) {
    const seen = new Set<Sheet>();
    for (let at = s.follows ? this.leaderOf(s) : undefined; at && !seen.has(at); at = at.follows ? this.leaderOf(at) : undefined) {
      if (at === leader) return true;
      seen.add(at);
    }
    return false;
  }

  // One settling movement on arrival: out quickly over DIP seconds, back
  // slowly over RECOVER, eased both ways. It drives the drooping corner
  // where a sheet has one, and otherwise a small unroll of the curl.
  private settle(dt: number) {
    for (const [sheet, state] of this.settling) {
      state.time += dt;
      let amount: number;
      if (state.time < DIP) {
        const x = state.time / DIP;
        amount = 1 - (1 - x) ** 3;
      } else {
        const x = Math.min((state.time - DIP) / RECOVER, 1);
        amount = 1 - (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
        if (x >= 1) {
          amount = 0;
          this.settling.delete(sheet);
          this.startBreathing(sheet);
        }
      }
      if (sheet.spec.droop) sheet.drooped = amount * state.amount;
      else sheet.curlOffset = state.amount * amount;
    }
  }

  private startBreathing(sheet: Sheet) {
    const amount = this.breath.get(sheet) ?? 0;
    if (amount === 0) return;
    const period = BREATH_PERIOD * (1 + noise(sheet.spec.id));
    this.breathing.set(sheet, { time: 0, amount, periods: [period, period * BREATH_SECOND] });
  }

  // The breathing: two slow waves, both starting from rest so it takes over
  // from the settling without a step, the faint second one keeping the
  // rhythm from ever quite repeating. A pulled sheet holds its breath.
  private breathe(dt: number) {
    for (const [sheet, state] of this.breathing) {
      if (sheet === this.held) continue;
      state.time += dt;
      const wave = (period: number) => (1 - Math.cos((2 * Math.PI * state.time) / period)) / 2;
      const amount = state.amount * (0.6 * wave(state.periods[0]) + 0.4 * wave(state.periods[1]));
      if (sheet.spec.droop) sheet.drooped = amount;
      else sheet.relax = amount;
    }
  }

  // The hovered sheet keeps its colour and every other one drains to grey;
  // a sheet called out holds the focus while it is out.
  private focus(dt: number) {
    const called = this.calledOut.keys().next().value;
    const focused = this.ready ? (called ?? this.hovered) : null;
    const k = 1 - Math.exp(-dt / FOCUS);
    const kr = 1 - Math.exp(-dt / REVEAL);
    for (const sheet of this.sheets) {
      const want = focused === null || sheet === focused ? 1 : 0;
      sheet.saturation += (want - sheet.saturation) * k;
      sheet.reveal += ((sheet === focused ? 1 : 0) - sheet.reveal) * kr;
    }
  }

  // Call a sheet out: it slides lengthwise along its own path, the end
  // nearer a way out first, and on along a smooth way out of the frame, by
  // the left or right edge or back and up out of the top, clear of every other
  // sheet and, where it can be, never seen over one (see way-out.ts), so the
  // end that goes last passes through every bend the paper made. Resolves with
  // the edge it left by once it is out of the frame. Sheets that lean on it
  // stay as they were. It stays out until put back.
  callOut(sheet: Sheet): Promise<Exit> {
    this.putBack(sheet);
    const stood = sheet.guide();
    const others = this.sheets.filter((s) => s !== sheet).map((s) => s.guide());
    const frame = { halfWidth: POSTER_SIZE.width / 2, halfHeight: POSTER_SIZE.height / 2, elevation: this.composition.view.elevation };
    const { rail, travel, exit } = wayOut(stood, others, frame, sheet.geometry.stationLength, sheet.spec);
    // Into the sheet's own space (a follower's is the world's).
    sheet.mesh.updateMatrixWorld();
    const toSheet = sheet.mesh.matrixWorld.clone().invert();
    const p = new THREE.Vector3();
    for (const edge of [rail.bottom, rail.top]) {
      for (let i = 0; i < edge.length; i += 3) {
        p.fromArray(edge, i).applyMatrix4(toSheet).toArray(edge, i);
      }
    }
    sheet.geometry.ride(rail);
    this.passBehind(sheet);
    const duration = THREE.MathUtils.clamp(travel / OUT_SPEED, ...OUT_TIME);
    return new Promise((resolve) => {
      this.calledOut.set(sheet, { travel, time: 0, duration, stood, gone: () => resolve(exit) });
    });
  }

  // Back where it stood, at once, as it was.
  putBack(sheet: Sheet) {
    const out = this.calledOut.get(sheet);
    if (!out) return;
    this.calledOut.delete(sheet);
    sheet.geometry.ride(null);
    this.passBehind(null);
    out.gone();
  }

  // While a sheet is out, the sheets it is told to pass behind (its spec's
  // `behind`) show in front of the part of it already out on its way out,
  // wherever the frame shows them, as if it went behind them even where its
  // way out runs through them; the rest of it, still on its own path, stands
  // where it stood, in front of them or not. Every sheet marks the stencil
  // where it is the one seen (1 for those, 0 for the rest), and the part on
  // its way out is the same paper drawn again last (splitBeyond), only where
  // none of them is seen. A sheet that floats would let it be seen under it,
  // so under each of them, down to the floor, a skirt marks the stencil too.
  private passBehind(sheet: Sheet | null) {
    for (const [s, part] of this.beyond) {
      s.mesh.remove(part);
      // Let go of the buffers it shares with the sheet before disposing of it.
      part.geometry.setIndex(null);
      for (const name of Object.keys(part.geometry.attributes)) part.geometry.deleteAttribute(name);
      part.geometry.dispose();
      part.material.dispose();
      s.geometry.setDrawRange(0, Infinity);
    }
    this.beyond.clear();
    for (const skirt of this.skirts.values()) {
      this.stage.scene.remove(skirt);
      skirt.geometry.dispose();
    }
    this.skirts.clear();
    const front = new Set(sheet?.spec.behind ?? []);
    for (const s of this.sheets) {
      const material = s.mesh.material;
      material.stencilWrite = front.size > 0;
      material.stencilRef = front.has(s.spec.id) ? 1 : 0;
      material.stencilFunc = THREE.AlwaysStencilFunc;
      material.stencilZPass = THREE.ReplaceStencilOp;
    }
    if (!sheet || front.size === 0) return;
    for (const s of this.sheets) {
      if (!front.has(s.spec.id)) continue;
      const stations = s.guide().bottom.length / 3;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(stations * 6), 3));
      const index: number[] = [];
      for (let i = 0; i < stations - 1; i++) index.push(2 * i, 2 * i + 2, 2 * i + 3, 2 * i, 2 * i + 3, 2 * i + 1);
      geometry.setIndex(index);
      const skirt = new THREE.Mesh(geometry, this.skirtMaterial);
      skirt.renderOrder = 0.5; // after the sheets, so only where it is not hidden
      skirt.frustumCulled = false;
      this.stage.scene.add(skirt);
      this.skirts.set(s, skirt);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(sheet.geometry.index);
    for (const [name, attribute] of Object.entries(sheet.geometry.attributes)) geometry.setAttribute(name, attribute);
    const material = sheet.mesh.material.clone();
    material.uniforms = sheet.mesh.material.uniforms; // one paper: saturation, label and all
    material.stencilWrite = true;
    material.stencilRef = 1;
    material.stencilFunc = THREE.NotEqualStencilFunc;
    material.stencilZPass = THREE.KeepStencilOp;
    const part = new THREE.Mesh(geometry, material);
    part.renderOrder = 1; // after every other sheet has marked the stencil
    part.frustumCulled = false; // its bounds move with the paper
    sheet.mesh.add(part);
    this.beyond.set(sheet, part);
    this.splitBeyond();
  }

  // Each sheet passing behind, cut where its own path ends: the segments
  // past it, from the leading end, drawn by its part on the way out. And the
  // skirts under the sheets it passes behind, kept under them as they breathe.
  private splitBeyond() {
    for (const [s, skirt] of this.skirts) {
      const { bottom } = s.guide();
      const position = skirt.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < bottom.length / 3; i++) {
        position.setXYZ(2 * i, bottom[3 * i], bottom[3 * i + 1], bottom[3 * i + 2]);
        position.setXYZ(2 * i + 1, bottom[3 * i], this.composition.floor, bottom[3 * i + 2]);
      }
      position.needsUpdate = true;
    }
    for (const [sheet, part] of this.beyond) {
      const all = sheet.geometry.index!.count / 6;
      const out = sheet.geometry.segmentsOut;
      const [kept, gone] = sheet.geometry.rail?.lead === 'tip' ? [[0, all - out], [all - out, out]] : [[out, all - out], [0, out]];
      sheet.geometry.setDrawRange(6 * kept[0], 6 * kept[1]);
      part.geometry.setDrawRange(6 * gone[0], 6 * gone[1]);
    }
  }

  private leave(dt: number) {
    for (const [sheet, out] of this.calledOut) {
      if (out.time >= out.duration) continue;
      out.time = Math.min(out.time + dt, out.duration);
      sheet.geometry.travelled = out.travel * ease(out.time / out.duration);
      if (out.time >= out.duration) out.gone();
    }
  }

  update(dt: number) {
    this.grow(dt);
    this.settle(dt);
    this.breathe(dt);
    this.focus(dt);
    this.leave(dt);
    this.stage.camera.getWorldDirection(this.towardsCamera).negate();
    for (const sheet of this.inBuildOrder()) {
      const leader = sheet.follows ? this.leaderOf(sheet) : undefined;
      const guide = leader && (this.calledOut.get(leader)?.stood ?? leader.guide());
      sheet.update(dt, this.towardsCamera, guide);
      if (sheet.spring.moving && !this.calledOut.has(sheet)) this.holdBack(sheet, guide);
    }
    this.splitBeyond();
    // Changed sheets get their labels placed afresh, once they are whole.
    if (!this.intro) this.placeLabels(this.sheets.filter((s) => s.labelStale && s.extent >= 1));

    this.onUpdate?.();
  }

  // Draw the poster as it stands. The halftone's dots keep their pitch on
  // the paper, so in pixels it follows the drawing buffer, which may have
  // been resized since the last update.
  render() {
    const { renderer, scene, camera, resolution } = this.stage;
    const pxPerCm = resolution.x / POSTER_SIZE.width;
    const pitch = this.composition.print.dotPitch * pxPerCm;
    printUniforms.uDotPitch.value = Math.max(pitch, MIN_DOT_PX * renderer.getPixelRatio());
    renderer.render(scene, camera);
  }

  // Put the labels of these sheets where the camera sees them.
  private placeLabels(sheets: Sheet[]) {
    if (sheets.length === 0) return;
    const seen = this.sight();
    for (const sheet of sheets) sheet.placeLabel(this.towardsCamera, (point) => seen(sheet, point));
  }

  // Where each sheet actually shows: the scene drawn once, small, each sheet
  // in an id of its own with its depth, so that a world point of a sheet can
  // be asked whether anything, that sheet itself included, hides it.
  private sight() {
    const { renderer, scene, camera } = this.stage;
    const w = Math.round((SIGHT * (camera.right - camera.left)) / (camera.top - camera.bottom));
    const h = SIGHT;
    if (!this.sightTarget || this.sightTarget.width !== w || this.sightTarget.height !== h) {
      this.sightTarget?.dispose();
      this.sightTarget = new THREE.WebGLRenderTarget(w, h);
      this.sightPixels = new Uint8Array(w * h * 4);
    }
    const target = this.sightTarget;
    const pixels = this.sightPixels;

    // Only the sheets, each in its id.
    const meshes = new Set<THREE.Object3D>(this.sheets.map((s) => s.mesh));
    const hidden = [...scene.children.filter((o) => !meshes.has(o) && o.visible), ...this.beyond.values()];
    for (const o of hidden) o.visible = false;
    const materials = this.sheets.map((s) => s.mesh.material);
    this.sheets.forEach((s, i) => ((s.mesh as THREE.Mesh).material = this.idMaterial(i + 1)));
    const clear = renderer.getClearColor(new THREE.Color());
    const alpha = renderer.getClearAlpha();
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clear, alpha);
    this.sheets.forEach((s, i) => ((s.mesh as THREE.Mesh).material = materials[i]));
    for (const o of hidden) o.visible = true;

    const tolerance = SIGHT_DEPTH / (camera.far - camera.near);
    const ndc = new THREE.Vector3();
    return (sheet: Sheet, point: THREE.Vector3) => {
      ndc.copy(point).project(camera);
      const x = Math.floor(((ndc.x + 1) / 2) * w);
      const y = Math.floor(((ndc.y + 1) / 2) * h);
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      const at = (y * w + x) * 4;
      if (pixels[at] !== this.sheets.indexOf(sheet) + 1) return false;
      const depth = (pixels[at + 1] + pixels[at + 2] / 255) / 255;
      return Math.abs(depth - (ndc.z + 1) / 2) <= tolerance;
    };
  }

  // Draws a sheet as its id (red) and depth (green, blue), for sight().
  private idMaterial(id: number) {
    return (this.idMaterials[id] ??= new THREE.ShaderMaterial({
      uniforms: { uId: { value: id } },
      vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader:
        'uniform float uId; void main() { float z = gl_FragCoord.z * 255.0; gl_FragColor = vec4(uId / 255.0, floor(z) / 255.0, fract(z), 1.0); }',
      side: THREE.DoubleSide,
    }));
  }

  // Paper stops at paper. If the sheet, pulled or still swinging from a
  // pull, would now run through another (or the floor), it goes only as far
  // as it can: the curl is bisected between the last clear one and this one,
  // and the spring rests against the curl found instead of passing it. Its
  // followers move along with it, so they are checked too.
  private holdBack(sheet: Sheet, guide?: ReturnType<Sheet['guide']>) {
    const followers = this.followersOf(sheet);
    const moving = new Set([sheet, ...followers]);
    const others = this.sheets.filter((s) => !moving.has(s));
    const floor = this.composition.floor;
    const place = () => {
      for (const follower of followers) follower.update(0, this.towardsCamera, sheet.guide());
    };
    const free = () => [sheet, ...followers].every((s) => collisionsOf(s, others, floor).length === 0);
    const curl = sheet.spring.value;
    place();
    if (free()) {
      sheet.safeCurl = curl;
      return;
    }
    if (Number.isNaN(sheet.safeCurl)) return; // started inside something; let it move
    let safe = sheet.safeCurl;
    let blocked = curl;
    for (let i = 0; i < REFINE && Math.abs(blocked - safe) > REFINE_CLOSE; i++) {
      const mid = (safe + blocked) / 2;
      sheet.spring.value = mid;
      sheet.update(0, this.towardsCamera, guide);
      place();
      if (free()) safe = mid;
      else blocked = mid;
    }
    if (curl < sheet.safeCurl) sheet.spring.min = safe;
    else sheet.spring.max = safe;
    sheet.safeCurl = safe;
    sheet.spring.value = safe;
    sheet.spring.velocity = 0;
    sheet.update(0, this.towardsCamera, guide);
    place();
  }

  // Followers after the sheets they follow; a loop breaks where it closes.
  private inBuildOrder() {
    const order: Sheet[] = [];
    const placed = new Set<Sheet>();
    const place = (sheet: Sheet, trail: Set<Sheet>) => {
      if (placed.has(sheet)) return;
      const leader = sheet.follows ? this.byId(sheet.spec.follow?.sheet) : undefined;
      if (leader && !trail.has(leader)) place(leader, new Set(trail).add(sheet));
      placed.add(sheet);
      order.push(sheet);
    };
    for (const sheet of this.sheets) place(sheet, new Set([sheet]));
    return order;
  }

  private mount(spec: SheetSpec) {
    const sheet = new Sheet(spec, this.composition);
    sheet.spring.stiffness = this.composition.spring.stiffness;
    sheet.spring.damping = this.composition.spring.damping;
    this.sheets.push(sheet);
    this.stage.scene.add(sheet.mesh);
    return sheet;
  }
}
