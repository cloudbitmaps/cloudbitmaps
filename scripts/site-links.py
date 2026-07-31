"""Every internal link and asset reference in site/ must resolve, and the crawler files must agree with reality.

Two checks, from the same premise: a page nobody linked and a page nobody listed both fail silently.

1. LINKS. Cross-links accumulate while pages are built one at a time, and a link to a page that does not exist
   yet is indistinguishable from a typo unless something enumerates them. This prints outstanding targets rather
   than only failing, so the list doubles as the build queue.

2. CRAWLER FILES. robots.txt, sitemap.xml and llms.txt were all three LOST in the site/ rename and nobody
   noticed for two commits. llms.txt surfaced only because tests/docs/site-version.test.ts happens to read it
   for a version badge — robots.txt and sitemap.xml were gated by nothing at all, so the site would have
   deployed with no crawler directives and no sitemap, and the only symptom would have been search traffic that
   never arrived.

   The sitemap check is deliberately BIDIRECTIONAL: the set of <loc> entries must equal the set of canonical
   URLs the pages declare. A one-way "every page is listed" check would have let the old sitemap pass while it
   still advertised a deleted page, and a one-way "every listing exists" check would have let /demo stay
   invisible. Rebuilding the sitemap from the canonicals is a one-liner; the point of the check is that the
   rebuild cannot be forgotten.
"""

import re, sys, glob, os

ROOT = 'site'
# Recursive: the site is no longer flat. `site/flavors/roaring.html` exists so that the `/flavors/roaring` URL
# the page has always declared as its canonical actually resolves, and a depth-one glob would have quietly
# excluded it from every check in this file.
pages = sorted(glob.glob(f'{ROOT}/**/*.html', recursive=True))
failed = False


def rel(page):
    """A page's path relative to site/ — 'usage.html', 'flavors/roaring.html'. The identity used throughout."""
    return os.path.relpath(page, ROOT).replace(os.sep, '/')


def resolve_ref(page, target):
    """Resolve a link/asset target the way a BROWSER would: relative to the page holding it, not to site/.

    This used to be `os.path.join(ROOT, target)`, which is the same thing only while every page sits at the top
    level. From `site/flavors/roaring.html`, `../cloudbitmaps.css` under the old rule resolved to
    `site/../cloudbitmaps.css` — the repo root — and would have been reported as a broken asset on a page whose
    stylesheet was perfectly fine. Anchoring on the page's own directory is what makes nesting checkable at all.
    """
    return os.path.normpath(os.path.join(os.path.dirname(page), target))

# ── 1 · internal references, and the fragments on them ────────────────────────────────────────────────────
# The fragment half of this was missing, and it mattered. `refs.add(t.split('#')[0])` threw the fragment away
# before checking anything, and pure `#foo` same-page links were skipped by the startswith() filter entirely.
# So `usage.html#api` was verified as far as "usage.html exists" and no further.
#
# Confirmed by breaking it: pointing Home at `usage.html#nonexistent-anchor` still printed "all internal
# references resolve". A broken fragment does not 404 — the browser silently lands the reader at the top of the
# page — so this is precisely the class of defect that needs a gate, and the gate was passing it through.
# Keyed by path-relative-to-site, not basename: two pages in different directories may share a filename, and
# collapsing them would check one page's fragments against the other's ids.
ids_by_page = {rel(p): set(re.findall(r'\bid="([^"]+)"', open(p).read())) for p in pages}

