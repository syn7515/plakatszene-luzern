// The wall beside the poster: the label, and the photo print tucked behind it.
//
// The label is plain HTML (index.html) and CSS (style.css); this decides
// where it stands and moves the print. The label stands beside the poster
// when the margin has room for it, a column as tall as the poster with the
// wall text at the top and the credits at the bottom like a gallery label.
// When the margin falls short by a little, the poster gives way to the left
// by the shortfall; when it has no room at all (portrait, a phone), the label
// goes under the poster and the wall text above it, the first thing read.
//
// Pointing at the label slides the print out from behind the card: it comes
// out beside the card, as wide as the label, nearly straight, standing on the
// card's foot, and its lower margin opens to say what the photo is; it slips
// back once the pointer has left both the card and the print (with SLACK to
// spare, so a cursor the rising print leaves behind does not send it back and
// forth). Where there is no pointer to hover with, a tap does the same and a
// tap anywhere else (or Escape) puts it back. Where the page has no room
// beside the card, the print comes up above it instead, or, under the poster,
// over the poster's foot, centred.

import { publicPath } from './public-path.ts';

const TILT = -2; // degrees, while out
const CLEAR = 14; // px between the print and the card
const SLACK = 12; // px around the card and the print within which a pointer keeps it out
const OUT = 520; // ms, out from behind the card (style.css's .note agrees)
const BACK = 420; // ms, back behind it
const EASE = 'cubic-bezier(0.55, 0, 0.15, 1)'; // the opening's curve

export interface Caption {
  show(): void; // fade the label in, once the sheets have grown in
  // While the label speaks for a poster called out (showcase.ts), the photo
  // of the original stays tucked away, out of sight and out of reach.
  away(on: boolean): void;
}

