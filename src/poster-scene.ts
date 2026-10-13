import * as THREE from 'three';
import { collisionsOf } from './collisions.ts';
import type { Composition } from './composition.ts';
import { printUniforms } from './materials.ts';
import { POSTER_SIZE, SURFACES } from './poster.ts';
import { Sheet, type SheetSpec } from './sheet.ts';
import type { Stage } from './stage.ts';

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

// Settled, a sheet never quite holds still: it keeps breathing, the same
// movement as its settling (a little unroll, or the corner dipping) at a
// fraction of the size, slowly, each sheet to a rhythm of its own that
// never quite repeats. It holds still while it is being pulled.
const IDLE = 0.3; // of the settling movement
const IDLE_PERIOD = 7; // s; each sheet breathes somewhere between this and twice it
const IDLE_SECOND = 1.618; // the second, fainter wave is this much slower

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
  // floor, so each frame it is checked and, where it would, held back.
  held: Sheet | null = null;

  private intro: { time: number; starts: Map<Sheet, number> } | null = null;
  // Per arriving sheet: seconds since arrival and how far it may move.
  private readonly settling = new Map<Sheet, { time: number; amount: number }>();
  // Leaders that have arrived and wait for their followers before breathing,
  // so the room is measured with everyone whole.
  private readonly waiting = new Set<Sheet>();
  // Per settled sheet: seconds breathing, how far it may move, its two periods.
  private readonly breathing = new Map<Sheet, { time: number; amount: number; periods: [number, number] }>();

  private readonly stage: Stage;
  private readonly towardsCamera = new THREE.Vector3();

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
    SURFACES.lavender.tone = print.lavender;
    SURFACES.darkGreen.tone = print.darkGreen;
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
    const order = this.inBuildOrder();
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
          this.settling.set(sheet, { time: 0, amount: this.room(sheet, leader?.guide(), 1) });
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
      this.startBreathing(sheet, this.room(sheet, this.leaderOf(sheet)?.guide(), IDLE));
    }
    if (done) this.intro = null;
  }

  private followersOf(sheet: Sheet) {
    return this.sheets.filter((s) => s !== sheet && s.follows && this.leaderOf(s) === sheet);
  }

  // How far a sheet may move without running through paper or the floor,
  // at `scale` of the settling movement: the unroll, tried at its deepest;
  // the other way (a little tighter) if that hits; nothing if both do. A
  // sheet with a drooping corner dips that instead. Its followers move
  // along with it, so they are checked too. Checked once, not every frame.
  private room(sheet: Sheet, guide: ReturnType<Sheet['guide']> | undefined, scale: number) {
    const followers = this.followersOf(sheet);
    const moving = new Set([sheet, ...followers]);
    const others = this.sheets.filter((s) => !moving.has(s));
    const place = () => {
      sheet.update(0, this.towardsCamera, guide);
      for (const follower of followers) follower.update(0, this.towardsCamera, sheet.guide());
    };
    const clear = (apply: () => void) => {
      apply();
      place();
      let hits = collisionsOf(sheet, others, this.composition.floor).length;
      for (const follower of followers) hits += collisionsOf(follower, others, this.composition.floor).length;
      sheet.curlOffset = 0;
      sheet.drooped = 0;
      place();
      return hits === 0;
    };
    if (sheet.spec.droop) return clear(() => (sheet.drooped = scale)) ? scale : 0;
    if (clear(() => (sheet.curlOffset = SETTLE * scale))) return SETTLE * scale;
    if (clear(() => (sheet.curlOffset = SETTLE_TIGHTER * scale))) return SETTLE_TIGHTER * scale;
    return 0;
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
          // Settled: carry on breathing within the room the settling had, or
          // look for a little where it had none.
          const room = state.amount !== 0 ? state.amount * IDLE : this.room(sheet, this.leaderOf(sheet)?.guide(), IDLE);
          this.startBreathing(sheet, room);
        }
      }
      if (sheet.spec.droop) sheet.drooped = amount * state.amount;
      else sheet.curlOffset = state.amount * amount;
    }
  }

  private startBreathing(sheet: Sheet, amount: number) {
    if (amount === 0) return;
    const period = IDLE_PERIOD * (1 + noise(sheet.spec.id));
    this.breathing.set(sheet, { time: 0, amount, periods: [period, period * IDLE_SECOND] });
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
      else sheet.curlOffset = amount;
    }
  }

  update(dt: number) {
    this.grow(dt);
    this.settle(dt);
    this.breathe(dt);
    this.stage.camera.getWorldDirection(this.towardsCamera).negate();
    for (const sheet of this.inBuildOrder()) {
      const leader = sheet.follows ? this.leaderOf(sheet) : undefined;
      sheet.update(dt, this.towardsCamera, leader?.guide());
      if (sheet === this.held) this.holdBack(sheet, leader?.guide());
    }

    const pxPerCm = this.stage.resolution.x / POSTER_SIZE.width;
    const pitch = this.composition.print.dotPitch * pxPerCm;
    printUniforms.uDotPitch.value = Math.max(pitch, MIN_DOT_PX * this.stage.renderer.getPixelRatio());

    this.onUpdate?.();
  }

  // Paper stops at paper. If the pulled sheet now runs through another (or
  // the floor), put it back at the last curl where it did not, and make the
  // spring rest against that curl instead of passing it.
  private holdBack(sheet: Sheet, guide?: ReturnType<Sheet['guide']>) {
    const others = this.sheets.filter((s) => s !== sheet && this.leaderOf(s) !== sheet);
    const curl = sheet.spring.value;
    if (collisionsOf(sheet, others, this.composition.floor).length === 0) {
      sheet.safeCurl = curl;
      return;
    }
    if (Number.isNaN(sheet.safeCurl)) return; // started inside something; let it move
    if (curl < sheet.safeCurl) sheet.spring.min = sheet.safeCurl;
    else sheet.spring.max = sheet.safeCurl;
    sheet.spring.value = sheet.safeCurl;
    sheet.spring.velocity = 0;
    sheet.update(0, this.towardsCamera, guide);
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
