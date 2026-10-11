/**
 * Resolution of a forecast record (paper Section 5.1, Appendix A.4). Every rule is a deterministic
 * function of chain state between the forecast block h and h + H, so any two archive nodes agree.
 */
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import { CHAIN } from "../launchpads";
import { readPositions, decodeSwaps, decodeTransfers, multicall, TOPIC, type ChainReader, type RawLog } from "./evidence";
import { positionAmounts } from "./liquidity";
import { PARAMS } from "./params";
import { rolesFor } from "./registry";
import { holdValue } from "./simulate";
import type { LaunchInfo, LiquidityPosition } from "./types";

export interface ChannelResolution { fired: boolean; block: number | null; realised: number | null }
export interface Resolution {
  horizonBlock: number;
  T: ChannelResolution; L: ChannelResolution; I: ChannelResolution;
  /** USDC per 100 the reference position returns when sold at h + H. */
  recoveryAtHorizon: number;
  severeLoss: boolean;
  /** Share of the pessimistic set's tokens at h that left the set by h + H. */
  insiderOutflow: number;
  /** Share of quote-side liquidity at h withdrawn by position owners by h + H. */
  liquidityWithdrawn: number;
}

export interface ResolveInput {
  launch: LaunchInfo;
  block: number;
  /** Tokens the reference purchase returned at h. */
  referenceTokens: bigint;
  /** Pessimistic insider set at h with balances. */
  pessimistic: Map<string, bigint>;
  /** Positions at h. */
  positions: LiquidityPosition[];
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const stateView = parseAbi(["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"]);

export async function resolveRecord(reader: ChainReader, input: ResolveInput): Promise<Resolution> {
  const { launch, block } = input;
  const start = await reader.timestamp(block);
  const end = await reader.blockAt(start + PARAMS.horizon);
  // The reference position bought at h and held, valued by buying it at the block in question and selling it
  // straight back, so the pool includes its own purchase (Appendix A.5).
  const sellAt = async (at: number) => {
    const value = await holdValue(reader.ethCall, launch, at, input.referenceTokens, PARAMS.notional);
    return { recovery: value.recovery, reverted: !value.ok };
  };
  if ((await sellAt(block)).reverted) throw new Error("the reference position cannot be bought and sold at the forecast block");

  // Insider exit: net outflow of the pessimistic set's tokens to the market or to addresses outside the set.
  const transfers = decodeTransfers(await reader.logs({ address: launch.token, topics: [TOPIC.transfer] }, block + 1, end));
  const members = input.pessimistic;
  const held = [...members.values()].reduce((sum, value) => sum + value, 0n);
  let outflow = 0n;
  let insiderBlock: number | null = null;
  const roles = rolesFor(launch);
  for (const transfer of transfers) {
    const fromMember = members.has(transfer.from), toMember = members.has(transfer.to);
    if (fromMember && !toMember && !roles.isInfrastructure(transfer.to)) outflow += transfer.value;
    if (toMember && !fromMember && roles.isMarket(transfer.from)) outflow -= transfer.value;
    if (insiderBlock == null && held > 0n && Number(outflow) >= PARAMS.insiderShare * Number(held)) insiderBlock = transfer.block;
  }

  // Liquidity: quote-side amounts withdrawn by owners, against the quote-side liquidity present at h.
  const quoteAtH = await quoteLiquidity(reader, launch, input.positions, block);
  const withdrawals = await liquidityWithdrawals(reader, launch, block + 1, end);
  let withdrawn = 0n;
  let liquidityBlock: number | null = null;
  for (const item of withdrawals) {
    withdrawn += item.usdc;
    if (liquidityBlock == null && quoteAtH > 0n && Number(withdrawn) >= PARAMS.liquidityShare * Number(quoteAtH)) liquidityBlock = item.block;
  }

  // Tradability: the reference position cannot be sold at the horizon while the pool still holds quote liquidity.
  // No registered template has a privileged parameter that changes a sale, so a failed sale is the only route.
  const horizon = await sellAt(end);
  const tradabilityBlock = horizon.reverted && (await quoteLiquidity(reader, launch, await readPositions(reader, launch, end), end)) > 0n ? end : null;

  const realised = async (at: number | null) => {
    if (at == null) return null;
    const [before, after] = await Promise.all([sellAt(at - 1), sellAt(at)]);
    return before.recovery > 0 ? (100 * after.recovery) / before.recovery : 0;
  };
  return {
    horizonBlock: end,
    T: { fired: tradabilityBlock != null, block: tradabilityBlock, realised: await realised(tradabilityBlock) },
    L: { fired: liquidityBlock != null, block: liquidityBlock, realised: await realised(liquidityBlock) },
    I: { fired: insiderBlock != null, block: insiderBlock, realised: await realised(insiderBlock) },
    recoveryAtHorizon: horizon.recovery,
    severeLoss: horizon.recovery <= PARAMS.severeLossUsdc,
    insiderOutflow: held > 0n ? Math.max(0, Number(outflow) / Number(held)) : 0,
    liquidityWithdrawn: quoteAtH > 0n ? Number(withdrawn) / Number(quoteAtH) : 0,
  };
}


/** Quote-side (USDC) liquidity: the V3 pool's USDC balance, or the USDC held by V4 positions at the pool price. */
export async function quoteLiquidity(reader: ChainReader, launch: LaunchInfo, positions: LiquidityPosition[], block: number): Promise<bigint> {
  if (launch.protocol === "v3") {
    const [balance] = await multicall(reader.ethCall, block, [{ target: CHAIN.usdc, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [launch.pool as Hex] }) }]);
    return balance ? BigInt(balance) : 0n;
  }
  const [slot0] = await multicall(reader.ethCall, block, [{ target: CHAIN.stateView, data: encodeFunctionData({ abi: stateView, functionName: "getSlot0", args: [launch.pool as Hex] }) }]);
  if (!slot0) return 0n;
  const sqrtPrice = BigInt(`0x${slot0.slice(2, 66)}`);
  let total = 0n;
  for (const position of positions) {
    const amounts = positionAmounts(position.liquidity, position.tickLower, position.tickUpper, sqrtPrice);
    total += launch.usdcIs0 ? amounts.amount0 : amounts.amount1;
  }
  return total;
}

