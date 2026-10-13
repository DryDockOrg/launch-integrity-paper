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

# --- Exploratory (not pre-registered): H4 net of trading costs. The floor and the realised loss both include the
# round-trip cost of the reference position, so part of the ordering is mechanical; this removes it by measuring
# the horizon recovery against the friction recovery of the same record.
net = res.dropna(subset=["friction"]).copy()
net = net[net.friction > 0]
net["loss_net"] = 1 - (net.recovery_at_horizon / net.friction).clip(upper=1)
by_grade_net = {g: {"n": int((net.grade == g).sum()), "mean_loss_net": float(net.loss_net[net.grade == g].mean()) if (net.grade == g).any() else None,
                    "mean_friction": float(net.friction[net.grade == g].mean()) if (net.grade == g).any() else None} for g in GRADES}
m_net = [by_grade_net[g]["mean_loss_net"] for g in GRADES if by_grade_net[g]["n"]]
results["h4_net_of_friction_exploratory"] = {"by_grade": by_grade_net, "monotone": all(a <= b for a, b in zip(m_net, m_net[1:]))}
say("H4 net of friction (exploratory): " + ", ".join("%s %.3f (friction %.1f)" % (g, by_grade_net[g]["mean_loss_net"], by_grade_net[g]["mean_friction"]) for g in GRADES if by_grade_net[g]["n"]))

# --- Exploratory (not pre-registered): H1's event measure compares value just before and at the block in which
# the event crosses its threshold, which captures only the last part of a gradual exit. For the same records,
# the insider-exit recovery at the last prior forecast against the recovery at the horizon.
fired_i = rated[(rated.fired_I == True) & (rated.block < rated.event_block_I)].sort_values("block").groupby("token").tail(1)  # noqa: E712
alt = (fired_i.recovery_at_horizon - fired_i.recovery_IPessimistic).dropna()
alt_low = (fired_i.recovery_at_horizon - fired_i.recovery_ILower).dropna()
results["h1_horizon_exploratory"] = {"events": int(len(alt)), "mean_abs_error": float(alt.abs().mean()) if len(alt) else None, "mean_error": float(alt.mean()) if len(alt) else None,
                                     "median_abs_error": float(alt.abs().median()) if len(alt) else None, "mean_abs_error_vs_lower_bound": float(alt_low.abs().mean()) if len(alt_low) else None,
                                     "share_horizon_below_pessimistic": float((alt < 0).mean()) if len(alt) else None}
say("H1 at the horizon (exploratory): events %d, mean |horizon - pessimistic| %.2f, mean signed %.2f, median |.| %.2f" % (len(alt), alt.abs().mean(), alt.mean(), alt.abs().median()))

# --- Why records abstain: holders at h of too-early records, and unobservable records by launchpad (24 h landmark)
day = valid[valid.landmark == 86400]
early = day[day.state == "too_early"]
results["too_early_24h"] = {"records": int(len(early)), "holders_under_10": int((early.holders < 10).sum()), "holders_zero": int((early.holders == 0).sum()),
                            "by_launchpad": {pad: {"records": int(len(g)), "holders_under_10": int((g.holders < 10).sum()), "holders_zero": int((g.holders == 0).sum())} for pad, g in early.groupby("launchpad")}}
results["unobservable_24h"] = {pad: int(n) for pad, n in day[day.state == "unobservable"].groupby("launchpad").size().items()}
results["rated_24h"] = {pad: int(n) for pad, n in day[day.state == "rated"].groupby("launchpad").size().items()}
say("Too early at 24 h: %d records, %d with under 10 holders, %d with none" % (len(early), (early.holders < 10).sum(), (early.holders == 0).sum()))

