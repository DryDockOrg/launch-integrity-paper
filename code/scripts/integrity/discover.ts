/**
 * Backfill step 1: every launch on a supported launchpad since Arc mainnet opened.
 *
 * Scans the V3 factory's PoolCreated and the V4 PoolManager's Initialize events from the first block of
 * 16 September 2026 to the end of 7 October 2026 (UTC; POPULATION_END_BLOCK), keeps USDC pools, and attributes each to a launchpad exactly as
 * the live indexer does (the contract the creating transaction called, or a launchpad's shared hook),
 * keeping V4 pools only when their hook is routable. Output: launches.json in the data directory.
 *
 *   npx tsx scripts/integrity/discover.ts [--from <block>] [--to <block>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionResult, encodeFunctionData, erc20Abi, parseAbi, type Log } from "viem";
import { CHAIN, LAUNCHPADS, hookTouchesSwaps, launchpadById, launchpadForEntry } from "../../lib/launchpads";
import { TOPICS, classifyLogs, cleanText } from "../../workers/api/src/chain";
import { DATA_DIR, batch, call, hex, logs, stats } from "./archive";
import { MAINNET_OPEN_BLOCK, POPULATION_END_BLOCK, type DiscoveredLaunch } from "./launches";


const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : undefined);
const out = join(DATA_DIR, "launches.json");
const existing: DiscoveredLaunch[] = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : [];
const head = Number(await call<string>("eth_blockNumber", []));
const from = arg("--from") ?? (existing.length ? existing.reduce((max, launch) => Math.max(max, launch.block), 0) + 1 : MAINNET_OPEN_BLOCK);
const to = arg("--to") ?? Math.min(head, POPULATION_END_BLOCK);
console.log(`discovering ${from}..${to} (${existing.length} launches already known)`);
const progress = setInterval(() => console.log(`  ${new Date().toISOString().slice(11, 19)} requests ${stats.requests}, retries ${stats.retries}`), 30_000);

const ENTRIES = LAUNCHPADS.flatMap((pad) => pad.entry.map((address) => address.toLowerCase()));
const SHARED_HOOKS = new Map([["0x3d90f1e09ae04e1f09b216acd6018a6598f1eacc", "arcora"], ["0x20eead6db6b3d0a4491e9073119dd0ebff166acc", "o1"]]);
const router = parseAbi(["function isHookAllowed(address) view returns (bool)"]);
const multicall = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"]);
const found = new Map(existing.map((launch) => [launch.pool, launch] as const));
const STEP = 100_000;
for (let low = from; low <= to; low += STEP) {
  const high = Math.min(to, low + STEP - 1);
  const raw = await logs({ address: [CHAIN.v3Factory, CHAIN.poolManager], topics: [[TOPICS.poolCreated, TOPICS.initialize]] }, low, high);
  const { candidates } = classifyLogs(raw.map((log) => ({ ...log, address: log.address, blockNumber: BigInt(log.blockNumber), logIndex: Number(log.logIndex), transactionIndex: Number(log.transactionIndex) })) as unknown as Log[]);
  // A launch transaction calls a launchpad entry contract, which logs the launch. Pools created in such a
  // transaction (or on a launchpad's shared hook) are candidates; the transaction sender is the creator.
  const entryLogs = await logs({ address: ENTRIES }, low, high);
  const padOfTx = new Map<string, string>();
  for (const log of entryLogs) padOfTx.set(log.transactionHash.toLowerCase(), launchpadForEntry(log.address)!.id);
  const fresh = candidates.flatMap((candidate) => {
    if (found.has(candidate.pool)) return [];
    const pad = padOfTx.get(candidate.tx.toLowerCase()) ?? SHARED_HOOKS.get(candidate.hooks.toLowerCase());
    return pad && launchpadById(pad)?.protocol === candidate.protocol ? [{ candidate, pad }] : [];
  });
  const txs = await batch<{ from: string; to: string | null }>(fresh.map(({ candidate }) => ({ method: "eth_getTransactionByBlockNumberAndIndex", params: [hex(candidate.block), hex(candidate.txIndex)] })));
  const matched = fresh.flatMap(({ candidate, pad }, index) => (txs[index] ? [{ candidate, pad, creator: txs[index]!.from.toLowerCase() }] : []));
  for (let index = 0; index < matched.length; index += 60) {
    const slice = matched.slice(index, index + 60);
    const calls = slice.flatMap(({ candidate }) => [
      { target: candidate.token, allowFailure: true, callData: encodeFunctionData({ abi: erc20Abi, functionName: "symbol" }) },
      { target: candidate.token, allowFailure: true, callData: encodeFunctionData({ abi: erc20Abi, functionName: "name" }) },
      { target: candidate.token, allowFailure: true, callData: encodeFunctionData({ abi: erc20Abi, functionName: "decimals" }) },
      { target: candidate.token, allowFailure: true, callData: encodeFunctionData({ abi: erc20Abi, functionName: "totalSupply" }) },
      { target: CHAIN.swapRouter, allowFailure: true, callData: encodeFunctionData({ abi: router, functionName: "isHookAllowed", args: [candidate.hooks] }) },
    ]);
    const data = await call<`0x${string}`>("eth_call", [{ to: CHAIN.multicall3, data: encodeFunctionData({ abi: multicall, functionName: "aggregate3", args: [calls as never] }) }, "latest"]);
    const results = decodeFunctionResult({ abi: multicall, functionName: "aggregate3", data }) as Array<{ success: boolean; returnData: `0x${string}` }>;
    slice.forEach(({ candidate, pad, creator }, position) => {
      const [symbol, name, decimals, supply, allowed] = results.slice(position * 5, position * 5 + 5);
      const read = <T>(result: { success: boolean; returnData: `0x${string}` }, fn: "symbol" | "name" | "decimals" | "totalSupply") => {
        try { return result.success ? (decodeFunctionResult({ abi: erc20Abi, functionName: fn, data: result.returnData }) as T) : null; } catch { return null; }
      };
      const dec = read<number>(decimals, "decimals");
      const total = read<bigint>(supply, "totalSupply");
      if (dec == null || total == null) return;
      if (candidate.protocol === "v4" && hookTouchesSwaps(candidate.hooks)) {
        let ok = false;
        try { ok = allowed.success && (decodeFunctionResult({ abi: router, functionName: "isHookAllowed", data: allowed.returnData }) as boolean); } catch { ok = false; }
        if (!ok) return;
      }
      found.set(candidate.pool, {
        token: candidate.token.toLowerCase(), launchpad: pad, creator, protocol: candidate.protocol, pool: candidate.pool, fee: candidate.fee,
        tickSpacing: candidate.tickSpacing, hooks: candidate.hooks.toLowerCase(), usdcIs0: candidate.usdcIs0, decimals: Number(dec), supply: total.toString(),
        block: candidate.block, tx: candidate.tx.toLowerCase(), txIndex: candidate.txIndex,
        symbol: cleanText(read<string>(symbol, "symbol"), "?", 24), name: cleanText(read<string>(name, "name"), "Unnamed token", 64),
      });
    });
  }
  const all = [...found.values()].sort((a, b) => a.block - b.block);
  writeFileSync(out, JSON.stringify(all));
  const counts = all.reduce<Record<string, number>>((acc, launch) => { acc[launch.launchpad] = (acc[launch.launchpad] ?? 0) + 1; return acc; }, {});
  console.log(`${high}: ${candidates.length} USDC pools, ${entryLogs.length} launchpad logs, ${matched.length} attributed; total ${all.length}`, JSON.stringify(counts));
}
clearInterval(progress);
