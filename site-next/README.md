# `site-next/` — the site in the Instrument display tier

> **This is the interim, side-by-side form of [`site/`](../site/README.md).** It is not published: Cloudflare Pages
> serves `site/` only. It exists so the two can be compared page for page before one replaces the other.
> Convergence is one move, `git mv site-next site`, in its own pull request, with the gates' `site-next` entries
> removed in the same change: [Converging](#converging) lists them.

The display tier generalises `/demo`'s treatment into the shared sheet: a display type tier (a 96px h1, 52px band
heads, 44px and 40px mono figures), a band rhythm that alternates the ground, a figure table, and diagrams in the same
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
| `index.html` | The display-tier homepage: the category in the h1, what you do not run in the standfirst, a strip of the key space over the four figures with the point where we lose among them, then what you operate, the write model, chunk-skipping, the crossover and what goes into it, memory at fleet scale, the conditions the figures do not prove, fit, and a quiet install band. |
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

- **The homepage follows the display-tier design**, its inline styles made classes, and it says what is true of
  the current release only. The hero's figures sit under a chunk strip, one square per 50
  chunks. What you operate sets our bucket beside the alternatives a reader would weigh, a Redis cluster and a
  tiered database, each box tagged with what keeping it costs. The cost band shows what goes in, each input marked
  measured, quoted or chosen, beside what comes out with its arithmetic. The chunk grid draws one cell per ten
  chunks; the memory band sets the flat heap beside the two that grow; and a band of conditions says what the
  figures do not prove.
- **Nothing describes an older release**: the figures are the current release's, and no sentence compares it with
  an earlier one. Where a comparison is needed, it is against an alternative, not against our own history.
- **The inner pages keep their content** and take the language: the h1 at the display tier beside a figure table,
  each section a band on the alternating ground, card grids as seams, long prose in sans.
- **Two animations, and nothing else moves**: the crossover drawing itself and chunk-skipping resolving its
  fetched cells, both on the homepage, each played once when its band comes into view and resting on its final
  frame without a script or with less motion asked for. The inner pages' figures rest on their informative frame.
  `/demo`'s stepper moves only when a reader drives it.
- **The drawings are generated.** The homepage's crossover, drawn once wide and once for a phone, and the benchmarks
  chart are `bench/run.cjs`'s, drawn from the estimator, so their geometry cannot drift from the published rate. The
  homepage's key-space strip, chunk grid and memory panel are `bench/scale.cjs`'s, drawn from the recorded runs in
  `bench/scale-results.json`.

## How it stays true

The gates `site/` has, on this tree too:

- `site-classes.py` and `site-links.py` take `SITE_DIR`; `pnpm site:check` and CI run each on both trees.
- `site-figures.cjs` takes `SITE_DIR`, and `pnpm site:figures` runs it on both. On this tree it also holds the
  homepage to its sources figure by figure, through `scripts/lib/home-figures.cjs`: each check reads the page as the
  browser parses it and marks what it read, and a number on the page that none of them read fails, since the footer
  says every figure on this page is gated in CI; what would show text no check reads, or hide text one did, is
  refused, and each script the page runs is pinned by its hash, so a changed one is read again before it passes. It
  holds a rate, a share of the Redis line and a cold intersect's request count to their one source on every page
  here, and the benchmarks page's comparison panel row by row.
- `site-replay.cjs` checks both trees' `demo.html`. `pnpm bench:check` holds both benchmarks pages' generated
  regions and the homepage's crossover, both drawings of it; `pnpm bench:scale:check` holds both at-scale tables
  and the homepage's strip, grid and memory panel.
- `site-text-floor.mjs` loads every page here at seven widths and fails on any text drawn below 9.5px, SVG labels
  included, on a page that scrolls sideways or a box that cuts off text, on a region that scrolls with no way in by
  keyboard, on a region whose name is missing, shared, or not its panel's, and, on the homepage, on any text outside
  its generated regions that no reader can see, found where it is drawn once every band has played and again at
  rest, in each colour scheme, printed and with scripts off, at the seven widths and one inside every band the
  sheet's media queries mark out, on a generated region that hides a run it renders, on a list marker, and on a
  figure Chrome and the figures gate count differently (`pnpm site:text-floor`, in CI).
- The docs tests that read `site/` read this tree as well, including the ones that refuse a claim of behaviour the
  library does not have, refuse a pointer the public cannot follow, and hold a cold intersect's request count and
  the calibration run's figures to the latest run's evidence.

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

- in `scripts/site-figures.cjs`, give `site` what `site-next` has now in each per-tree map (`HOME_HAS_SPEC_STRIP`,
  `DRIVER_STATEMENT_FLOOR`, `HOLDS_EVERY_PAGE`, `HELD_ROW_BY_ROW`), then drop the `site-next` entries; the homepage's ledger needs
  no entry, since it runs on whichever homepage carries the display-tier hero or says its figures are gated;
- point the homepage's generated regions at `site/index.html`, in `bench/run.cjs` and in `bench/scale.cjs`'s
  `HOME_PAGE`;
- drop `site-next` from the site gates (`site-classes.py`, `site-links.py`, `site-figures.cjs`, `site-replay.cjs`),
  from `bench/run.cjs` and `bench/scale.cjs`, from the tests under `tests/docs/` and `tests/bench/` that read both
  trees, and from `.prettierignore`, `eslint.config.js`, `package.json`, CI and the READMEs that name it;
- point `pnpm site:text-floor` at `site`, which fails it today and will not once this tree is `site/`;
- drop the `site-next/` assertions in `tests/docs/superseded-behaviour-claims.test.ts` and
  `tests/docs/internal-citations.test.ts` that this tree is scanned;
- add the CHANGELOG entry, since that is the change that alters the published site.