# --- Worked example (Section 9): the first rated 1-hour record, by forecast block, of a launch whose insider-exit
# event fired before its horizon and whose floor is an interval (lower and upper bounds differ).
pick = res[(res.landmark == 3600) & (res.fired_I == True) & (res.floor_high - res.floor_low > 1)].sort_values("block")  # noqa: E712
if len(pick):
    row = pick.iloc[0]
    keys = ["token", "launchpad", "landmark", "block", "ts", "grade", "friction", "depth", "recovery_T", "recovery_L", "recovery_ILower", "recovery_IPessimistic",
            "floor_low", "floor_high", "holders", "lower_count", "pessimistic_count", "entities_outside_lower", "lower_take_usdc", "pessimistic_take_usdc",
            "recovery_at_horizon", "severe_loss", "insider_outflow", "liquidity_withdrawn", "event_block_I", "realised_I", "v1_score_1001", "v1_score_1007", "flags", "token_template", "hook_template"]
    results["example"] = {k: (row[k].item() if hasattr(row[k], "item") else row[k]) for k in keys if k in row and not (isinstance(row[k], float) and np.isnan(row[k]))}
    say("Example: %s (%s) at block %d, grade %s, floor %.2f to %.2f, realised at horizon %.2f" % (row.token, row.launchpad, row.block, row.grade, row.floor_low, row.floor_high, row.recovery_at_horizon))

# --- Gate counts (Section 7.5), retrospective
events = {c: int(rated["fired_" + c].fillna(False).astype(bool).sum()) for c in "TLI"}
gates = {"resolved": int(valid.resolved.sum()), "resolved_rated": int(res.shape[0]), "creators": int(valid[valid.resolved].creator.nunique()), "creators_all_records": int(valid.creator.nunique()), "events": events}
gates["met"] = bool(gates["resolved"] >= GATES["resolved"] and gates["creators"] >= GATES["clusters"] and min(events.values()) >= GATES["events"])
results["gates"] = gates
say("Gates: resolved %d (rated %d), creators %d, events %s, met %s" % (gates["resolved"], gates["resolved_rated"], gates["creators"], events, gates["met"]))

# --- Baseline B0 and v1 (B1) for the insider channel, as descriptive comparisons only. Whether a channel model may
# be fitted (and H2, H3 and H6 tested) depends on the gates of Section 7.5, computed above as `gates["met"]`.
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

# --- Audit of 13 October 2026 (Section 8.4 and Appendix D): what H4 can and cannot show, H1's comparators, clustering.
from scipy import stats as sstats
rng = np.random.default_rng(20261013)


def rho(x, y):
    keep = ~(np.isnan(x) | np.isnan(y))
    return float(sstats.spearmanr(x[keep], y[keep]).statistic) if keep.sum() > 2 else None


def cluster_ci(frame, fx, fy, reps=2000):
    """Spearman correlation with a 95% interval from a bootstrap that resamples creators (Section 7.4 clustering)."""
    groups = [g for _, g in frame.groupby("creator")]
    point = rho(fx(frame), fy(frame))
    draws = []
    for _ in range(reps):
        sample = pd.concat([groups[i] for i in rng.integers(0, len(groups), len(groups))])
        value = rho(fx(sample), fy(sample))
        if value is not None:
            draws.append(value)
    return {"rho": point, "lo": float(np.percentile(draws, 2.5)), "hi": float(np.percentile(draws, 97.5)), "clusters": len(groups), "records": int(len(frame))}


realised = lambda f: f.recovery_at_horizon.to_numpy(float)
audit = {}
gap = res.recovery_at_horizon - res.floor_low  # realised recovery minus the floor's lower end, USDC per 100
audit["bound_breach"] = {"records": int((gap < -0.5).sum()), "of": int(len(res)), "rate": float((gap < -0.5).mean()), "tolerance": 0.5,
                         "below_at_all": int((gap < 0).sum()), "below_by_more_than_0_1": int((gap < -0.1).sum()),
                         "by_grade": {g: float((grp.recovery_at_horizon - grp.floor_low < -0.5).mean()) for g, grp in res.groupby("grade")}}
