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
pages = sorted(glob.glob(f'{ROOT}/*.html'))
failed = False

# ── 1 · internal references ───────────────────────────────────────────────────────────────────────────────
missing = {}
for page in pages:
    html = re.sub(r'<!--.*?-->', '', open(page).read(), flags=re.S)
    refs = set()
    for attr in ('href', 'src'):
        for m in re.finditer(attr + r'="([^"]+)"', html):
            t = m.group(1)
            if t.startswith(('http://', 'https://', 'mailto:', '#', 'data:')):
                continue
            refs.add(t.split('#')[0])
    for t in sorted(refs):
        if not t:
            continue
        if not os.path.exists(os.path.join(ROOT, t)):
            missing.setdefault(t, []).append(os.path.basename(page))

if missing:
    failed = True
    print(f'site-links: {len(missing)} unresolved target(s) across {len(pages)} page(s)')
    for t, srcs in sorted(missing.items()):
        print(f'    {t:26} linked from {", ".join(sorted(set(srcs)))}')
else:
    print(f'site-links: all internal references resolve across {len(pages)} page(s).')

# ── 2 · the crawler files ─────────────────────────────────────────────────────────────────────────────────
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

sys.exit(1 if failed else 0)
