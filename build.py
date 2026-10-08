"""Builds every edition from launch-integrity.md:

    python build.py

1. runs appendix_b.py and keeps its output (analysis/output/appendix_b.txt);
2. writes the figures' TeX sources from data (analysis/figures.py);
3. converts the Markdown to tex/abstract.tex and tex/body.tex with pandoc, drawing figures from figures/*.tex;
4. compiles tex/main.pdf with tectonic;
5. crops each figure from the PDF as figures/figure-N.svg for the Markdown edition (poppler).
Requires numpy, scipy, pandas, pypandoc_binary, tectonic and poppler.
"""
import os
import re
import subprocess
import sys
import pypandoc

ROOT = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
run = lambda *args, **kw: subprocess.run(args, check=True, **kw)

os.makedirs(os.path.join(ROOT, "analysis", "output"), exist_ok=True)
with open(os.path.join(ROOT, "analysis", "output", "appendix_b.txt"), "w") as out:
    run(PY, os.path.join(ROOT, "appendix_b.py"), stdout=out)
run(PY, os.path.join(ROOT, "analysis", "figures.py"))

source = open(os.path.join(ROOT, "launch-integrity.md")).read()
# Title, byline and status note are typeset by main.tex; the abstract goes to its own file.
abstract = source.split("## Abstract", 1)[1].split("**Keywords:**", 1)[0].strip()
body = source.split("**Keywords:**", 1)[1].split("\n", 1)[1]
body = body[body.index("## 1. Introduction"):]
# Figures: an image paragraph becomes the figure drawn from data.
body = re.sub(r"!\[[^\]]*\]\(figures/(figure-\d+)\.svg\)\n\n\*Figure [^\n]*\*", lambda m: "```{=latex}\n\\input{../figures/%s}\n```" % m.group(1), body)


def tex(markdown):
    out = pypandoc.convert_text(markdown, "latex", format="markdown+tex_math_dollars-tex_math_single_backslash", extra_args=["--wrap=none", "--no-highlight"])
    # Section numbers are part of the headings, so LaTeX's own numbering stays off (see main.tex).
    return out


open(os.path.join(ROOT, "tex", "abstract.tex"), "w").write(tex(abstract))
open(os.path.join(ROOT, "tex", "body.tex"), "w").write(tex(body))
run(os.path.expanduser("~/.local/bin/tectonic"), "-X", "compile", "main.tex", cwd=os.path.join(ROOT, "tex"))

# Crop each figure (drawn at the top of its page, above its "Figure n:" caption) as vector SVG.
pdf = os.path.join(ROOT, "tex", "main.pdf")
pages = int(re.search(r"Pages:\s+(\d+)", subprocess.run(["pdfinfo", pdf], capture_output=True, text=True).stdout).group(1))
for page in range(1, pages + 1):
    xml = subprocess.run(["pdftotext", "-f", str(page), "-l", str(page), "-bbox-layout", pdf, "-"], capture_output=True, text=True).stdout
    lines = [(float(a), float(b), float(c), float(d), " ".join(re.findall(r">([^<]*)</word>", w)))
             for a, b, c, d, w in re.findall(r'<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)</line>', xml)]
    for x0, y0, x1, y1, text in lines:
        match = re.match(r"^Figure (\d+):", text)
        if not match:
            continue
        above = [line for line in lines if line[3] < y0]
        left = max(0, int(min(line[0] for line in above) - 16))
        right = int(max(line[2] for line in above) + 16)
        top = max(0, int(min(line[1] for line in above) - 13))
        bottom = int(y0 - 6)
        out = os.path.join(ROOT, "figures", "figure-%s.svg" % match.group(1))
        run("pdftocairo", "-svg", "-f", str(page), "-l", str(page), "-x", str(left), "-y", str(top), "-W", str(right - left), "-H", str(bottom - top),
            "-paperw", str(right - left), "-paperh", str(bottom - top), pdf, out)
print("built", pdf)
