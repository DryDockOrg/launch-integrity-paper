import { erc20Abi, parseAbi, toEventSelector, type Address } from "viem";
import type { LaunchRecord } from "./api";
import { CHAIN, KNOWN_ADDRESSES, launchpadById, sqrtPriceToUsdc, swapSide } from "./launchpads";
import { getLogs, headBlock, rpc, type ChainLog } from "./rpc";

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const V3_SWAP = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)");
const V4_SWAP = toEventSelector("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
/** EIP-7708 system emitter for native USDC movements on Arc. */
const NATIVE_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
/** Buys this close to the launch block are "early": about ten seconds on Arc. */
export const EARLY_BLOCKS = 20;

export interface Trade { block: number; index: number; tx: string; ts: number; buy: boolean; usd: number; tokens: number; price: number; trader: string | null }
export interface Holder { address: string; balance: number; share: number; label: string | null; firstBlock: number }
export interface EarlyBuyer { address: string; block: number; offset: number; spent: number; bought: number; holds: number; holdsShare: number; funder: string | null }
export interface Cluster { funder: string; wallets: string[]; label: string | null }

export interface Dossier {
  head: number;
  partial: boolean; // launch is older than public nodes retain; holder balances may be incomplete
  trades: Trade[];
  holders: Holder[];
  holderCount: number;
  top10Share: number; // excluding pools, lockers, routers, burn
  launchAllocation: Array<{ address: string; amount: number; share: number; label: string | null }>;
  creator: { launchShare: number; boughtTokens: number; soldTokens: number; peak: number; holds: number; holdsShare: number; firstSell: number | null; sellUsd: number; buyUsd: number; earlyBuyUsd: number; minutesToFirstSell: number | null };
  early: EarlyBuyer[];
  sameBlockBuyers: number;
  clusters: Cluster[];
  custody: { kind: "burned" | "launchpad" | "wallet" | "contract" | "none"; owner: string | null; label: string };
  hook: { address: string; allowedByRouter: boolean | null; flags: string[] } | null;
  flow: { m15: Flow; h1: Flow; h6: Flow; h24: Flow };
  market: Market;
  fees: Fees;
}

/** What a trade costs, read from the pool and its hook. Basis points. */
export interface Fees {
  poolBps: number; // LP fee
  buyTaxBps: number | null; // hook tax on buys, null when not readable
  sellTaxBps: number | null;
  antiSnipe: { startBps: number; endsAt: number } | null; // o1-style launch surcharge
}
export interface Flow { buys: number; sells: number; buyUsd: number; sellUsd: number; buyers: number; sellers: number }

/** Market-structure measures traders use to judge whether activity is real and supply is safe. */
export interface Market {
  price: number;
  athPrice: number;
  drawdown: number; // 0..1 below the highest traded price
  change5m: number; change1h: number; change6h: number; // fractions
  insiderShare: number; // supply now held by the creator, launch-window buyers, and wallets sharing their funders
  earlyShare: number; // supply now held by launch-window buyers
  earlyExited: number; // share of launch-window buyers that have sold everything
  washShare: number; // share of 24h volume from wallets that buy and sell nearly equal amounts repeatedly
  top3VolumeShare: number; // share of 24h volume from the three most active wallets
  newHolders1h: number; newHolders6h: number;
  medianBuy1h: number;
  acceleration: number; // last 15 minutes' volume rate divided by the last hour's rate
}

const topicAddress = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();
const word = (data: string, index: number) => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
const signed = (value: bigint, bits: number) => (value >= 1n << BigInt(bits - 1) ? value - (1n << BigInt(bits)) : value);
const padAddress = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** Labels for addresses that hold tokens without being traders. */
function labeller(launch: LaunchRecord) {
  const pad = launchpadById(launch.launchpad);
  const labels = new Map<string, string>(Object.entries(KNOWN_ADDRESSES).map(([address, label]) => [address.toLowerCase(), label]));
  if (launch.protocol === "v3") labels.set(launch.pool.toLowerCase(), "Uniswap V3 pool");
  if (launch.hooks && launch.hooks !== ZERO) labels.set(launch.hooks.toLowerCase(), "Pool hook");
  for (const entry of pad?.entry ?? []) labels.set(entry.toLowerCase(), `${pad!.name} launch contract`);
  return (address: string) => labels.get(address) ?? null;
}

export async function buildDossier(launch: LaunchRecord, now = Date.now() / 1000): Promise<Dossier> {
  const head = await headBlock();
  const token = launch.token.toLowerCase();
  const swapQuery = launch.protocol === "v3"
    ? { address: launch.pool, topics: [V3_SWAP] }
    : { address: CHAIN.poolManager, topics: [V4_SWAP, launch.pool] };
  const [transfers, swaps, positions] = await Promise.all([
    getLogs({ address: token, topics: [TRANSFER] }, launch.block, head.number),
    getLogs(swapQuery, launch.block, head.number),
    getLogs({ address: [CHAIN.v3PositionManager, CHAIN.v4PositionManager], topics: [TRANSFER, padAddress(ZERO)] }, launch.block, launch.block),
  ]);
  return dossierFrom(launch, {
    head, now, partial: transfers.partial, transfers: transfers.logs, swaps: swaps.logs, positions: positions.logs,
    funding: async (wallets) => (await getLogs({ address: [CHAIN.usdc, NATIVE_EMITTER], topics: [TRANSFER, null, wallets.map(padAddress)] }, launch.block - 100_000, launch.block + EARLY_BLOCKS).catch(() => null))?.logs ?? [],
    codeOf: (address) => rpc().getCode({ address: address as Address }).then((code) => code ?? "0x").catch(() => "0x"),
    hookAllowed: () => rpc().readContract({ address: CHAIN.swapRouter, abi: parseAbi(["function isHookAllowed(address) view returns (bool)"]), functionName: "isHookAllowed", args: [launch.hooks as Address] }).catch(() => null),
    fees: () => readFees(launch),
  });
}

/** What a dossier is built from; the browser fetches it live, the v1 baseline reads it from the v2 backfill store. */
export interface DossierSources {
  head: { number: number; timestamp: number };
  now: number;
  partial: boolean;
  transfers: ChainLog[];
  swaps: ChainLog[];
  /** Position-NFT mints in the launch block. */
  positions: ChainLog[];
  /** USDC transfers into the given wallets from 100,000 blocks before the launch to 20 blocks after it. */
  funding(wallets: string[]): Promise<ChainLog[]>;
  codeOf(address: string): Promise<string>;
  hookAllowed(): Promise<boolean | null>;
  fees(): Promise<Fees>;
}

export async function dossierFrom(launch: LaunchRecord, sources: DossierSources): Promise<Dossier> {
  const { head, now } = sources;
  const transfers = { logs: sources.transfers, partial: sources.partial };
  const swaps = { logs: sources.swaps };
  const positions = { logs: sources.positions };
  const label = labeller(launch);
  const infra = (address: string) => label(address) !== null && address !== launch.creator;
  const scale = 10 ** launch.decimals;
  const time = (block: number) => head.timestamp - (head.number - block) / 2;

  // Balances and per-transaction token deltas from the complete transfer history.
  const balances = new Map<string, bigint>();
  const firstSeen = new Map<string, number>();
  const txDeltas = new Map<string, Map<string, bigint>>();
  for (const log of transfers.logs) {
    if (log.topics.length < 3) continue;
    const from = topicAddress(log.topics[1]), to = topicAddress(log.topics[2]);
    const value = word(log.data, 0);
    balances.set(from, (balances.get(from) ?? 0n) - value);
    balances.set(to, (balances.get(to) ?? 0n) + value);
    if (!firstSeen.has(to)) firstSeen.set(to, log.block);
    const deltas = txDeltas.get(log.tx) ?? new Map<string, bigint>();
    deltas.set(from, (deltas.get(from) ?? 0n) - value);
    deltas.set(to, (deltas.get(to) ?? 0n) + value);
    txDeltas.set(log.tx, deltas);
  }
  balances.delete(ZERO);

  // Trades, attributed to the wallet whose token balance moved most in that transaction.
  const trades: Trade[] = [];
  for (const log of swaps.logs) {
    // ABI encoding sign-extends int128 to a full word, so both protocols decode as int256.
    const amount0 = signed(word(log.data, 0), 256);
    const amount1 = signed(word(log.data, 1), 256);
    const sqrt = word(log.data, 2);
    const usdcIs0 = Boolean(launch.usdc_is0);
    const { buy, usd } = swapSide(launch.protocol, usdcIs0 ? amount0 : amount1);
    const tokenDelta = usdcIs0 ? amount1 : amount0;
    const tokens = Number(tokenDelta < 0n ? -tokenDelta : tokenDelta) / scale;
    const price = sqrtPriceToUsdc(sqrt, usdcIs0, launch.decimals);
    if (!(usd > 0) || !(tokens > 0)) continue;
    let trader: string | null = null;
    let best = 0n;
    for (const [address, delta] of txDeltas.get(log.tx) ?? []) {
      if (infra(address) && address !== launch.creator) continue;
      const directional = buy ? delta : -delta;
      if (directional > best) { best = directional; trader = address; }
    }
    trades.push({ block: log.block, index: log.index, tx: log.tx, ts: time(log.block), buy, usd, tokens, price, trader });
  }

  // Holders.
  const supply = launch.supply;
  const holders: Holder[] = [...balances.entries()]
    .filter(([, balance]) => balance > 0n)
    .map(([address, balance]) => ({ address, balance: Number(balance) / scale, share: supply ? Number(balance) / scale / supply : 0, label: label(address) ?? (address === launch.creator ? "Creator" : null), firstBlock: firstSeen.get(address) ?? 0 }))
    .sort((a, b) => b.balance - a.balance);
  const traders = holders.filter((holder) => !infra(holder.address) && holder.address !== DEAD);
  const top10Share = traders.slice(0, 10).reduce((sum, holder) => sum + holder.share, 0);

  // Where the supply went in the launch transaction.
  const launchTx = transfers.logs.filter((log) => log.tx.toLowerCase() === launch.tx.toLowerCase() && log.topics.length >= 3);
  const allocation = new Map<string, number>();
  for (const log of launchTx) {
    const to = topicAddress(log.topics[2]);
    allocation.set(to, (allocation.get(to) ?? 0) + Number(word(log.data, 0)) / scale);
    const from = topicAddress(log.topics[1]);
    if (from !== ZERO) allocation.set(from, (allocation.get(from) ?? 0) - Number(word(log.data, 0)) / scale);
  }
  const launchAllocation = [...allocation.entries()].filter(([, value]) => value > 0)
    .map(([address, value]) => ({ address, amount: value, share: supply ? value / supply : 0, label: label(address) ?? (address === launch.creator ? "Creator" : null) }))
    .sort((a, b) => b.amount - a.amount);

  // Creator activity.
  const creator = launch.creator.toLowerCase();
  const creatorTrades = trades.filter((trade) => trade.trader === creator);
  let running = 0, peak = 0;
  for (const log of transfers.logs) {
    if (log.topics.length < 3) continue;
    const value = Number(word(log.data, 0)) / scale;
    if (topicAddress(log.topics[2]) === creator) running += value;
    if (topicAddress(log.topics[1]) === creator) running -= value;
    peak = Math.max(peak, running);
  }
  const creatorHolds = Number(balances.get(creator) ?? 0n) / scale;
  const firstSell = creatorTrades.find((trade) => !trade.buy);
  const creatorFacts = {
    launchShare: supply ? (allocation.get(creator) ?? 0) / supply : 0,
    boughtTokens: creatorTrades.filter((trade) => trade.buy).reduce((sum, trade) => sum + trade.tokens, 0),
    soldTokens: creatorTrades.filter((trade) => !trade.buy).reduce((sum, trade) => sum + trade.tokens, 0),
    sellUsd: creatorTrades.filter((trade) => !trade.buy).reduce((sum, trade) => sum + trade.usd, 0),
    peak, holds: creatorHolds, holdsShare: supply ? creatorHolds / supply : 0, firstSell: firstSell?.ts ?? null,
    buyUsd: creatorTrades.filter((trade) => trade.buy).reduce((sum, trade) => sum + trade.usd, 0),
    earlyBuyUsd: creatorTrades.filter((trade) => trade.buy && trade.block - launch.block <= EARLY_BLOCKS).reduce((sum, trade) => sum + trade.usd, 0),
    minutesToFirstSell: firstSell ? (firstSell.block - launch.block) / 120 : null,
  };

  // Early buyers: buys within EARLY_BLOCKS of the launch block, one row per wallet.
  const earlyMap = new Map<string, EarlyBuyer>();
  for (const trade of trades) {
    if (!trade.buy || !trade.trader || trade.block - launch.block > EARLY_BLOCKS || trade.trader === creator) continue;
    const entry = earlyMap.get(trade.trader) ?? { address: trade.trader, block: trade.block, offset: trade.block - launch.block, spent: 0, bought: 0, holds: 0, holdsShare: 0, funder: null };
    entry.spent += trade.usd;
    entry.bought += trade.tokens;
    earlyMap.set(trade.trader, entry);
  }
  const early = [...earlyMap.values()].sort((a, b) => a.block - b.block).slice(0, 40);
  for (const entry of early) {
    entry.holds = Number(balances.get(entry.address) ?? 0n) / scale;
    entry.holdsShare = supply ? entry.holds / supply : 0;
  }
  const sameBlockBuyers = early.filter((entry) => entry.offset === 0).length;

  // Who funded the early wallets: first USDC received in the ~14 hours before launch.
  const clusters: Cluster[] = [];
  if (early.length) {
    const funding = { logs: await sources.funding(early.map((entry) => entry.address)) };
    // The relevant funder is the last USDC transfer each wallet received before buying.
    const firstFunder = new Map<string, string>();
    for (const log of [...funding.logs].reverse()) {
      const to = topicAddress(log.topics[2]);
      const from = topicAddress(log.topics[1]);
      const buyBlock = earlyMap.get(to)?.block ?? launch.block;
      if (log.block > buyBlock || from === ZERO || from === to || KNOWN_ADDRESSES[from] || firstFunder.has(to)) continue;
      firstFunder.set(to, from);
    }
    const byFunder = new Map<string, string[]>();
    for (const entry of early) {
      const funder = firstFunder.get(entry.address) ?? null;
      entry.funder = funder;
      if (funder) byFunder.set(funder, [...(byFunder.get(funder) ?? []), entry.address]);
    }
    for (const [funder, wallets] of byFunder) {
      if (wallets.length >= 2 || funder === creator) clusters.push({ funder, wallets, label: funder === creator ? "Creator" : label(funder) });
    }
    clusters.sort((a, b) => b.wallets.length - a.wallets.length);
  }

  // Liquidity custody: the position NFT minted in the launch transaction.
  const mint = positions.logs.find((log) => log.tx.toLowerCase() === launch.tx.toLowerCase() && log.topics.length >= 3);
  let custody: Dossier["custody"] = { kind: "none", owner: null, label: "No liquidity position NFT was minted in the launch transaction." };
  if (mint) {
    const owner = topicAddress(mint.topics[2]);
    const known = label(owner);
    if (owner === DEAD || owner === ZERO) custody = { kind: "burned", owner, label: "The liquidity position NFT was sent to a burn address at launch. Liquidity cannot be withdrawn." };
    else if (isLaunchpadContract(launch, owner)) custody = { kind: "launchpad", owner, label: `The liquidity position is held by ${known ?? "the launchpad"}, not by a wallet. Whether the launchpad can withdraw it depends on that contract.` };
    else {
      const code = await sources.codeOf(owner);
      custody = code && code !== "0x"
        ? { kind: "contract", owner, label: `The liquidity position is held by contract ${known ?? owner}. It is not a wallet; whether it can withdraw depends on that contract's code.` }
        : { kind: "wallet", owner, label: `The liquidity position is held by a wallet${owner === creator ? " (the creator)" : ""}. That wallet can remove liquidity.` };
    }
  }

  // V4 hook: permissions encoded in its address, and whether the swap router accepts it.
  let hook: Dossier["hook"] = null;
  if (launch.protocol === "v4" && launch.hooks !== ZERO) {
    const allowed = await sources.hookAllowed();
    hook = { address: launch.hooks, allowedByRouter: allowed, flags: hookFlags(launch.hooks) };
  }

  const fees = await sources.fees();
  const insiderSet = new Set<string>([creator, ...early.map((entry) => entry.address), ...clusters.flatMap((cluster) => [cluster.funder, ...cluster.wallets])]);
  const holdingShare = (address: string) => supply ? Number(balances.get(address) ?? 0n) / scale / supply : 0;
  const market = marketStructure(trades, now, {
    insiderShare: [...insiderSet].reduce((sum, address) => sum + Math.max(0, holdingShare(address)), 0),
    earlyShare: early.reduce((sum, entry) => sum + entry.holdsShare, 0),
    earlyExited: early.length ? early.filter((entry) => entry.holds <= entry.bought * 0.01).length / early.length : 0,
    newHolders1h: [...firstSeen.values()].filter((block) => time(block) >= now - 3600).length,
    newHolders6h: [...firstSeen.values()].filter((block) => time(block) >= now - 6 * 3600).length,
  });

  return {
    head: head.number, partial: transfers.partial, trades, holders: holders.slice(0, 100), holderCount: traders.length, top10Share,
    launchAllocation, creator: creatorFacts, early, sameBlockBuyers, clusters, custody, hook,
    flow: { m15: flow(trades, now - 900), h1: flow(trades, now - 3600), h6: flow(trades, now - 6 * 3600), h24: flow(trades, now - 86_400) },
    market,
    fees,
  };
}

const ZERO_HOOK = "0x0000000000000000000000000000000000000000";
const argusAbi = parseAbi(["function buyTaxBps() view returns (uint256)", "function sellTaxBps() view returns (uint256)"]);
const arcoraAbi = parseAbi([
  "function FEE_BIPS() view returns (uint256)",
  "function creatorTax(address) view returns (bool enabled, uint16 buyBps, uint16 sellBps, address creator, uint16 creatorBps, uint16 burnBps, uint16 dividendBps, uint16 liquidityBps)",
]);
const o1Abi = parseAbi(["function poolConfig(bytes32) view returns (bool initialized, bool tokenIsCurrency0, address currentCreator, address creatorFeeRecipient, uint16 baseFeeBps, uint16 antiSnipeStartTotalBps, uint32 antiSnipeWindowSeconds, uint48 launchTime)"]);

/** Buy and sell costs from each launchpad's hook. Unreadable values stay null rather than guessed. */
export async function readFees(launch: LaunchRecord): Promise<Fees> {
  const poolBps = launch.fee === 0x800000 ? 0 : launch.fee / 100;
  const fees: Fees = { poolBps, buyTaxBps: launch.protocol === "v3" ? 0 : null, sellTaxBps: launch.protocol === "v3" ? 0 : null, antiSnipe: null };
  if (launch.protocol !== "v4" || launch.hooks === ZERO_HOOK) return { ...fees, buyTaxBps: 0, sellTaxBps: 0 };
  const hook = launch.hooks as Address;
  try {
    if (launch.launchpad === "argus") {
      const [buy, sell] = await Promise.all([
        rpc().readContract({ address: hook, abi: argusAbi, functionName: "buyTaxBps" }),
        rpc().readContract({ address: hook, abi: argusAbi, functionName: "sellTaxBps" }),
      ]);
      return { ...fees, buyTaxBps: Number(buy), sellTaxBps: Number(sell) };
    }
    if (launch.launchpad === "arcora") {
      const [base, tax] = await Promise.all([
        rpc().readContract({ address: hook, abi: arcoraAbi, functionName: "FEE_BIPS" }),
        rpc().readContract({ address: hook, abi: arcoraAbi, functionName: "creatorTax", args: [launch.token as Address] }),
      ]);
      const [enabled, buyBps, sellBps] = tax;
      return { ...fees, buyTaxBps: Number(base) + (enabled ? buyBps : 0), sellTaxBps: Number(base) + (enabled ? sellBps : 0) };
    }
    if (launch.launchpad === "o1") {
      const config = await rpc().readContract({ address: hook, abi: o1Abi, functionName: "poolConfig", args: [launch.pool as `0x${string}`] });
      const [, , , , baseFeeBps, antiSnipeStartTotalBps, antiSnipeWindowSeconds, launchTime] = config;
      const endsAt = Number(launchTime) + Number(antiSnipeWindowSeconds);
      return { ...fees, buyTaxBps: baseFeeBps, sellTaxBps: baseFeeBps, antiSnipe: antiSnipeStartTotalBps > baseFeeBps ? { startBps: antiSnipeStartTotalBps, endsAt } : null };
    }
  } catch { /* hook without readable fees: leave unknown */ }
  return fees;
}

function priceAt(trades: Trade[], ts: number) {
  let price = 0;
  for (const trade of trades) { if (trade.ts > ts) break; price = trade.price; }
  return price || trades[0]?.price || 0;
}

export function marketStructure(trades: Trade[], now: number, supplyFacts: Pick<Market, "insiderShare" | "earlyShare" | "earlyExited" | "newHolders1h" | "newHolders6h">): Market {
  const price = trades[trades.length - 1]?.price ?? 0;
  const athPrice = trades.reduce((max, trade) => Math.max(max, trade.price), 0);
  const change = (seconds: number) => { const then = priceAt(trades, now - seconds); return then > 0 && price > 0 ? price / then - 1 : 0; };
  const day = trades.filter((trade) => trade.ts >= now - 86_400 && trade.trader);
  const total = day.reduce((sum, trade) => sum + trade.usd, 0);
  const perWallet = new Map<string, { buy: number; sell: number; n: number }>();
  for (const trade of day) {
    const entry = perWallet.get(trade.trader!) ?? { buy: 0, sell: 0, n: 0 };
    if (trade.buy) entry.buy += trade.usd; else entry.sell += trade.usd;
    entry.n++;
    perWallet.set(trade.trader!, entry);
  }
  // Wash pattern: several round trips whose buy and sell legs nearly cancel out.
  const wash = [...perWallet.values()].filter((entry) => entry.n >= 4 && entry.buy > 0 && entry.sell > 0 && Math.abs(entry.buy - entry.sell) / Math.max(entry.buy, entry.sell) < 0.15)
    .reduce((sum, entry) => sum + entry.buy + entry.sell, 0);
  const top3 = [...perWallet.values()].map((entry) => entry.buy + entry.sell).sort((a, b) => b - a).slice(0, 3).reduce((sum, value) => sum + value, 0);
  const volumeSince = (seconds: number) => trades.filter((trade) => trade.ts >= now - seconds).reduce((sum, trade) => sum + trade.usd, 0);
  const hourRate = volumeSince(3600) / 4;
  const buys1h = trades.filter((trade) => trade.buy && trade.ts >= now - 3600).map((trade) => trade.usd).sort((a, b) => a - b);
  return {
    ...supplyFacts,
    price, athPrice, drawdown: athPrice > 0 ? 1 - price / athPrice : 0,
    change5m: change(300), change1h: change(3600), change6h: change(6 * 3600),
    washShare: total > 0 ? wash / total : 0,
    top3VolumeShare: total > 0 ? top3 / total : 0,
    medianBuy1h: buys1h.length ? buys1h[Math.floor(buys1h.length / 2)] : 0,
    acceleration: hourRate > 0 ? volumeSince(900) / hourRate : volumeSince(900) > 0 ? 2 : 0,
  };
}

function isLaunchpadContract(launch: LaunchRecord, address: string) {
  const pad = launchpadById(launch.launchpad);
  return Boolean(pad && (Object.keys(pad.custody).includes(address) || pad.entry.some((entry) => entry.toLowerCase() === address)));
}

function flow(trades: Trade[], since: number): Flow {
  const recent = trades.filter((trade) => trade.ts >= since);
  const buys = recent.filter((trade) => trade.buy), sells = recent.filter((trade) => !trade.buy);
  return {
    buys: buys.length, sells: sells.length,
    buyUsd: buys.reduce((sum, trade) => sum + trade.usd, 0), sellUsd: sells.reduce((sum, trade) => sum + trade.usd, 0),
    buyers: new Set(buys.map((trade) => trade.trader).filter(Boolean)).size, sellers: new Set(sells.map((trade) => trade.trader).filter(Boolean)).size,
  };
}

const HOOK_BITS: Array<[number, string]> = [
  [13, "before initialize"], [12, "after initialize"], [11, "before add liquidity"], [10, "after add liquidity"],
  [9, "before remove liquidity"], [8, "after remove liquidity"], [7, "before swap"], [6, "after swap"],
  [5, "before donate"], [4, "after donate"], [3, "can change swap input"], [2, "can change swap output"],
  [1, "can change added liquidity"], [0, "can change removed liquidity"],
];
export function hookFlags(hooks: string) {
  const bits = BigInt(hooks) & 0x3fffn;
  return HOOK_BITS.filter(([bit]) => (bits >> BigInt(bit)) & 1n).map(([, name]) => name);
}

/** OHLC candles from trades at a given resolution in seconds. */
export function candles(trades: Trade[], resolution: number) {
  const out: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
  for (const trade of trades) {
    const time = Math.floor(trade.ts / resolution) * resolution;
    const last = out[out.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, trade.price); last.low = Math.min(last.low, trade.price); last.close = trade.price; last.volume += trade.usd;
    } else {
      const open = last?.close ?? trade.price;
      out.push({ time, open, high: Math.max(open, trade.price), low: Math.min(open, trade.price), close: trade.price, volume: trade.usd });
    }
  }
  return out;
}

export async function tokenBalance(token: string, holder: string) {
  return rpc().readContract({ address: token as Address, abi: erc20Abi, functionName: "balanceOf", args: [holder as Address] });
}

export type { ChainLog };