/** Liquidity removals in (from, to]: V3 Burn events carry amounts; V4 removals are valued at the price of the last swap before them. */
async function liquidityWithdrawals(reader: ChainReader, launch: LaunchInfo, from: number, to: number) {
  if (launch.protocol === "v3") {
    const logs = await reader.logs({ address: launch.pool, topics: [TOPIC.v3Burn] }, from, to);
    return logs.map((log) => ({ block: Number(log.blockNumber), usdc: BigInt(`0x${log.data.slice(2 + (launch.usdcIs0 ? 1 : 2) * 64, 2 + (launch.usdcIs0 ? 2 : 3) * 64)}`) }))
      .filter((item) => item.usdc > 0n);
  }
  const [modify, swaps] = await Promise.all([
    reader.logs({ address: CHAIN.poolManager, topics: [TOPIC.v4ModifyLiquidity, launch.pool] }, from, to),
    reader.logs({ address: CHAIN.poolManager, topics: [TOPIC.v4Swap, launch.pool] }, from, to),
  ]);
  const prices = decodeSwaps(swaps, launch);
  const [slot0] = await multicall(reader.ethCall, from - 1, [{ target: CHAIN.stateView, data: encodeFunctionData({ abi: stateView, functionName: "getSlot0", args: [launch.pool as Hex] }) }]);
  let price = slot0 ? BigInt(`0x${slot0.slice(2, 66)}`) : 0n;
  const out: Array<{ block: number; usdc: bigint }> = [];
  let cursor = 0;
  for (const log of modify as RawLog[]) {
    const at = Number(log.blockNumber);
    while (cursor < prices.length && prices[cursor].block <= at) price = prices[cursor++].sqrtPriceX96;
    const word = (index: number) => BigInt(`0x${log.data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
    const signed = (value: bigint) => (value >= 1n << 255n ? value - (1n << 256n) : value);
    const delta = signed(word(2));
    if (delta >= 0n) continue;
    const amounts = positionAmounts(-delta, Number(signed(word(0))), Number(signed(word(1))), price);
    out.push({ block: at, usdc: launch.usdcIs0 ? amounts.amount0 : amounts.amount1 });
  }
  return out;
}
