// The showcase: tap a sheet in the poster and the real poster it stands for
// is shown.
//
// The sheet is called out first: it slides along its own path and out of the
// frame (PosterScene.callOut). Then a white scrim comes over the poster, the
// other sheets still faintly there behind it, and the real poster is wiped
// on over the scrim from the side the sheet left by, a little smaller than
// the frame. The wall label turns to that poster, its heading becoming the
// roll to step through (‹ 9 / 18 ›, or the arrow keys); "Back to the
// original", Escape or a click on the poster or the scrim fades it all away,
// the sheet already back in its place underneath.
//
// What each sheet's poster is lives in posters.json, by sheet id: an image,
// and optionally a year, a link to its full credits, and whether it is only
// a placeholder for now.

import type { Caption } from './caption.ts';
import type { PosterScene } from './poster-scene.ts';
import posters from './posters.json';
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
const STEP_OUT = 160; // ms, stepping to the next poster: this one fades
const STEP_IN = 240; // ms, and that one comes
const TURN = 180; // ms, the label fading out before it turns (style.css's .label.turning agrees)
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
  img.decoding = 'async';
  shown.append(img);
  frame.append(scrim, shown);

  // The label's other heading and card, for the poster shown.
  const kind = document.createElement('p');
  kind.className = 'kind called';
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
    const ready = load(entry);
    scene.callOut(sheet).then(async (side) => {
      if (open?.sheet !== sheet) return;
      frame.classList.add('showing');
      scrim.animate([{ opacity: 0 }, { opacity: SCRIM }], { duration: ms(SCRIM_IN), easing: 'ease-out', fill: 'forwards' });
      turn(sheet);
      await Promise.all([ready, new Promise((r) => setTimeout(r, ms(WIPE_AFTER)))]);
      if (open?.sheet !== sheet) return;
      // From the edge it left by: out to the right, the poster comes on from the right.
      const from = side > 0 ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)';
      shown.animate([{ clipPath: from }, { clipPath: 'inset(0 0 0 0)' }], { duration: ms(WIPE), easing: EASE, fill: 'forwards' });
    });
    return true;
  }

  function load(entry: Entry) {
    img.src = entry.image;
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
      },
      () => {},
    );
    turn(null);
    caption.away(false);
    pull.enabled = true;
  }

  // The next or previous poster of the roll, in the frame as it is.
  async function step(by: number) {
    if (!open) return;
    open.at = (open.at + by + roll.length) % roll.length;
    const sheet = roll[open.at];
    turn(sheet);
    await shown.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms(STEP_OUT), fill: 'forwards' }).finished;
    if (roll[open?.at ?? -1] !== sheet) return;
    await load(entryOf(sheet)!);
    if (roll[open?.at ?? -1] !== sheet) return;
    shown.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms(STEP_IN), fill: 'forwards' });
  }

  // The label fades, turns to this sheet's poster (or back to the original
  // with null), and comes back.
  let turning = 0;
  function turn(sheet: Sheet | null) {
    const id = ++turning;
    label.classList.add('turning');
    setTimeout(
      () => {
        if (id !== turning) return;
        if (sheet) fill(sheet);
        label.classList.toggle('calling', !!sheet);
        label.classList.remove('turning');
      },
      ms(TURN),
    );
  }

  function fill(sheet: Sheet) {
    const { title, name } = sheet.spec.label!;
    const entry = entryOf(sheet)!;
    const at = roll.indexOf(sheet);
    const button = (text: string, className: string, aria?: string) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = className;
      b.textContent = text;
      if (aria) b.setAttribute('aria-label', aria);
      return b;
    };
    const [back, on] = [button('‹', 'step', 'Previous poster'), button('›', 'step', 'Next poster')];
    back.dataset.by = '-1';
    on.dataset.by = '1';
    kind.replaceChildren(back, `${at + 1} / ${roll.length}`, on);
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
    lines.push(button('Back to the original', 'link back'));
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
