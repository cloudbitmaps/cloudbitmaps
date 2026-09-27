# `site-next/` — the site in the Instrument display tier

> **This is the interim, side-by-side form of [`site/`](../site/README.md).** It is not published: Cloudflare Pages
> serves `site/` only. It exists so the two can be compared page for page before one replaces the other.
> Convergence is one move, `git mv site-next site`, in its own pull request, with the gates' `site-next` entries
> removed in the same change.

The display tier comes from the Claude Design delivery "Instrument, display tier": a homepage in light and dark, and
an extension page that states the language. That delivery generalised `/demo`'s treatment into the shared sheet: a
display type tier (a 96px h1, 52px band heads, 64px and 40px mono figures), a band rhythm that alternates the ground,
a figure table, and diagrams in the same register. Everything else of Instrument holds: radius 0, 1px shared rules,
light designed rather than inverted, nothing below 9.5px, no external anything.

## Contents

- [The pages](#the-pages)
- [Everything else](#everything-else)
- [What differs from site/](#what-differs-from-site)
- [How it stays true](#how-it-stays-true)
- [Comparing the two](#comparing-the-two)

## The pages

| page | what it is |
|---|---|
| `index.html` | The delivery's homepage: the category in the h1, what you do not run in the standfirst, the four figures with the point where we lose among them, then what you operate, the write model, chunk-skipping, the crossover, memory at fleet scale and fit, and a quiet install band. |
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

- **The homepage is the delivery's**, with its inline styles made classes. Where its copy or figures had gone
  stale it says what is true now: the figure table carries the S3 run's cost of a cold intersect and of a write and
  publish, not the July figures, which left the pointer out; the crossover is a rate of GETs with every read a cache
  miss, beside the cold intersect's; and the middle column of "what you operate" is what ran before 0.10.0.
- **The inner pages keep their content** and take the language: the h1 at the display tier beside a figure table,
  each section a band on the alternating ground, card grids as seams, long prose in sans.
- **Two animations, and nothing else moves**: the crossover drawing itself once and chunk-skipping on a 12-second
  loop, both on the homepage, both with a reduced-motion final frame. The inner pages' figures rest on their
  informative frame. `/demo`'s stepper moves only when a reader drives it.
- **The benchmarks chart** is `bench/run.cjs`'s display-tier variant, drawn from the same figures as `site/`'s.

## How it stays true

The same gates as `site/`, run on this tree too — `pnpm site:check` and CI run each with `SITE_DIR=site-next`:
`site-classes.py`, `site-links.py`, `site-figures.cjs` and `site-replay.cjs`, and `pnpm bench:check` and
`pnpm bench:scale:check` hold the benchmarks page's generated regions. `site-figures.cjs` also holds the homepage's
memory band — each fleet's heap and scan, both bars, and the scan axis — to `bench/scale-results.json`. The docs
tests that read `site/` read this tree as well.

## Comparing the two

Serve the repository root and open both trees side by side, for example
`python3 -m http.server -d . 8080`, then `/site/` and `/site-next/`. Pages link to each other by `.html` file, so
they work locally.

- **Check both themes.** Dark is the default; light is designed rather than derived.
- **Load nothing from another origin**, and **respect reduced motion**, as in `site/`.
- **List a new page here.** `tests/docs/directory-readmes.test.ts` holds this README's rows to the directory, as it
  does `site/`'s.
