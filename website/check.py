"""Check Pages-local files and HTML anchors without network dependencies."""
from html.parser import HTMLParser
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parent / "dist"
PREFIX = "/DobStudio/"

class Page(HTMLParser):
    def __init__(self, path):
        super().__init__()
        self.ids = set()
        self.links = []
        self.feed(path.read_text(encoding="utf-8"))

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            assert attrs["id"] not in self.ids, f"Duplicate id: {attrs['id']}"
            self.ids.add(attrs["id"])
        for key in ("src", "href"):
            if key in attrs:
                self.links.append(attrs[key])

pages = {p.resolve(): Page(p) for p in ROOT.glob("*.html")}
def check_link(source, link):
    url = urlsplit(link)
    if url.scheme or url.netloc:
        return
    path = unquote(url.path)
    if path.startswith("/"):
        assert path.startswith(PREFIX), f"Wrong Pages base path: {path}"
        target = ROOT / path.removeprefix(PREFIX)
    else:
        target = source.parent / path if path else source
    if target.is_dir():
        target /= "index.html"
    target = target.resolve()
    assert target.is_file(), f"{source.name}: missing {link}"
    if url.fragment and target in pages:
        assert unquote(url.fragment) in pages[target].ids, f"Missing anchor: {link}"

for path, page in pages.items():
    for link in page.links:
        check_link(path, link)
for css in ROOT.glob("*.css"):
    for link in re.findall(r"url\(\s*['\"]?([^'\"\)]+)", css.read_text(encoding="utf-8")):
        check_link(css, link)
ElementTree.parse(ROOT / "sitemap.xml")
print(f"Checked {len(pages)} HTML pages, local resources, anchors and sitemap.")
