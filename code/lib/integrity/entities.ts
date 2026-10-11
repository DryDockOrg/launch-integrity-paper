/**
 * Entity resolution as an identified set (paper Section 5.3, Appendix A.1).
 *
 * The lower-bound set holds the creator and every wallet tied to it by positive evidence. The pessimistic
 * set adds every holder that cannot show independence. Both are pure functions of the evidence, so the
 * same chain state always yields the same sets.
 */
import { PARAMS } from "./params";
import type { Evidence, InsiderSets, UsdcTransfer } from "./types";

/** How the registry classifies an address for one launch. */
export interface AddressRoles {
  /** The pool (V3) or the PoolManager (V4): where purchases come from and sales go. */
  isMarket(address: string): boolean;
  /** Launch infrastructure that holds tokens without being a trader: routers, position managers, lockers, launchpad contracts, burn addresses. */
  isInfrastructure(address: string): boolean;
  /** Launchpad contracts whose off-market token transfers are allocations by the launch itself. */
  isLaunchpad(address: string): boolean;
  /** Bridges, exchanges, routers and system addresses: they end a funding path and never link wallets. */
  isHub(address: string): boolean;
}

export interface Activity {
  balances: Map<string, bigint>;
  firstPurchase: Map<string, { block: number; tx: string }>;
  firstSale: Map<string, number>;
  purchases: Array<{ address: string; block: number; tx: string; tokens: bigint }>;
  sales: Array<{ address: string; block: number; tx: string; tokens: bigint }>;
  /** Off-market token receipts: recipient, sender, block. */
  receipts: Array<{ to: string; from: string; block: number; value: bigint }>;
}

/** Balances and purchase/sale history at the forecast block, attributing each transaction to the wallets whose balance it moved. */
export function activity(evidence: Evidence, roles: AddressRoles): Activity {
  const balances = new Map<string, bigint>();
  const byTx = new Map<string, Array<{ from: string; to: string; value: bigint; block: number }>>();
  for (const transfer of evidence.transfers) {
    if (transfer.block > evidence.block) continue;
    balances.set(transfer.from, (balances.get(transfer.from) ?? 0n) - transfer.value);
    balances.set(transfer.to, (balances.get(transfer.to) ?? 0n) + transfer.value);
    const list = byTx.get(transfer.tx) ?? [];
    list.push(transfer);
    byTx.set(transfer.tx, list);
  }
  balances.delete("0x0000000000000000000000000000000000000000");
  const firstPurchase = new Map<string, { block: number; tx: string }>();
  const firstSale = new Map<string, number>();
  const purchases: Activity["purchases"] = [];
  const sales: Activity["sales"] = [];
  const receipts: Activity["receipts"] = [];
  for (const [tx, moves] of byTx) {
    const block = moves[0].block;
    const fromMarket = moves.some((move) => roles.isMarket(move.from));
    const toMarket = moves.some((move) => roles.isMarket(move.to));
    const delta = new Map<string, bigint>();
    for (const move of moves) {
      delta.set(move.from, (delta.get(move.from) ?? 0n) - move.value);
      delta.set(move.to, (delta.get(move.to) ?? 0n) + move.value);
    }
    const wallets = [...delta.entries()].filter(([address]) => !roles.isMarket(address) && !roles.isInfrastructure(address) && address !== "0x0000000000000000000000000000000000000000");
    for (const [address, change] of wallets) {
      if (change > 0n && fromMarket) {
        purchases.push({ address, block, tx, tokens: change });
        if (!firstPurchase.has(address)) firstPurchase.set(address, { block, tx });
      } else if (change < 0n && toMarket) {
        sales.push({ address, block, tx, tokens: -change });
        if (!firstSale.has(address)) firstSale.set(address, block);
      } else if (change > 0n) {
        // Off-market receipt: credit it to the transaction's largest sender (a wallet if any, else infrastructure).
        const senders = [...delta.entries()].filter(([sender, value]) => value < 0n && sender !== address).sort((a, b) => (a[1] < b[1] ? -1 : 1));
        const sender = senders.find(([candidate]) => !roles.isInfrastructure(candidate))?.[0] ?? senders[0]?.[0];
        if (sender) receipts.push({ to: address, from: sender, block, value: change });
      }
    }
  }
  return { balances, firstPurchase, firstSale, purchases, sales, receipts };
}

