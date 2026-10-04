"""Every class used in markup must be defined in the stylesheet.

Scoped to `site/`, the only site directory.

Markup referencing a class the sheet never declares renders as bare HTML and nothing complains: without this
check it is found only by eye, in a screenshot, after shipping.

The site's scripts are read too. A class a script adds at runtime is the same failure with no markup to find it
in: when a stepper sets `is-fetched` and `is-done` on its stage and no rule in the sheet styles either, its fetch
and result beats look no different from the rest, and a check that reads only the markup cannot see it. A
script's classes are every string argument of a `classList` call, the value it gives `className` or
`setAttribute('class', …)`, and any string literal made only of `is-…` state classes, the site's naming
convention for them — in the `.js` files and in each page's inline scripts. Markup is read through
`site_markup.py`, so a class attribute in single quotes, or none, is read like any other.
"""
import re, sys, glob, os

# The shared reader, imported without leaving a `__pycache__/` in the tree for the directory-README gate to find.
sys.dont_write_bytecode = True
import site_markup  # noqa: E402

# Which tree: `site/` is what Cloudflare Pages publishes, `site-next/` the display-tier rebuild beside it until it
# replaces it. `SITE_DIR=site-next python3 scripts/site-classes.py` checks the second.
ROOT = os.environ.get('SITE_DIR', 'site')
if ROOT not in ('site', 'site-next'):
    sys.exit(f'SITE_DIR must be site or site-next, not {ROOT}')

css = open(f'{ROOT}/cloudbitmaps.css').read()
css_no_comments = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
defined = set(re.findall(r'\.([A-Za-z][\w-]*)', css_no_comments))

# Classes that exist as READING AIDS rather than style hooks: `.rc1` sits beside `.rc2`/`.rc3`, which do carry
# animation delays, and naming the first car explicitly is clearer than leaving it bare. Anything added here
# needs that kind of reason.
INTENTIONAL = {'rc1'}

# Recursive, as site-links.py is: a depth-one glob skips `flavors/roaring.html`, the one nested page, and a page
# this gate cannot see passes it.
pages = sorted(glob.glob(f'{ROOT}/**/*.html', recursive=True))
if not pages:
    print(f'site-classes: no pages found under {ROOT}/ — refusing to report success over nothing')
    sys.exit(1)

bad = {}
for page in pages:
    used = set()
    for _, attrs in site_markup.tags(open(page).read()):
        used.update(attrs.get('class', '').split())
    missing = sorted(c for c in used if c not in defined and c not in INTENTIONAL)
    if missing:
        bad[os.path.relpath(page, ROOT)] = missing

# The scripts: each `.js` file, and each page's inline scripts. A class a script applies is every string argument of
# a `classList` call, the value given to `className` or to `setAttribute('class', …)`, and any string made only of
# `is-…` state classes, which is how the stepper keeps its states in a table.
CLASS_CALL = re.compile(r"""classList\s*\.\s*(?:add|remove|toggle|contains|replace)\s*\(([^)]*)\)""")
CLASS_NAME = re.compile(r"""\.className\s*\+?=\s*(['"`])([^'"`]*)\1""")
SET_CLASS = re.compile(r"""setAttribute\(\s*(['"])class\1\s*,\s*(['"`])([^'"`]*)\2""")
for where, source in site_markup.site_scripts(ROOT, pages):
    js = site_markup.js_code(source)
    used = set()
    for m in CLASS_CALL.finditer(js):
        for literal in site_markup.js_strings(m.group(1)):
            used.update(literal.split())
    for m in CLASS_NAME.finditer(js):
        used.update(m.group(2).split())
    for m in SET_CLASS.finditer(js):
        used.update(m.group(3).split())
    for literal in site_markup.js_strings(js):
        tokens = literal.split()
        if tokens and all(re.fullmatch(r'is-[\w-]+', t) for t in tokens):
            used.update(tokens)
    missing = sorted(c for c in used if c not in defined and c not in INTENTIONAL)
    if missing:
        bad[where] = missing

for page, missing in bad.items():
    print(f'{page}: {len(missing)} undefined class(es)')
    for c in missing:
        print(f'    .{c}')
print(f'\n{sum(len(v) for v in bad.values())} undefined class reference(s)')
sys.exit(1 if bad else 0)
