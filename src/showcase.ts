// The showcase: tap a sheet in the poster and the real poster it stands for
// is shown.
//
// The sheet is called out first: it slides along its own path and out of the
// frame (PosterScene.callOut). Then a white scrim comes over the poster, the
// other sheets still faintly there behind it, and the real poster is wiped
// on over the scrim from the top, whichever way the sheet left, a little
// smaller than the frame. The wall label turns to that poster, its heading becoming the
// roll to step through (‹ 09 / 18 ›, or the arrow keys) with the way back at
// its other end, both on the wall above the card. Turning to a poster
// and back, and stepping, only change what the label says: its white card
// stays where it is; stepping swaps the poster at once, without a fade.
// "Back to the original", Escape or a click on the poster or the scrim fades
// it all away, the sheet already back in its place underneath.
//
// What each sheet's poster is lives in posters.json, by sheet id: an image,
// and optionally a year, a link to its full credits, and whether it is only
// a placeholder for now.

import type { Caption } from './caption.ts';
import type { PosterScene } from './poster-scene.ts';
import posters from './posters.json';
import { publicPath } from './public-path.ts';
import type { Sheet } from './sheet.ts';

interface Entry {
  image: string;
  year?: string;
  link?: string;
  placeholder?: boolean;
}

const SCRIM = 0.82; // opacity of the white over the poster
const SCRIM_IN = 320; // ms
const WIPE = 700; // ms, the poster wiped on
const WIPE_AFTER = 260; // ms after the scrim starts coming
const FADE_OUT = 450; // ms, closing
const EASE = 'cubic-bezier(0.55, 0, 0.15, 1)'; // the opening's curve

export interface Showcase {
  open(sheet: Sheet): boolean; // false if that sheet has no poster to show
}

