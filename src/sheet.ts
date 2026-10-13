import * as THREE from 'three';
import { labelSize, printLabel, type LabelPrint } from './label.ts';
import { createPaperMaterial, setFace } from './materials.ts';
import { SURFACES, type SurfaceName } from './poster.ts';
import { Spring } from './spring.ts';
import { StripGeometry, paperLength, type Droop, type Follow, type Guide, type Pull, type StripShape } from './strip-geometry.ts';

// One sheet as stored in composition.json.
export interface SheetSpec {
  id: string;
  position: [number, number, number]; // anchored end, bottom edge; cm
  // Degrees: tilt forward/back (x), turn (y), tilt sideways (z). Turning comes
  // first, so both tilts read as seen on the poster.
  rotation: [number, number, number];
  // Stands on the floor: its bottom edge rests there and it cannot tilt.
  // Otherwise it floats, still on its way down, at any height and angle.
  grounded?: boolean;
  curl: number; // at rest
  shape: StripShape;
  faces: SurfaceName[]; // one per visible face, from the anchored end
  // Lies against another sheet: x, z and the turn are then taken from that
  // sheet (see Follow); only the height and the floor still apply.
  follow?: Follow;
  // The stretch that pays out when pulled (see Pull). Without it the whole
  // sheet unrolls from its anchored end.
  pull?: Pull;
  // A corner at the anchored end that can sag (see Droop); the opening
  // transition lets it dip and slowly recover instead of fluttering the roll.
  droop?: Droop;
  // What the sheet says about itself when pointed at.
  label?: Label;
}

// A title and year printed on the paper, shown on hover. Where it goes the
// sheet works out itself unless the spec fixes it.
export interface Label {
  title: string;
  year: number;
  vertical?: boolean; // reads up the paper instead of along it
  at?: number; // cm along the paper where it starts
  y?: number; // cm up from the bottom edge
  side?: 'front' | 'back';
}

export interface LabelPlace {
  at: number;
  y: number;
  side: 'front' | 'back';
  vertical: boolean;
}

const TOP = 1.5; // cm between the top edge and the label
const MAX_TURN = 45; // degrees a label may wrap through along the paper before it goes vertical instead

const towardsCameraLocal = new THREE.Vector3();
const inverse = new THREE.Quaternion();
const point = new THREE.Vector3();

// What every sheet needs to know about the space it is in.
export interface World {
  floor: number;
}

export class Sheet {
  readonly geometry: StripGeometry;
  readonly mesh: THREE.Mesh<StripGeometry, ReturnType<typeof createPaperMaterial>>;
  readonly spring: Spring; // holds the curl
  spec: SheetSpec;
  // The curl at which this sheet last stood clear of the others, while pulled.
  safeCurl = NaN;
  // How much of the paper exists, 0..1; the opening transition grows it.
  extent = 1;
  // How far the corner has sagged, 0..1.
  drooped = 0;
  // Added to the curl the geometry is built with; the opening transition
  // eases a small unroll in and out through it, without the spring.
  curlOffset = 0;
  // Every bend this much looser than drawn (negative: tighter); the breathing.
  relax = 0;

  // 1 = printed as it is, 0 = drained to grey; the focus on a hovered sheet.
  get saturation(): number {
    return this.mesh.material.uniforms.uSaturation.value;
  }
  set saturation(value: number) {
    this.mesh.material.uniforms.uSaturation.value = value;
  }
  // The label's opacity, 0..1; it fades in on hover.
  get reveal(): number {
    return this.mesh.material.uniforms.uReveal.value;
  }
  set reveal(value: number) {
    this.mesh.material.uniforms.uReveal.value = value;
  }
  // Where the label was put; null without one. Needs placing again after the spec changed.
  placed: LabelPlace | null = null;
  labelStale = true;
  private print: LabelPrint | null = null;
  private printed = '';
  private readonly world: World;
  private guideCache: Guide | null = null;

