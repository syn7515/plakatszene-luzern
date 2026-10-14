import { inject } from '@vercel/analytics';
import { mountCaption } from './caption.ts';
import { initialComposition } from './composition.ts';
import { labelFontLoaded } from './label.ts';
import { PosterScene } from './poster-scene.ts';
import { enablePull } from './pull.ts';
import { mountShowcase, type Showcase } from './showcase.ts';
import { createStage } from './stage.ts';

// Page views, to this project's Web Analytics on Vercel (built only). The
// page is seen at suepark.xyz/experiments/1, so its script and its reports go
// by that path too, which the portfolio passes on to this project; the
// domain's own /_vercel/insights belongs to the portfolio.
if (import.meta.env.PROD) {
  const insights = `${import.meta.env.BASE_URL}_vercel/insights`;
  inject({ scriptSrc: `${insights}/script.js`, endpoint: insights });
}

// Dev only: open with ?edit to trace the original and arrange sheets.
// The editor skips the opening so the sheets are there to work on, and
// has no wall label.
const editing = import.meta.env.DEV && new URLSearchParams(location.search).has('edit');

// Until the first frame, the poster's place holds a blank sheet (style.css).
// It shows once the label has decided where the poster stands, and is let be
// painted before the scene is built, which holds up the page for a while.
const frame = document.querySelector<HTMLElement>('.poster-frame')!;
const caption = editing ? null : mountCaption(document.querySelector<HTMLElement>('.work')!);
frame.classList.add('placed');
await new Promise((painted) => requestAnimationFrame(() => setTimeout(painted)));

// The labels on the paper are set in the wall's face; index.html preloads
// it, so this rarely waits.
await labelFontLoaded();

const canvas = document.querySelector<HTMLCanvasElement>('#poster')!;
const stage = createStage(canvas);
const poster = new PosterScene(stage, initialComposition);
// A tap on a sheet shows the poster it stands for (not in the editor).
let showcase: Showcase | null = null;
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
  (target) => {
    const sheet = poster.sheets.find((s) => s === target);
    return !!sheet && !!showcase?.open(sheet);
  },
);
if (caption) showcase = mountShowcase(frame, document.querySelector<HTMLElement>('.label')!, caption, poster, pull);

// Dev only: reach the scene from the console.
if (import.meta.env.DEV) (window as unknown as { __poster: PosterScene }).__poster = poster;

if (editing) import('./editor.ts').then(({ startEditor }) => startEditor(poster, stage, pull));
else poster.startIntro();

let last = 0;
stage.renderer.setAnimationLoop((time) => {
  const dt = last ? (time - last) / 1000 : 0;
  last = time;
  poster.update(dt);
  // The label joins the wall once every sheet has grown in.
  if (caption && poster.ready) caption.show();
  poster.render();
  // The first frame is on the canvas: the blank sheet gives way.
  if (!frame.classList.contains('drawn')) frame.classList.add('drawn');
});
stage.onResize = () => poster.render();