audit["floor_low_is_pessimistic_exit"] = float(np.isclose(res.floor_low, res.recovery_IPessimistic, atol=1e-6).mean())
audit["T_L_equal_friction"] = float((np.isclose(res.recovery_T, res.friction, atol=1e-6) & np.isclose(res.recovery_L, res.friction, atol=1e-6)).mean())
audit["median_holders_by_grade"] = {g: float(grp.holders.median()) for g, grp in res.groupby("grade")}
audit["predictors_of_horizon_recovery"] = {
    "floor_low": cluster_ci(res, lambda f: f.floor_low.to_numpy(float), realised),
    "B4_pessimistic_supply_share": cluster_ci(res, lambda f: f.pessimistic_supply_share.to_numpy(float), realised),
    "B5_price_multiple_since_first_trade": cluster_ci(res, lambda f: f.price_multiple.to_numpy(float), realised),
    "pessimistic_take_usdc": cluster_ci(res, lambda f: f.pessimistic_take_usdc.to_numpy(float), realised),
    "v1_score_1007": cluster_ci(res, lambda f: f.v1_score_1007.to_numpy(float), realised),
}
grade_rank = {g: i for i, g in enumerate(GRADES)}
audit["h4_grade_rank_clustered"] = cluster_ci(res, lambda f: f.grade.map(grade_rank).to_numpy(float), lambda f: f.loss.to_numpy(float))
audit["v1_mean_by_grade"] = {g: float(grp.v1_score_1007.mean()) for g, grp in res.groupby("grade")}
audit["rated_launches"] = int(res.token.nunique()); audit["rated_creators"] = int(res.creator.nunique())
audit["rated_by_launchpad"] = {pad: {"records": int(len(g)), "launches": int(g.token.nunique())} for pad, g in res.groupby("launchpad")}
audit["insider_events_launches"] = int(res[res.fired_I == True].token.nunique())  # noqa: E712
# H1's comparators, on the same 70 launches as the pre-registered test (event measure, and horizon measure)
fi = fired_i.copy()
comparators = {"constant_99": lambda f: np.full(len(f), 99.0), "friction": lambda f: f.friction.to_numpy(float),
               "lower_bound_exit": lambda f: f.recovery_ILower.to_numpy(float), "pessimistic_exit": lambda f: f.recovery_IPessimistic.to_numpy(float)}
audit["h1_comparators"] = {name: {"event_mae": float(np.nanmean(np.abs(fi.realised_I.to_numpy(float) - fn(fi)))), "horizon_mae": float(np.nanmean(np.abs(fi.recovery_at_horizon.to_numpy(float) - fn(fi))))} for name, fn in comparators.items()}
audit["h1_event_measure_median"] = float(fi.realised_I.median()); audit["h1_min_error"] = float((fi.realised_I - fi.recovery_IPessimistic).min())
audit["h1_median_outflow"] = float(fi.insider_outflow.median()); audit["h1_grade_counts"] = {g: int(n) for g, n in fi.grade.value_counts().items()}


def cluster_diff(frame, stat, reps=2000):
    """A statistic of a frame with a 95% interval from a bootstrap that resamples creators."""
    groups = [g for _, g in frame.groupby("creator")]
    draws = [stat(pd.concat([groups[i] for i in rng.integers(0, len(groups), len(groups))])) for _ in range(reps)]
    return {"value": float(stat(frame)), "lo": float(np.nanpercentile(draws, 2.5)), "hi": float(np.nanpercentile(draws, 97.5))}


# Exploratory on the retrospective records (registered as H1' and H4' for committed records, Section 7.9)
mae = lambda f, col: np.nanmean(np.abs(f.recovery_at_horizon.to_numpy(float) - f[col].to_numpy(float)))
audit["h1_prime_exploratory"] = cluster_diff(fi, lambda f: mae(f, "friction") - mae(f, "recovery_IPessimistic"))
audit["h1_prime_exploratory"].update({"pessimistic_mae": float(mae(fi, "recovery_IPessimistic")), "friction_mae": float(mae(fi, "friction"))})
audit["h4_prime_exploratory"] = cluster_diff(res, lambda f: rho(f.floor_low.to_numpy(float), realised(f)) - abs(rho(f.price_multiple.to_numpy(float), realised(f))))
results["audit"] = audit
say("Audit: below the floor by more than 0.5 point %d of %d (%.1f%%); floor_low = pessimistic exit in %.0f%%; Spearman with horizon recovery: floor %.2f, B4 %.2f, B5 %.2f, take %.2f, v1 %.2f" % (
    audit["bound_breach"]["records"], audit["bound_breach"]["of"], 100 * audit["bound_breach"]["rate"], 100 * audit["floor_low_is_pessimistic_exit"],
    *(audit["predictors_of_horizon_recovery"][k]["rho"] for k in ("floor_low", "B4_pessimistic_supply_share", "B5_price_multiple_since_first_trade", "pessimistic_take_usdc", "v1_score_1007"))))