  constructor(spec: SheetSpec, world: World) {
    this.spec = spec;
    this.world = world;
    this.geometry = new StripGeometry(spec.shape);
    this.mesh = new THREE.Mesh(this.geometry, createPaperMaterial());
    this.mesh.rotation.order = 'ZXY';
    this.spring = new Spring(spec.curl, 170, 15, 0);
    this.apply();
  }

  paperLength = () => paperLength(this.spec.shape);

  // How much paper a pull can pay out: the pull stretch, or the whole sheet.
  pullLength = () => {
    const pull = this.spec.pull;
    return pull ? Math.abs(pull.to - pull.from) : paperLength(this.spec.shape);
  };

  // World direction the paper runs in where the pull starts to pay it out, so
  // a drag that way unrolls the sheet. Stations are evenly spaced along the paper.
  pullDirection = () => {
    const { bottom } = this.geometry.edges;
    const stations = bottom.length / 3 - 1;
    const length = paperLength(this.spec.shape);
    const pull = this.spec.pull;
    const at = pull ? pull.from : 0;
    const towards = pull ? Math.sign(pull.to - pull.from) || 1 : 1;
    const i = THREE.MathUtils.clamp(Math.round((at / length) * stations), 1, stations - 1);
    const a = new THREE.Vector3(bottom[3 * (i - 1)], bottom[3 * (i - 1) + 1], bottom[3 * (i - 1) + 2]);
    const b = new THREE.Vector3(bottom[3 * (i + 1)], bottom[3 * (i + 1) + 1], bottom[3 * (i + 1) + 2]);
    this.mesh.updateMatrixWorld();
    a.applyMatrix4(this.mesh.matrixWorld);
    b.applyMatrix4(this.mesh.matrixWorld);
    return b.sub(a).multiplyScalar(towards).normalize();
  };

  get follows() {
    return !!this.spec.follow && this.spec.shape.bends.some((b) => b.follow);
  }

  // cm of this sheet before the stretch that follows another.
  get followStart() {
    let s = 0;
    for (const b of this.spec.shape.bends) {
      if (b.follow) break;
      s += b.length;
    }
    return s;
  }

  // Push the spec into the scene after it changed.
  apply() {
    const { position, rotation, grounded, curl, shape, faces, follow } = this.spec;
    if (grounded) {
      position[1] = this.world.floor;
      rotation[0] = rotation[2] = 0;
    }
    if (this.follows) {
      // Built in the followed sheet's space; the mesh carries no transform.
      this.mesh.position.set(0, 0, 0);
      this.mesh.rotation.set(0, 0, 0);
      this.geometry.baseY = position[1];
      this.geometry.follow = follow!;
    } else {
      this.mesh.position.fromArray(position);
      const [rx, ry, rz] = rotation.map(THREE.MathUtils.degToRad);
      this.mesh.rotation.set(rx, ry, rz);
      this.geometry.baseY = 0;
      this.geometry.follow = null;
    }

    this.geometry.shape = shape;
    this.geometry.pull = this.spec.pull ?? null;
    this.geometry.droop = this.spec.droop ?? null;
    this.geometry.invalidate();
    this.spring.min = 0;
    this.spring.max = Infinity;
    this.safeCurl = NaN;
    this.labelStale = true;
    faces.forEach((name, i) => setFace(this.mesh.material, i, SURFACES[name]));

    if (this.spring.target !== curl) {
      this.spring.target = this.spring.value = curl;
      this.spring.velocity = 0;
    }
  }

  // guide: the followed sheet's edges, when this sheet follows one.
  update(dt: number, towardsCamera: THREE.Vector3, guide?: Guide) {
    this.spring.step(dt);
    inverse.copy(this.mesh.quaternion).invert();
    towardsCameraLocal.copy(towardsCamera).applyQuaternion(inverse);
    this.geometry.update(
      this.spring.value + this.curlOffset,
      towardsCameraLocal,
      this.follows ? guide : undefined,
      this.extent,
      this.drooped,
      this.relax,
    );
    if (this.follows) {
      // Where the anchored end ended up, so the editor can show it.
      const { bottom } = this.geometry.edges;
      this.spec.position[0] = bottom[0];
      this.spec.position[2] = bottom[2];
    }
  }