class UnionFind {
  private parent = new Map<string, string>();
  find(node: string): string {
    let root = node;
    while (this.parent.has(root) && this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cursor = node;
    while (cursor !== root) { const next = this.parent.get(cursor) ?? root; this.parent.set(cursor, root); cursor = next; }
    if (!this.parent.has(root)) this.parent.set(root, root);
    return root;
  }
  union(a: string, b: string) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(rb < ra ? ra : rb, rb < ra ? rb : ra); }
}

/**
 * Funding ancestors of each wallet: USDC it received from non-hub addresses, traced back `depth` hops,
 * with every transfer on the path inside the lookback window that ends at the wallet's first purchase.
 * A transfer links only if it is at least 1 USDC and carries at least half of what the recipient then
 * spent or forwarded, so an unsolicited transfer never creates a link.
 */
export function fundingAncestors(evidence: Evidence, roles: AddressRoles, firstSpend: Map<string, { block: number; usdc: bigint | null }>, depth: number = PARAMS.fundingDepth) {
  const lookbackBlocks = PARAMS.fundingLookbackBlocks;
  const inbound = new Map<string, UsdcTransfer[]>();
  for (const transfer of evidence.funding) {
    const list = inbound.get(transfer.to) ?? [];
    list.push(transfer);
    inbound.set(transfer.to, list);
  }
  const ancestors = new Map<string, Map<string, number>>(); // wallet -> ancestor -> hop
  const direct = new Map<string, Set<string>>();
  for (const [wallet, spend] of firstSpend) {
    const found = new Map<string, number>();
    let frontier: Array<{ address: string; until: number; amount: bigint | null }> = [{ address: wallet, until: spend.block, amount: spend.usdc }];
    for (let hop = 1; hop <= depth && frontier.length; hop++) {
      const next: typeof frontier = [];
      for (const node of frontier) {
        for (const transfer of inbound.get(node.address) ?? []) {
          if (transfer.block > node.until || transfer.block < spend.block - lookbackBlocks || transfer.block < evidence.fundingFrom) continue;
          if (transfer.value < PARAMS.dustUsdc || roles.isHub(transfer.from) || transfer.from === node.address || transfer.from === wallet) continue;
          if (node.amount != null && Number(transfer.value) < PARAMS.materialShare * Number(node.amount)) continue;
          if (hop === 1) { const set = direct.get(wallet) ?? new Set<string>(); set.add(transfer.from); direct.set(wallet, set); }
          if (!found.has(transfer.from)) { found.set(transfer.from, hop); next.push({ address: transfer.from, until: transfer.block, amount: transfer.value }); }
        }
      }
      frontier = next;
    }
    ancestors.set(wallet, found);
  }
  return { ancestors, direct };
}

/** True when an address passes the history part of the independence test. */
export function hasHistory(evidence: Evidence, address: string) {
  const history = evidence.history[address];
  return Boolean(history && history.beforeMargin >= 1 && (history.atCreation ?? 0) >= PARAMS.historyMinTx);
}

