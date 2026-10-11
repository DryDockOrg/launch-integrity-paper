/**
 * Backfill step 2: pool events and token transfers for every launch since mainnet opened.
 *
 *   npx tsx scripts/integrity/backfill/scan.ts pools       swaps and liquidity events of every launch pool, and position-manager mints
 *   npx tsx scripts/integrity/backfill/scan.ts transfers   transfers of every sampled traded launch token, from launch to 48 h after its first trade
 *
 * Each 100-block window is one request per log shape; windows are recorded as done, so a run can resume.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAIN } from "../../../lib/launchpads";
import { TOPIC } from "../../../lib/integrity/evidence";
import { DATA_DIR, call, hex, stats, type RawLog } from "../archive";
import { keccak256, toHex } from "viem";
import { MAINNET_OPEN_BLOCK, SAMPLE_SEED, backfillSample, type DiscoveredLaunch } from "../launches";
import { HUBS } from "../../../lib/integrity/registry";
import { NATIVE_EMITTER } from "../../../lib/integrity/evidence";
import { db, done, getKv, indexUsdc, markDone, putLogs, putUsdc, setKv } from "./store";

const WINDOW = 100;
const PARALLEL = 24;
const mode = process.argv[2];
const launches = JSON.parse(readFileSync(join(DATA_DIR, "launches.json"), "utf8")) as DiscoveredLaunch[];
const head = Number(await call<string>("eth_blockNumber", []));
const v3Pools = new Map(launches.filter((launch) => launch.protocol === "v3").map((launch) => [launch.pool.toLowerCase(), launch]));
const v4Pools = new Map(launches.filter((launch) => launch.protocol === "v4").map((launch) => [launch.pool.toLowerCase(), launch]));
const progress = setInterval(() => console.log(`  ${new Date().toISOString().slice(11, 19)} requests ${stats.requests} retries ${stats.retries}`), 60_000);

async function getLogs(filter: Record<string, unknown>, from: number, to: number): Promise<RawLog[]> {
  try {
    return await call<RawLog[]>("eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]);
  } catch (error) {
    if (to > from && /limit|exceed|too many|ranges over|too large/i.test(String((error as Error).message))) {
      const middle = Math.floor((from + to) / 2);
      return (await getLogs(filter, from, middle)).concat(await getLogs(filter, middle + 1, to));
    }
    throw error;
  }
}

const row = (log: RawLog, key: string) => ({ key, block: Number(log.blockNumber), idx: Number(log.logIndex), tx: log.transactionHash.toLowerCase(), address: log.address.toLowerCase(), topics: log.topics, data: log.data });

async function sweep(kind: string, from: number, to: number, work: (low: number, high: number) => Promise<void>) {
  const windows: number[] = [];
  for (let low = from; low <= to; low += WINDOW) if (!done(kind, "all", low)) windows.push(low);
  console.log(`${kind}: ${windows.length} windows to scan in ${from}..${to}`);
  let next = 0, finished = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < windows.length) {
      const low = windows[next++];
      const high = Math.min(to, low + WINDOW - 1);
      await work(low, high);
      markDone(kind, "all", low, high);
      if (++finished % 2000 === 0) console.log(`  ${kind} ${finished}/${windows.length}`);
    }
  }));
}

if (mode === "pools") {
  await sweep("pools", MAINNET_OPEN_BLOCK, head, async (low, high) => {
    const [v3, v4, npm] = await Promise.all([
      getLogs({ topics: [[TOPIC.v3Swap, TOPIC.v3Mint, TOPIC.v3Burn]] }, low, high),
      getLogs({ address: CHAIN.poolManager, topics: [[TOPIC.v4Swap, TOPIC.v4ModifyLiquidity]] }, low, high),
      getLogs({ address: CHAIN.v3PositionManager, topics: [TOPIC.npmIncrease] }, low, high),
    ]);
    const keep = [
      ...v3.filter((log) => v3Pools.has(log.address.toLowerCase())).map((log) => row(log, log.address.toLowerCase())),
      ...v4.filter((log) => v4Pools.has(log.topics[1]?.toLowerCase())).map((log) => row(log, log.topics[1].toLowerCase())),
    ];
    const npmKept = npm.filter((log) => keep.some((item) => item.tx === log.transactionHash.toLowerCase())).map((log) => row(log, CHAIN.v3PositionManager));
    putLogs("pool", keep);
    putLogs("npm", npmKept);
  });
} else if (mode === "transfers") {
  // First trades, from the pool scan: only traded launches need their transfers.
  let first = getKv<Array<[string, number]>>("first_trades");
  if (!first) {
    first = (db.prepare("SELECT key, MIN(block) AS block FROM logs WHERE kind = 'pool' AND substr(topics, 3, 66) IN (?, ?) GROUP BY key").all(TOPIC.v3Swap, TOPIC.v4Swap) as Array<{ key: string; block: number }>).map((item) => [item.key, item.block]);
    setKv("first_trades", first);
  }
  const firstTrade = new Map(first);
  const sampled = backfillSample(launches.filter((launch) => firstTrade.has(launch.pool.toLowerCase())), (token) => keccak256(toHex(`${SAMPLE_SEED}:${token.toLowerCase()}`)));
  const spans = sampled.map((launch) => ({ token: launch.token.toLowerCase(), from: launch.block, to: Math.min(head, firstTrade.get(launch.pool.toLowerCase())! + 2 * 172_800 + 1_000) }));
  console.log(`${spans.length} sampled of ${firstTrade.size} traded launches (${launches.length} launches)`);
  const start = spans.reduce((min, span) => Math.min(min, span.from), Infinity);
  // Spans grouped by the 100,000-block bucket they start in; a span is at most ~3,500 windows long.
  const BUCKET = 100_000;
  const buckets = new Map<number, typeof spans>();
  for (const span of spans) { const key = Math.floor(span.from / BUCKET); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key)!.push(span); }
  // Windows already swept by the earlier unfiltered scan ("transfers") hold every token's transfers.
  const unfiltered = (low: number) => done("transfers", "all", low);
  await sweep("transfers-sample", start, head, async (low, high) => {
    if (unfiltered(low)) return;
    const live = new Set<string>();
    for (let key = Math.floor(high / BUCKET); key >= Math.floor(high / BUCKET) - 5; key--) for (const span of buckets.get(key) ?? []) if (span.from <= high && span.to >= low) live.add(span.token);
    if (!live.size) return;
    const tokens = [...live];
    for (let i = 0; i < tokens.length; i += 1_000) {
      const logs = await getLogs({ address: tokens.slice(i, i + 1_000), topics: [TOPIC.transfer] }, low, high);
      putLogs("transfer", logs.map((log) => row(log, log.address.toLowerCase())));
    }
  });
} else if (mode === "usdc") {
  // Every USDC move of at least 1 USDC whose sender is not a hub, from one funding lookback before mainnet
  // opened to the head: the funding and proceeds evidence of every launch.
  const hubs = new Set(HUBS.map((hub) => hub.address.toLowerCase()));
  await sweep("usdc", MAINNET_OPEN_BLOCK - 86_400, head, async (low, high) => {
    const logs = await getLogs({ address: [CHAIN.usdc, NATIVE_EMITTER], topics: [TOPIC.transfer] }, low, high);
    const rows = [];
    for (const log of logs) {
      if (log.topics.length !== 3 || log.data.length < 66) continue;
      const native = log.address.toLowerCase() === NATIVE_EMITTER;
      const value = native ? BigInt(log.data.slice(0, 66)) / 1_000_000_000_000n : BigInt(log.data.slice(0, 66));
      const src = `0x${log.topics[1].slice(26)}`.toLowerCase();
      if (value < 1_000_000n || hubs.has(src)) continue;
      rows.push({ block: Number(log.blockNumber), idx: Number(log.logIndex), tx: log.transactionHash.toLowerCase(), src, dst: `0x${log.topics[2].slice(26)}`.toLowerCase(), value, native });
    }
    putUsdc(rows);
  });
  indexUsdc();
}
clearInterval(progress);
console.log("done", stats);
