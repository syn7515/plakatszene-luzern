// The social card: the poster as the page shows it with one sheet under the
// hand, 011 in its two inks and every other sheet drained to grey, with no
// text on it. 1200 x 630, drawn at twice that by scripts/og.mjs; on the dev
// server it is at /scripts/og/.
import { initialComposition } from '../../src/composition.ts';
import { printUniforms } from '../../src/materials.ts';
import { PosterScene } from '../../src/poster-scene.ts';
import { createStage } from '../../src/stage.ts';

const SIZE = { width: 1200, height: 630 }; // CSS px; index.html agrees
const CALLED = 'violet-pink-yellow'; // 011
// The card's window onto the poster: its centre and width, cm in the camera's plane.
const WINDOW = { x: -5, y: 48.5, width: 62 };
// On the card only, sheets are set this tall (cm; the bottom edge stays) to
// let more of 011 show: it rises a little, and the sheets around it come
// down: 012 wraps its back, 013 stands at the far left, 001 at the top right.
const HEIGHTS: Record<string, number> = {
  'violet-pink-yellow': 54,
  'dark-beige': 31.5,
  'crescent-lavender': 36,
  'cup-violet-dark': 11.5,
};

const canvas = document.querySelector('canvas')!;
const stage = createStage(canvas);
const poster = new PosterScene(stage, initialComposition);
for (const [id, height] of Object.entries(HEIGHTS)) {
  const sheet = poster.byId(id)!;
  sheet.spec.shape.height = height;
  sheet.apply();
}
const called = poster.byId(CALLED)!;
delete called.spec.label; // under the hand it would print its own

const { camera } = stage;
const tall = (WINDOW.width * SIZE.height) / SIZE.width;
camera.left = WINDOW.x - WINDOW.width / 2;
camera.right = WINDOW.x + WINDOW.width / 2;
camera.top = WINDOW.y + tall / 2;
camera.bottom = WINDOW.y - tall / 2;
camera.updateProjectionMatrix();

// At rest, as after the opening (which the card skips), with 011 under the
// hand: the colour drains over these frames.
(poster as unknown as { opened: boolean }).opened = true;
poster.hovered = called;
for (let i = 0; i < 180; i++) poster.update(1 / 60);

// The dots keep their pitch on the paper, as on the page.
function draw() {
  printUniforms.uDotPitch.value = initialComposition.print.dotPitch * (stage.resolution.x / WINDOW.width);
  stage.renderer.render(stage.scene, camera);
}
stage.onResize = draw;
stage.renderer.setAnimationLoop(draw);
