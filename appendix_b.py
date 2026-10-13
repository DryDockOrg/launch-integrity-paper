# Reproduces every number computed in the paper other than the empirical results of Section 8, which
# come from analysis/ and the released dataset. Requires Python 3 with numpy and scipy; reads no data.
import numpy as np
from scipy import stats

# --- Section 3, F1 and F3: v1 weights as published, and the normalisation the implementation applied
w = dict(insider=15, top10=10, creator=10, liquidity=15, demand=20, momentum=10, smart=10)
tot = sum(w.values())
print('F1 sum of published weights:', tot)
print('F1 share of attainable needed for the top band if the score were a plain sum: %.1f%%' % (100 * 70 / tot))
# The code (DryDock v1, 1 October 2026) scored points over the points attainable, scaled to 100. Smart money
# counted only when wallet records had loaded, so the attainable total was 80 or 90; on 7 October a
# trading-costs factor (5) was added, giving 85 or 95.
for label, attainable, activity in (('1 Oct, no wallet records', 80, 30), ('1 Oct, wallet records', 90, 40),
                                    ('7 Oct, no wallet records', 85, 30), ('7 Oct, wallet records', 95, 40)):
    print('F1 %s: attainable %d, top band needs 70%% of it; F3 activity share %.1f%%' % (label, attainable, 100 * activity / attainable))

# --- Section 3, F5 and Section 9: the worked example under v1's real rule
def scale(v, bad, good):
    return min(1, max(0, (v - bad) / (good - bad)))
def v1_points(insider, top10, version):
    # Linear between endpoints (verified in the code); holders >= 25 so the 7 October breadth discount is 1.
    p = 15 * scale(insider, .30, .03) + 10 * scale(top10, .50, .15)
    p += 10                                   # creator: an earlier launch reached $100k
    p += 10 * scale(np.log10(25000), np.log10(500), np.log10(25000)) + 5   # depth 25k USDC; custody held by the launchpad
    p += 10 + 5 + 5                           # buyers >= 30, buy pressure >= 65%, organic volume
    p += 10                                   # momentum at full marks
    p += 10                                   # smart money: three winning wallets holding, no snipers
    attainable = 90
    if version == '7 Oct':
        p += 5                                # trading costs: 1% pool fee each way plus the 0.5% swap fee, under 3%
        attainable = 95
    return p, attainable
for version in ('1 Oct', '7 Oct'):
    for ins in (0.08, 0.20):
        p, a = v1_points(ins, .30, version)
        print('F5 v1 (%s) with measured insider share %.0f%%: %.2f of %d points, score %d' % (version, 100 * ins, p, a, round(100 * p / a)))
# F7: the cliff at the 30% insider cap (1 October code, wallet records loaded)
for ins in (0.299, 0.301):
    p, a = v1_points(ins, .30, '1 Oct')
    print('F7 insider share %.1f%%: score %d' % (100 * ins, 30 if ins > .30 else round(100 * p / a)))
# What the first version of the paper computed by assuming a plain sum of the published weights:
lin = lambda v, full, zero, pts: pts * min(1, max(0, (zero - v) / (zero - full)))
for ins in (0.08, 0.20):
    print('F5 plain-sum reading of the published page, insider share %.0f%%: %.1f'
          % (100 * ins, lin(ins, .03, .30, 15) + lin(.30, .15, .50, 10) + 10 + 15 + 20 + 10 + 10))

# --- Section 3, F6 (Proposition 1): constant-product exit impact
for g in (.10, .20, .40):
    for f in (.15, .20, .30):
        print('P1 g=%.2f f=%.2f price drop %.0f%%, quote drained %.0f%%'
              % (g, f, 100 * (1 - (g / (g + f)) ** 2), 100 * f / (g + f)))
    print('P1 g=%.2f insider share giving an 80%% drop: %.1f%%' % (g, 100 * g * (1 / np.sqrt(.2) - 1)))

