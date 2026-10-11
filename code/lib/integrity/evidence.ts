/**
 * Evidence gathering for one token at one forecast block, against any Arc endpoint set.
 *
 * The browser, the forecast runner and the backfill all use this module; they differ only in the
 * `ChainReader` they pass (which nodes, how ranges are split, what is cached). The output is a plain
 * `Evidence` object, so everything after this point is a pure function of chain state at the block.
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi, toEventSelector, type Hex } from "viem";
import { CHAIN } from "../launchpads";
import { cloneTarget, templateHash } from "./bytecode";
import { decodePositionInfo } from "./liquidity";
import { PARAMS } from "./params";
import { activity, insiderSets } from "./entities";
import { isHub, rolesFor, templateFor } from "./registry";
import { codeKinds, type EthCall } from "./simulate";
import type { AddressHistory, Evidence, LaunchInfo, LiquidityPosition, PoolSwap, TokenTransfer, UsdcTransfer } from "./types";

export interface RawLog { address: string; topics: string[]; data: string; blockNumber: string | number; logIndex: string | number; transactionHash: string }
export interface LogFilter { address?: string | string[]; topics: Array<string | string[] | null> }

export interface ChainReader {
  /** Logs in [from, to], however the reader needs to split the range. */
  logs(filter: LogFilter, from: number, to: number): Promise<RawLog[]>;
  ethCall: EthCall;
  code(address: string, block: number): Promise<Hex>;
  timestamp(block: number): Promise<number>;
  /** First block with a timestamp at or after `timestamp`. */
  blockAt(timestamp: number): Promise<number>;
  /** Transaction counts at historical blocks; null where the node could not answer. */
  nonces(requests: Array<{ address: string; block: number }>): Promise<Array<number | null>>;
  /**
   * Optional: USDC transfer logs (ERC-20 and native mirror) into `address` in [from, to] carrying at least
   * `minimum` (6 decimals). Readers backed by an indexed store implement it so funding traces through busy
   * contracts do not load every small transfer; the result after tracedInbound's filters is the same.
   */
  usdcInbound?(address: string, from: number, to: number, minimum: bigint): Promise<RawLog[]>;
}

