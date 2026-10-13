# Calibrated Launch Integrity

**A verifiable, manipulation-aware scoring protocol for newly launched tokens.**

Farbod Ghasemlu, Drydock Org. Working paper, version of 13 October 2026.

This repository holds the paper, its data and the code behind every number in it.

- Paper (PDF): [`tex/main.pdf`](tex/main.pdf); LaTeX source in [`tex/`](tex/)
- Paper (Markdown, same text): [`launch-integrity.md`](launch-integrity.md)
- Read online: https://drydockprotocol.org/research/launch-integrity
- Normative section: **Appendix A** (version 2.0.3) governs where it differs from the body.

## Contents

| Path | What it is |
| --- | --- |
| `data/launches.csv.gz` | Every launch on the seven launchpads, 16 September to 7 October 2026, and whether it traded |
| `data/records.csv.gz` | 47,375 retrospective records (9,475 sampled launches, five ages each) with facts, resolutions and v1 scores |
| `data/committed.csv.gz` | Records committed before their outcomes, as published by DryDock's API |
| `appendix_b.py` | Every number computed (not measured) in the paper; output in `analysis/output/appendix_b.txt` |
| `analysis/` | `results.py` (every empirical number in Section 8), `metrics.py`, `figures.py`, `dataset.py` |
| `code/` | The implementation that produced the records (see [`code/README.md`](code/README.md)) |
| `build.py` | Builds every edition: runs the scripts, draws the figures from data, compiles the PDF |

The dataset is also deposited at Harvard Dataverse: https://doi.org/10.7910/DVN/ROY5A4

## Reproducing

```sh
python appendix_b.py                 # numpy, scipy
python analysis/results.py           # pandas; reads data/
python build.py                      # pypandoc, tectonic, poppler
```

The records themselves are recomputed from public Arc state with `code/` (about five hours on a well-connected server).

## Citing

See [`CITATION.cff`](CITATION.cff).

## License

Paper, figures and data: CC BY 4.0. Code: MIT. See [`LICENSE.md`](LICENSE.md).

## Contact

- Farbod Ghasemlu, farbodghasemlu@outlook.com
- Site: https://drydockprotocol.org
