// Draws the social card (scripts/og/) to public/og-image-<hash>.png and
// points index.html's tags at it. The name carries a hash of the image
// because chat apps and X cache a card by its image's URL: a changed card
// gets a new one. Needs Chrome (CHROME may name another binary).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createServer } from 'vite';

const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const server = await createServer({ logLevel: 'error', server: { port: 0 } });
await server.listen();
const { port } = server.httpServer.address();
const scratch = mkdtempSync(join(tmpdir(), 'og-'));
const shot = join(scratch, 'card.png');
try {
  await promisify(execFile)(chrome, [
    '--headless=new',
    '--hide-scrollbars',
    '--window-size=1200,630',
    '--force-device-scale-factor=2', // 2400 x 1260
    '--use-angle=swiftshader', // WebGL without a GPU
    '--enable-unsafe-swiftshader',
    '--virtual-time-budget=20000', // the scene is built and drawn before the shot
    `--user-data-dir=${join(scratch, 'profile')}`,
    `--screenshot=${shot}`,
    `http://localhost:${port}/scripts/og/`,
  ]);
  const png = readFileSync(shot);
  const name = `og-image-${createHash('sha256').update(png).digest('hex').slice(0, 8)}.png`;
  for (const old of readdirSync('public').filter((f) => /^og-image-[0-9a-f]{8}\.png$/.test(f))) rmSync(`public/${old}`);
  writeFileSync(`public/${name}`, png);
  writeFileSync('index.html', readFileSync('index.html', 'utf8').replace(/og-image-[0-9a-f]{8}\.png/g, name));
  console.log(name);
} finally {
  await server.close();
  rmSync(scratch, { recursive: true, force: true });
}
