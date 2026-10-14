import { mountCaption, type Caption } from './caption.ts';
import { initialComposition } from './composition.ts';
import { PosterScene } from './poster-scene.ts';
import { enablePull } from './pull.ts';
import { createStage } from './stage.ts';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#poster')!;
const stage = createStage(canvas);
const poster = new PosterScene(stage, initialComposition);
const pull = enablePull(
  canvas,
  stage.camera,
  () => poster.sheets,
  (target) => {
    poster.held = poster.sheets.find((s) => s === target) ?? null;
  },
  (target) => {
    poster.hovered = poster.sheets.find((s) => s === target) ?? null;
  },
);

// Dev only: reach the scene from the console.
if (import.meta.env.DEV) (window as unknown as { __poster: PosterScene }).__poster = poster;

// Dev only: open with ?edit to trace the original and arrange sheets.
// The editor skips the opening so the sheets are there to work on, and
// has no wall label.
let caption: Caption | null = null;
if (import.meta.env.DEV && new URLSearchParams(location.search).has('edit')) {
  import('./editor.ts').then(({ startEditor }) => startEditor(poster, stage, pull));
} else {
  caption = mountCaption(document.querySelector<HTMLElement>('.work')!);
  poster.startIntro();
}

let last = 0;
stage.renderer.setAnimationLoop((time) => {
  const dt = last ? (time - last) / 1000 : 0;
  last = time;
  poster.update(dt);
  // The label joins the wall once every sheet has grown in.
  if (caption && poster.ready) caption.show();
  poster.render();
});
stage.onResize = () => poster.render();
