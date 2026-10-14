// ABC Areal is licensed and kept out of this public repository (public/fonts
// is ignored). On this machine the files are simply there; a build anywhere
// else (Vercel) first fetches them from the URLs in FONT_ABC_AREAL_REGULAR and
// FONT_ABC_AREAL_MEDIUM, set in that project's settings. Without them the
// page falls back to Helvetica.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const fonts = {
  'ABCAreal-Regular.woff2': process.env.FONT_ABC_AREAL_REGULAR,
  'ABCAreal-Medium.woff2': process.env.FONT_ABC_AREAL_MEDIUM,
};

mkdirSync('public/fonts', { recursive: true });
for (const [file, url] of Object.entries(fonts)) {
  const to = `public/fonts/${file}`;
  if (existsSync(to)) continue;
  if (!url) {
    console.warn(`${file}: not in public/fonts and no URL to fetch it from; Helvetica will stand in`);
    continue;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${file}: ${response.status} from ${url}`);
  writeFileSync(to, Buffer.from(await response.arrayBuffer()));
  console.log(`${file}: fetched`);
}
