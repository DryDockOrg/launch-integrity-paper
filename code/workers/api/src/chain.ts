import { decodeEventLog, erc20Abi, parseAbi, parseAbiItem, toEventSelector, zeroAddress, type Address, type Hex, type Log, type PublicClient } from "viem";
import { CHAIN, hookTouchesSwaps, launchpadForEntry, launchpadForHook, sqrtPriceToUsdc, swapSide, type Protocol } from "../../../lib/launchpads";

export const V3_POOL_CREATED = parseAbiItem("event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)");
export const V4_INITIALIZE = parseAbiItem("event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)");
export const V3_SWAP = parseAbiItem("event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)");
export const V4_SWAP = parseAbiItem("event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)");
export const TOPICS = {
  poolCreated: toEventSelector(V3_POOL_CREATED),
  initialize: toEventSelector(V4_INITIALIZE),
  v3Swap: toEventSelector(V3_SWAP),
  v4Swap: toEventSelector(V4_SWAP),
} as const;

const routerAbi = parseAbi(["function isHookAllowed(address hook) view returns (bool)"]);
const v3PoolAbi = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)"]);
const usdc = CHAIN.usdc.toLowerCase();
const factory = CHAIN.v3Factory.toLowerCase();
const manager = CHAIN.poolManager.toLowerCase();

/** A newly created USDC pool that may belong to a supported launchpad. */
export interface PoolCandidate {
  protocol: Protocol;
  pool: string;
  token: Address;
  usdcIs0: boolean;
  fee: number;
  tickSpacing: number;
  hooks: Address;
  sqrtPriceX96: bigint;
  block: number;
  txIndex: number;
  tx: Hex;
}

export interface SwapEvent {
  protocol: Protocol;
  pool: string;
  block: number;
  logIndex: number;
  sqrtPriceX96: bigint;
  amount0: bigint;
  amount1: bigint;
}

/** Split one combined log query into pool candidates and swaps. Unrelated emitters are ignored. */
export function classifyLogs(logs: Log[]) {
  const candidates: PoolCandidate[] = [];
  const swaps: SwapEvent[] = [];
  for (const log of logs) {
    const emitter = log.address.toLowerCase();
    const topic = log.topics[0];
    if (log.blockNumber == null || log.logIndex == null || !log.transactionHash) continue;
    const block = Number(log.blockNumber);
    const txIndex = Number(log.transactionIndex ?? 0);
    try {
      if (topic === TOPICS.poolCreated && emitter === factory) {
        const { args } = decodeEventLog({ abi: [V3_POOL_CREATED], data: log.data, topics: log.topics });
        const usdcIs0 = args.token0.toLowerCase() === usdc;
        if (!usdcIs0 && args.token1.toLowerCase() !== usdc) continue;
        candidates.push({ protocol: "v3", pool: args.pool.toLowerCase(), token: usdcIs0 ? args.token1 : args.token0, usdcIs0, fee: args.fee, tickSpacing: args.tickSpacing, hooks: zeroAddress, sqrtPriceX96: 0n, block, txIndex, tx: log.transactionHash });
      } else if (topic === TOPICS.initialize && emitter === manager) {
        const { args } = decodeEventLog({ abi: [V4_INITIALIZE], data: log.data, topics: log.topics });
        const usdcIs0 = args.currency0.toLowerCase() === usdc;
        if (!usdcIs0 && args.currency1.toLowerCase() !== usdc) continue; // native-currency pools are not routable by the swap router
        if (args.hooks === zeroAddress) continue; // no supported launchpad uses a hookless V4 pool
        candidates.push({ protocol: "v4", pool: args.id.toLowerCase(), token: usdcIs0 ? args.currency1 : args.currency0, usdcIs0, fee: args.fee, tickSpacing: args.tickSpacing, hooks: args.hooks, sqrtPriceX96: args.sqrtPriceX96, block, txIndex, tx: log.transactionHash });
      } else if (topic === TOPICS.v3Swap) {
        const { args } = decodeEventLog({ abi: [V3_SWAP], data: log.data, topics: log.topics });
        swaps.push({ protocol: "v3", pool: emitter, block, logIndex: log.logIndex, sqrtPriceX96: args.sqrtPriceX96, amount0: args.amount0, amount1: args.amount1 });
      } else if (topic === TOPICS.v4Swap && emitter === manager) {
        const { args } = decodeEventLog({ abi: [V4_SWAP], data: log.data, topics: log.topics });
        swaps.push({ protocol: "v4", pool: args.id.toLowerCase(), block, logIndex: log.logIndex, sqrtPriceX96: args.sqrtPriceX96, amount0: args.amount0, amount1: args.amount1 });
      }
    } catch { /* malformed or non-standard log with a colliding topic */ }
  }
  swaps.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  return { candidates, swaps };
}

