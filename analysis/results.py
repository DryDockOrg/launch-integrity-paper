"""Every empirical number in Section 8 of the paper. Reads the released dataset (data/records.csv.gz and
data/launches.csv.gz, written by dataset.py) and writes output/results.json and output/results.txt.

    python analysis/results.py
"""
import json
import os
import numpy as np
import pandas as pd
from metrics import auc, brier, calibration, jonckheere, log_score, murphy, net_benefit, pr_auc

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
OUT = os.path.join(HERE, "output")
os.makedirs(OUT, exist_ok=True)

GATES = {"resolved": 2000, "clusters": 500, "events": 100}
GRADES = list("ABCDE")
LANDMARKS = {60: "1 min", 600: "10 min", 3600: "1 h", 21600: "6 h", 86400: "24 h"}

launches = pd.read_csv(os.path.join(DATA, "launches.csv.gz"))
records = pd.read_csv(os.path.join(DATA, "records.csv.gz"))
lines = []
say = lambda text: (lines.append(text), print(text))
results = {}

# --- Population
pop = launches.groupby("launchpad").agg(launches=("token", "size"), traded=("traded", "sum")).reset_index()
results["population"] = {row.launchpad: {"launches": int(row.launches), "traded": int(row.traded)} for row in pop.itertuples()}
results["population_total"] = {"launches": int(len(launches)), "traded": int(launches.traded.sum()), "first_block": int(launches.block.min()), "last_block": int(launches.block.max())}
say("Launches %d, traded %d" % (len(launches), launches.traded.sum()))
for row in pop.itertuples():
    say("  %-8s launches %6d traded %6d" % (row.launchpad, row.launches, row.traded))

# --- Records by landmark and state
valid = records[records.landmark >= 0].copy()
valid["resolved"] = valid.recovery_at_horizon.notna()
states = valid.groupby(["landmark", "state"]).size().unstack(fill_value=0)
results["states"] = {LANDMARKS[int(k)]: {s: int(v) for s, v in row.items()} for k, row in states.iterrows()}
say("Records %d (launches with records %d); failed launches %d" % (len(valid), valid.token.nunique(), int((records.landmark < 0).sum())))
for k, row in states.iterrows():
    say("  %-6s %s" % (LANDMARKS[int(k)], ", ".join("%s %d" % (s, v) for s, v in row.items())))
reasons = valid[valid.state != "rated"].state_reason.fillna("").str.replace(r"\d+", "N", regex=True).value_counts().head(8)
results["abstention_reasons"] = {k: int(v) for k, v in reasons.items()}

# --- Insider sets on a young chain (Section 5.3's named risk)
rated = valid[valid.state == "rated"]
if len(valid):
    share = (valid.pessimistic_count / valid.holders.clip(lower=1)).clip(upper=1)
    results["pessimistic_share_of_holders"] = {"median": float(share.median()), "mean": float(share.mean()), "share_of_records_all_holders": float((share >= 0.999).mean())}
    hist = valid.history_pass_share.dropna()
    results["history_pass_share"] = {"median": float(hist.median()) if len(hist) else None, "mean": float(hist.mean()) if len(hist) else None}
    say("Pessimistic set as share of holders: median %.3f, mean %.3f; records where it holds every holder %.3f" % (share.median(), share.mean(), (share >= 0.999).mean()))

# --- Grade distribution by launchpad (Objection 2)
grade_dist = rated.groupby(["launchpad", "grade"]).size().unstack(fill_value=0)
results["grade_distribution"] = {pad: {g: int(row.get(g, 0)) for g in GRADES} for pad, row in grade_dist.iterrows()}
for pad, row in grade_dist.iterrows():
    total = row.sum()
    say("  grades %-8s %s" % (pad, " ".join("%s %d (%.0f%%)" % (g, row.get(g, 0), 100 * row.get(g, 0) / total) for g in GRADES)))

# --- H1: severity. Realised recovery at an event against the recovery the last prior record gave for it.
h1 = {}
for channel, predicted in (("I", "recovery_IPessimistic"), ("L", "recovery_L"), ("T", "recovery_T")):
    fired = rated[rated["fired_" + channel] == True]  # noqa: E712
    # Last prior forecast per token: the latest rated record whose block precedes the event block.
    fired = fired[fired["block"] < fired["event_block_" + channel]]
    last = fired.sort_values("block").groupby("token").tail(1)
    diff = (last["realised_" + channel] - last[predicted]).dropna()
    h1[channel] = {"events": int(len(last)), "mean_abs_error": float(diff.abs().mean()) if len(diff) else None, "mean_error": float(diff.mean()) if len(diff) else None,
                   "median_abs_error": float(diff.abs().median()) if len(diff) else None, "passes": bool(len(diff) and diff.abs().mean() <= 10)}
    if channel == "I":
        alt = (last["realised_I"] - last["recovery_ILower"]).dropna()
        h1[channel]["mean_abs_error_vs_lower_bound"] = float(alt.abs().mean()) if len(alt) else None
results["h1"] = h1
for channel, row in h1.items():
    say("H1 %s: events %d, mean |realised - predicted| %s, passes %s" % (channel, row["events"], None if row["mean_abs_error"] is None else round(row["mean_abs_error"], 2), row["passes"]))

