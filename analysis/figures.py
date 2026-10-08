"""Writes the paper's figures as pgfplots/TikZ sources (figures/figure-N.tex) from computed data, so the
drawings in both editions are generated, not hand-made. Figure 4 reads the empirical results."""
import json
import os
import numpy as np
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "figures")
os.makedirs(OUT, exist_ok=True)


def coords(xs, ys):
    return " ".join("(%.4f,%.4f)" % (x, y) for x, y in zip(xs, ys))


# Figure 1: Proposition 1, price multiple after an insider sale of share f with the pool holding share g.
f = np.linspace(0, 0.4, 81)
lines = []
for g, style in ((0.10, "solid"), (0.20, "dashed"), (0.40, "dotted")):
    lines.append(r"\addplot[%s, thick] coordinates {%s}; \addlegendentry{pool holds %d\%%}" % (style, coords(100 * f, 100 * (g / (g + f)) ** 2), round(100 * g)))
fig1 = r"""\begin{figure}[t]
\centering
\begin{tikzpicture}
\begin{axis}[width=0.82\linewidth, height=6.2cm, xlabel={Insider share sold (\% of supply)}, ylabel={Price after the sale (\% of before)}, xmin=0, xmax=40, ymin=0, ymax=100, grid=major, grid style={gray!25}, legend pos=north east, legend cell align=left, tick label style={font=\small}, label style={font=\small}, legend style={font=\small}]
@LINES@
\addplot[gray, densely dashed] coordinates {(0,20) (40,20)};
\end{axis}
\end{tikzpicture}
\caption{Price after an insider sale in a constant-product pool, by the pool's share of supply (Proposition 1). The grey line marks an 80\% drop. Computed by Appendix~B.}
\label{fig:exit}
\end{figure}
""".replace("@LINES@", "\n".join(lines))

# Figure 2: v1's "profitable trader" label under no skill (code rule, q = 0.35 and 0.40) and the v2 rule.
ns = np.arange(5, 51)
v1_35 = [stats.binom.sf(int(np.ceil(.55 * n)) - 1, n, .35) for n in ns]
v1_40 = [stats.binom.sf(int(np.ceil(.55 * n)) - 1, n, .40) for n in ns]
q0, m = .35, 20
v2_fp, v2_power, v2_n = [], [], []
for n in ns:
    k = np.arange(n + 1)
    ok = k[stats.beta.sf(q0 + .05, q0 * m + k, (1 - q0) * m + n - k) > .95]
    if len(ok):
        v2_n.append(n); v2_fp.append(stats.binom.sf(ok.min() - 1, n, q0)); v2_power.append(stats.binom.sf(ok.min() - 1, n, .6))
fig2 = r"""\begin{figure}[t]
\centering
\begin{tikzpicture}
\begin{axis}[width=0.82\linewidth, height=6.2cm, xlabel={Launches traded}, ylabel={Share of wallets labelled}, xmin=5, xmax=50, ymin=0, ymax=1, grid=major, grid style={gray!25}, legend pos=north east, legend cell align=left, tick label style={font=\small}, label style={font=\small}, legend style={font=\small}]
\addplot[thick] coordinates {@A@}; \addlegendentry{v1 label, no skill, $q=0.40$}
\addplot[thick, dashed] coordinates {@B@}; \addlegendentry{v1 label, no skill, $q=0.35$}
\addplot[thick, dotted] coordinates {@C@}; \addlegendentry{v2 label, no skill, $q=0.35$}
\addplot[thick, gray] coordinates {@D@}; \addlegendentry{v2 label, true $q=0.60$ (power)}
\end{axis}
\end{tikzpicture}
\caption{Chance that a wallet earns a skill label, by launches traded: v1's ``profitable trader'' rule as implemented (at least 55\% of launches won) for wallets with no skill, and the v2 rule of Section~5.8 for wallets with no skill and with a true win rate of 0.60. Computed by Appendix~B.}
\label{fig:labels}
\end{figure}
""".replace("@A@", coords(ns, v1_40)).replace("@B@", coords(ns, v1_35)).replace("@C@", coords(v2_n, v2_fp)).replace("@D@", coords(v2_n, v2_power))

