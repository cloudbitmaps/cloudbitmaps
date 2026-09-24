"""What the site gates read out of a page: its tags and their attributes, its scripts, and its styles.

Shared by `site-classes.py` and `site-links.py`, because both used to read markup with patterns that saw only one
spelling of it. A review planted each of these and watched a gate pass: an attribute in single quotes, or none; a
`>` inside a quoted value, which ended the tag early; a `rel` the pattern could not parse, read as "not a load";
and the inline `<script>` every page carries, which neither gate read at all — so a tracker loaded from there went
through the check written to keep third-party loads off the site. The site's own pages use double quotes and no
inline loads today; the point of reading every spelling is that nothing has to stay that way by luck.
"""
from __future__ import annotations

import glob
import os
import re

# An opening tag. A quoted value may hold `>`: `alt="p99 > 10ms"` must not end the tag before its `src`.
TAG = re.compile(r"""<([a-zA-Z][a-zA-Z0-9:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>""")
# One attribute: double-quoted, single-quoted, unquoted, or bare.
ATTR = re.compile(r"""([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?""")
SCRIPT = re.compile(r"<script\b((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>(.*?)</script\s*>", re.S | re.I)
STYLE = re.compile(r"<style\b[^>]*>(.*?)</style\s*>", re.S | re.I)
# A script's strings, or its comments. Matching both in one pass is what keeps a `//` inside a string from being
# read as a comment, and a quote inside a comment from being read as a string.
JS_TOKEN = re.compile(
    r"""("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|//[^\n]*|/\*[\s\S]*?\*/"""
)
# Script types that are data, not code.
DATA_SCRIPT = re.compile(r"json|template", re.I)


def without_comments(html: str) -> str:
    return re.sub(r"<!--.*?-->", "", html, flags=re.S)


def attributes(inside: str) -> dict[str, str]:
    """A tag's attributes, names lowercased, the first of a repeated name winning as it does in a browser."""
    out: dict[str, str] = {}
    for a in ATTR.finditer(inside):
        value = next((g for g in a.group(2, 3, 4) if g is not None), "")
        out.setdefault(a.group(1).lower(), value)
    return out


def tags(html: str):
    """Every opening tag in a page, comments removed: `(name lowercased, attributes)`."""
    for m in TAG.finditer(without_comments(html)):
        yield m.group(1).lower(), attributes(m.group(2))


def js_code(js: str) -> str:
    """A script with its comments removed and its strings kept."""
    return JS_TOKEN.sub(lambda m: m.group(1) or "", js)


def js_strings(js: str) -> list[str]:
    """Every string literal in a script, comments excluded, quotes removed. Template literals are kept whole."""
    return [m.group(1)[1:-1] for m in JS_TOKEN.finditer(js) if m.group(1)]


def inline_scripts(html: str) -> list[str]:
    """The bodies of a page's inline scripts: no `src`, and not a data block such as JSON-LD."""
    out = []
    for m in SCRIPT.finditer(without_comments(html)):
        attrs = attributes(m.group(1))
        if "src" in attrs or DATA_SCRIPT.search(attrs.get("type", "")):
            continue
        out.append(m.group(2))
    return out


def inline_styles(html: str) -> list[str]:
    """A page's own CSS: its `<style>` blocks and its `style` attributes."""
    html = without_comments(html)
    return [m.group(1) for m in STYLE.finditer(html)] + [
        attrs["style"] for _, attrs in tags(html) if "style" in attrs
    ]


def css_code(css: str) -> str:
    return re.sub(r"/\*.*?\*/", "", css, flags=re.S)


def site_scripts(root: str, pages: list[str]) -> list[tuple[str, str]]:
    """Every script on the site, as `(where, source)`: each `.js` file, and each page's inline scripts."""
    out = [
        (os.path.relpath(p, root), open(p).read())
        for p in sorted(glob.glob(f"{root}/**/*.js", recursive=True))
    ]
    for page in pages:
        for i, body in enumerate(inline_scripts(open(page).read())):
            out.append((f"{os.path.relpath(page, root)} (inline script {i + 1})", body))
    return out
