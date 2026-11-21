"""Refresh self-hosted Noto Sans SC subsets after changing website copy."""
from pathlib import Path
import re
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent / "dist"
text = "\n".join(p.read_text(encoding="utf-8") for p in [*ROOT.glob("*.html"), ROOT / "site.js"])
characters = "".join(sorted(set(re.findall(r"[\u3000-\u9fff]", text))))
characters += "".join(chr(code) for code in range(32, 127))
url = "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;600;700&display=swap&text=" + quote(characters)
request = Request(url, headers={"User-Agent": "DobStudio-font-maintenance"})
with urlopen(request, timeout=60) as response:
    css = response.read().decode()
faces = []
for block in re.findall(r"@font-face\s*\{[^}]+\}", css):
    weight = re.search(r"font-weight:\s*(\d+)", block)[1]
    remote = re.search(r"url\(([^)]+)\)", block)[1]
    with urlopen(remote, timeout=60) as response:
        data = response.read()
    filename = f"assets/dob-sans-{weight}.ttf"
    (ROOT / filename).write_bytes(data)
    faces.append(block.replace("Noto Sans SC", "Dob Sans").replace(remote, filename))
style = ROOT / "style.css"
existing = re.sub(r"@font-face\s*\{[^}]+\}\s*", "", style.read_text(encoding="utf-8"))
style.write_text("\n".join(faces) + "\n\n" + existing, encoding="utf-8")
print(f"Updated {len(faces)} font weights for {len(characters)} characters.")