  // Put the label on the paper and print it there. Called with the sheet
  // whole and at rest; `seen` says whether the camera sees a world point of
  // this sheet. The label sits up against the top edge. It wants a stretch
  // of one side that faces the camera, long enough for it, in plain sight,
  // turning as little as possible and nearest the middle of that side, with
  // room above the floor: along the paper if such a stretch turns less than
  // MAX_TURN, else up the paper, else along the paper wherever it turns
  // least and shows most. The spec may fix any of this instead.
  placeLabel(towardsCamera: THREE.Vector3, seen: (point: THREE.Vector3) => boolean) {
    const u = this.mesh.material.uniforms;
    const label = this.spec.label;
    this.labelStale = false;
    if (!label) {
      u.uLabelSide.value = 0;
      this.placed = null;
      return;
    }
    const { bottom, top } = this.guide();
    const stations = bottom.length / 3 - 1;
    const ds = this.geometry.stationLength;
    const length = this.paperLength();
    const { height } = this.spec.shape;
    const floor = this.world.floor;

    // Per segment: which side faces the camera, and the turn from the one before, summed up.
    const facing = new Int8Array(stations);
    const turned = new Float32Array(stations + 1);
    const along = new THREE.Vector3();
    const prev = new THREE.Vector3();
    const up = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (let i = 0; i < stations; i++) {
      const [a, b] = [3 * i, 3 * (i + 1)];
      along.set(
        (bottom[b] + top[b] - bottom[a] - top[a]) / 2,
        (bottom[b + 1] + top[b + 1] - bottom[a + 1] - top[a + 1]) / 2,
        (bottom[b + 2] + top[b + 2] - bottom[a + 2] - top[a + 2]) / 2,
      );
      up.set(
        (top[a] + top[b] - bottom[a] - bottom[b]) / 2,
        (top[a + 1] + top[b + 1] - bottom[a + 1] - bottom[b + 1]) / 2,
        (top[a + 2] + top[b + 2] - bottom[a + 2] - bottom[b + 2]) / 2,
      );
      normal.crossVectors(along, up);
      facing[i] = Math.sign(normal.dot(towardsCamera));
      turned[i + 1] = turned[i] + (i > 0 ? THREE.MathUtils.radToDeg(prev.angleTo(along)) : 0);
      prev.copy(along);
    }
    // Where the floor cuts the paper at a station, in cm up the paper.
    const floorAt = (i: number) => {
      const [yb, yt] = [bottom[3 * i + 1], top[3 * i + 1]];
      return THREE.MathUtils.clamp(((floor - yb) / (yt - yb)) * height, 0, height);
    };
    // Where a label h cm tall sits, starting at station i over n stations:
    // up against the top edge, but never below the floor.
    const yFor = (i: number, n: number, h: number) =>
      Math.max(height - TOP - h, floorAt(Math.min(stations, Math.round(i + n / 2))));
    // Whether the camera sees each station, at the middle of a label h cm tall there.
    const point = new THREE.Vector3();
    const sightAt = (h: number) => {
      const seenAt = new Uint8Array(stations + 1);
      for (let i = 0; i <= stations; i++) {
        const f = (yFor(i, 0, h) + h / 2) / height;
        const at = 3 * i;
        point.set(
          bottom[at] + (top[at] - bottom[at]) * f,
          bottom[at + 1] + (top[at + 1] - bottom[at + 1]) * f,
          bottom[at + 2] + (top[at + 2] - bottom[at + 2]) * f,
        );
        seenAt[i] = seen(point) ? 1 : 0;
      }
      return seenAt;
    };
    // The runs of segments that show one side (and, strictly, that the
    // camera sees): where each segment's run starts and ends.
    const runs = (seenAt: Uint8Array | null) => {
      const start = new Int32Array(stations);
      const end = new Int32Array(stations);
      const same = (i: number, j: number) => facing[j] === facing[i] && (!seenAt || seenAt[j] === 1);
      for (let i = 0; i < stations; ) {
        let j = i;
        while (j < stations && same(i, j)) j++;
        start.fill(i, i, Math.max(j, i + 1));
        end.fill(j, i, Math.max(j, i + 1));
        i = Math.max(j, i + 1);
      }
      return { start, end };
    };
    // The best start for a label w cm along and h cm up the paper: within
    // one run, turning least and nearest the run's middle. Strictly, the
    // run must be in sight and the label must fit under the top edge;
    // otherwise hidden stretches only count against it.
    const search = (w: number, h: number, strict: boolean) => {
      const n = Math.max(1, Math.ceil(w / ds));
      const seenAt = sightAt(h);
      const { start, end } = runs(strict ? seenAt : null);
      let best: { i: number; turn: number; score: number } | null = null;
      for (let i = 0; i + n <= stations; i++) {
        if (facing[i] === 0 || (strict && seenAt[i] === 0) || end[i] < i + n) continue;
        const c = i + n / 2;
        const y = yFor(i, n, h);
        if (strict && y + h > height - TOP + 0.01) continue; // pushed up by the floor: no room
        const turn = turned[i + n] - turned[i + 1];
        const offCentre = 0.05 * Math.abs(c - (start[i] + end[i]) / 2) * ds;
        let hidden = 0;
        if (!strict) for (let k = i; k <= i + n; k++) hidden += 1 - seenAt[k];
        const score = turn + offCentre + (hidden / (n + 1)) * 200;
        if (!best || score < best.score) best = { i, turn, score };
      }
      return best;
    };

    const { title, year } = label;
    const sizes = { along: labelSize(title, year, false), up: labelSize(title, year, true) };
    let vertical: boolean;
    let best: ReturnType<typeof search>;
    if (label.vertical !== undefined) {
      vertical = label.vertical;
      const size = vertical ? sizes.up : sizes.along;
      best = search(size.width, size.height, true) ?? search(size.width, size.height, false);
    } else {
      const h = search(sizes.along.width, sizes.along.height, true);
      const v = h && h.turn <= MAX_TURN ? null : search(sizes.up.width, sizes.up.height, true);
      vertical = !!v && (!h || v.turn < h.turn);
      best = vertical ? v : (h ?? search(sizes.along.width, sizes.along.height, false));
    }
    const size = vertical ? sizes.up : sizes.along;
    const start = best?.i ?? 0;
    this.placed = {
      at: label.at ?? start * ds,
      y: label.y ?? yFor(start, Math.ceil(size.width / ds), size.height),
      side: label.side ?? (best && facing[best.i] < 0 ? 'back' : 'front'),
      vertical,
    };

    const text = `${title}\n${year}`;
    if (!this.print || this.print.vertical !== vertical || this.printed !== text) {
      this.print?.texture.dispose();
      this.print = printLabel(title, year, vertical);
      this.printed = text;
      u.uLabel.value = this.print.texture;
    }
    const { at, y: py, side } = this.placed;
    u.uLabelRect.value.set(at / length, py / height, (at + size.width) / length, (py + size.height) / height);
    u.uLabelSide.value = side === 'front' ? 1 : -1;
  }

  // This sheet's edges in world space, for the sheets that follow it.
  guide(): Guide {
    const version = this.geometry.version;
    if (this.guideCache?.version === version) return this.guideCache;
    this.mesh.updateMatrixWorld();
    const { bottom, top } = this.geometry.edges;
    const toWorld = (edge: Readonly<Float32Array>) => {
      const out = new Float32Array(edge.length);
      for (let i = 0; i < edge.length; i += 3) {
        point.set(edge[i], edge[i + 1], edge[i + 2]).applyMatrix4(this.mesh.matrixWorld);
        out[i] = point.x;
        out[i + 1] = point.y;
        out[i + 2] = point.z;
      }
      return out;
    };
    const stations = bottom.length / 3 - 1;
    this.guideCache = {
      bottom: toWorld(bottom),
      top: toWorld(top),
      ds: this.geometry.stationLength,
      version,
      live: Math.round(this.extent * stations),
    };
    return this.guideCache;
  }

  dispose() {
    this.geometry.dispose();
    this.mesh.material.dispose();
    this.print?.texture.dispose();
  }
}
