"""Every class used in markup must be defined in the stylesheet.

Scoped to `site/`, which is now the only site directory — `site-old/` (the superseded site) and `site2/` (the
design delivery, imported verbatim to diff against) are both deleted, along with their entries in
.prettierignore and eslint.config.js.

This is the `.table` bug generalised: markup referencing a class the sheet never
declares renders as bare HTML and nothing complains. Both instances of it on
/demo were found by eye, in a screenshot, after shipping.

The site's scripts are read too. A class a script adds at runtime is the same bug with no markup to find it in:
/demo's stepper set `is-fetched` and `is-done` on its stage for as long as the page existed, and no rule in
the sheet ever styled either, so the fetch and result beats never looked any different — and this check, which
read only the markup, could not see it. A script's classes are every string argument of a `classList` call, the
value it gives `className` or `setAttribute('class', …)`, and any string literal made only of `is-…` state
classes, the site's naming convention for them — in the `.js` files and in each page's inline scripts. Markup is
read through `site_markup.py`, so a class attribute in single quotes, or none, is read like any other.
"""
import re, sys, glob, os

# The shared reader, imported without leaving a `__pycache__/` in the tree for the directory-README gate to find.
sys.dont_write_bytecode = True
import site_markup  # noqa: E402

ROOT = 'site'

css = open(f'{ROOT}/cloudbitmaps.css').read()
css_no_comments = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
defined = set(re.findall(r'\.([A-Za-z][\w-]*)', css_no_comments))

# Classes that exist as READING AIDS rather than style hooks: `.rc1` sits beside `.rc2`/`.rc3`, which do carry
# animation delays, and naming the first car explicitly is clearer than leaving it bare. Anything added here
# needs that kind of reason.
INTENTIONAL = {'rc1'}

# Recursive, as site-links.py is. A depth-one glob skipped `flavors/roaring.html` — the one nested page — so its
# classes were never checked, and a page this gate could not see passed it.
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
