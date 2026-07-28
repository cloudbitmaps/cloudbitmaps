"""Every class used in markup must be defined in the stylesheet.

This is the `.table` bug generalised: markup referencing a class the sheet never
declares renders as bare HTML and nothing complains. Both instances of it on
/demo were found by eye, in a screenshot, after shipping.
"""
import re, sys, glob, os

css = open('site-final/cloudbitmaps.css').read()
css_no_comments = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
defined = set(re.findall(r'\.([A-Za-z][\w-]*)', css_no_comments))

# Classes that exist as READING AIDS rather than style hooks: `.rc1` sits beside `.rc2`/`.rc3`, which do carry
# animation delays, and naming the first car explicitly is clearer than leaving it bare. Anything added here
# needs that kind of reason.
INTENTIONAL = {'rc1'}

bad = {}
for page in sorted(glob.glob('site-final/*.html')):
    html = re.sub(r'<!--.*?-->', '', open(page).read(), flags=re.S)
    used = set()
    for m in re.finditer(r'class="([^"]*)"', html):
        for c in m.group(1).split():
            used.add(c)
    missing = sorted(c for c in used if c not in defined and c not in INTENTIONAL)
    if missing:
        bad[os.path.basename(page)] = missing

for page, missing in bad.items():
    print(f'{page}: {len(missing)} undefined class(es)')
    for c in missing:
        print(f'    .{c}')
print(f'\n{sum(len(v) for v in bad.values())} undefined class reference(s)')
sys.exit(1 if bad else 0)
