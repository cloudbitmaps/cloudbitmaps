# `site-next/` — the site in the Instrument display tier

> **This is the interim, side-by-side form of [`site/`](../site/README.md).** It is not published: Cloudflare Pages
> serves `site/` only. It exists so the two can be compared page for page before one replaces the other.
> Convergence is one move, `git mv site-next site`, in its own pull request, with the gates' `site-next` entries
> removed in the same change: [Converging](#converging) lists them.

The display tier generalises `/demo`'s treatment into the shared sheet: a display type tier (a 96px h1, 52px band
heads, 64px and 40px mono figures), a band rhythm that alternates the ground, a figure table, and diagrams in the same
register. Everything else of Instrument holds: radius 0, 1px shared rules, light designed rather than inverted, nothing
below 9.5px, no external anything, and the point where we lose shown as a peer of the points where we win.

## Contents

- [The pages](#the-pages)
- [Everything else](#everything-else)
- [What differs from site/](#what-differs-from-site)
- [How it stays true](#how-it-stays-true)
- [Comparing the two](#comparing-the-two)
- [Converging](#converging)

## The pages

| page | what it is |
|---|---|
| `index.html` | The display-tier homepage: the category in the h1, what you do not run in the standfirst, the four figures with the point where we lose among them, then what you operate, the write model, chunk-skipping, the crossover, memory at fleet scale and fit, and a quiet install band. |
| `demo.html` | The step-through replay of a **measured** intersection of two 2,000,000-id segments. |
| `demo.js` | The replay's stepper, unchanged from `site/`. |
| `flavors.html` | The hub for codec flavors. |
| `flavors/roaring.html` | The roaring flavor, including what carries over from Redis bitmaps. |
| `architecture.html` | How it works: generations, the pointer, the cache, chunk-skipping, and what the design costs you. |
| `usage.html` | Installing, wiring a storage backend, and the calls. |
| `benchmarks.html` | The measured costs, the crossover, the memory bounds, and what is still owed. |

## Everything else

| file | what it is |
|---|---|
| `cloudbitmaps.css` | The one stylesheet: the display tier, the bands, the seam and figure table, the homepage's components, and the inner pages' components carried from `site/` with their motion taken out. |
| `theme.js` | The light / dark toggle, unchanged from `site/`. |
| `assets/` | Favicons, and the image link previews use. |
| `llms.txt` | The plain-text account written to be quoted by an assistant. |
| `robots.txt`, `sitemap.xml` | Crawler directives and the list of every page, as `site/` has them. |
| `_redirects` | Cloudflare Pages redirects, as `site/` has them. |

## What differs from site/

- **The homepage is the design's**, with its inline styles made classes. Where its copy or figures had gone stale it
  says what is true now: the figure table carries the S3 run's cost of a cold intersect and of a write and publish,
  not the July figures, which left the pointer out; the crossover is a rate of GETs with every read a cache miss,
  beside the cold intersect's; the middle column of "what you operate" is what 0.9.0 ran; the memory band shows peak
  RSS beside the retained heap; and what a comparison of keys never reads is chunk bytes.
- **The inner pages keep their content** and take the language: the h1 at the display tier beside a figure table,
  each section a band on the alternating ground, card grids as seams, long prose in sans.
- **Two animations, and nothing else moves**: the crossover drawing itself once and chunk-skipping on a 12-second
  loop, both on the homepage, both with a reduced-motion final frame. The inner pages' figures rest on their
  informative frame. `/demo`'s stepper moves only when a reader drives it.
- **The charts are generated.** The homepage's crossover and the benchmarks chart are `bench/run.cjs`'s, drawn from
  the estimator, so their geometry cannot drift from the published rate.

## How it stays true

The gates `site/` has, on this tree too:

- `site-classes.py` and `site-links.py` take `SITE_DIR`; `pnpm site:check` and CI run each on both trees.
- `site-figures.cjs` takes `SITE_DIR`, and `pnpm site:figures` runs it on both. On this tree it also holds the
  homepage to its sources cell by cell: the hero's four figures, each row of the figure table, the chunk-skipping
  band and the grid it draws, and the memory band's heap, RSS and scan per fleet, with their bars and axes.
- `site-replay.cjs` checks both trees' `demo.html`; `pnpm bench:check` and `pnpm bench:scale:check` hold both
  benchmarks pages' generated regions and the homepage's chart.
- `site-text-floor.mjs` loads every page here at six widths and fails on any text drawn below 9.5px, SVG labels
  included (`pnpm site:text-floor`, in CI).
- The docs tests that read `site/` read this tree as well.

## Comparing the two

Serve the repository root and open both trees side by side, for example
`python3 -m http.server -d . 8080`, then `/site/` and `/site-next/`. Pages link to each other by `.html` file, so
they work locally.

- **Check both themes.** Dark is the default; light is designed rather than derived.
- **Load nothing from another origin**, and **respect reduced motion**, as in `site/`.
- **List a new page here.** `tests/docs/directory-readmes.test.ts` holds this README's rows to the directory, as it
  does `site/`'s.

## Converging

`git mv site-next site`, in its own pull request, and in the same change:

- in `scripts/site-figures.cjs`, give `site` what `site-next` has now in each per-tree map (`HOME_IS_DISPLAY_TIER`,
  `HOME_HAS_SPEC_STRIP`, `DRIVER_STATEMENT_FLOOR`), then drop the `site-next` entries;
- drop `site-next` from the site gates (`site-classes.py`, `site-links.py`, `site-figures.cjs`, `site-replay.cjs`),
  from `bench/run.cjs` and `bench/scale.cjs`, from the tests under `tests/docs/` and `tests/bench/` that read both
  trees, and from `.prettierignore`, `eslint.config.js`, `package.json`, CI and the READMEs that name it;
- point `pnpm site:text-floor` at `site`, which fails it today and will not once this tree is `site/`;
- add the CHANGELOG entry, since that is the change that alters the published site.
