/**
 * Backfill step 3: retrospective records. For every traded launch in the store, the facts at each landmark
 * (1 min, 10 min, 1 h, 6 h, 24 h after the first trade) and their resolution 24 hours later, computed by the
 * same code as the live runner. Every row is marked retrospective: none was committed before its outcome.
 *
 *   npx tsx scripts/integrity/backfill/run.ts [--limit N]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assessLaunch } from "../../../lib/integrity";
import { PARAMS } from "../../../lib/integrity/params";
import { leafOf, recordFromFacts } from "../../../lib/integrity/record";
import { resolveRecord } from "../../../lib/integrity/resolve";
import { TOPIC } from "../../../lib/integrity/evidence";
import type { LaunchInfo } from "../../../lib/integrity/types";
import { DATA_DIR, call, stats } from "../archive";
import { keccak256, toHex } from "viem";
import { SAMPLE_SEED, backfillSample, type DiscoveredLaunch } from "../launches";
import { hasHistory } from "../../../lib/integrity/entities";
import { storeReader } from "./reader";
import { v1At } from "./v1";
import { db, getKv, setKv } from "./store";

db.exec(`CREATE TABLE IF NOT EXISTS records (
  token TEXT NOT NULL, landmark INTEGER NOT NULL, launchpad TEXT NOT NULL, creator TEXT NOT NULL,
  block INTEGER NOT NULL, ts INTEGER NOT NULL, state TEXT NOT NULL, grade TEXT, leaf TEXT NOT NULL,
  record TEXT NOT NULL, facts TEXT NOT NULL, resolution TEXT, v1 TEXT, error TEXT,
  PRIMARY KEY (token, landmark)) WITHOUT ROWID`);

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : undefined);
const launches = JSON.parse(readFileSync(join(DATA_DIR, "launches.json"), "utf8")) as DiscoveredLaunch[];
const scanned = (db.prepare("SELECT MAX(high) AS high FROM scanned WHERE kind IN ('transfers', 'transfers-sample')").get() as { high: number | null }).high;
if (!scanned) throw new Error("Run scan.ts transfers first.");
const head = Math.min(scanned, Number(await call<string>("eth_blockNumber", [])));
// First swap of every launch pool (topics are stored as JSON, so topic0 sits at characters 3 to 68), cached once computed.
let firstRows = getKv<Array<[string, number]>>("first_trades");
if (!firstRows) {
  firstRows = (db.prepare("SELECT key, MIN(block) AS block FROM logs WHERE kind = 'pool' AND substr(topics, 3, 66) IN (?, ?) GROUP BY key").all(TOPIC.v3Swap, TOPIC.v4Swap) as Array<{ key: string; block: number }>).map((row) => [row.key, row.block]);
  setKv("first_trades", firstRows);
}
const first = new Map(firstRows);
const traded = backfillSample(launches.filter((launch) => first.has(launch.pool.toLowerCase())), (token) => keccak256(toHex(`${SAMPLE_SEED}:${token.toLowerCase()}`)));
const limit = opt("--limit") ?? traded.length;
const has = db.prepare("SELECT 1 FROM records WHERE token = ? AND landmark = ?");
const clearError = db.prepare("DELETE FROM records WHERE token = ? AND landmark = -1");
const save = db.prepare("INSERT OR REPLACE INTO records (token, landmark, launchpad, creator, block, ts, state, grade, leaf, record, facts, resolution, v1, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
// Earlier launches by the same creator, for v1's creator factor.
const byCreator = new Map<string, DiscoveredLaunch[]>();
for (const launch of [...launches].sort((a, b) => a.block - b.block)) { if (!byCreator.has(launch.creator)) byCreator.set(launch.creator, []); byCreator.get(launch.creator)!.push(launch); }
const reader = storeReader(head);
const nonceCache = new Map<string, number>();
console.log(`${traded.length} sampled traded launches; processing ${Math.min(limit, traded.length)} up to block ${head}`);

const jobs = traded.slice(0, limit);
let next = 0, finished = 0, failures = 0;
const started = Date.now();
await Promise.all(Array.from({ length: 12 }, async () => {
  while (next < jobs.length) {
    const raw = jobs[next++];
    const launch: LaunchInfo = {
      token: raw.token, launchpad: raw.launchpad, creator: raw.creator, protocol: raw.protocol, pool: raw.pool.toLowerCase(), fee: raw.fee, tickSpacing: raw.tickSpacing,
      hooks: raw.hooks, usdcIs0: raw.usdcIs0, decimals: raw.decimals, supply: BigInt(raw.supply), block: raw.block, tx: raw.tx, firstTradeBlock: first.get(raw.pool.toLowerCase())!,
    };
    try {
      const firstTs = await reader.timestamp(launch.firstTradeBlock!);
      for (const landmark of PARAMS.landmarks) {
        if (has.get(launch.token, landmark)) continue;
        const block = await reader.blockAt(firstTs + landmark);
        // blockAt clamps to the head: a landmark later than the head's timestamp has not happened yet.
        if (block >= head && (await reader.timestamp(block)) < firstTs + landmark) break;
        let resolution = null, error: string | null = null;
        const { facts, sets, evidence } = await assessLaunch(reader, launch, block, { nonceCache });
        const record = recordFromFacts(facts, { pool: launch.pool, launchpad: launch.launchpad, landmark });
        // Resolutions and v1 scores are computed for rated records, the ones H1, H4 and the baselines read.
        if (facts.referenceTokens && facts.state === "rated") {
          const end = await reader.blockAt(facts.timestamp + PARAMS.horizon);
          if (end < head || (await reader.timestamp(end)) >= facts.timestamp + PARAMS.horizon) {
            try {
              resolution = await resolveRecord(reader, { launch, block, referenceTokens: facts.referenceTokens, pessimistic: sets.pessimistic, positions: evidence.positions });
            } catch (failure) { error = `resolution: ${String((failure as Error).message).slice(0, 200)}`; }
          }
        }
        let v1 = null;
        if (facts.state === "rated") try {
          const earlier = (byCreator.get(launch.creator) ?? []).filter((item) => item.block < launch.block);
          v1 = await v1At(reader, raw, block, facts.timestamp, await reader.timestamp(launch.block), earlier);
        } catch (failure) { error = `${error ? `${error}; ` : ""}v1: ${String((failure as Error).message).slice(0, 160)}`; }
        const factsJson = JSON.stringify({ ...facts, insiders: { ...facts.insiders, lowerBalance: String(facts.insiders.lowerBalance), pessimisticBalance: String(facts.insiders.pessimisticBalance) }, referenceTokens: facts.referenceTokens?.toString() ?? null, template: evidence.code, holdersAtH: sets.holders.size, historyChecked: Object.keys(evidence.history).length, historyPassed: [...sets.holders.keys()].filter((address) => hasHistory(evidence, address)).length, lowerSet: [...sets.lower.keys()].length, retrospective: true });
        save.run(launch.token, landmark, launch.launchpad, launch.creator, block, facts.timestamp, facts.state, facts.grade, leafOf(record), JSON.stringify(record), factsJson, resolution ? JSON.stringify(resolution) : null, v1 ? JSON.stringify(v1) : null, error);
      }
      clearError.run(launch.token);
    } catch (failure) {
      failures++;
      save.run(launch.token, -1, launch.launchpad, launch.creator, 0, 0, "error", null, "", "{}", "{}", null, null, String((failure as Error).message).slice(0, 300));
    }
    if (++finished % 10 === 0) console.log(`  ${finished}/${jobs.length} launches, ${failures} failed, ${((Date.now() - started) / 1000 / finished).toFixed(2)} s each, requests ${stats.requests} ${JSON.stringify(stats.methods)}`);
  }
}));
console.log("done", { finished, failures, stats });
