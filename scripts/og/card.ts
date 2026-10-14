// The social card: the poster as the page shows it with one sheet under the
// hand, 011 in its two inks and every other sheet drained to grey, and on it,
// where its own label would be, the project's name. 1200 x 630, drawn at
// twice that by scripts/og.mjs; on the dev server it is at /scripts/og/.
import { initialComposition } from '../../src/composition.ts';
import { labelFontLoaded } from '../../src/label.ts';
import { printUniforms } from '../../src/materials.ts';
import { PosterScene } from '../../src/poster-scene.ts';
import { createStage } from '../../src/stage.ts';

const SIZE = { width: 1200, height: 630 }; // CSS px; index.html agrees
const CALLED = 'violet-pink-yellow'; // 011
// Pinned on its teal top, where the paper shows it whole. Printed this much
// larger than on the page, so the name still reads in a chat app's preview.
const LABEL = { title: 'Roll Call', name: '', at: 2.5, y: 46.8 };
const LABEL_SCALE = 1.4;
// The card's window onto the poster: its centre and width, cm in the camera's plane.
const WINDOW = { x: -5, y: 43.5, width: 62 };
// On the card only, the sheets around 011 come down (cm tall; the bottom
// edge stays) to let more of it show: 012 wraps its back, 013 stands at
// the far left, 001 at the top right.
const HEIGHTS: Record<string, number> = { 'dark-beige': 31.5, 'crescent-lavender': 36, 'cup-violet-dark': 11.5 };

await labelFontLoaded();
const canvas = document.querySelector('canvas')!;
const stage = createStage(canvas);
const poster = new PosterScene(stage, initialComposition);
for (const [id, height] of Object.entries(HEIGHTS)) {
  const sheet = poster.byId(id)!;
  sheet.spec.shape.height = height;
  sheet.apply();
}
const called = poster.byId(CALLED)!;
called.spec.label = { ...LABEL };

const { camera } = stage;
const tall = (WINDOW.width * SIZE.height) / SIZE.width;
camera.left = WINDOW.x - WINDOW.width / 2;
camera.right = WINDOW.x + WINDOW.width / 2;
camera.top = WINDOW.y + tall / 2;
camera.bottom = WINDOW.y - tall / 2;
camera.updateProjectionMatrix();

// At rest, as after the opening (which the card skips), with 011 under the
// hand: the colour drains and the label prints over these frames. Labels
// are placed as the window sees the paper.
(poster as unknown as { opened: boolean }).opened = true;
poster.hovered = called;
for (let i = 0; i < 180; i++) poster.update(1 / 60);

// The label's field scales cleanly: enlarge it from its top left corner.
const rect = called.mesh.material.uniforms.uLabelRect.value;
rect.z = rect.x + (rect.z - rect.x) * LABEL_SCALE;
rect.y = rect.w - (rect.w - rect.y) * LABEL_SCALE;

// The dots keep their pitch on the paper, as on the page.
function draw() {
  printUniforms.uDotPitch.value = initialComposition.print.dotPitch * (stage.resolution.x / WINDOW.width);
  stage.renderer.render(stage.scene, camera);
}
stage.onResize = draw;
stage.renderer.setAnimationLoop(draw);
