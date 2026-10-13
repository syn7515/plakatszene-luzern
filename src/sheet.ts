import * as THREE from 'three';
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
}

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
    );
    if (this.follows) {
      // Where the anchored end ended up, so the editor can show it.
      const { bottom } = this.geometry.edges;
      this.spec.position[0] = bottom[0];
      this.spec.position[2] = bottom[2];
    }
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
  }
}