# Method versions on the same rated records (Appendix D): 2.0.2 before D13's fix, 2.1.0 with parked liquidity counted
mv_path = os.path.join(DATA, "method-versions.csv.gz")
if os.path.exists(mv_path):
    mv = pd.read_csv(mv_path)
    base = res[["token", "landmark", "grade", "floor_low", "recovery_at_horizon"]].rename(columns={"grade": "grade_203", "floor_low": "floor_203", "recovery_at_horizon": "horizon_203"})
    out = {}
    for version, g in mv.groupby("version"):
        g = g.merge(base, on=["token", "landmark"], how="inner")
        rated_v = g[g.state == "rated"].dropna(subset=["recovery_at_horizon"]).copy()
        rated_v["loss"] = 1 - rated_v.recovery_at_horizon.clip(upper=100) / 100
        means = {gr: float(rated_v.loss[rated_v.grade == gr].mean()) for gr in GRADES if (rated_v.grade == gr).any()}
        m = [means[gr] for gr in GRADES if gr in means]
        out[version] = {"records": int(len(g)), "rated": int(len(rated_v)), "errors": int(g.error.notna().sum()), "mean_loss_by_grade": means,
                        "n_by_grade": {gr: int((rated_v.grade == gr).sum()) for gr in GRADES}, "monotone": all(a <= b for a, b in zip(m, m[1:])),
                        "floor_changed_vs_203": int((~np.isclose(g.floor_low.astype(float), g.floor_203.astype(float), atol=0.01)).sum()),
                        "grade_changed_vs_203": int((g.grade != g.grade_203).sum())}
    results["method_versions"] = out
    for version, o in out.items():
        say("Method %s on the rated records: %d rated, floors changed %d, grades changed %d, losses by grade %s, monotone %s" % (version, o["rated"], o["floor_changed_vs_203"], o["grade_changed_vs_203"],
            ", ".join("%s %.3f" % (k, v) for k, v in o["mean_loss_by_grade"].items()), o["monotone"]))

# --- The committed record (Section 8.6): records issued live and batched for the ledger, as the API publishes them
committed_path = os.path.join(DATA, "committed.csv.gz")
committed = pd.read_csv(committed_path) if os.path.getsize(committed_path) > 64 else pd.DataFrame()
if len(committed):
    states_live = committed.state.value_counts()
    results["committed"] = {"records": int(len(committed)), "batches": int(committed.batch.nunique()), "first_block": int(committed.block.min()), "last_block": int(committed.block.max()),
                            "states": {k: int(v) for k, v in states_live.items()}, "rated_share": float((committed.state == "rated").mean()),
                            "roots_on_chain": int(committed.drop_duplicates("batch").tx.notna().sum()),
                            "in_deadline": int(((committed.committed_block.notna()) & (committed.committed_block <= committed.block + 1200)).sum()),
                            "launches": int(committed.token.nunique()), "backfill_rated_share": float((valid.state == "rated").mean()),
                            "unobservable_share": float((committed.state == "unobservable").mean()), "backfill_unobservable_share": float((valid.state == "unobservable").mean()),
                            "launchpad_share": {k: float(v) for k, v in committed.drop_duplicates("token").launchpad.value_counts(normalize=True).items()}}
    say("Committed record: %d records in %d batches, %d roots on chain, %d within the deadline; rated %.2f%% (backfill %.2f%%)" % (
        len(committed), committed.batch.nunique(), results["committed"]["roots_on_chain"], results["committed"]["in_deadline"], 100 * results["committed"]["rated_share"], 100 * results["committed"]["backfill_rated_share"]))

with open(os.path.join(OUT, "results.json"), "w") as handle:
    json.dump(results, handle, indent=2, default=float)
with open(os.path.join(OUT, "results.txt"), "w") as handle:
    handle.write("\n".join(lines) + "\n")
