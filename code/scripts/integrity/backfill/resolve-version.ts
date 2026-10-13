/**
 * Recomputes and resolves the rated backfill records with the method version of the code tree this script sits
 * in, writing to its own table so the main records are untouched. Used for the paper's comparison of method 2.0.2
 * (before D13's fix) with 2.0.3 on the same records: run from an extract of the 2.0.2 commit.
 *
 *   npx tsx scripts/integrity/backfill/resolve-version.ts <table>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assessLaunch } from "../../../lib/integrity";
import { SPEC_VERSION } from "../../../lib/integrity/params";
import { resolveRecord } from "../../../lib/integrity/resolve";
import type { LaunchInfo } from "../../../lib/integrity/types";
import { DATA_DIR, call } from "../archive";
import type { DiscoveredLaunch } from "../launches";
import { storeReader } from "./reader";
import { db, getKv } from "./store";

const table = process.argv[2];
if (!table || !/^[a-z0-9_]+$/.test(table)) throw new Error("Give a table name.");
db.exec(`CREATE TABLE IF NOT EXISTS ${table} (token TEXT NOT NULL, landmark INTEGER NOT NULL, version TEXT NOT NULL, state TEXT NOT NULL, grade TEXT,
  floor_low REAL, floor_high REAL, resolution TEXT, error TEXT, PRIMARY KEY (token, landmark)) WITHOUT ROWID`);
const launches = new Map((JSON.parse(readFileSync(join(DATA_DIR, "launches.json"), "utf8")) as DiscoveredLaunch[]).map((launch) => [launch.token, launch]));
const first = new Map(getKv<Array<[string, number]>>("first_trades")!);
const rows = db.prepare("SELECT token, landmark, block FROM records WHERE state = 'rated' ORDER BY token, landmark").all() as Array<{ token: string; landmark: number; block: number }>;
const has = db.prepare(`SELECT 1 FROM ${table} WHERE token = ? AND landmark = ?`);
const save = db.prepare(`INSERT OR REPLACE INTO ${table} (token, landmark, version, state, grade, floor_low, floor_high, resolution, error) VALUES (?,?,?,?,?,?,?,?,?)`);
const reader = storeReader(Number(await call<string>("eth_blockNumber", [])));
const nonceCache = new Map<string, number>();
let next = 0, done = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < rows.length) {
    const row = rows[next++];
    if (has.get(row.token, row.landmark)) continue;
    const raw = launches.get(row.token)!;
    const launch: LaunchInfo = {
      token: raw.token, launchpad: raw.launchpad, creator: raw.creator, protocol: raw.protocol, pool: raw.pool.toLowerCase(), fee: raw.fee, tickSpacing: raw.tickSpacing,
      hooks: raw.hooks, usdcIs0: raw.usdcIs0, decimals: raw.decimals, supply: BigInt(raw.supply), block: raw.block, tx: raw.tx, firstTradeBlock: first.get(raw.pool.toLowerCase())!,
    };
    let resolution = null, error: string | null = null;
    const { facts, sets, evidence } = await assessLaunch(reader, launch, row.block, { nonceCache });
    if (facts.state === "rated" && facts.referenceTokens) {
      try {
        resolution = await resolveRecord(reader, { launch, block: row.block, referenceTokens: facts.referenceTokens, pessimistic: sets.pessimistic, positions: evidence.positions });
      } catch (failure) { error = String((failure as Error).message).slice(0, 200); }
    }
    save.run(row.token, row.landmark, SPEC_VERSION, facts.state, facts.grade, facts.floor?.low ?? null, facts.floor?.high ?? null, resolution ? JSON.stringify(resolution) : null, error);
    if (++done % 100 === 0) console.log(`  ${done}/${rows.length}`);
  }
}));
console.log({ version: SPEC_VERSION, records: rows.length, done });
