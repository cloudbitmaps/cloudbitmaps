import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * bench/lib/log-chart.cjs draws the explainer's charts, and refuses what it cannot draw honestly rather than drawing
 * it: a point outside the axes, a label past the card's edge, over another label or across a line, and an axis a
 * log scale cannot start from. Each refusal is held here, and so is the theme: a dark chart that painted the light
 * palette would be a feature that does nothing in one mode.
 */
const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const require_ = createRequire(join(ROOT, 'bench', 'sizing.cjs'));
const { logChart, THEMES } = require_('./lib/log-chart.cjs') as {
  logChart: (spec: object, theme: string) => string;
  THEMES: Record<'light' | 'dark', Record<string, string>>;
};
const { CHARTS, DOCS } = require_('./lib/sizing-pages.cjs') as {
  CHARTS: string[];
  DOCS: Record<string, string[]>;
};

const axis = (min: number, max: number) => ({
  min,
  max,
  ticks: [{ at: min, text: String(min) }],
  title: 'axis',
});
const spec = (over: object = {}) => ({
  title: 'A chart',
  subtitle: ['one line'],
  label: 'what it shows',
  x: axis(1, 1000),
  y: axis(1, 1000),
  lines: [
    {
      points: [
        [1, 1],
        [1000, 1000],
      ],
      color: 'ink',
      text: 'a line',
      textAt: [2, 200],
    },
  ],
  ...over,
});

describe('log-chart refuses what it cannot draw honestly', () => {
  it('draws a chart that fits', () => {
    expect(logChart(spec(), 'light')).toContain('<svg');
  });

  it('refuses a point outside the axes, an axis from zero, and an unknown colour or theme', () => {
    const outside = {
      points: [
        [1, 1],
        [2000, 5],
      ],
      color: 'ink',
      text: 'x',
      textAt: [2, 200],
    };
    expect(() => logChart(spec({ lines: [outside] }), 'light')).toThrow(/outside the axes/);
    expect(() => logChart(spec({ x: axis(0, 1000) }), 'light')).toThrow(/from above 0/);
    const pink = { ...spec().lines[0], color: 'pink' };
    expect(() => logChart(spec({ lines: [pink] }), 'light')).toThrow(/no colour "pink"/);
    expect(() => logChart(spec(), 'sepia')).toThrow(/no theme "sepia"/);
  });

  it('refuses a label past the card, over another label, or across a line', () => {
    expect(() => logChart(spec({ subtitle: ['x'.repeat(200)] }), 'light')).toThrow(
      /past the card's edge/,
    );
    const markers = [
      { at: [10, 10], text: 'first' },
      { at: [10, 10.5], text: 'second' },
    ];
    expect(() => logChart(spec({ markers }), 'light')).toThrow(/would overlap/);
    // Named where the diagonal runs through it.
    const across = { ...spec().lines[0], textAt: [20, 18] };
    expect(() => logChart(spec({ lines: [across] }), 'light')).toThrow(/would sit on a line/);
  });
});

describe('log-chart draws each theme in its own palette', () => {
  it('paints the dark chart dark, and in no colour the light palette alone uses', () => {
    const light = logChart(spec(), 'light');
    const dark = logChart(spec(), 'dark');
    expect(light).toContain(`fill="${THEMES.light.card}"`);
    expect(dark).toContain(`fill="${THEMES.dark.card}"`);
    for (const colour of Object.values(THEMES.light)) {
      if (!Object.values(THEMES.dark).includes(colour)) expect(dark).not.toContain(colour);
    }
  });

  it('every dark chart is shown to dark readers, with its light twin as the image', () => {
    const pages = Object.keys(DOCS).map((doc) => readFileSync(join(ROOT, doc), 'utf8'));
    for (const chart of CHARTS.filter((c) => c.endsWith('-dark.svg'))) {
      const light = chart.replace(/-dark\.svg$/, '.svg');
      expect(CHARTS).toContain(light);
      const shown = pages.some((text) =>
        new RegExp(
          `<source media="\\(prefers-color-scheme: dark\\)" srcset="[./]*${chart}">\\s*<img alt="[^"]+" src="[./]*${light}">`,
        ).test(text),
      );
      expect(shown, `${chart} is not shown to dark readers`).toBe(true);
    }
  });
});