export function mountShowcase(
  frame: HTMLElement,
  label: HTMLElement,
  caption: Caption,
  scene: PosterScene,
  pull: { enabled: boolean },
): Showcase {
  const entries = posters as Record<string, Entry>;
  const entryOf = (sheet: Sheet) => (sheet.spec.label ? entries[sheet.spec.id] : undefined);
  const roll = scene.sheets.filter((s) => entryOf(s)).sort((a, b) => a.spec.label!.title.localeCompare(b.spec.label!.title));
  const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ms = (t: number) => (quick ? 0 : t);

  // Over the canvas: the scrim and the poster.
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  scrim.setAttribute('aria-hidden', 'true');
  const shown = document.createElement('figure');
  shown.className = 'shown-poster';
  const img = document.createElement('img');
  // Decoded before it goes up (load); drawn at once whenever the browser
  // draws it again, never a frame of nothing while it decodes.
  img.decoding = 'sync';
  shown.append(img);
  frame.append(scrim, shown);

  // The label's other heading and card, for the poster shown. The heading's
  // buttons and the way back are made once, so stepping keeps them (and
  // keyboard focus) where they are.
  const button = (text: string, className: string, aria?: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = className;
    b.textContent = text;
    if (aria) b.setAttribute('aria-label', aria);
    return b;
  };
  const previous = button('‹', 'step', 'Previous poster');
  const next = button('›', 'step', 'Next poster');
  previous.dataset.by = '-1';
  next.dataset.by = '1';
  const count = document.createElement('span');
  count.className = 'count';
  const kind = document.createElement('p');
  kind.className = 'kind called';
  // The way back is on the wall too, at the other end of the heading, as a
  // return arrow: the card holds only what it says about the poster.
  const back = button('', 'back', 'Back to the original');
  back.title = 'Back to the original';
  back.innerHTML =
    '<svg viewBox="0 0 14 14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4.5 2.5 1.5 5.5l3 3"/><path d="M1.5 5.5h7a3.5 3.5 0 0 1 0 7H6"/></svg>';
  const steps = document.createElement('span');
  steps.append(previous, count, next);
  kind.append(steps, back);
  const card = document.createElement('div');
  card.className = 'card called';
  label.querySelector('.card')!.after(kind, card);

  let open: { sheet: Sheet; at: number } | null = null;

  function show(sheet: Sheet): boolean {
    const entry = entryOf(sheet);
    if (!entry || open || !scene.ready) return false;
    open = { sheet, at: roll.indexOf(sheet) };
    pull.enabled = false;
    caption.away(true);
    for (const el of [scrim, shown]) el.getAnimations().forEach((a) => a.cancel());
    shown.style.clipPath = '';
    const ready = load(entry);
    scene.callOut(sheet).then(async () => {
      if (open?.sheet !== sheet) return;
      frame.classList.add('showing');
      scrim.animate([{ opacity: 0 }, { opacity: SCRIM }], { duration: ms(SCRIM_IN), easing: 'ease-out', fill: 'forwards' });
      turn(sheet);
      await Promise.all([ready, new Promise((r) => setTimeout(r, ms(WIPE_AFTER)))]);
      if (open?.sheet !== sheet) return;
      // From the top down. Once on, the poster keeps that as its own style and
      // the animation goes: an animation held at its end can hand the drawing
      // back and forth and flicker.
      const wipe = shown.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }], {
        duration: ms(WIPE),
        easing: EASE,
        fill: 'forwards',
      });
      wipe.finished.then(
        () => {
          if (open?.sheet !== sheet) return;
          shown.style.clipPath = 'inset(0 0 0 0)';
          wipe.cancel();
          // Only now the posters either side, so drawing them does not
          // compete with drawing this one while it comes on.
          warm();
        },
        () => {},
      );
    });
    return true;
  }

  function load(entry: Entry) {
    img.src = publicPath(entry.image);
    return img.decode().catch(() => {});
  }

  function close() {
    if (!open) return;
    scene.putBack(open.sheet);
    open = null;
    const fade = (el: HTMLElement) =>
      el.animate([{ opacity: getComputedStyle(el).opacity }, { opacity: 0 }], {
        duration: ms(FADE_OUT),
        easing: 'ease-out',
        fill: 'forwards',
      });
    fade(shown);
    fade(scrim).finished.then(
      () => {
        if (open) return;
        frame.classList.remove('showing');
        for (const el of [scrim, shown]) el.getAnimations().forEach((a) => a.cancel());
        shown.style.clipPath = '';
      },
      () => {},
    );
    turn(null);
    caption.away(false);
    pull.enabled = true;
  }

  // The next or previous poster of the roll, at once, without a fade: its
  // image is decoded first, then it and the label change together.
  async function step(by: number) {
    if (!open) return;
    open.at = (open.at + by + roll.length) % roll.length;
    const sheet = roll[open.at];
    const image = publicPath(entryOf(sheet)!.image);
    const next = new Image();
    next.src = image;
    await next.decode().catch(() => {});
    if (roll[open?.at ?? -1] !== sheet) return;
    img.src = image;
    fill(sheet);
    warm();
  }

  // The posters either side, fetched and decoded ahead, so a step lands at once.
  const warmed = new Map<string, HTMLImageElement>();
  function warm() {
    if (!open) return;
    for (const by of [-1, 1]) {
      const image = publicPath(entryOf(roll[(open.at + by + roll.length) % roll.length])!.image);
      if (warmed.has(image)) continue;
      const ahead = new Image();
      ahead.src = image;
      ahead.decode().catch(() => {});
      warmed.set(image, ahead);
    }
  }

  // The label turns to this sheet's poster, or back to the original (null).
  function turn(sheet: Sheet | null) {
    if (sheet) fill(sheet);
    label.classList.toggle('calling', !!sheet);
  }

  function fill(sheet: Sheet) {
    const { title, name } = sheet.spec.label!;
    const entry = entryOf(sheet)!;
    // Two figures always (09, 10), so the count keeps one width.
    count.textContent = `${String(roll.indexOf(sheet) + 1).padStart(2, '0')} / ${roll.length}`;
    const h1 = document.createElement('h1');
    h1.textContent = title;
    if (entry.year) {
      const year = document.createElement('span');
      year.className = 'year';
      year.textContent = ` (${entry.year})`;
      h1.append(year);
    }
    const lines: HTMLElement[] = [h1];
    const p = (text: string, className = '') => Object.assign(document.createElement('p'), { textContent: text, className });
    lines.push(p(name));
    if (entry.placeholder) lines.push(p('Placeholder: the real poster goes here', 'dim'));
    if (entry.link) {
      const a = Object.assign(document.createElement('a'), { className: 'link', href: entry.link, target: '_blank', rel: 'noopener', textContent: 'Full credits ↗' });
      lines.push(a);
    }
    card.replaceChildren(...lines);
    img.alt = `${title}, ${name}${entry.placeholder ? ' (placeholder)' : ''}`;
  }

  label.addEventListener('click', (e) => {
    if (!open) return;
    const target = e.target as HTMLElement;
    const by = target.closest<HTMLElement>('.step')?.dataset.by;
    if (by) step(Number(by));
    else if (target.closest('.back')) close();
  });
  scrim.addEventListener('click', close);
  shown.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
  });

  return { open: show };
}
