/**
 * Layer 3, the market panel (paper Section 5.7). Shown beside the facts, never an input to them:
 * nothing in this module is read by the facts layer, the records or the score.
 */
import { activity, type AddressRoles } from "./entities";
import type { Evidence, InsiderSets } from "./types";

export interface MarketPanel {
  /** USDC paid in by entities outside the pessimistic set, minus USDC they took out, since launch. */
  netRetainedInflow: number;
  /** Hill number of net-inflow shares across entities (linked wallets count once). */
  effectiveParticipants: number;
  /** Share of the last 24 hours' volume in matched round trips by one entity. */
  washShare: number;
  /** Swap fees or taxes flow back to the creator. */
  feeRecycling: boolean;
  /** USDC returned per 100 on a 1,000 USDC round trip. */
  depth: number | null;
  /** Trades and volume in the last 24 hours, for context. */
  trades24h: number;
  volume24h: number;
}

interface Trade { entity: string; block: number; buy: boolean; usdc: number; tokens: bigint }

/** Trades attributed to entities: the wallet whose balance moved in the swap's transaction, grouped by linked evidence. */
export function entityTrades(evidence: Evidence, roles: AddressRoles, sets: InsiderSets): Trade[] {
  const act = activity(evidence, roles);
  const byTx = new Map<string, string>();
  for (const purchase of act.purchases) if (!byTx.has(purchase.tx)) byTx.set(purchase.tx, purchase.address);
  for (const sale of act.sales) if (!byTx.has(sale.tx)) byTx.set(sale.tx, sale.address);
  const trades: Trade[] = [];
  for (const swap of evidence.swaps) {
    if (swap.block > evidence.block) continue;
    const wallet = byTx.get(swap.tx);
    if (!wallet) continue;
    trades.push({ entity: sets.component.get(wallet) ?? wallet, block: swap.block, buy: swap.buy, usdc: Number(swap.usdc) / 1e6, tokens: swap.tokens });
  }
  return trades;
}

export function marketPanel(evidence: Evidence, roles: AddressRoles, sets: InsiderSets, extra: { feeRecycling: boolean; depth: number | null; blocksPerDay?: number }): MarketPanel {
  const trades = entityTrades(evidence, roles, sets);
  const insiderEntities = new Set([...sets.pessimistic.keys()].map((address) => sets.component.get(address) ?? address));
  let netRetainedInflow = 0;
  const net = new Map<string, number>();
  for (const trade of trades) {
    const signed = trade.buy ? trade.usdc : -trade.usdc;
    net.set(trade.entity, (net.get(trade.entity) ?? 0) + signed);
    if (!insiderEntities.has(trade.entity)) netRetainedInflow += signed;
  }
  const positive = [...net.values()].filter((value) => value > 0);
  const total = positive.reduce((sum, value) => sum + value, 0);
  const entropy = total > 0 ? -positive.reduce((sum, value) => sum + (value / total) * Math.log(value / total), 0) : 0;

  const since = evidence.block - (extra.blocksPerDay ?? 172_800);
  const recent = trades.filter((trade) => trade.block > since);
  const volume = recent.reduce((sum, trade) => sum + trade.usdc, 0);
  // A sale matched to an earlier unmatched buy by the same entity, within 15 minutes and 5% in token amount, is a round trip.
  const WINDOW = 1_800;
  let wash = 0;
  const open = new Map<string, Trade[]>();
  for (const trade of recent) {
    const list = open.get(trade.entity) ?? [];
    if (trade.buy) { list.push(trade); open.set(trade.entity, list); continue; }
    const match = list.findIndex((buy) => trade.block - buy.block <= WINDOW && within(buy.tokens, trade.tokens, 0.05));
    if (match >= 0) { wash += list[match].usdc + trade.usdc; list.splice(match, 1); }
  }
  return {
    netRetainedInflow,
    effectiveParticipants: total > 0 ? Math.exp(entropy) : 0,
    washShare: volume > 0 ? wash / volume : 0,
    feeRecycling: extra.feeRecycling,
    depth: extra.depth,
    trades24h: recent.length,
    volume24h: volume,
  };
}

function within(a: bigint, b: bigint, tolerance: number) {
  const larger = a > b ? a : b;
  const diff = a > b ? a - b : b - a;
  return larger > 0n && Number(diff) / Number(larger) <= tolerance;
}
