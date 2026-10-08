"""Scoring rules and calibration measures of Section 7.4, written out so every number can be traced."""
import numpy as np
from scipy import stats


def brier(p, y):
    p, y = np.asarray(p, float), np.asarray(y, float)
    return float(np.mean((p - y) ** 2))


def log_score(p, y, eps=1e-6):
    p, y = np.clip(np.asarray(p, float), eps, 1 - eps), np.asarray(y, float)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def murphy(p, y, bins=10):
    """Murphy (1973): Brier = reliability - resolution + uncertainty, over equal-width probability bins."""
    p, y = np.asarray(p, float), np.asarray(y, float)
    base = y.mean()
    edges = np.linspace(0, 1, bins + 1)
    index = np.clip(np.digitize(p, edges) - 1, 0, bins - 1)
    rel = res = 0.0
    for b in range(bins):
        mask = index == b
        if not mask.any():
            continue
        w = mask.mean()
        rel += w * (p[mask].mean() - y[mask].mean()) ** 2
        res += w * (y[mask].mean() - base) ** 2
    return {"reliability": rel, "resolution": res, "uncertainty": base * (1 - base)}


def calibration(p, y, eps=1e-6):
    """Calibration slope and intercept from a logistic regression of the outcome on logit(p)."""
    p = np.clip(np.asarray(p, float), eps, 1 - eps)
    x = np.log(p / (1 - p))
    y = np.asarray(y, float)
    X = np.column_stack([np.ones_like(x), x])
    beta = np.zeros(2)
    for _ in range(100):
        mu = 1 / (1 + np.exp(-X @ beta))
        W = mu * (1 - mu)
        H = X.T @ (X * W[:, None])
        step = np.linalg.solve(H + 1e-9 * np.eye(2), X.T @ (y - mu))
        beta += step
        if np.abs(step).max() < 1e-10:
            break
    cov = np.linalg.inv(H)
    se = np.sqrt(np.diag(cov))
    return {"intercept": beta[0], "slope": beta[1], "intercept_ci": (beta[0] - 1.96 * se[0], beta[0] + 1.96 * se[0])}


def auc(score, y):
    score, y = np.asarray(score, float), np.asarray(y, int)
    pos, neg = score[y == 1], score[y == 0]
    if not len(pos) or not len(neg):
        return float("nan")
    ranks = stats.rankdata(np.concatenate([pos, neg]))
    return float((ranks[: len(pos)].sum() - len(pos) * (len(pos) + 1) / 2) / (len(pos) * len(neg)))


def pr_auc(score, y):
    order = np.argsort(-np.asarray(score, float))
    y = np.asarray(y, int)[order]
    tp = np.cumsum(y)
    precision = tp / np.arange(1, len(y) + 1)
    return float(np.sum(precision * y) / max(1, y.sum()))


def net_benefit(p, y, thresholds=(0.05, 0.1, 0.2, 0.3, 0.5)):
    """Vickers and Elkin (2006): treat when p >= t; benefit = TP/n - FP/n * t/(1-t)."""
    p, y = np.asarray(p, float), np.asarray(y, int)
    n = len(y)
    return {t: float(((p >= t) & (y == 1)).sum() / n - ((p >= t) & (y == 0)).sum() / n * t / (1 - t)) for t in thresholds}


def isotonic(x, y):
    """Pool-adjacent-violators fit of y on x (non-decreasing); returns a predictor."""
    order = np.argsort(x)
    xs, ys = np.asarray(x, float)[order], np.asarray(y, float)[order]
    blocks = [[v, 1.0, xs[i], xs[i]] for i, v in enumerate(ys)]
    merged = []
    for b in blocks:
        merged.append(b)
        while len(merged) > 1 and merged[-2][0] > merged[-1][0]:
            v2, w2, l2, h2 = merged.pop()
            v1, w1, l1, h1 = merged.pop()
            merged.append([(v1 * w1 + v2 * w2) / (w1 + w2), w1 + w2, l1, h2])
    lows = np.array([m[2] for m in merged])
    values = np.array([m[0] for m in merged])
    return lambda q: values[np.clip(np.searchsorted(lows, np.asarray(q, float), side="right") - 1, 0, len(values) - 1)]


def jonckheere(groups):
    """Jonckheere-Terpstra test for an ordered alternative (increasing across groups); returns z and one-sided p."""
    groups = [np.asarray(g, float) for g in groups if len(g)]
    s = 0.0
    for i in range(len(groups)):
        for j in range(i + 1, len(groups)):
            a, b = groups[i], groups[j]
            s += (b[:, None] > a[None, :]).sum() + 0.5 * (b[:, None] == a[None, :]).sum()
    n = np.array([len(g) for g in groups])
    N = n.sum()
    mean = (N ** 2 - (n ** 2).sum()) / 4
    var = (N ** 2 * (2 * N + 3) - (n ** 2 * (2 * n + 3)).sum()) / 72
    z = (s - mean) / np.sqrt(var)
    return {"statistic": s, "z": z, "p": 1 - stats.norm.cdf(z)}