missing = {}
bad_frags = {}
for page in pages:
    html = re.sub(r'<!--.*?-->', '', open(page).read(), flags=re.S)
    refs = set()
    for attr in ('href', 'src'):
        for m in re.finditer(attr + r'="([^"]+)"', html):
            t = m.group(1)
            if t.startswith(('http://', 'https://', 'mailto:', 'data:')):
                continue
            if t.startswith('#'):
                # Same-page anchor: the target file IS this page.
                target, frag = rel(page), t[1:]
            else:
                file_part, _, frag = t.partition('#')
                if file_part:
                    refs.add(file_part)
                target = (
                    rel(resolve_ref(page, file_part)) if file_part else rel(page)
                )
            if frag and target in ids_by_page and frag not in ids_by_page[target]:
                bad_frags.setdefault(f'{target}#{frag}', []).append(rel(page))
    for t in sorted(refs):
        if not t:
            continue
        if not os.path.exists(resolve_ref(page, t)):
            missing.setdefault(f'{rel(page)} → {t}', []).append(rel(page))

if missing:
    failed = True
    print(f'site-links: {len(missing)} unresolved target(s) across {len(pages)} page(s)')
    for t, srcs in sorted(missing.items()):
        print(f'    {t:26} linked from {", ".join(sorted(set(srcs)))}')
else:
    print(f'site-links: all internal references resolve across {len(pages)} page(s).')

if bad_frags:
    failed = True
    print(f'site-links: {len(bad_frags)} link(s) point at an id that does not exist')
    for t, srcs in sorted(bad_frags.items()):
        print(f'    {t:34} linked from {", ".join(sorted(set(srcs)))}')
else:
    n_frags = sum(
        len(re.findall(r'(?:href|src)="[^"]*#[^"]+"', re.sub(r'<!--.*?-->', '', open(p).read(), flags=re.S)))
        for p in pages
    )
    # Counted and printed so that a refactor which removes every fragment link cannot leave this reporting
    # success over an empty set — the vacuous-pass failure mode.
    print(f'site-links: {n_frags} fragment link(s) resolve to a real id.')

# ── 2 · external links leave the site in a new tab ────────────────────────────────────────────────────────
# Every off-site anchor opens in a new tab, so following one does not throw away the page someone was reading.
# Three attributes make that safe and legible rather than merely working:
#
#   target="_blank"  — the behaviour itself.
#   rel="noopener"   — the security half: without it the opened page can reach back through `window.opener`.
#                      Deliberately NOT `noreferrer`, which would also strip the Referer header and with it
#                      GitHub's ability to see that the traffic came from here.
#   aria-label       — a new tab with no warning is disorienting for a screen-reader user. The label repeats
#                      the visible text before adding the hint, which keeps WCAG 2.5.3 (Label in Name) intact.
#
# `<link rel="canonical">` and `<meta>` URLs are absolute too but are not anchors, so the pattern below is
# anchored on `<a ` specifically rather than on "contains https://".
ANCHOR_RE = re.compile(r'<a\s[^>]*href="https?://[^"]+"[^>]*>', re.I)
ext_problems = {}
ext_count = 0
for page in pages:
    html = re.sub(r'<!--.*?-->', '', open(page).read(), flags=re.S)
    for m in ANCHOR_RE.finditer(html):
        tag = m.group(0)
        ext_count += 1
        missing_attrs = []
        if 'target="_blank"' not in tag:
            missing_attrs.append('target="_blank"')
        if 'noopener' not in tag:
            missing_attrs.append('rel="noopener"')
        if 'aria-label' not in tag:
            missing_attrs.append('aria-label="… (opens in a new tab)"')
        if missing_attrs:
            href = re.search(r'href="([^"]+)"', tag).group(1)
            ext_problems.setdefault(
                f'{os.path.basename(page)} → {href}', []
            ).extend(missing_attrs)

if ext_problems:
    failed = True
    print(f'site-links: {len(ext_problems)} external link(s) not set to open in a new tab')
    for where, attrs in sorted(ext_problems.items()):
        print(f'    {where}\n        missing: {", ".join(sorted(set(attrs)))}')
elif ext_count == 0:
    # A page set with no external anchors at all would otherwise make the check above vacuously true.
    print('site-links: no external anchors found — check skipped (was this intended?)')
else:
    print(f'site-links: {ext_count} external link(s) open in a new tab, with rel=noopener.')

