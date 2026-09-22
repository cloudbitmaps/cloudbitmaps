"""Every class used in markup must be defined in the stylesheet.

Scoped to `site/`, which is now the only site directory — `site-old/` (the superseded site) and `site2/` (the
design delivery, imported verbatim to diff against) are both deleted, along with their entries in
.prettierignore and eslint.config.js.

This is the `.table` bug generalised: markup referencing a class the sheet never
declares renders as bare HTML and nothing complains. Both instances of it on
/demo were found by eye, in a screenshot, after shipping.
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

for page, missing in bad.items():
    print(f'{page}: {len(missing)} undefined class(es)')
    for c in missing:
        print(f'    .{c}')
print(f'\n{sum(len(v) for v in bad.values())} undefined class reference(s)')
sys.exit(1 if bad else 0)
