"""Every internal link and asset reference in site-final/ must resolve.

Cross-links accumulate while pages are built one at a time, and a link to a page that does not exist yet is
indistinguishable from a typo unless something enumerates them. This prints outstanding targets rather than
only failing, so the list doubles as the build queue.
"""
import re, sys, glob, os

ROOT = 'site-final'
pages = sorted(glob.glob(f'{ROOT}/*.html'))
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

if not missing:
    print(f'site-links: all internal references resolve across {len(pages)} page(s).')
    sys.exit(0)
print(f'site-links: {len(missing)} unresolved target(s) across {len(pages)} page(s)')
for t, srcs in sorted(missing.items()):
    print(f'    {t:26} linked from {", ".join(sorted(set(srcs)))}')
sys.exit(1)
