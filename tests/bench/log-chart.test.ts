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
    expect(() => logChart(spec({ markers }), 'light')).toThrow(/would crowd/);
    // Named where the diagonal runs through it.
    const across = { ...spec().lines[0], textAt: [20, 18] };
    expect(() => logChart(spec({ lines: [across] }), 'light')).toThrow(/would sit on a line/);
  });
});

describe('log-chart keeps every word clear of every mark', () => {
  // On a 1–1,000 axis the plot's 292 pixels hold three decades: 97.33 pixels a decade.
  const up = (v: number, px: number) => v * 10 ** (px / 97.33);

  it('refuses two labels closer than a third of an em, and passes them just past it', () => {
    // Two 12 px labels, their baselines 14 px apart, leave 2 px between them; 16 px apart, 4.
    const at = (px: number) => [
      { at: [10, 10], text: 'first' },
      { at: [10, up(10, px)], text: 'second' },
    ];
    expect(() => logChart(spec({ lines: [], markers: at(14) }), 'light')).toThrow(/would crowd/);
    expect(logChart(spec({ lines: [], markers: at(16) }), 'light')).toContain('<svg');
  });

  it("refuses a label drawn through another marker's dot", () => {
    const markers = [
      { at: [10, 10], text: 'a label long enough' },
      // Its dot inside the first label; its own label well below, so only the dot can meet it.
      { at: [15, 10], text: 'b', dy: 40 },
    ];
    expect(() => logChart(spec({ lines: [], markers }), 'light')).toThrow(
      /would sit on the dot of "b"/,
    );
  });

  it('keeps a label off a line by the width of the line, not only its middle', () => {
    const rule = (labelY: number) => ({
      points: [
        [1, 10],
        [1000, 10],
      ],
      color: 'ink',
      text: 'a rule',
      textAt: [2, labelY],
    });
    // A 12.5 px label whose bottom is 2.5 px above a 2 px line's middle, then 4 px above it.
    expect(() => logChart(spec({ lines: [rule(11.256)] }), 'light')).toThrow(/would sit on a line/);
    expect(logChart(spec({ lines: [rule(11.662)] }), 'light')).toContain('<svg');
  });

  it('refuses a label set across a dashed line, as across a solid one', () => {
    const dashed = { ...spec().lines[0], dashed: true, textAt: [20, 18] };
    expect(() => logChart(spec({ lines: [dashed] }), 'light')).toThrow(/would sit on a line/);
  });

  it("refuses a region's name on the other side of its boundary, and passes it on its own", () => {
    const below = (textAt: [number, number]) => ({
      lines: [],
      areas: [
        {
          points: [
            [1, 1],
            [1000, 1000],
          ],
          toward: 'min',
          color: 'cloudbitmaps',
          text: 'below the diagonal',
          textAt,
        },
      ],
    });
    expect(() => logChart(spec(below([2, 200])), 'light')).toThrow(/outside the region it names/);
    expect(logChart(spec(below([200, 2])), 'light')).toContain('<svg');
  });

  it('refuses a marker outside the axes, and a label whose position did not compute', () => {
    expect(() => logChart(spec({ markers: [{ at: [5000, 5], text: 'm' }] }), 'light')).toThrow(
      /outside the axes/,
    );
    // With no line to sit on, a NaN position reaches the file, which refuses it by name.
    expect(() =>
      logChart(
        spec({ lines: [], markers: [{ at: [10, 10], text: 'm', dy: Number.NaN }] }),
        'light',
      ),
    ).toThrow(/draws "NaN"/);
  });

  it("rings every label inside the plot in the card's colour, so no gridline runs through a word", () => {
    const svg = logChart(spec({ markers: [{ at: [100, 2], text: 'm' }] }), 'dark');
    const labels = svg.match(/<text[^>]*>(?:a line|m)<\/text>/g) ?? [];
    expect(labels).toHaveLength(2);
    for (const t of labels) expect(t).toContain(`stroke="${THEMES.dark.card}"`);
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

  it('makes each theme readable on its own card, and shares no colour between the two', () => {
    // WCAG's relative luminance and contrast ratio.
    const linear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const lum = (hex: string): number => {
      const channel = (i: number): number => linear(parseInt(hex.slice(i, i + 2), 16) / 255);
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    };
    const contrast = (a: string, b: string): number =>
      (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
    const colour = (theme: 'light' | 'dark', role: string): string => {
      const c = THEMES[theme][role];
      if (c === undefined) throw new Error(`no ${role} in the ${theme} theme`);
      return c;
    };
    for (const theme of ['light', 'dark'] as const) {
      const card = colour(theme, 'card');
      for (const role of ['ink', 'inkSoft', 'muted']) {
        expect(contrast(colour(theme, role), card), `${theme} ${role}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const role of ['cloudbitmaps', 'redis']) {
        expect(contrast(colour(theme, role), card), `${theme} ${role}`).toBeGreaterThanOrEqual(3);
      }
    }
    // A theme that borrowed the other's colours would pass everything above in the wrong mode.
    for (const role of Object.keys(THEMES.light)) {
      expect(THEMES.dark[role], role).not.toBe(THEMES.light[role]);
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
