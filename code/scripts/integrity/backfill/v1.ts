/**
 * v1 at a forecast block, for the baselines B1 and B2 (paper Section 7.3): the same dossier and the same
 * `assess` the site ran until 8 October 2026, fed from the backfill store instead of live nodes. Wallet
 * records (the smart-money factor) needed 24 hours of every holder's trades across all launches and are
 * not reconstructed, so the score is the one v1 showed before wallet records loaded (deviation D9).
 */
import { encodeFunctionData, parseAbi, type Hex } from "viem";
import type { CreatorLaunch, LaunchRecord } from "../../../lib/api";
import { dossierFrom, readFees } from "../../../lib/dossier";
import { decodeSwaps, NATIVE_EMITTER, padAddress, TOPIC, type ChainReader, type RawLog } from "../../../lib/integrity/evidence";
import type { LaunchInfo } from "../../../lib/integrity/types";
import { CHAIN, sqrtPriceToUsdc } from "../../../lib/launchpads";
import type { ChainLog } from "../../../lib/rpc";
import { call } from "../archive";
import type { DiscoveredLaunch } from "../launches";
import { assess } from "../baselines/v1";

const toChainLog = (log: RawLog): ChainLog => ({ address: log.address.toLowerCase(), topics: log.topics, data: log.data, block: Number(log.blockNumber), index: Number(log.logIndex), tx: log.transactionHash.toLowerCase(), txIndex: 0 });
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const receipts = new Map<string, Array<{ address: string; topics: string[]; data: string; logIndex: string; blockNumber: string; transactionHash: string }>>();
const peaks = new Map<string, number>();

function record(raw: DiscoveredLaunch, ts: number): LaunchRecord {
  return {
    token: raw.token, launchpad: raw.launchpad, creator: raw.creator, symbol: raw.symbol, name: raw.name, decimals: raw.decimals,
    supply: Number(BigInt(raw.supply) / 10n ** BigInt(raw.decimals)), protocol: raw.protocol, pool: raw.pool.toLowerCase(), fee: raw.fee,
    tick_spacing: raw.tickSpacing, hooks: raw.hooks, usdc_is0: raw.usdcIs0 ? 1 : 0, block: raw.block, tx: raw.tx, ts, price: 0, ath_mcap: 0,
    liquidity: 0, volume: 0, trades: 0, last_trade: 0, creator_launches: 0, creator_best: 0,
  };
}

/** Peak market cap of a launch up to a block, from its stored swaps. */
async function peakOf(reader: ChainReader, raw: DiscoveredLaunch, until: number) {
  const key = `${raw.pool}@${until}`;
  if (peaks.has(key)) return peaks.get(key)!;
  const info = { protocol: raw.protocol, usdcIs0: raw.usdcIs0 } as LaunchInfo;
  const filter = raw.protocol === "v3" ? { address: raw.pool, topics: [TOPIC.v3Swap] } : { address: CHAIN.poolManager, topics: [TOPIC.v4Swap, raw.pool] };
  const swaps = decodeSwaps(await reader.logs(filter, raw.block, until), info);
  const supply = Number(BigInt(raw.supply) / 10n ** BigInt(raw.decimals));
  const peak = swaps.reduce((max, swap) => Math.max(max, sqrtPriceToUsdc(swap.sqrtPriceX96, raw.usdcIs0, raw.decimals) * supply), 0);
  peaks.set(key, peak);
  return peak;
}

export async function v1At(reader: ChainReader, raw: DiscoveredLaunch, block: number, timestamp: number, creationTs: number, earlier: DiscoveredLaunch[]) {
  const launch = record(raw, creationTs);
  const swapFilter = raw.protocol === "v3" ? { address: launch.pool, topics: [TOPIC.v3Swap] } : { address: CHAIN.poolManager, topics: [TOPIC.v4Swap, launch.pool] };
  const [transfers, swaps] = await Promise.all([
    reader.logs({ address: launch.token, topics: [TOPIC.transfer] }, launch.block, block),
    reader.logs(swapFilter, launch.block, block),
  ]);
  if (!receipts.has(launch.tx)) receipts.set(launch.tx, (await call<{ logs: Array<{ address: string; topics: string[]; data: string; logIndex: string; blockNumber: string; transactionHash: string }> }>("eth_getTransactionReceipt", [launch.tx])).logs);
  const mints = receipts.get(launch.tx)!.filter((log) => [CHAIN.v3PositionManager, CHAIN.v4PositionManager].includes(log.address.toLowerCase() as never) && log.topics[0] === TOPIC.transfer && log.topics.length === 4 && BigInt(log.topics[1]) === 0n)
    .map((log) => toChainLog({ ...log, logIndex: log.logIndex, blockNumber: log.blockNumber }));
  const dossier = await dossierFrom(launch, {
    head: { number: block, timestamp }, now: timestamp, partial: false,
    transfers: transfers.map(toChainLog), swaps: swaps.map(toChainLog), positions: mints,
    funding: async (wallets) => (await reader.logs({ address: [CHAIN.usdc, NATIVE_EMITTER], topics: [TOPIC.transfer, null, wallets.map(padAddress)] }, Math.max(0, launch.block - 100_000), launch.block + 20)).map(toChainLog),
    codeOf: (address) => reader.code(address, block),
    hookAllowed: async () => true,
    fees: () => readFees(launch),
  });
  let liquidity: number;
  if (raw.protocol === "v3") {
    const balance = await reader.ethCall({ to: CHAIN.usdc, data: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [launch.pool as Hex] }), gas: 1_000_000n }, block, {});
    liquidity = Number(BigInt(balance)) / 1e6;
  } else {
    liquidity = Math.max(0, dossier.trades.reduce((sum, trade) => sum + (trade.buy ? trade.usd : -trade.usd), 0));
  }
  const marketCap = dossier.market.price * launch.supply;
  const history: CreatorLaunch[] = [];
  for (const item of earlier.slice(-100)) {
    const peak = await peakOf(reader, item, block);
    history.push({ token: item.token, launchpad: item.launchpad, symbol: item.symbol, name: item.name, ts: 0, price: 0, supply: 0, ath_mcap: peak, liquidity: 0, volume: 0, trades: 0, last_trade: 0 });
  }
  const out: Record<string, unknown> = {};
  for (const version of ["2026-10-01", "2026-10-07"] as const) {
    const result = assess({ dossier, liquidity, marketCap, creatorLaunches: history, version, now: timestamp });
    out[version] = { score: result.score, verdict: result.verdict, caps: result.caps, factors: Object.fromEntries(result.factors.map((factor) => [factor.id, factor.points])) };
  }
  return { ...out, liquidity, marketCap, insiderShare: dossier.market.insiderShare, top10Share: dossier.top10Share, holders: dossier.holderCount };
}
