import data from './composition.json';
import type { SheetSpec } from './sheet.ts';

// The whole poster as data. Written by the ?edit page, read by the poster.
export interface Composition {
  view: { elevation: number }; // degrees the camera looks down
  // Height of the floor, cm. Grounded sheets stand on it; nothing may go below.
  floor: number;
  print: {
    dotPitch: number; // cm; the scan measures about 0.38
    dotAngle: number; // degrees; the scan uses 45
  };
  spring: { stiffness: number; damping: number };
  sheets: SheetSpec[];
}

export const initialComposition = data as Composition;

// Two decimals is plenty for centimetres and degrees, and short arrays and
// flat objects (a bend, a position) stay on one line, so the file reads well
// and diffs stay small.
export function serialize(composition: Composition) {
  const round = (_: string, v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  return (
    JSON.stringify(composition, round, 2)
      .replace(/\[\s*([^[\]{}]+?)\s*\]/g, (_, items: string) => `[${items.split(/,\s*/).join(', ')}]`)
      .replace(/\{\s*([^{}[\]]+?)\s*\}/g, (_, body: string) => `{ ${body.split(/,\s*\n\s*/).join(', ')} }`) + '\n'
  );
}