export function mountCaption(work: HTMLElement): Caption {
  const main = work.parentElement!;
  const frame = work.querySelector<HTMLElement>('.poster-frame')!;
  const caption = work.querySelector<HTMLElement>('.caption')!;
  const about = caption.querySelector<HTMLElement>('.about')!;
  const label = caption.querySelector<HTMLElement>('.label')!;
  const print = label.querySelector<HTMLButtonElement>('.print')!;
  const img = print.querySelector<HTMLImageElement>('img')!;
  const note = print.querySelector<HTMLElement>('.note')!;
  const quick = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hovers = matchMedia('(hover: hover)').matches;
  let out = false;
  let aside = false; // put away (see Caption.away)
  let by: 'pointer' | 'focus' | 'tap' | null = null; // what brought it out decides what sends it back

  const px = (style: CSSStyleDeclaration, name: string) => parseFloat(style.getPropertyValue(name)) || 0;
  const below = () => work.classList.contains('below');

  // --- Where the label stands ----------------------------------------------

  function layout() {
    const root = getComputedStyle(document.documentElement);
    const area = getComputedStyle(main);
    // The gap, the label, and the tucked print's reach past the label, so
    // it never pokes out of the page and raises a scrollbar.
    const need = px(root, '--gap') + px(root, '--label') + px(getComputedStyle(print), '--overhang');
    const inner = main.clientWidth - px(area, 'padding-left') - px(area, 'padding-right');
    const room = inner - frame.offsetWidth; // both margins together
    const under = room < need;
    work.classList.toggle('below', under);
    if (under !== (about.parentElement === work)) {
      if (under) work.prepend(about);
      else caption.prepend(about);
    }
    document.documentElement.style.setProperty('--shift', `${under ? 0 : Math.max(0, need - room / 2)}px`);
    if (out) go(shown(), 0);
  }
  const observer = new ResizeObserver(layout);
  observer.observe(main);
  observer.observe(frame);

  // --- The print's two places ----------------------------------------------

  // Tucked, as the stylesheet puts it: turned by its --tuck, made smaller by its --small.
  const rest = () => {
    const style = getComputedStyle(print);
    return `rotate(${px(style, '--tuck')}deg) scale(${px(style, '--small') || 1})`;
  };
  // How far the open note reaches below the print's box, before scaling.
  const margin = () => note.firstElementChild!.scrollHeight + 0.6 * parseFloat(getComputedStyle(note).fontSize);
  // Out: beside the card, standing on its foot, wherever the page has room
  // for it there as wide as the label. Otherwise above the card, as wide as
  // the label; under the poster, as wide as the print's share of the page and
  // centred. Never taller, note included, than the room between its foot and
  // the top of the window.
  function beside() {
    const edge = main.getBoundingClientRect().right - px(getComputedStyle(main), 'padding-right');
    return edge - label.getBoundingClientRect().right - CLEAR >= label.offsetWidth;
  }
  function scale(side: boolean) {
    const wide = (below() && !side ? 0.72 * work.clientWidth : label.offsetWidth) / print.offsetWidth;
    const gutter = px(getComputedStyle(document.documentElement), '--gutter');
    const card = label.getBoundingClientRect();
    const headroom = (side ? card.bottom : card.top - CLEAR) - gutter;
    return Math.max(1, Math.min(wide, headroom / (print.offsetHeight + margin())));
  }
  function shown() {
    // The print's centre before any transform, from its offset box, so a
    // transform already applied does not move the target. The box keeps the
    // photo's shape; the note hangs below it, so the foot is lower by that.
    const a = print.offsetParent!.getBoundingClientRect(); // the label: its card
    const w0 = print.offsetWidth;
    const h0 = print.offsetHeight;
    const cx = a.left + print.offsetLeft + w0 / 2;
    const cy = a.top + print.offsetTop + h0 / 2;
    const side = beside();
    const s = scale(side);
    let x = a.left + (w0 * s) / 2;
    if (side) x = a.right + CLEAR + (w0 * s) / 2;
    else if (below()) x = work.getBoundingClientRect().left + work.clientWidth / 2;
    const foot = side ? a.bottom : a.top - CLEAR;
    const y = foot - (margin() + h0 / 2) * s;
    return `translate(${x - cx}px, ${y - cy}px) rotate(${TILT}deg) scale(${s})`;
  }

  // --- Out and back ----------------------------------------------------------

  // From wherever it is now, animation included, to `to`; at rest the inline
  // transform is cleared so the stylesheet's tuck applies again.
  let moving: Animation | null = null;
  function go(to: string, ms: number) {
    const from = getComputedStyle(print).transform;
    moving?.cancel();
    const a = print.animate([{ transform: from === 'none' ? rest() : from }, { transform: to }], {
      duration: quick ? 0 : ms,
      easing: EASE,
      fill: 'forwards',
    });
    moving = a;
    a.finished.then(
      () => {
        if (moving !== a) return;
        if (out) a.commitStyles();
        else print.style.transform = '';
        a.cancel();
        moving = null;
      },
      () => {},
    );
  }

  // The full-size photo, fetched the first time anyone comes near.
  let upgraded = false;
  function upgrade() {
    const full = img.dataset.full && publicPath(img.dataset.full);
    if (upgraded || !full) return;
    upgraded = true;
    const loader = new Image();
    loader.src = full;
    loader.decode().then(
      () => (img.src = full),
      () => {},
    );
  }

  function pullOut(cause: typeof by) {
    if (out || aside) return;
    out = true;
    by = cause;
    upgrade();
    print.classList.add('out');
    print.setAttribute('aria-expanded', 'true');
    go(shown(), OUT);
  }
  function putBack() {
    if (!out) return;
    out = false;
    by = null;
    print.classList.remove('out');
    print.setAttribute('aria-expanded', 'false');
    go(rest(), BACK);
  }

  // A pointer that hovers brings it out by pointing at the label, and keeps
  // it out while it stays over the card or the print, wherever the print is
  // at that moment; a finger brings it out by tapping.
  function near(x: number, y: number) {
    const c = label.getBoundingClientRect(); // the card
    const p = print.getBoundingClientRect(); // the print, transform included
    return (
      x >= Math.min(c.left, p.left) - SLACK &&
      x <= Math.max(c.right, p.right) + SLACK &&
      y >= Math.min(c.top, p.top) - SLACK &&
      y <= Math.max(c.bottom, p.bottom) + SLACK
    );
  }
  label.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'touch') pullOut('pointer');
  });
  document.addEventListener('pointermove', (e) => {
    if (by === 'pointer' && e.pointerType !== 'touch' && !near(e.clientX, e.clientY)) putBack();
  });
  // Out of the window altogether (no element to go to). Not <html>'s own
  // pointerleave: its box is only the first screen, and the label can sit
  // below it once the page scrolls.
  document.addEventListener('pointerout', (e) => {
    if (by === 'pointer' && !e.relatedTarget) putBack();
  });
  label.addEventListener('focusin', () => pullOut('focus'));
  label.addEventListener('focusout', (e) => {
    if (by === 'focus' && !label.contains(e.relatedTarget as Node | null)) putBack();
  });
  let touched = false;
  print.addEventListener('pointerdown', (e) => (touched = e.pointerType === 'touch'));
  print.addEventListener('click', (e) => {
    e.stopPropagation();
    if (touched || !hovers) out ? putBack() : pullOut('tap');
  });
  document.addEventListener('click', putBack);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') putBack();
  });
  label.addEventListener('pointerenter', upgrade, { once: true });

  function away(on: boolean) {
    aside = on;
    if (on) putBack();
    print.classList.toggle('away', on);
    print.tabIndex = on ? -1 : 0;
    print.toggleAttribute('aria-hidden', on);
  }

  layout();
  function show() {
    caption.classList.add('shown');
    about.classList.add('shown');
  }

  return { show, away };
}