export const TOPIC = {
  transfer: toEventSelector("Transfer(address,address,uint256)"),
  v3Swap: toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  v4Swap: toEventSelector("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  v3Mint: toEventSelector("Mint(address,address,int24,int24,uint128,uint256,uint256)"),
  v3Burn: toEventSelector("Burn(address,int24,int24,uint128,uint256,uint256)"),
  v4ModifyLiquidity: toEventSelector("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)"),
  npmIncrease: toEventSelector("IncreaseLiquidity(uint256,uint128,uint256,uint256)"),
};
export const NATIVE_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";

const topicAddress = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();
export const padAddress = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
const word = (data: string, index: number) => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
const signed = (value: bigint, bits: number) => (value >= 1n << BigInt(bits - 1) ? value - (1n << BigInt(bits)) : value);
const num = (value: string | number) => (typeof value === "number" ? value : Number(value));

export function decodeTransfers(logs: RawLog[]): TokenTransfer[] {
  return logs.filter((log) => log.topics.length === 3 && log.data.length >= 66)
    .map((log) => ({ block: num(log.blockNumber), index: num(log.logIndex), tx: log.transactionHash.toLowerCase(), from: topicAddress(log.topics[1]), to: topicAddress(log.topics[2]), value: word(log.data, 0) }));
}

/** USDC transfers from both the ERC-20 and the native mirror, normalised to 6 decimals, one per (tx, from, to). */
export function decodeUsdc(logs: RawLog[]): UsdcTransfer[] {
  const seen = new Map<string, UsdcTransfer>();
  for (const log of logs) {
    if (log.topics.length !== 3 || log.data.length < 66) continue;
    const native = log.address.toLowerCase() === NATIVE_EMITTER;
    const value = native ? word(log.data, 0) / 1_000_000_000_000n : word(log.data, 0);
    const transfer = { block: num(log.blockNumber), index: num(log.logIndex), tx: log.transactionHash.toLowerCase(), from: topicAddress(log.topics[1]), to: topicAddress(log.topics[2]), value };
    const key = `${transfer.tx}:${transfer.from}:${transfer.to}:${value}`;
    if (!seen.has(key)) seen.set(key, transfer);
  }
  return [...seen.values()].sort((a, b) => a.block - b.block || a.index - b.index);
}

export function decodeSwaps(logs: RawLog[], launch: LaunchInfo): PoolSwap[] {
  const out: PoolSwap[] = [];
  for (const log of logs) {
    if (log.topics[0] !== TOPIC.v3Swap && log.topics[0] !== TOPIC.v4Swap) continue;
    const amount0 = signed(word(log.data, 0), 256), amount1 = signed(word(log.data, 1), 256);
    const usdcDelta = launch.usdcIs0 ? amount0 : amount1;
    const tokenDelta = launch.usdcIs0 ? amount1 : amount0;
    // V3 amounts are pool deltas (USDC paid in => buy); V4 amounts are swapper deltas (USDC paid => negative).
    const buy = launch.protocol === "v3" ? usdcDelta > 0n : usdcDelta < 0n;
    const abs = (value: bigint) => (value < 0n ? -value : value);
    out.push({ block: num(log.blockNumber), index: num(log.logIndex), tx: log.transactionHash.toLowerCase(), buy, usdc: abs(usdcDelta), tokens: abs(tokenDelta), sqrtPriceX96: word(log.data, 2) });
  }
  return out.sort((a, b) => a.block - b.block || a.index - b.index);
}

const npmAbi = parseAbi([
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
  "function ownerOf(uint256) view returns (address)",
]);
const posmAbi = parseAbi(["function getPositionLiquidity(uint256) view returns (uint128)", "function ownerOf(uint256) view returns (address)", "function positionInfo(uint256) view returns (uint256)"]);
const multicallAbi = parseAbi(["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"]);

/** Batched view calls at a block through Multicall3. */
export async function multicall(ethCall: EthCall, block: number, calls: Array<{ target: string; data: Hex }>) {
  const out: Array<Hex | null> = [];
  for (let index = 0; index < calls.length; index += 200) {
    const slice = calls.slice(index, index + 200);
    const data = encodeFunctionData({ abi: multicallAbi, functionName: "aggregate3", args: [slice.map((call) => ({ target: call.target as Hex, allowFailure: true, callData: call.data }))] });
    const result = await ethCall({ to: CHAIN.multicall3, data, gas: 50_000_000n }, block, {});
    const decoded = decodeFunctionResult({ abi: multicallAbi, functionName: "aggregate3", data: result }) as Array<{ success: boolean; returnData: Hex }>;
    out.push(...decoded.map((item) => (item.success ? item.returnData : null)));
  }
  return out;
}

/** Liquidity positions in the launch's pool at `block`, from mint/modify events and the managers' state. */
export async function readPositions(reader: ChainReader, launch: LaunchInfo, block: number): Promise<LiquidityPosition[]> {
  const positions: LiquidityPosition[] = [];
  if (launch.protocol === "v3") {
    const logs = await reader.logs({ address: launch.pool, topics: [[TOPIC.v3Mint, TOPIC.v3Burn]] }, launch.block, block);
    const direct = new Map<string, LiquidityPosition>();
    const npmTxs = new Set<string>();
    for (const log of logs) {
      // Mint(sender, owner indexed, tickLower indexed, tickUpper indexed, amount, ...); Burn(owner indexed, tickLower indexed, tickUpper indexed, amount, ...).
      const owner = topicAddress(log.topics[1]);
      const lower = Number(signed(BigInt(log.topics[2]), 256));
      const upper = Number(signed(BigInt(log.topics[3]), 256));
      const amount = log.topics[0] === TOPIC.v3Mint ? word(log.data, 1) : word(log.data, 0);
      if (owner === CHAIN.v3PositionManager) { if (log.topics[0] === TOPIC.v3Mint) npmTxs.add(log.transactionHash.toLowerCase()); continue; }
      const key = `${owner}:${lower}:${upper}`;
      const position = direct.get(key) ?? { manager: "direct" as const, owner, tokenId: null, tickLower: lower, tickUpper: upper, liquidity: 0n, salt: "0x" as Hex };
      position.liquidity += log.topics[0] === TOPIC.v3Mint ? amount : -amount;
      direct.set(key, position);
    }
    positions.push(...[...direct.values()].filter((position) => position.liquidity > 0n));
    if (npmTxs.size) {
      const increases = await reader.logs({ address: CHAIN.v3PositionManager, topics: [TOPIC.npmIncrease] }, launch.block, block);
      const ids = [...new Set(increases.filter((log) => npmTxs.has(log.transactionHash.toLowerCase())).map((log) => BigInt(log.topics[1])))];
      const results = await multicall(reader.ethCall, block, ids.flatMap((id) => [
        { target: CHAIN.v3PositionManager, data: encodeFunctionData({ abi: npmAbi, functionName: "positions", args: [id] }) },
        { target: CHAIN.v3PositionManager, data: encodeFunctionData({ abi: npmAbi, functionName: "ownerOf", args: [id] }) },
      ]));
      ids.forEach((id, index) => {
        const [state, owner] = [results[index * 2], results[index * 2 + 1]];
        if (!state || !owner) return;
        const decoded = decodeFunctionResult({ abi: npmAbi, functionName: "positions", data: state }) as readonly unknown[];
        const liquidity = decoded[7] as bigint;
        if (liquidity > 0n) positions.push({ manager: "npm", owner: (decodeFunctionResult({ abi: npmAbi, functionName: "ownerOf", data: owner }) as string).toLowerCase(), tokenId: id, tickLower: Number(decoded[5]), tickUpper: Number(decoded[6]), liquidity, salt: "0x" });
      });
    }
    return positions;
  }
  const logs = await reader.logs({ address: CHAIN.poolManager, topics: [TOPIC.v4ModifyLiquidity, launch.pool] }, launch.block, block);
  const direct = new Map<string, LiquidityPosition>();
  const posmIds = new Set<bigint>();
  for (const log of logs) {
    const sender = topicAddress(log.topics[2]);
    const lower = Number(signed(word(log.data, 0), 256)), upper = Number(signed(word(log.data, 1), 256));
    const delta = signed(word(log.data, 2), 256);
    const salt = `0x${log.data.slice(2 + 3 * 64, 2 + 4 * 64)}` as Hex;
    if (sender === CHAIN.v4PositionManager) { posmIds.add(BigInt(salt)); continue; }
    const key = `${sender}:${lower}:${upper}:${salt}`;
    const position = direct.get(key) ?? { manager: "direct" as const, owner: sender, tokenId: null, tickLower: lower, tickUpper: upper, liquidity: 0n, salt };
    position.liquidity += delta;
    direct.set(key, position);
  }
  positions.push(...[...direct.values()].filter((position) => position.liquidity > 0n));
  const ids = [...posmIds];
  if (ids.length) {
    const results = await multicall(reader.ethCall, block, ids.flatMap((id) => [
      { target: CHAIN.v4PositionManager, data: encodeFunctionData({ abi: posmAbi, functionName: "getPositionLiquidity", args: [id] }) },
      { target: CHAIN.v4PositionManager, data: encodeFunctionData({ abi: posmAbi, functionName: "ownerOf", args: [id] }) },
      { target: CHAIN.v4PositionManager, data: encodeFunctionData({ abi: posmAbi, functionName: "positionInfo", args: [id] }) },
    ]));
    ids.forEach((id, index) => {
      const [liquidityData, owner, info] = [results[index * 3], results[index * 3 + 1], results[index * 3 + 2]];
      if (!liquidityData || !owner || !info) return;
      const liquidity = decodeFunctionResult({ abi: posmAbi, functionName: "getPositionLiquidity", data: liquidityData }) as bigint;
      const ticks = decodePositionInfo(decodeFunctionResult({ abi: posmAbi, functionName: "positionInfo", data: info }) as bigint);
      if (liquidity > 0n) positions.push({ manager: "posm", owner: (decodeFunctionResult({ abi: posmAbi, functionName: "ownerOf", data: owner }) as string).toLowerCase(), tokenId: id, ...ticks, liquidity, salt: `0x${id.toString(16).padStart(64, "0")}` as Hex });
    });
  }
  return positions;
}

/**
 * Inbound USDC (at least the dust threshold, from non-hub senders) to each address inside its own window.
 * Addresses are grouped by window end so one query serves many of them without spanning the whole token history.
 */
async function tracedInbound(reader: ChainReader, windows: Map<string, { start: number; until: number; amount: bigint | null }>) {
  const BUCKET = 40_000;
  const buckets = new Map<number, string[]>();
  for (const [address, window] of windows) {
    const bucket = Math.floor(window.until / BUCKET);
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), address]);
  }
  const out: UsdcTransfer[] = [];
  const keep = (transfer: UsdcTransfer) => {
    const window = windows.get(transfer.to);
    if (!window || transfer.block < window.start || transfer.block > window.until || transfer.value < PARAMS.dustUsdc || isHub(transfer.from) || transfer.from === transfer.to) return false;
    return window.amount == null || Number(transfer.value) >= PARAMS.materialShare * Number(window.amount);
  };
  if (reader.usdcInbound) {
    for (const [address, window] of windows) {
      // The smallest value that can pass the materiality test (rounded down, so the exact test below still decides).
      const material = window.amount == null ? 0n : BigInt(Math.floor(PARAMS.materialShare * Number(window.amount)));
      const minimum = material > PARAMS.dustUsdc ? material : PARAMS.dustUsdc;
      for (const transfer of decodeUsdc(await reader.usdcInbound(address, window.start, window.until, minimum))) if (keep(transfer)) out.push(transfer);
    }
    return out;
  }
  for (const addresses of buckets.values()) {
    for (let index = 0; index < addresses.length; index += 200) {
      const group = addresses.slice(index, index + 200);
      const from = group.reduce((min, address) => Math.min(min, windows.get(address)!.start), Infinity);
      const to = group.reduce((max, address) => Math.max(max, windows.get(address)!.until), 0);
      const logs = await reader.logs({ address: [CHAIN.usdc, NATIVE_EMITTER], topics: [TOPIC.transfer, null, group.map(padAddress)] }, from, to);
      for (const transfer of decodeUsdc(logs)) if (keep(transfer)) out.push(transfer);
    }
  }
  return out;
}