# Figure 3: the v2 pipeline.
fig3 = r"""\begin{figure}[t]
\centering
\begin{tikzpicture}[every node/.style={font=\small}, box/.style={draw, rounded corners=2pt, align=center, minimum height=11mm, inner sep=4pt, text width=40mm}, arrow/.style={-{Stealth[length=2mm]}}]
\node[box, text width=24mm] (state) at (0,-2.2) {Arc state at a finalized block $h$};
\node[box] (facts) at (4.6,0) {Layer 1: facts by simulation (floor, losses, friction)};
\node[box] (prob) at (4.6,-2.2) {Layer 2: event probabilities, in shadow until the gates pass};
\node[box] (panel) at (4.6,-4.4) {Layer 3: market panel (shown, never an input)};
\node[box, text width=33mm] (record) at (11.6,-1.1) {Forecast record};
\node[box, text width=33mm] (root) at (11.6,-2.9) {Merkle root posted to Arc};
\node[box, text width=33mm] (resolve) at (11.6,-4.7) {Resolution at $h+H$ from chain state};
\node[box, text width=33mm] (board) at (11.6,-6.5) {Scoreboard of committed records};
\draw[arrow] (state.east) -- ++(0.5,0) |- (facts.west);
\draw[arrow] (state.east) -- (prob.west);
\draw[arrow] (state.east) -- ++(0.5,0) |- (panel.west);
\draw[arrow] (facts.east) -- (record.west);
\draw[arrow] ($(prob.east)+(0,0.3)$) -- (record.west);
\draw[arrow] (record) -- (root);
\draw[arrow] (root) -- (resolve);
\draw[arrow] (resolve) -- (board);
\draw[arrow, dashed] (board.west) -- ++(-1.2,0) node[below, font=\footnotesize] {recalibration} |- ($(prob.east)+(0,-0.3)$);
\end{tikzpicture}
\caption{The v2 pipeline. One block feeds three layers; only Layers 1 and 2 enter the record, and the market panel has no path into it. The dashed loop is the only route by which outcomes change later forecasts.}
\label{fig:pipeline}
\end{figure}
"""

for name, body in (("figure-1.tex", fig1), ("figure-2.tex", fig2), ("figure-3.tex", fig3)):
    with open(os.path.join(OUT, name), "w") as handle:
        handle.write(body)

# Figure 4: realised loss by grade, from the empirical results (written by results.py).
results = os.path.join(HERE, "output", "results.json")
if os.path.exists(results):
    data = json.load(open(results))["h4"]["by_grade"]
    bars = " ".join("(%s,%.4f)" % (g, 100 * data[g]["mean_loss"]) for g in "ABCDE" if g in data and data[g]["n"])
    labels = ",".join(g for g in "ABCDE" if g in data and data[g]["n"])
    counts = "; ".join("%s: %d" % (g, data[g]["n"]) for g in "ABCDE" if g in data and data[g]["n"])
    fig4 = r"""\begin{figure}[t]
\centering
\begin{tikzpicture}
\begin{axis}[ybar, width=0.7\linewidth, height=6cm, bar width=14pt, symbolic x coords={@L@}, xtick=data, xlabel={Grade of the floor's lower end at the forecast}, ylabel={Mean realised loss after 24 hours (\%)}, ymin=0, ymax=100, grid=major, grid style={gray!25}, nodes near coords, nodes near coords style={font=\scriptsize}, tick label style={font=\small}, label style={font=\small}]
\addplot[fill=gray!45] coordinates {@B@};
\end{axis}
\end{tikzpicture}
\caption{Mean loss of the 100 USDC reference position 24 hours after the forecast, by grade, over rated retrospective records (H4). Records per grade: @C@. Computed by analysis/results.py from the released dataset.}
\label{fig:grades}
\end{figure}
""".replace("@L@", labels).replace("@B@", bars).replace("@C@", counts)
    with open(os.path.join(OUT, "figure-4.tex"), "w") as handle:
        handle.write(fig4)
print("figures written")
