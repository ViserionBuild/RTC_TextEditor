// Records docs/demo.gif: two users side by side, one goes offline, everything merges.
//   node scripts/record-demo.mjs http://localhost:8787   (needs ffmpeg; PW_CHANNEL=chrome optional)
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://localhost:8787';
const size = { width: 800, height: 520 };
const dir = mkdtempSync(join(tmpdir(), 'collabpad-demo-'));
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });

const res = await fetch(`${base}/api/docs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'Launch checklist' }),
});
const { id } = await res.json();

const open = async (name, query = '') => {
  const context = await browser.newContext({
    viewport: size,
    recordVideo: { dir: join(dir, name), size },
  });
  await context.addInitScript(
    ([n, c]) => localStorage.setItem('collabpad:identity', JSON.stringify({ name: n, color: c })),
    [name, name === 'Alice' ? '#1971c2' : '#c2255c'],
  );
  const page = await context.newPage();
  await page.goto(`${base}/d/${id}${query}`);
  await page.getByRole('status').waitFor();
  return { context, page };
};

const alice = await open('Alice');
const bob = await open('Bob', '?debug');
const type = async (p, text) => {
  await p.locator('.cm-content').click();
  await p.keyboard.press('Control+End');
  await p.keyboard.type(text, { delay: 55 });
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

await pause(800);
await type(alice.page, 'Launch checklist\n- ship the relay');
await pause(600);
await type(bob.page, '\n- write the report');
await pause(900);
await bob.page.getByLabel('Simulate offline').check();
await pause(500);
await type(bob.page, '\n- typed while offline');
await type(alice.page, '\n- review the GC proof');
await pause(1200);
await bob.page.getByLabel('Simulate offline').uncheck();
await pause(2500);

await alice.context.close();
await bob.context.close();
await browser.close();

const video = (name) => join(dir, name, readdirSync(join(dir, name))[0]);
const out = new URL('../docs/demo.gif', import.meta.url).pathname;
execFileSync('ffmpeg', [
  '-y',
  '-loglevel',
  'error',
  '-i',
  video('Alice'),
  '-i',
  video('Bob'),
  '-filter_complex',
  '[0:v][1:v]hstack=inputs=2,fps=10,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
  out,
]);
console.log(`wrote ${out}`);
