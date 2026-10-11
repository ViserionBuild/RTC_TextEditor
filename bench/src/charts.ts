/**
 * Renders the report charts from bench/results/results.json into docs/charts/*.svg.
 * Each chart is written twice (light and dark) for a <picture> element, because SVGs shown as
 * images on GitHub cannot follow the page theme on their own.
 *
 *   pnpm bench:charts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

interface Theme {
  name: 'light' | 'dark';
  surface: string;
  text: string;
  muted: string;
  grid: string;
  series: [string, string];
}

// Categorical slots 1–2 of the reference palette, validated on GitHub's surfaces.
const THEMES: Theme[] = [
  {
    name: 'light',
    surface: '#ffffff',
    text: '#0b0b0b',
    muted: '#52514e',
    grid: '#e8e7e3',
    series: ['#2a78d6', '#eb6834'],
  },
  {
    name: 'dark',
    surface: '#0d1117',
    text: '#f0efec',
    muted: '#c3c2b7',
    grid: '#2a2d33',
    series: ['#3987e5', '#d95926'],
  },
];

interface Series {
  name: string;
  points: [number, number][];
  /** Draw markers at each point (sparse, measured data). */
  markers?: boolean;
}

interface LineChart {
  file: string;
  title: string;
  xLabel: string;
  yLabel: string;
  x: (v: number) => string;
  y: (v: number) => string;
  series: [Series, Series];
}

const W = 720;
const H = 380;
const M = { top: 64, right: 150, bottom: 52, left: 64 };
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Round-number ticks covering [0, max]. */
function ticks(max: number, count = 5): number[] {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  if (out.at(-1)! < max) out.push(out.at(-1)! + step);
  return out;
}

function render(chart: LineChart, theme: Theme): string {
  const all = chart.series.flatMap((s) => s.points);
  const xt = ticks(Math.max(...all.map((p) => p[0])));
  const yt = ticks(Math.max(...all.map((p) => p[1])));
  const pw = W - M.left - M.right;
  const ph = H - M.top - M.bottom;
  const sx = (v: number) => M.left + (v / xt.at(-1)!) * pw;
  const sy = (v: number) => M.top + ph - (v / yt.at(-1)!) * ph;

  const parts: string[] = [];
  parts.push(`<rect width="${W}" height="${H}" rx="8" fill="${theme.surface}"/>`);
  parts.push(
    `<text x="${M.left}" y="28" font-size="16" font-weight="600" fill="${theme.text}">${esc(chart.title)}</text>`,
  );

  // Legend (always present for two series), top-left under the title.
  chart.series.forEach((s, i) => {
    const lx = M.left + i * 190;
    parts.push(
      `<line x1="${lx}" y1="46" x2="${lx + 18}" y2="46" stroke="${theme.series[i]}" stroke-width="2" stroke-linecap="round"/>`,
    );
    parts.push(
      `<text x="${lx + 24}" y="50" font-size="12" fill="${theme.muted}">${esc(s.name)}</text>`,
    );
  });

  // Recessive grid and axes.
  for (const v of yt) {
    parts.push(
      `<line x1="${M.left}" y1="${sy(v)}" x2="${M.left + pw}" y2="${sy(v)}" stroke="${theme.grid}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${M.left - 8}" y="${sy(v) + 4}" font-size="11" text-anchor="end" fill="${theme.muted}">${esc(chart.y(v))}</text>`,
    );
  }
  for (const v of xt) {
    parts.push(
      `<text x="${sx(v)}" y="${M.top + ph + 18}" font-size="11" text-anchor="middle" fill="${theme.muted}">${esc(chart.x(v))}</text>`,
    );
  }
  parts.push(
    `<text x="${M.left + pw / 2}" y="${H - 12}" font-size="12" text-anchor="middle" fill="${theme.muted}">${esc(chart.xLabel)}</text>`,
  );
  parts.push(
    `<text transform="translate(16 ${M.top + ph / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="${theme.muted}">${esc(chart.yLabel)}</text>`,
  );

  // Lines, markers with a surface ring, and a direct label at each line's end.
  chart.series.forEach((s, i) => {
    const color = theme.series[i];
    const d = s.points
      .map(([x, y], k) => `${k ? 'L' : 'M'}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`)
      .join(' ');
    parts.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    if (s.markers) {
      for (const [x, y] of s.points) {
        parts.push(
          `<circle cx="${sx(x)}" cy="${sy(y)}" r="4" fill="${color}" stroke="${theme.surface}" stroke-width="2"/>`,
        );
      }
    }
    const [lx, ly] = s.points.at(-1)!;
    parts.push(
      `<text x="${sx(lx) + 10}" y="${sy(ly) + 4}" font-size="12" fill="${theme.text}">${esc(s.name)} · ${esc(chart.y(ly))}</text>`,
    );
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif" role="img" aria-label="${esc(chart.title)}">\n${parts.join('\n')}\n</svg>\n`;
}

const results = JSON.parse(
  readFileSync(new URL('../results/results.json', import.meta.url), 'utf8'),
) as {
  growth: { ops: number; visible: number; tombstones: number }[];
  naivePrefix: { ops: number; naiveMs: number; runLengthMs: number }[];
};

const k = (v: number) => (v === 0 ? '0' : `${Math.round(v / 1000)}k`);
const charts: LineChart[] = [
  {
    file: 'growth',
    title: 'Characters a replica holds while the paper is written',
    xLabel: 'edits applied (automerge-paper trace)',
    yLabel: 'characters',
    x: k,
    y: k,
    series: [
      {
        name: 'visible text',
        points: [[0, 0], ...results.growth.map((g): [number, number] => [g.ops, g.visible])],
      },
      {
        name: 'tombstones',
        points: [[0, 0], ...results.growth.map((g): [number, number] => [g.ops, g.tombstones])],
      },
    ],
  },
  {
    file: 'integration',
    title: 'Time to integrate the first N ops',
    xLabel: 'ops integrated',
    yLabel: 'seconds',
    x: k,
    y: (v) => (v === 0 ? '0' : v < 1 ? `${v.toFixed(1)} s` : `${v.toFixed(1)} s`),
    series: [
      {
        name: 'per-character RGA',
        markers: true,
        points: [
          [0, 0],
          ...results.naivePrefix.map((p): [number, number] => [p.ops, p.naiveMs / 1000]),
        ],
      },
      {
        name: 'run-length RGA',
        markers: true,
        points: [
          [0, 0],
          ...results.naivePrefix.map((p): [number, number] => [p.ops, p.runLengthMs / 1000]),
        ],
      },
    ],
  },
];

const out = new URL('../../docs/charts/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const chart of charts) {
  for (const theme of THEMES)
    writeFileSync(`${out}${chart.file}-${theme.name}.svg`, render(chart, theme));
}
console.log(`wrote ${charts.length * THEMES.length} charts to docs/charts/`);