# ── 3 · the crawler files ─────────────────────────────────────────────────────────────────────────────────
REQUIRED = ['robots.txt', 'sitemap.xml', 'llms.txt']
absent = [f for f in REQUIRED if not os.path.exists(os.path.join(ROOT, f))]
if absent:
    failed = True
    print(f'site-links: {len(absent)} crawler file(s) missing from {ROOT}/')
    for f in absent:
        print(f'    {f}')
else:
    canonical = set()
    for page in pages:
        for line in open(page):
            if 'rel="canonical"' in line:
                m = re.search(r'href="([^"]+)"', line)
                if m:
                    canonical.add(m.group(1))
    listed = set(re.findall(r'<loc>([^<]+)</loc>', open(os.path.join(ROOT, 'sitemap.xml')).read()))

    unlisted = canonical - listed
    stale = listed - canonical
    if unlisted or stale:
        failed = True
        print('site-links: sitemap.xml disagrees with the pages\' canonical URLs')
        for u in sorted(unlisted):
            print(f'    not in the sitemap   {u}')
        for u in sorted(stale):
            print(f'    no page claims it    {u}')
        print('\n    Rebuild it from the canonicals rather than editing by hand.')
    else:
        print(f'site-links: robots/sitemap/llms present; sitemap matches {len(canonical)} canonical URL(s).')

    # A page with no canonical at all would silently shrink the comparison set on both sides and pass.
    if len(canonical) != len(pages):
        failed = True
        print(
            f'site-links: {len(pages)} page(s) but only {len(canonical)} canonical URL(s) — '
            'a page without <link rel="canonical"> makes the sitemap check vacuous for that page.'
        )

    # ── 4 · every advertised URL must actually SERVE the page that claims it ───────────────────────────────
    # The bidirectional check above compares two sets of strings we wrote ourselves. Both can agree perfectly on
    # a URL that does not exist — and did. `/flavors/roaring` was the sitemap entry, the canonical AND the
    # og:url of the roaring page while the file sat at `site/flavors-roaring.html`, so Cloudflare had nothing to
    # serve at that path and fell back to the home page. Every string matched every other string; the flagship
    # flavor page told Google to index it at a URL returning someone else's content, and nothing here objected.
    #
    # Internal consistency is not resolution. This resolves each <loc> against the files that will actually be
    # deployed, using Pages' clean-URL rules:  /  → index.html ·  /x  → x.html, else x/index.html.
    def serves(url_path):
        p = url_path.strip('/')
        if not p:
            return 'index.html' if os.path.exists(os.path.join(ROOT, 'index.html')) else None
        for candidate in (f'{p}.html', f'{p}/index.html'):
            if os.path.exists(os.path.join(ROOT, candidate)):
                return candidate
        return None

    unresolved = {}
    for loc in sorted(listed):
        path = re.sub(r'^https?://[^/]+', '', loc)
        hit = serves(path)
        if hit is None:
            unresolved[loc] = 'nothing to serve — Pages will fall back to another page'
        else:
            # And it must be the page that CLAIMS that URL, not merely some page. A file existing at the path is
            # necessary but not sufficient: the canonical is what tells search engines which URL is the real one.
            declared = re.search(
                r'rel="canonical"\s+href="([^"]+)"', open(os.path.join(ROOT, hit)).read()
            )
            if not declared or declared.group(1).rstrip('/') != loc.rstrip('/'):
                got = declared.group(1) if declared else '(none)'
                unresolved[loc] = f'served by {hit}, whose canonical is {got}'

    if unresolved:
        failed = True
        print(f'site-links: {len(unresolved)} sitemap URL(s) do not resolve to the page that claims them')
        for loc, why in sorted(unresolved.items()):
            print(f'    {loc}\n        {why}')
    else:
        print(f'site-links: all {len(listed)} sitemap URL(s) resolve to the page declaring them.')

sys.exit(1 if failed else 0)