/** Convert a swap on a known pool into a priced trade. */
export function tradeOf(swap: SwapEvent, pool: { usdcIs0: boolean; decimals: number }) {
  const { buy, usd } = swapSide(swap.protocol, pool.usdcIs0 ? swap.amount0 : swap.amount1);
  const price = sqrtPriceToUsdc(swap.sqrtPriceX96, pool.usdcIs0, pool.decimals);
  return usd > 0 && price > 0 ? { buy, usd, price } : null;
}

export interface AttributedLaunch extends PoolCandidate {
  launchpad: string;
  creator: Address;
  symbol: string;
  name: string;
  decimals: number;
  supply: number;
  price: number;
}

/**
 * Attribute candidates to supported launchpads (by the contract the creating transaction called),
 * require the swap router to allow any swap-affecting V4 hook, and read token metadata and the opening price.
 */
export async function attribute(client: PublicClient, candidates: PoolCandidate[]): Promise<AttributedLaunch[]> {
  if (!candidates.length) return [];
  // Looked up by block and index: public nodes prune their transaction-hash index sooner than their logs.
  const txs = await Promise.all(candidates.map((candidate) => client.getTransaction({ blockNumber: BigInt(candidate.block), index: candidate.txIndex }).catch(() => null)));
  const matched = candidates.flatMap((candidate, index) => {
    const tx = txs[index];
    const pad = launchpadForEntry(tx?.to) ?? (candidate.protocol === "v4" ? launchpadForHook(candidate.hooks) : undefined);
    return tx && pad && pad.protocol === candidate.protocol ? [{ candidate, pad: pad.id, creator: tx.from }] : [];
  });
  if (!matched.length) return [];
  const calls = matched.flatMap(({ candidate }) => [
    { address: candidate.token, abi: erc20Abi, functionName: "symbol" },
    { address: candidate.token, abi: erc20Abi, functionName: "name" },
    { address: candidate.token, abi: erc20Abi, functionName: "decimals" },
    { address: candidate.token, abi: erc20Abi, functionName: "totalSupply" },
    candidate.protocol === "v3"
      ? { address: candidate.pool as Address, abi: v3PoolAbi, functionName: "slot0" }
      : hookTouchesSwaps(candidate.hooks)
        ? { address: CHAIN.swapRouter, abi: routerAbi, functionName: "isHookAllowed", args: [candidate.hooks] }
        : { address: CHAIN.swapRouter, abi: routerAbi, functionName: "isHookAllowed", args: [zeroAddress] },
  ]);
  const results = (await client.multicall({ contracts: calls as never, allowFailure: true, multicallAddress: CHAIN.multicall3 })) as Array<{ status: "success" | "failure"; result?: unknown }>;
  return matched.flatMap(({ candidate, pad, creator }, index) => {
    const [symbol, name, decimals, supply, extra] = results.slice(index * 5, index * 5 + 5);
    if (decimals.status !== "success" || supply.status !== "success") return [];
    const tokenDecimals = Number(decimals.result);
    if (!Number.isInteger(tokenDecimals) || tokenDecimals > 36) return [];
    let sqrt = candidate.sqrtPriceX96;
    if (candidate.protocol === "v3") {
      if (extra.status === "success") sqrt = (extra.result as readonly [bigint])[0];
    } else if (hookTouchesSwaps(candidate.hooks) && !(extra.status === "success" && extra.result === true)) {
      return []; // the swap router would refuse this pool's hook, so DryDock does not list it
    }
    return [{
      ...candidate,
      launchpad: pad,
      creator,
      symbol: cleanText(symbol.status === "success" ? symbol.result : null, "?", 24),
      name: cleanText(name.status === "success" ? name.result : null, "Unnamed token", 64),
      decimals: tokenDecimals,
      supply: Number(supply.result as bigint) / 10 ** tokenDecimals,
      price: sqrtPriceToUsdc(sqrt, candidate.usdcIs0, tokenDecimals),
    }];
  });
}

export function cleanText(value: unknown, fallback: string, max: number) {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").trim().slice(0, max);
  return cleaned || fallback;
}
