import * as THREE from 'three';
import { PAPER, POSTER_SIZE } from './poster.ts';

// The canvas *is* the poster: CSS keeps it at the F4 aspect ratio, so the
// orthographic frustum maps 1:1 onto the sheet and anything past the edge
// is trimmed like the printed crop.
export function createStage(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(PAPER);

  const { width: w, height: h } = POSTER_SIZE;
  document.documentElement.style.setProperty('--poster-ratio', String(w / h));

  const camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 1000);

  // The print looks down on its sheets slightly: tops of the rolls read as
  // ellipses. Orthographic, so this only tilts, never adds perspective.
  function setElevation(degrees: number) {
    const a = THREE.MathUtils.degToRad(degrees);
    camera.position.set(0, Math.sin(a), Math.cos(a)).multiplyScalar(200);
    camera.lookAt(0, 0, 0);
  }
  setElevation(0);

  const scene = new THREE.Scene();

  const resolution = new THREE.Vector2(); // drawing buffer, device px
  const stage = { renderer, scene, camera, resolution, setElevation, onResize: () => {} };
  // Resizing the drawing buffer clears it, and the observer reports only
  // after this frame was drawn: onResize draws it again straight away, or
  // the frame goes out blank and the poster flickers while the window is
  // being resized.
  new ResizeObserver(() => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    renderer.getDrawingBufferSize(resolution);
    stage.onResize();
  }).observe(canvas);

  return stage;
}

export type Stage = ReturnType<typeof createStage>;