# --- Section 3, F11: v1's "profitable trader" label under a no-skill null. The code required at least 55%
# of launches won (P&L marked to the current price) and more than $10 ahead; the page said "more than half".
ns = (5, 10, 15, 20, 30, 40, 50)
for q in (.30, .35, .40):
    print('F11 page rule q=%.2f' % q, ['n=%d: %.3f' % (n, stats.binom.sf(n // 2, n, q)) for n in ns])
    print('F11 code rule q=%.2f' % q, ['n=%d: %.3f' % (n, stats.binom.sf(int(np.ceil(.55 * n)) - 1, n, q)) for n in ns])

# --- Section 5.8: shrinkage rule, Beta prior mean .35 weight 20, label iff P(q > .40 | data) > .95
q0, m = .35, 20
for n in ns:
    k = np.arange(n + 1)
    ok = k[stats.beta.sf(q0 + .05, q0 * m + k, (1 - q0) * m + n - k) > .95]
    if len(ok) == 0:
        print('S5.8 n=%d: cannot qualify' % n)
        continue
    kmin = ok.min()
    print('S5.8 n=%d: needs %d wins; false positive %.4f; power at q=.60 %.3f'
          % (n, kmin, stats.binom.sf(kmin - 1, n, q0), stats.binom.sf(kmin - 1, n, .6)))

# --- Section 9.2: v2 facts for the stylised example (constant product, fee retained in the pool)
x0, g, phi, B, S = 25000.0, 0.10, 0.01, 100.0, 1e9
def buy(x, y, usd):
    a = usd * (1 - phi); out = y * a / (x + a); return out, x + usd, y - out
def sell(x, y, tok):
    a = tok * (1 - phi); out = x * a / (y + a); return out, x - out, y + tok
q, x1, y1 = buy(x0, g * S, B)
rho0 = sell(x1, y1, q)[0]
print('S9.2 friction: 100 USDC returns %.1f' % rho0)
for name, f in (('lower-bound set, 8%', .08), ('pessimistic set, 20%', .20)):
    got, x2, y2 = sell(x1, y1, f * S)
    r = sell(x2, y2, q)[0]
    print('S9.2 insider exit as one block, %s: insiders take %.0f USDC (%.0f%% of pool); reference returns %.1f; loss %.1f%%'
          % (name, got, 100 * got / x1, r, 100 - r))
    # Integrity Score as amended (Section 5.5): friction once, and before any outcomes the loss given event is the
    # simulated worst case net of friction, 1 - r / rho0.
    for pi in (.10, .30, .60):
        print('   assumed pi=%.2f -> Integrity Score %.0f' % (pi, rho0 * (1 - pi * (1 - r / rho0))))
# Appendix A.2 sells address by address, largest first. With the split of Section 9.2 (creator 4%, two
# launch-block buyers 2% each; six fresh wallets 2% each) and fees retained in the pool:
for name, parts in (('lower-bound set', [.04, .02, .02]), ('pessimistic set', [.04, .02, .02] + [.02] * 6)):
    x, y = x1, y1
    for f in sorted(parts, reverse=True):
        _, x, y = sell(x, y, f * S)
    print('S9.2 insider exit address by address, %s: reference returns %.2f' % (name, sell(x, y, q)[0]))
# Uniswap V3 and V4 keep fees outside active liquidity; with fees outside the pool the same example gives:
def sell_ext(x, y, tok):
    a = tok * (1 - phi); out = x * a / (y + a); return out, x - out, y + a
def buy_ext(x, y, usd):
    a = usd * (1 - phi); out = y * a / (x + a); return out, x + a, y - out
q2, xa, ya = buy_ext(x0, g * S, B)
print('S9.2 fees outside the pool: friction %.1f' % sell_ext(xa, ya, q2)[0])
for f in (.08, .20):
    _, xb, yb = sell_ext(xa, ya, f * S)
    print('S9.2 fees outside the pool, exit of %.0f%%: reference returns %.1f' % (100 * f, sell_ext(xb, yb, q2)[0]))

# --- Section 7.5: sample sizes
z = stats.norm.ppf(.975)
for p in (.5, .9):
    print('S7.5 bin rate %.1f to within 5 points: n=%d' % (p, int(np.ceil(z * z * p * (1 - p) / .05 ** 2))))
def se_auc(A, n1, n0):  # Hanley and McNeil (1982)
    Q1, Q2 = A / (2 - A), 2 * A * A / (1 + A)
    return np.sqrt((A * (1 - A) + (n1 - 1) * (Q1 - A * A) + (n0 - 1) * (Q2 - A * A)) / (n1 * n0))
for N in (500, 2000):
    print('S7.5 AUC 0.75, N=%d, prevalence 0.2: 95%% half-width %.3f' % (N, z * se_auc(.75, int(.2 * N), N - int(.2 * N))))

# --- Section 6.3: cost of an aged-wallet farm (gaming class (d), audit finding M1). A wallet passes the history
# margin with at least one transaction 30 days before the token's creation and at least ten before it, so each
# farm wallet needs ten transactions it sends itself. Gas price observed on Arc on 13 October 2026 (eth_gasPrice).
GAS_PRICE_GWEI, TRANSFER_GAS = 20, 21_000
per_tx = TRANSFER_GAS * GAS_PRICE_GWEI * 1e9 / 1e18  # USDC (Arc's gas token, 18 decimals)
for wallets in (100, 1000):
    print('S6.3 aged-wallet farm of %d wallets: %d transactions, %.2f USDC of gas, ready 30 days after its first transaction'
          % (wallets, 10 * wallets, 10 * wallets * per_tx))
