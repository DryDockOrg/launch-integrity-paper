import { createPublicClient, defineChain, fallback, http, type Log, type PublicClient } from "viem";
import { CHAIN } from "./launchpads";

/**
 * Browser RPC access. Analysis reads come straight from public Arc nodes, never through DryDock's
 * servers. The deep-history node (wide log ranges, recent history only) goes first.
 */
export const HISTORY_RPC = process.env.ARC_RECENT_RPC ?? process.env.ARC_CALL_RPC ?? "";
const RPCS = (process.env.ARC_ARCHIVE_RPCS ?? "")
  .split(",").map((url) => url.trim()).filter(Boolean);

/**
 * How far back history reads go. The public history node's retention varies (about 595k blocks in
 * late September, about 297k in early October); ranges it has pruned are skipped and reported as partial.
 */
export const HISTORY_BLOCKS = 280_000;
const CHUNK = 100_000;

export const arc = defineChain({
  id: CHAIN.id,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [HISTORY_RPC, ...RPCS] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
  contracts: { multicall3: { address: CHAIN.multicall3 } },
});

let shared: PublicClient | null = null;
export function rpc() {
  shared ??= createPublicClient({
    chain: arc,
    transport: fallback([HISTORY_RPC, ...RPCS].map((url) => http(url, { retryCount: 1, timeout: 20_000 })), { rank: false }),
  }) as PublicClient;
  return shared;
}

export const hex = (value: number | bigint) => `0x${value.toString(16)}`;

export interface LogQuery { address?: string | string[]; topics: Array<string | string[] | null> }

/** Raw logs with numeric block/index fields, in chain order. */
export interface ChainLog { address: string; topics: string[]; data: string; block: number; index: number; tx: string; txIndex: number }

/**
 * Logs for [from, to], fetched in 100k-block chunks from the history node and halved on
 * "too many results". The range start is clamped to what public nodes retain; `partial`
 * reports that the requested start was older than that.
 */
export async function getLogs(query: LogQuery, from: number, to: number) {
  const floor = Math.max(0, to - HISTORY_BLOCKS);
  const start = Math.max(from, floor);
  const out: ChainLog[] = [];
  const ranges: Array<[number, number]> = [];
  for (let low = start; low <= to; low += CHUNK) ranges.push([low, Math.min(to, low + CHUNK - 1)]);
  let pruned = false;
  const results = await Promise.all(ranges.map(([low, high]) => fetchRange(query, low, high).catch((error) => {
    if (/pruned/i.test(String((error as { details?: string }).details ?? error))) { pruned = true; return [] as ChainLog[]; }
    throw error;
  })));
  for (const logs of results) out.push(...logs);
  out.sort((a, b) => a.block - b.block || a.index - b.index);
  return { logs: out, partial: from < floor || pruned, start };
}

async function fetchRange(query: LogQuery, from: number, to: number): Promise<ChainLog[]> {
  try {
    const logs = (await rpc().request({ method: "eth_getLogs", params: [{ ...query, fromBlock: hex(from), toBlock: hex(to) }] as never })) as Log[];
    return logs.map((log) => ({
      address: log.address.toLowerCase(), topics: log.topics as string[], data: log.data,
      block: Number(log.blockNumber), index: Number(log.logIndex), tx: log.transactionHash as string, txIndex: Number(log.transactionIndex),
    }));
  } catch (error) {
    const message = String((error as { details?: string }).details ?? error);
    if (/pruned/i.test(message)) throw error;
    if (to > from && /max results|too many|range|limit|too large/i.test(message + String((error as Error).name))) {
      const middle = Math.floor((from + to) / 2);
      const [left, right] = await Promise.all([fetchRange(query, from, middle), fetchRange(query, middle + 1, to)]);
      return [...left, ...right];
    }
    throw error;
  }
}

export async function headBlock() {
  const block = await rpc().getBlock({ blockTag: "latest" });
  return { number: Number(block.number), timestamp: Number(block.timestamp) };
}

