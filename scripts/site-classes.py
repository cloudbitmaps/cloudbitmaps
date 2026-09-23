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
read only the markup, could not see it. A script's classes are the literal arguments of `classList.add`,
`remove`, `toggle` and `contains`, and any string literal made only of `is-…` state classes, the site's naming
convention for them.
"""
import re, sys, glob, os

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
    html = re.sub(r'<!--.*?-->', '', open(page).read(), flags=re.S)
    used = set()
    for m in re.finditer(r'class="([^"]*)"', html):
        for c in m.group(1).split():
            used.add(c)
    missing = sorted(c for c in used if c not in defined and c not in INTENTIONAL)
    if missing:
        bad[os.path.relpath(page, ROOT)] = missing

# The scripts. Recursive, like the pages, and for the same reason.
CLASSLIST = re.compile(r"""classList\.(?:add|remove|toggle|contains)\(\s*(['"])([\w-]+)\1""")
STRING = re.compile(r"""(['"])([^'"\n]*)\1""")
scripts = sorted(glob.glob(f'{ROOT}/**/*.js', recursive=True))
for script in scripts:
    js = re.sub(r'/\*.*?\*/', '', open(script).read(), flags=re.S)
    js = re.sub(r'(?m)^\s*//.*$', '', js)
    used = {m.group(2) for m in CLASSLIST.finditer(js)}
    for m in STRING.finditer(js):
        tokens = m.group(2).split()
        if tokens and all(re.fullmatch(r'is-[\w-]+', t) for t in tokens):
            used.update(tokens)
    missing = sorted(c for c in used if c not in defined and c not in INTENTIONAL)
    if missing:
        bad[os.path.relpath(script, ROOT)] = missing

for page, missing in bad.items():
    print(f'{page}: {len(missing)} undefined class(es)')
    for c in missing:
        print(f'    .{c}')
print(f'\n{sum(len(v) for v in bad.values())} undefined class reference(s)')
sys.exit(1 if bad else 0)
