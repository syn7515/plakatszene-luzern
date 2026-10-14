import * as THREE from 'three';
import type { Spring } from './spring.ts';

export interface PullTarget {
  mesh: THREE.Mesh;
  spring: Spring; // holds the curl
  pullLength: () => number; // cm; pulling this far unrolls the sheet completely
  pullDirection: () => THREE.Vector3; // world; dragging this way pays paper out
}

const TAP_SLOP = 4; // px of movement before a press counts as a drag
const FLING_WINDOW = 100; // ms of recent movement that sets the release speed
const MAX_FLING = 6; // curl per second
const TAP_NUDGE = 4; // curl per second

// Grab a sheet and pull along its length to unroll it; let go and its spring
// rolls it back up, carrying the speed of the pull. A tap goes to `tap`,
// and if that does nothing with it, just nudges the sheet. `hover` hears
// which sheet is under the pointer whenever that changes (the held one,
// while pulling). Switch it off through the returned `enabled` flag.
export function enablePull(
  canvas: HTMLCanvasElement,
  camera: THREE.Camera,
  targets: () => PullTarget[],
  held: (target: PullTarget | null) => void = () => {},
  hover: (target: PullTarget | null) => void = () => {},
  tap: (target: PullTarget) => boolean = () => false,
) {
  const control = { enabled: true };
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let over: PullTarget | null = null;
  const setOver = (target: PullTarget | null) => {
    if (target === over) return;
    over = target;
    hover(target);
  };

  let drag: {
    target: PullTarget;
    startX: number;
    startY: number;
    startCurl: number;
    axis: THREE.Vector2;
    history: { time: number; curl: number }[];
    moved: boolean;
  } | null = null;

  const targetAt = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const all = targets();
    const [hit] = raycaster.intersectObjects(all.map((t) => t.mesh), false);
    return hit && all.find((t) => t.mesh === hit.object);
  };

  // Screen px covered by 1 cm of paper paying out, at the sheet's anchor.
  const lengthAxis = (target: PullTarget) => {
    const r = canvas.getBoundingClientRect();
    const origin = new THREE.Vector3().setFromMatrixPosition(target.mesh.matrixWorld);
    const a = origin.clone().project(camera);
    const b = origin.clone().add(target.pullDirection()).project(camera);
    return new THREE.Vector2(((b.x - a.x) * r.width) / 2, (-(b.y - a.y) * r.height) / 2);
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!control.enabled) return;
    const target = targetAt(e);
    if (!target) return;
    setOver(target);
    canvas.setPointerCapture(e.pointerId);
    target.spring.held = true;
    target.spring.velocity = 0;
    target.spring.min = 0;
    target.spring.max = Infinity;
    held(target);
    drag = {
      target,
      startX: e.clientX,
      startY: e.clientY,
      startCurl: target.spring.value,
      axis: lengthAxis(target),
      history: [{ time: e.timeStamp, curl: target.spring.value }],
      moved: false,
    };
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
      const target = control.enabled ? (targetAt(e) ?? null) : null;
      canvas.style.cursor = target ? 'grab' : '';
      setOver(target);
      return;
    }
    const { target, axis, history } = drag;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    drag.moved ||= Math.hypot(dx, dy) > TAP_SLOP;

    const pulledCm = (dx * axis.x + dy * axis.y) / axis.lengthSq();
    const curl = THREE.MathUtils.clamp(drag.startCurl - pulledCm / target.pullLength(), 0, 1.2);
    // Blocked by paper or the floor: the stops the scene set hold it there.
    target.spring.value = THREE.MathUtils.clamp(curl, target.spring.min, target.spring.max);
    history.push({ time: e.timeStamp, curl });
    while (history.length > 2 && e.timeStamp - history[1].time > FLING_WINDOW) history.shift();
  });

  const release = (e: PointerEvent) => {
    if (!drag) return;
    const { target, history, moved } = drag;
    const { spring } = target;
    spring.held = false;
    held(null);

    if (!moved) {
      if (e.type !== 'pointerup' || !tap(target)) spring.velocity = -TAP_NUDGE;
    } else {
      // Speed over the last moments of the pull; zero if the hand had stopped.
      const first = history[0];
      const last = history[history.length - 1];
      const elapsed = (e.timeStamp - first.time) / 1000;
      const velocity = elapsed > 0 && e.timeStamp - last.time < FLING_WINDOW ? (last.curl - first.curl) / elapsed : 0;
      spring.velocity = THREE.MathUtils.clamp(velocity, -MAX_FLING, MAX_FLING);
    }

    drag = null;
    const under = targetAt(e) ?? null;
    canvas.style.cursor = under ? 'grab' : '';
    setOver(under);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('lostpointercapture', release);
  canvas.addEventListener('pointerleave', () => {
    if (!drag) setOver(null);
  });

  return control;
}
