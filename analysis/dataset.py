"""Builds the released dataset from the backfill store (DryDock's scripts/integrity/backfill) and the
committed records published by the API: data/launches.csv.gz, data/records.csv.gz, data/committed.csv.gz.

    python analysis/dataset.py <path to backfill.sqlite> [<path to launches.json>]
"""
import json
import os
import sqlite3
import sys
import urllib.request
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")
os.makedirs(DATA, exist_ok=True)
store = sys.argv[1]
launches_json = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(store), "launches.json")
con = sqlite3.connect(store)

launches = pd.DataFrame(json.load(open(launches_json)))
cached = con.execute("SELECT v FROM kv WHERE k = 'first_trades'").fetchone()
if cached:
    first = pd.DataFrame(json.loads(cached[0]), columns=["pool", "first_trade"])
else:
    first = pd.read_sql_query("SELECT key AS pool, MIN(block) AS first_trade FROM logs WHERE kind = 'pool' AND substr(topics, 3, 66) IN "
                              "('0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67', '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f') GROUP BY key", con)
launches["pool"] = launches.pool.str.lower()
launches = launches.merge(first, on="pool", how="left")
launches["traded"] = launches.first_trade.notna()
launches[["token", "launchpad", "creator", "protocol", "pool", "fee", "hooks", "block", "tx", "symbol", "first_trade", "traded"]].to_csv(os.path.join(DATA, "launches.csv.gz"), index=False)

supply_of = {row["token"]: int(row["supply"]) for row in json.load(open(launches_json))}
prices = {}
if con.execute("SELECT 1 FROM sqlite_master WHERE name = 'record_prices'").fetchone():
    prices = {(t, l): m for t, l, m in con.execute("SELECT token, landmark, multiple FROM record_prices")}
rows = []
for token, landmark, launchpad, creator, block, ts, state, grade, leaf, record, facts, resolution, v1, error in con.execute(
        "SELECT token, landmark, launchpad, creator, block, ts, state, grade, leaf, record, facts, resolution, v1, error FROM records"):
    f = json.loads(facts) if facts else {}
    r = json.loads(resolution) if resolution else {}
    v = json.loads(v1) if v1 else {}
    ins = f.get("insiders", {})
    rec = f.get("recovery", {}) or {}
    row = {
        "token": token, "landmark": landmark, "launchpad": launchpad, "creator": creator, "block": block, "ts": ts, "state": state, "grade": grade, "leaf": leaf,
        "state_reason": f.get("stateReason"), "friction": f.get("friction"), "depth": f.get("depth"),
        "recovery_T": rec.get("T"), "recovery_L": rec.get("L"), "recovery_ILower": rec.get("ILower"), "recovery_IPessimistic": rec.get("IPessimistic"),
        "floor_low": (f.get("floor") or {}).get("low"), "floor_high": (f.get("floor") or {}).get("high"),
        "holders": ins.get("holders"), "lower_count": ins.get("lowerCount"), "pessimistic_count": ins.get("pessimisticCount"), "entities_outside_lower": ins.get("entitiesOutsideLower"),
        "lower_take_usdc": ins.get("lowerTakeUsdc"), "pessimistic_take_usdc": ins.get("pessimisticTakeUsdc"),
        "history_pass_share": (f.get("historyPassed", 0) / f["holdersAtH"]) if f.get("holdersAtH") else None,
        "withdrawable_positions": (f.get("liquidity") or {}).get("withdrawable"), "flags": ";".join(f.get("flags", [])),
        "token_template": (f.get("template") or {}).get("tokenTemplate"), "hook_template": (f.get("template") or {}).get("hookTemplate"),
        "recovery_at_horizon": r.get("recoveryAtHorizon"), "severe_loss": r.get("severeLoss"), "horizon_block": r.get("horizonBlock"),
        "insider_outflow": r.get("insiderOutflow"), "liquidity_withdrawn": r.get("liquidityWithdrawn"),
        "v1_score_1001": (v.get("2026-10-01") or {}).get("score"), "v1_score_1007": (v.get("2026-10-07") or {}).get("score"),
        "v1_factors_1007": json.dumps((v.get("2026-10-07") or {}).get("factors")) if v else None,
        "pessimistic_supply_share": (int(ins["pessimisticBalance"]) / supply_of[token]) if ins.get("pessimisticBalance") is not None and supply_of.get(token) else None,
        "price_multiple": prices.get((token, landmark)),
        "error": error, "retrospective": True,
    }
    for channel in "TLI":
        event = r.get(channel) or {}
        row["fired_" + channel] = event.get("fired") if r else None
        row["event_block_" + channel] = event.get("block")
        row["realised_" + channel] = event.get("realised")
    rows.append(row)
pd.DataFrame(rows).to_csv(os.path.join(DATA, "records.csv.gz"), index=False)

# The rated records recomputed under other method versions (backfill/resolve-version.ts): 2.0.2, before the fix of
# deviation D13, and 2.1.0, which counts tokens parked in withdrawable liquidity.
versions = []
for table in ("records_v202", "records_v210"):
    if not con.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (table,)).fetchone():
        continue
    for token, landmark, version, state, grade, low, high, resolution, error in con.execute("SELECT token, landmark, version, state, grade, floor_low, floor_high, resolution, error FROM %s" % table):
        r = json.loads(resolution) if resolution else {}
        versions.append({"token": token, "landmark": landmark, "version": version, "state": state, "grade": grade, "floor_low": low, "floor_high": high,
                         "recovery_at_horizon": r.get("recoveryAtHorizon"), "severe_loss": r.get("severeLoss"), "fired_I": (r.get("I") or {}).get("fired") if r else None, "error": error})
if versions:
    pd.DataFrame(versions).to_csv(os.path.join(DATA, "method-versions.csv.gz"), index=False)

# Committed records, as published by the API (batches and their records).
committed = []
keep = os.environ.get("KEEP_COMMITTED") and os.path.exists(os.path.join(DATA, "committed.csv.gz"))  # reuse the last download
fetch = lambda url: json.load(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "launch-integrity-dataset/1.0"}), timeout=60))
try:
    if keep:
        raise RuntimeError("kept the existing committed.csv.gz (KEEP_COMMITTED)")
    batches, after = [], 0
    while True:  # the endpoint returns 500 batches per page, after a given sequence number
        page = fetch("https://api.drydockprotocol.org/v1/integrity/batches?after=%d" % after)["batches"]
        batches += page
        if len(page) < 500:
            break
        after = page[-1]["seq"]
    for batch in batches:
        body = fetch("https://api.drydockprotocol.org/v1/integrity/batch/%d" % batch["seq"])
        for item in body["records"]:
            committed.append({"batch": batch["seq"], "root": batch["root"], "tx": batch["tx"], "committed_block": batch["committed_block"], "id": item["id"], "token": item["token"],
                              "launchpad": item["launchpad"], "landmark": item["landmark"], "block": item["block"], "leaf": item["leaf"], "state": item["record"]["state"],
                              "floor_low": item["record"]["floorLow"], "floor_high": item["record"]["floorHigh"], "resolution": json.dumps(item["resolution"]) if item["resolution"] else None})
except Exception as error:  # the committed record is optional for a local rebuild
    print("committed records not fetched:", error)
if not keep:
    pd.DataFrame(committed).to_csv(os.path.join(DATA, "committed.csv.gz"), index=False)
print("launches %d, records %d, committed %d" % (len(launches), len(rows), len(committed)))
