import * as THREE from 'three';
import type { Sheet } from './sheet.ts';

// Paper cannot pass through paper, nor through the floor. Each sheet is
// ruled: straight lines run from its bottom edge to its top edge. Two sheets
// collide where, at some height both reach, their horizontal cross-sections
// cross. Checking a handful of heights through the overlap catches slanted
// and tilted sheets too.

export interface Collision {
  a: Sheet;
  b: Sheet; // the same sheet when it runs through itself or the floor
  at: THREE.Vector3;
  floor?: boolean; // goes below the floor
}

const FLOOR_SLACK = 0.05; // cm; grounded sheets sit exactly on it

const STEP = 3; // check every 3rd station along the paper
const LEVELS = 5; // heights checked through each overlap
const ANCHOR_SLACK = 0.5; // cm; two sheets may share an anchor point

interface Ruled {
  sheet: Sheet;
  bottom: THREE.Vector3[]; // world, per checked station
  top: THREE.Vector3[];
  y0: number;
  y1: number;
  box: [number, number, number, number]; // min x, min z, max x, max z
}

function ruled(sheet: Sheet, step = STEP): Ruled {
  sheet.mesh.updateMatrixWorld();
  const matrix = sheet.mesh.matrixWorld;
  const { bottom: b, top: t } = sheet.geometry.edges;
  const stations = b.length / 3;
  const picks: number[] = [];
  for (let i = 0; i < stations - 1; i += step) picks.push(i);
  picks.push(stations - 1);
  const bottom = picks.map((i) => new THREE.Vector3(b[3 * i], b[3 * i + 1], b[3 * i + 2]).applyMatrix4(matrix));
  const top = picks.map((i) => new THREE.Vector3(t[3 * i], t[3 * i + 1], t[3 * i + 2]).applyMatrix4(matrix));
  const all = [...bottom, ...top];
  const ys = all.map((p) => p.y);
  const xs = all.map((p) => p.x);
  const zs = all.map((p) => p.z);
  return {
    sheet, bottom, top,
    y0: Math.min(...ys), y1: Math.max(...ys),
    box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)],
  };
}

// Plan points where the sheet meets the horizontal plane at height y (null
// where a station's line does not reach that height).
function section(r: Ruled, y: number): ([number, number] | null)[] {
  return r.bottom.map((b, i) => {
    const t = r.top[i];
    if (t.y === b.y) return null;
    const f = (y - b.y) / (t.y - b.y);
    if (f < 0 || f > 1) return null;
    return [b.x + (t.x - b.x) * f, b.z + (t.z - b.z) * f];
  });
}

function crossing(p: [number, number], q: [number, number], r: [number, number], s: [number, number]): [number, number] | null {
  const denom = (q[0] - p[0]) * (s[1] - r[1]) - (q[1] - p[1]) * (s[0] - r[0]);
  if (denom === 0) return null;
  const t = ((r[0] - p[0]) * (s[1] - r[1]) - (r[1] - p[1]) * (s[0] - r[0])) / denom;
  const u = ((r[0] - p[0]) * (q[1] - p[1]) - (r[1] - p[1]) * (q[0] - p[0])) / denom;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
}

function crossingAt(a: Ruled, b: Ruled, y: number): THREE.Vector3 | null {
  const self = a === b;
  const sa = section(a, y);
  const sb = self ? sa : section(b, y);
  const nearAnchor = (pts: ([number, number] | null)[], i: number) => {
    const [p, o] = [pts[i], pts[0]];
    return !!p && !!o && Math.hypot(p[0] - o[0], p[1] - o[1]) < ANCHOR_SLACK;
  };
  for (let i = 0; i < sa.length - 1; i++) {
    const [p, q] = [sa[i], sa[i + 1]];
    if (!p || !q) continue;
    for (let j = self ? i + 2 : 0; j < sb.length - 1; j++) {
      const [r, s] = [sb[j], sb[j + 1]];
      if (!r || !s) continue;
      const hit = crossing(p, q, r, s);
      if (!hit || (!self && nearAnchor(sa, i) && nearAnchor(sb, j))) continue;
      return new THREE.Vector3(hit[0], y, hit[1]);
    }
  }
  return null;
}

// Where one sheet runs through the floor or any of the others, for checking a
// sheet as it is pulled: only its pairs, every frame.
export function collisionsOf(sheet: Sheet, others: Sheet[], floor: number, step = STEP * 2): Collision[] {
  const a = ruled(sheet, step);
  const found: Collision[] = [];
  const lowest = [...a.bottom, ...a.top].reduce((m, q) => (q.y < m.y ? q : m));
  if (lowest.y < floor - FLOOR_SLACK) found.push({ a: sheet, b: sheet, at: lowest.clone(), floor: true });
  for (const other of others) {
    if (other === sheet) continue;
    const b = ruled(other, step);
    const lo = Math.max(a.y0, b.y0);
    const hi = Math.min(a.y1, b.y1);
    if (hi <= lo) continue;
    if (a.box[0] > b.box[2] || b.box[0] > a.box[2] || a.box[1] > b.box[3] || b.box[1] > a.box[3]) continue;
    for (let k = 0; k < LEVELS; k++) {
      const at = crossingAt(a, b, lo + ((k + 0.5) / LEVELS) * (hi - lo));
      if (at) {
        found.push({ a: sheet, b: other, at });
        break;
      }
    }
  }
  return found;
}

export function findCollisions(sheets: Sheet[], floor: number): Collision[] {
  const all = sheets.map((s) => ruled(s)); // not map(ruled): the index would become the step
  const collisions: Collision[] = [];
  for (const r of all) {
    const lowest = [...r.bottom, ...r.top].reduce((a, b) => (b.y < a.y ? b : a));
    if (lowest.y < floor - FLOOR_SLACK) collisions.push({ a: r.sheet, b: r.sheet, at: lowest.clone(), floor: true });
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i; j < all.length; j++) {
      const [a, b] = [all[i], all[j]];
      const lo = Math.max(a.y0, b.y0);
      const hi = Math.min(a.y1, b.y1);
      if (hi <= lo) continue;
      if (a.box[0] > b.box[2] || b.box[0] > a.box[2] || a.box[1] > b.box[3] || b.box[1] > a.box[3]) continue;
      for (let k = 0; k < LEVELS; k++) {
        const at = crossingAt(a, b, lo + ((k + 0.5) / LEVELS) * (hi - lo));
        if (at) {
          collisions.push({ a: a.sheet, b: b.sheet, at });
          break;
        }
      }
    }
  }
  return collisions;
}
