/**
 * Baseline B5 (paper Section 8.4): the price multiple since launch for every rated backfill record, from the
 * pool's stored swaps. The multiple is the pool price after the last swap at or before the forecast block over the
 * price after the launch's first swap. Written to the store's `record_prices` table, which analysis/dataset.py
 * exports as `price_multiple`.
 *
 *   npx tsx scripts/integrity/backfill/prices.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeSwaps, TOPIC } from "../../../lib/integrity/evidence";
import type { LaunchInfo } from "../../../lib/integrity/types";
import { CHAIN, sqrtPriceToUsdc } from "../../../lib/launchpads";
import { DATA_DIR } from "../archive";
import type { DiscoveredLaunch } from "../launches";
import { storeReader } from "./reader";
import { db } from "./store";

db.exec("CREATE TABLE IF NOT EXISTS record_prices (token TEXT NOT NULL, landmark INTEGER NOT NULL, first_price REAL, price REAL, multiple REAL, PRIMARY KEY (token, landmark)) WITHOUT ROWID");
const launches = new Map((JSON.parse(readFileSync(join(DATA_DIR, "launches.json"), "utf8")) as DiscoveredLaunch[]).map((launch) => [launch.token, launch]));
const rows = db.prepare("SELECT token, landmark, block FROM records WHERE state = 'rated'").all() as Array<{ token: string; landmark: number; block: number }>;
const reader = storeReader(Number.MAX_SAFE_INTEGER);
const save = db.prepare("INSERT OR REPLACE INTO record_prices (token, landmark, first_price, price, multiple) VALUES (?,?,?,?,?)");
let done = 0;
for (const row of rows) {
  const raw = launches.get(row.token)!;
  const info = { protocol: raw.protocol, usdcIs0: raw.usdcIs0, pool: raw.pool.toLowerCase() } as LaunchInfo;
  const filter = raw.protocol === "v3" ? { address: info.pool, topics: [TOPIC.v3Swap] } : { address: CHAIN.poolManager, topics: [TOPIC.v4Swap, info.pool] };
  const swaps = decodeSwaps(await reader.logs(filter, raw.block, row.block), info);
  if (!swaps.length) continue;
  const price = (sqrt: bigint) => sqrtPriceToUsdc(sqrt, raw.usdcIs0, raw.decimals);
  const first = price(swaps[0].sqrtPriceX96), last = price(swaps[swaps.length - 1].sqrtPriceX96);
  save.run(row.token, row.landmark, first, last, first > 0 ? last / first : null);
  done++;
}
console.log({ rated: rows.length, priced: done });