async function outboundUsdc(reader: ChainReader, wallets: string[], from: number, to: number) {
  let out: UsdcTransfer[] = [];
  for (let index = 0; index < wallets.length; index += 200) {
    const topics = wallets.slice(index, index + 200).map(padAddress);
    out = out.concat(decodeUsdc(await reader.logs({ address: [CHAIN.usdc, NATIVE_EMITTER], topics: [TOPIC.transfer, topics] }, from, to)).filter((transfer) => transfer.value >= PARAMS.dustUsdc && !isHub(transfer.to)));
  }
  return out;
}

export interface CodeFacts { implementation: string | null; templateHash: string }
export async function codeFacts(reader: ChainReader, address: string, block: number): Promise<CodeFacts & { code: Hex }> {
  const code = await reader.code(address, block);
  const implementation = cloneTarget(code);
  const runtime = implementation ? await reader.code(implementation, block) : code;
  return { code: runtime, implementation, templateHash: templateHash(runtime) };
}

export interface GatherOptions {
  /** Earliest block whose logs the reader can serve; funding traces before it are truncated and flagged. */
  historyFloor?: number;
  /** Nonce answers already known (address -> per-block counts), shared across tokens by long-running callers. */
  nonceCache?: Map<string, number>;
}

/** Everything the facts layer needs about `launch` at block `block`. */
export async function gatherEvidence(reader: ChainReader, launch: LaunchInfo, block: number, options: GatherOptions = {}): Promise<Evidence> {
  const swapFilter: LogFilter = launch.protocol === "v3" ? { address: launch.pool, topics: [TOPIC.v3Swap] } : { address: CHAIN.poolManager, topics: [TOPIC.v4Swap, launch.pool] };
  const [timestamp, creationTimestamp, transferLogs, swapLogs, positions, tokenCode, hookCode] = await Promise.all([
    reader.timestamp(block),
    reader.timestamp(launch.block),
    reader.logs({ address: launch.token, topics: [TOPIC.transfer] }, launch.block, block),
    reader.logs(swapFilter, launch.block, block),
    readPositions(reader, launch, block),
    codeFacts(reader, launch.token, block),
    launch.hooks !== "0x0000000000000000000000000000000000000000" ? codeFacts(reader, launch.hooks, block) : Promise.resolve(null),
  ]);
  const transfers = decodeTransfers(transferLogs);
  const swaps = decodeSwaps(swapLogs, launch);

  // Purchases and sales as the entity layer defines them (net token delta in a transaction with a market leg).
  const marketAddress = launch.protocol === "v3" ? launch.pool : CHAIN.poolManager;
  const act = activity({ launch, block, transfers } as Evidence, rolesFor(launch));
  const firstBuy = new Map([...act.firstPurchase].map(([address, purchase]) => [address, purchase.block] as const));
  const firstSell = act.firstSale;

  // Funding, traced back hop by hop. Every transfer on a wallet's path must fall inside the one lookback
  // window that ends at the wallet's first purchase; each address is queried only over the windows it serves.
  const lookback = PARAMS.fundingLookbackBlocks;
  const fundingFrom = Math.max(launch.block - lookback, options.historyFloor ?? 0);
  const funding: UsdcTransfer[] = [];
  const spentIn = new Map<string, bigint>();
  for (const swap of swaps) if (swap.buy) spentIn.set(swap.tx, (spentIn.get(swap.tx) ?? 0n) + swap.usdc);
  let frontier = new Map([...act.firstPurchase].map(([address, purchase]) => [address, { start: Math.max(purchase.block - lookback, fundingFrom), until: purchase.block, amount: spentIn.get(purchase.tx) ?? null }] as const));
  const traced = new Set(frontier.keys());
  // Funding is traced only into accounts without contract code (EIP-7702 delegations count as accounts): a
  // transfer from a contract links the recipient to it, but the contract's own inflows (a router's or a pool's
  // every user) are not followed (Appendix A.3, method 2.0.2).
  const accountsOnly = async (candidates: typeof frontier) => {
    const kinds = await codeKinds(reader.ethCall, [...candidates.keys()], block);
    return new Map([...candidates].filter(([address]) => kinds.get(address) !== 2));
  };
  frontier = await accountsOnly(frontier);
  for (let hop = 1; hop <= PARAMS.fundingDepth && frontier.size; hop++) {
    const found = await tracedInbound(reader, frontier);
    for (const transfer of found) funding.push(transfer);
    const next = new Map<string, { start: number; until: number; amount: bigint | null }>();
    for (const transfer of found) {
      if (traced.has(transfer.from)) continue;
      const window = frontier.get(transfer.to)!;
      const known = next.get(transfer.from);
      // Only funding that carried at least half of what the recipient spent is followed (the entity layer applies the same test).
      const smallest = known?.amount != null && known.amount < transfer.value ? known.amount : transfer.value;
      next.set(transfer.from, { start: Math.min(known?.start ?? Infinity, window.start), until: Math.max(known?.until ?? 0, transfer.block), amount: smallest });
    }
    for (const address of next.keys()) traced.add(address);
    frontier = hop < PARAMS.fundingDepth ? await accountsOnly(next) : next;
  }
  const sellers = [...firstSell.keys()];
  const proceeds = sellers.length ? await outboundUsdc(reader, sellers, [...firstSell.values()].reduce((min, value) => Math.min(min, value), Infinity), block) : [];

  // Address history, read only where the independence test can turn on it: holders outside the lower-bound
  // set whose first purchase came after the launch window (everyone else fails regardless), then the direct
  // funders of those that pass the history test. The count at creation is read only after the earlier
  // count shows activity, since both are required.
  const history: Record<string, AddressHistory> = {};
  const preliminary = insiderSets({ launch, block, timestamp, creationTimestamp, transfers, swaps, positions, funding, proceeds, history: {}, fundingFrom, code: { tokenTemplate: null, hookTemplate: null, tokenCodeHash: "", hookCodeHash: null } }, rolesFor(launch));
  const candidates = [...preliminary.holders.keys()].filter((address) => !preliminary.lower.has(address) && (act.firstPurchase.get(address)?.block ?? 0) > launch.block + PARAMS.launchWindowBlocks);
  if (candidates.length) {
    const marginBlock = await reader.blockAt(creationTimestamp - PARAMS.historyMargin);
    const atCreation = launch.block - 1;
    const cache = options.nonceCache ?? new Map<string, number>();
    const key = (address: string, at: number) => `${address}@${at}`;
    const read = async (addresses: string[], at: number) => {
      const needed = addresses.filter((address) => !cache.has(key(address, at)));
      const answers = needed.length ? await reader.nonces(needed.map((address) => ({ address, block: at }))) : [];
      needed.forEach((address, index) => { if (answers[index] != null) cache.set(key(address, at), answers[index]!); });
    };
    const resolveHistory = async (addresses: string[]) => {
      await read(addresses, marginBlock);
      const active = addresses.filter((address) => (cache.get(key(address, marginBlock)) ?? 0) >= 1);
      await read(active, atCreation);
      for (const address of addresses) {
        const before = cache.get(key(address, marginBlock));
        if (before == null) continue;
        history[address] = { beforeMargin: before, atCreation: before >= 1 ? cache.get(key(address, atCreation)) ?? null : null };
      }
    };
    await resolveHistory(candidates);
    const passed = new Set(candidates.filter((address) => (history[address]?.beforeMargin ?? 0) >= 1 && (history[address]?.atCreation ?? 0) >= PARAMS.historyMinTx));
    const funders = [...new Set(funding.filter((transfer) => passed.has(transfer.to)).map((transfer) => transfer.from))];
    if (funders.length) await resolveHistory(funders);
  }

  const tokenTemplate = templateFor("token", { address: launch.token, implementation: tokenCode.implementation, templateHash: tokenCode.templateHash });
  const hookTemplate = hookCode ? templateFor("hook", { address: launch.hooks, implementation: hookCode.implementation, templateHash: hookCode.templateHash }) : null;
  return {
    launch, block, timestamp, creationTimestamp, transfers, swaps, positions, funding, proceeds, history, fundingFrom,
    code: { tokenTemplate: tokenTemplate?.id ?? null, hookTemplate: hookTemplate?.id ?? null, tokenCodeHash: tokenCode.templateHash, hookCodeHash: hookCode?.templateHash ?? null },
  };
}