export function insiderSets(evidence: Evidence, roles: AddressRoles): InsiderSets {
  const act = activity(evidence, roles);
  const creator = evidence.launch.creator;
  const reasons = new Map<string, string[]>();
  const note = (address: string, reason: string) => { const list = reasons.get(address) ?? []; if (!list.includes(reason)) list.push(reason); reasons.set(address, list); };

  // USDC each wallet spent on its first purchase, from the pool's swap in the same transaction.
  const swapUsdc = new Map<string, bigint>();
  for (const swap of evidence.swaps) if (swap.buy) swapUsdc.set(swap.tx, (swapUsdc.get(swap.tx) ?? 0n) + swap.usdc);
  const firstSpend = new Map<string, { block: number; usdc: bigint | null }>();
  for (const [address, purchase] of act.firstPurchase) firstSpend.set(address, { block: purchase.block, usdc: swapUsdc.get(purchase.tx) ?? null });
  const { ancestors, direct } = fundingAncestors(evidence, roles, firstSpend);

  const graph = new UnionFind();
  const seeds = new Set<string>([creator]);
  note(creator, "creator");
  // Purchases in the launch block itself.
  for (const purchase of act.purchases) {
    if (purchase.block === evidence.launch.block && purchase.address !== creator) { seeds.add(purchase.address); note(purchase.address, "bought in the launch block"); }
  }
  // Tokens received off-market before a first purchase link the recipient to the sender; allocations by the launch contract seed the set.
  for (const receipt of act.receipts) {
    const purchase = act.firstPurchase.get(receipt.to);
    if (purchase && purchase.block < receipt.block) continue;
    if (roles.isLaunchpad(receipt.from) || receipt.from === creator) { seeds.add(receipt.to); note(receipt.to, receipt.from === creator ? "received tokens from the creator before buying" : "received a launch allocation"); }
    else if (!roles.isInfrastructure(receipt.from) && !roles.isMarket(receipt.from)) { graph.union(receipt.to, receipt.from); note(receipt.to, `received tokens from ${receipt.from} before buying`); }
  }
  // Funding within the lookback, up to the configured depth.
  for (const [wallet, found] of ancestors) {
    for (const [ancestor, hop] of found) { graph.union(wallet, ancestor); note(wallet, `funded by ${ancestor} (${hop} hop${hop === 1 ? "" : "s"})`); }
  }
  // Sale proceeds that converge on one address.
  const proceedsBy = new Map<string, bigint>();
  const saleUsdc = new Map<string, bigint>();
  for (const swap of evidence.swaps) if (!swap.buy) saleUsdc.set(swap.tx, (saleUsdc.get(swap.tx) ?? 0n) + swap.usdc);
  const salesByWallet = new Map<string, Array<{ block: number; usdc: bigint }>>();
  for (const sale of act.sales) { const list = salesByWallet.get(sale.address) ?? []; list.push({ block: sale.block, usdc: saleUsdc.get(sale.tx) ?? 0n }); salesByWallet.set(sale.address, list); }
  for (const transfer of evidence.proceeds) {
    if (transfer.block > evidence.block || transfer.value < PARAMS.dustUsdc || roles.isHub(transfer.to)) continue;
    const sold = (salesByWallet.get(transfer.from) ?? []).filter((sale) => sale.block <= transfer.block).reduce((sum, sale) => sum + sale.usdc, 0n);
    if (sold === 0n || Number(transfer.value) < PARAMS.materialShare * Number(sold)) continue;
    graph.union(transfer.from, transfer.to);
    proceedsBy.set(transfer.from, (proceedsBy.get(transfer.from) ?? 0n) + transfer.value);
    note(transfer.from, `sent sale proceeds to ${transfer.to}`);
  }

  const seedRoots = new Set([...seeds].map((seed) => graph.find(seed)));
  const holders = new Map<string, bigint>();
  for (const [address, balance] of act.balances) {
    if (balance > 0n && !roles.isMarket(address) && !roles.isInfrastructure(address)) holders.set(address, balance);
  }
  const everyone = new Set<string>([...holders.keys(), ...act.firstPurchase.keys(), ...seeds]);
  const component = new Map<string, string>();
  for (const address of everyone) component.set(address, graph.find(address));
  const inLower = (address: string) => seedRoots.has(graph.find(address));

  const lower = new Map<string, bigint>();
  const pessimistic = new Map<string, bigint>();
  for (const [address, balance] of holders) {
    if (inLower(address)) {
      lower.set(address, balance);
      pessimistic.set(address, balance);
      if (!seeds.has(address)) note(address, "linked to the creator by the evidence above");
      continue;
    }
    // Independence needs all three: history, a purchase outside the launch window, and funding that is not only fresh unlabelled addresses.
    const failures: string[] = [];
    if (!hasHistory(evidence, address)) failures.push(`no ${PARAMS.historyMargin / 86_400}-day, ${PARAMS.historyMinTx}-transaction history before the token`);
    const purchase = act.firstPurchase.get(address);
    if (!purchase) failures.push("holds tokens it never bought");
    else if (purchase.block <= evidence.launch.block + PARAMS.launchWindowBlocks) failures.push(`first bought within ${PARAMS.launchWindowBlocks} blocks of launch`);
    const funders = [...(direct.get(address) ?? [])];
    if (funders.length && funders.every((funder) => !roles.isHub(funder) && !hasHistory(evidence, funder))) failures.push("funded only by fresh unlabelled addresses");
    if (failures.length) { pessimistic.set(address, balance); for (const failure of failures) note(address, failure); }
  }

  const outside = new Set<string>();
  for (const address of act.firstPurchase.keys()) if (!inLower(address)) outside.add(graph.find(address));
  return { lower, pessimistic, reasons, holders, entitiesOutsideLower: outside.size, component };
}