# --- H4: grades order realised loss, over resolved rated records (all landmarks, and per landmark)
res = rated[rated.resolved].copy()
res["loss"] = 1 - res.recovery_at_horizon.clip(upper=100) / 100
by_grade = {g: {"n": int((res.grade == g).sum()), "mean_loss": float(res.loss[res.grade == g].mean()) if (res.grade == g).any() else None,
                "severe": float(res.severe_loss[res.grade == g].mean()) if (res.grade == g).any() else None} for g in GRADES}
present = [g for g in GRADES if by_grade[g]["n"]]
means = [by_grade[g]["mean_loss"] for g in present]
monotone = all(a <= b for a, b in zip(means, means[1:]))
jt = jonckheere([res.loss[res.grade == g].values for g in present]) if len(present) > 1 else None
per_landmark = {}
for k, group in res.groupby("landmark"):
    m = [group.loss[group.grade == g].mean() for g in GRADES if (group.grade == g).any()]
    per_landmark[LANDMARKS[int(k)]] = {"n": int(len(group)), "means": {g: float(group.loss[group.grade == g].mean()) for g in GRADES if (group.grade == g).any()}, "monotone": all(a <= b for a, b in zip(m, m[1:]))}
results["h4"] = {"by_grade": by_grade, "grades_present": present, "monotone": monotone, "jonckheere": jt, "per_landmark": per_landmark, "passes": bool(monotone and len(present) >= 2)}
say("H4: " + ", ".join("%s n=%d loss=%.3f" % (g, by_grade[g]["n"], by_grade[g]["mean_loss"]) for g in present) + "; monotone %s" % monotone)
if jt:
    say("    Jonckheere-Terpstra z=%.2f p=%.4g" % (jt["z"], jt["p"]))

# --- Gate counts (Section 7.5), retrospective
events = {c: int(rated["fired_" + c].fillna(False).astype(bool).sum()) for c in "TLI"}
gates = {"resolved": int(valid.resolved.sum()), "resolved_rated": int(res.shape[0]), "creators": int(valid.creator.nunique()), "events": events}
gates["met"] = bool(gates["resolved"] >= GATES["resolved"] and gates["creators"] >= GATES["clusters"] and min(events.values()) >= GATES["events"])
results["gates"] = gates
say("Gates: resolved %d (rated %d), creators %d, events %s, met %s" % (gates["resolved"], gates["resolved_rated"], gates["creators"], events, gates["met"]))

# --- Baseline B0 and v1 (B1) for the insider channel, as descriptive comparisons only: the gates of Section 7.5
# are not met, so no channel model is fitted and H2, H3 and H6 are not tested (Section 8.4).
b0 = {}
y = res["fired_I"].fillna(False).astype(int).values
if len(res) >= 50 and y.sum() and (1 - y).sum():
    res_sorted = res.sort_values("block")
    cut = int(len(res_sorted) * 0.6)
    train, test = res_sorted.iloc[:cut], res_sorted.iloc[cut:]
    # Embargo: drop test records within one horizon of the last training forecast, and creators seen in training.
    test = test[(test.ts > train.ts.max() + 86400) & (~test.creator.isin(set(train.creator)))]
    if len(test) >= 20:
        freq = train.groupby(["launchpad", "landmark"])["fired_I"].mean()
        overall = train["fired_I"].astype(float).mean()
        p0 = np.array([freq.get((r.launchpad, r.landmark), overall) for r in test.itertuples()], float)
        yt = test["fired_I"].fillna(False).astype(int).values
        b0 = {"train": int(len(train)), "test": int(len(test)), "events_test": int(yt.sum()), "brier": brier(p0, yt), "log": log_score(p0, yt), "murphy": murphy(p0, yt)}
        if "v1_score_1007" in test and test.v1_score_1007.notna().any():
            # B1: v1 score mapped to probability by isotonic regression on the training fold.
            from metrics import isotonic
            tr = train.dropna(subset=["v1_score_1007"])
            fit = isotonic(-tr.v1_score_1007.values, tr["fired_I"].fillna(False).astype(float).values)
            te = test.dropna(subset=["v1_score_1007"])
            p1 = np.clip(fit(-te.v1_score_1007.values), 1e-3, 1 - 1e-3)
            y1 = te["fired_I"].fillna(False).astype(int).values
            b0["b1"] = {"n": int(len(te)), "brier": brier(p1, y1), "log": log_score(p1, y1), "auc": auc(-te.v1_score_1007.values, y1), "pr_auc": pr_auc(-te.v1_score_1007.values, y1)}
            b0["auc_floor_low"] = auc(-te.floor_low.values, y1)
results["baselines_descriptive"] = b0
if b0:
    say("B0 (insider exit, out of time, %d test records, %d events): Brier %.4f" % (b0["test"], b0["events_test"], b0["brier"]))
    if "b1" in b0:
        say("B1 v1 isotonic: Brier %.4f, AUC %.3f; floor lower end AUC %.3f" % (b0["b1"]["brier"], b0["b1"]["auc"], b0["auc_floor_low"]))

# --- Severe loss overall, for the market panel's reference line
results["severe_loss_rate"] = {LANDMARKS[int(k)]: float(g.severe_loss.mean()) for k, g in valid[valid.resolved].groupby("landmark")}

with open(os.path.join(OUT, "results.json"), "w") as handle:
    json.dump(results, handle, indent=2, default=float)
with open(os.path.join(OUT, "results.txt"), "w") as handle:
    handle.write("\n".join(lines) + "\n")
