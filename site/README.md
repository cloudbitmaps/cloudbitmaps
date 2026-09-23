# `site/` — the project site

Plain HTML, one stylesheet and a little JavaScript, served as-is: there is no build step and no framework. It is
published at **https://cloudbitmaps.pages.dev**.

**Deployment is not in this repository.** Cloudflare Pages is connected to it and publishes `site/` from `main`,
and builds a preview for every pull request — the `Cloudflare Pages` check on a PR links to it. There is no deploy
workflow to find, because the connection is configured in Cloudflare. Everything in `site/` is published, this
README included: it is reachable on the site, though nothing links to it.

## Contents

- [The pages](#the-pages)
- [Everything else](#everything-else)
- [What is generated, and must not be edited by hand](#what-is-generated-and-must-not-be-edited-by-hand)
- [How it stays true](#how-it-stays-true)
- [Changing it](#changing-it)

## The pages

| page | what it is |
|---|---|
| `index.html` | The front door: what the library is, what it costs against an always-on Redis node, and where that comparison stops favouring it. |
| `demo.html` | A step-through replay of a **measured** intersection of two 2,000,000-id segments — every number on it comes from a recorded benchmark run, not from code running in your browser. |
| `demo.js` | The replay's stepper. The only substantial script on the site. |
| `flavors.html` | The hub for codec **flavors**: what a flavor is, and how to choose one. |
| `flavors/roaring.html` | The roaring flavor, including what carries over from Redis bitmaps and what does not. |
| `architecture.html` | How it works: generations, the pointer, the cache, chunk-skipping, and what the design deliberately does not do. |
| `usage.html` | Installing, wiring a storage backend, and the calls. |
| `benchmarks.html` | The measured costs, the crossover past which a flat node is cheaper, the memory bounds, and what is still owed. |

## Everything else

| file | what it is |
|---|---|
| `cloudbitmaps.css` | The one stylesheet, for every page. |
| `theme.js` | The light / dark toggle — the only client-side state on the site. The theme itself is applied by an inline script in each page's `<head>`, before first paint, so a page never flashes the wrong theme; this file syncs the control, remembers a choice, and follows the system theme for as long as no choice is stored. |
| `assets/` | Favicons, and `logo-light.png`, the image link previews use. |
| `llms.txt` | A plain-text account of the library, written to be read and quoted by an AI assistant. Its version, its presence, its dollar amounts and its count of storage drivers are gated, the last two by `scripts/site-figures.cjs`, which reads a count of "backends" as well as of "drivers". |
| `robots.txt`, `sitemap.xml` | Crawler directives, and the list of every page. |
| `_redirects` | Cloudflare Pages redirects: keeps an old address, `/flavors-roaring`, working. |

## What is generated, and must not be edited by hand

Hand edits here are overwritten by the next run. How much of a stale copy CI catches differs, so each says:

- **The crossover chart** on `benchmarks.html`, between the `BENCH:CHART` markers — written by `bench/run.cjs`
  (`pnpm bench`). CI checks its crossover and baseline labels against `bench/results.json`, not the drawing.
- **The at-scale table** on `benchmarks.html`, between the `BENCH:SCALE` markers — written by `bench/scale.cjs`.
  `pnpm bench:scale:check` fails in CI if this copy, or the one in `docs/benchmarks.md`, is not what
  `bench/scale-results.json` renders, so regenerate both with `pnpm bench:scale:render` rather than editing either.

## How it stays true

These run in CI on every pull request. Between them they check the site's money figures and measured values
against the files that produced them, and the pages against each other — with the gaps named above:

| gate | checks |
|---|---|
| `scripts/site-figures.cjs` | Checks the site's money figures and its crossover rate against `bench/results.json`, `docs/benchmarks.md`, the latest calibration run's evidence in `bench/calibration/` and the pricing profile: every one must appear on `benchmarks.html`, which owns them, and a dollar amount that none of them accounts for fails on any of six site pages, `llms.txt`, the root and npm READMEs, the roadmap or `docs/benchmarks.md` — so no price can drift or improve without a run behind it. A run's figures pass at any honest precision, through the matcher its report is checked with, bindings included: wherever a paragraph, list item or table row states one of the run's figures or a request shape, every figure in it must also stand beside the words for the claim it makes. The superseded July publish figure may appear only on the benchmarks pages, and either July figure only beside the pointer it leaves out. Inside `benchmarks.html`'s panel on the latest run, every unit and every count is checked, and each row against the run's derivation. The rate is required on `benchmarks.html` and its chart, and is checked wherever it stands in a block that quotes the run; stated anywhere else, it is not checked. Also: the measured values two pages quote — the RSS ceiling and soak figures on `benchmarks.html`, the encoding sizes on `flavors/roaring.html` — and any count of storage drivers on the pages or in `llms.txt`, against the drivers that ship, whether it says "drivers" or "backends". |
| `scripts/site-links.py` | Links resolve; the crawler files exist; every page declares a canonical URL, and the sitemap and those URLs agree in both directions; external links open in a new tab, with `rel="noopener"` and an `aria-label`; a link to `page.html#id` names an id that page has; and nothing a page loads — a script, a stylesheet, an image, a font, a preconnect, a `url()` in the stylesheet — comes from another origin, and neither script holds an absolute URL. |
| `scripts/site-classes.py` | Every class in a page's markup, nested pages included, and every class a script applies, is defined in the stylesheet. |
| `scripts/site-replay.cjs --check` | `demo.html`'s figures still match the benchmark it replays. |
| `pnpm bench:scale:check` | The at-scale table here and in `docs/benchmarks.md` is what `bench/scale-results.json` renders. |
| `tests/docs/version-claims.test.ts` | The version the site states is the version that ships. |
| `tests/docs/links.test.ts` | Relative links across the site and the docs resolve — and a link into a markdown file, its heading anchor too. |

## Changing it

- **Check both themes.** Dark is the default; light is designed rather than derived, so a change that looks right
  on one can be unreadable on the other. `pnpm site:screenshots` captures every page in both.
- **Load nothing from another origin.** No CDN, no web fonts, no third-party scripts — the pages are
  self-contained, and `site-links.py` fails on anything a page would fetch from elsewhere. Copy an asset into
  `site/` and reference it relatively.
- **Respect reduced motion.** Anything that moves must reach a readable resting state under
  `prefers-reduced-motion`.
- **Gate any new figure.** A number added to a page needs a source, and a check in `scripts/site-figures.cjs`
  against it — otherwise nothing stops it drifting from the run that produced it.
- **Preview locally** with any static server, for example `python3 -m http.server -d site 8080`. Pages link to each
  other by `.html` file, so they work locally; the extensionless addresses in the sitemap are served by Pages.
- **List a new page here.** `tests/docs/directory-readmes.test.ts` fails if a page or top-level file in this
  directory has no row in a table here, or if a row names one that does not exist.
