import { describe, expect, it } from "vitest";
import { insiderSets } from "../lib/integrity/entities";
import { computeFacts } from "../lib/integrity/facts";
import { marketPanel } from "../lib/integrity/market";
import { gradeOf, PARAMS } from "../lib/integrity/params";
import { encodeRecord, leafOf, merkleProof, merkleRoot, recordFromFacts, verifyProof } from "../lib/integrity/record";
import { rolesFor } from "../lib/integrity/registry";
import type { Evidence, LaunchInfo, PoolSwap, TokenTransfer, UsdcTransfer } from "../lib/integrity/types";
import { constantProduct, type Pool, UNIT } from "./integrity-model";

// The worked example of the paper (Section 8): a constant-product pool with 25,000 USDC holding 10% of a
// 1e9 supply at a 1% fee; the creator and two launch-block buyers hold 8%; twelve fresh bridge-funded
// wallets hold 12% more; small independent holders with address history make up the public.
const POOL = "0x00000000000000000000000000000000000000f0";
const TOKEN = "0x00000000000000000000000000000000000000f1";
const CREATOR = "0x00000000000000000000000000000000000000c0";
const BRIDGE = "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d"; // a registry hub
const DEAD = "0x000000000000000000000000000000000000dead";
const LAUNCH_BLOCK = 1_000;
const addr = (prefix: string, index: number) => `0x${prefix}${index.toString(16).padStart(40 - prefix.length, "0")}`;
const supply = 1_000_000_000n * UNIT;
const pct = (value: number) => (supply * BigInt(Math.round(value * 1_000_000))) / 1_000_000n;

const launch: LaunchInfo = {
  token: TOKEN, launchpad: "lift", creator: CREATOR, protocol: "v3", pool: POOL, fee: 10_000, tickSpacing: 200,
  hooks: "0x0000000000000000000000000000000000000000", usdcIs0: true, decimals: 18, supply, block: LAUNCH_BLOCK, tx: "0xlaunch", firstTradeBlock: LAUNCH_BLOCK,
};

interface World { transfers: TokenTransfer[]; swaps: PoolSwap[]; funding: UsdcTransfer[]; history: Evidence["history"]; balances: Map<string, bigint> }

function world(): World {
  const w: World = { transfers: [], swaps: [], funding: [], history: {}, balances: new Map() };
  let index = 0;
  const transfer = (block: number, tx: string, from: string, to: string, value: bigint) => {
    w.transfers.push({ block, index: index++, tx, from, to, value });
    w.balances.set(from, (w.balances.get(from) ?? 0n) - value);
    w.balances.set(to, (w.balances.get(to) ?? 0n) + value);
  };
  const purchase = (block: number, wallet: string, value: bigint, usdc: bigint) => {
    const tx = `0xbuy${wallet}${block}`;
    transfer(block, tx, POOL, wallet, value);
    w.swaps.push({ block, index: index++, tx, buy: true, usdc, tokens: value, sqrtPriceX96: 1n });
  };
  transfer(LAUNCH_BLOCK, "0xlaunch", "0x0000000000000000000000000000000000000000", POOL, pct(0.10));
  transfer(LAUNCH_BLOCK, "0xlaunch", "0x0000000000000000000000000000000000000000", DEAD, pct(0.6988));
  transfer(LAUNCH_BLOCK, "0xlaunch", "0x0000000000000000000000000000000000000000", CREATOR, pct(0.04));
  for (const buyer of [addr("b0", 1), addr("b0", 2)]) {
    w.funding.push({ block: LAUNCH_BLOCK - 50, index: index++, tx: `0xfund${buyer}`, from: CREATOR, to: buyer, value: 600_000_000n });
    purchase(LAUNCH_BLOCK, buyer, pct(0.02), 500_000_000n);
  }
  for (let i = 1; i <= 6; i++) {
    const wallet = addr("f0", i);
    w.funding.push({ block: LAUNCH_BLOCK + 10, index: index++, tx: `0xbridge${i}`, from: BRIDGE, to: wallet, value: 900_000_000n });
    purchase(LAUNCH_BLOCK + 30 + i, wallet, pct(0.02), 800_000_000n);
  }
  for (let i = 1; i <= 12; i++) {
    const wallet = addr("a0", i);
    w.history[wallet] = { beforeMargin: 40, atCreation: 60 };
    purchase(LAUNCH_BLOCK + 200 + i, wallet, pct(0.0001), 3_000_000n);
  }
  return w;
}

function evidenceOf(w: World, block = LAUNCH_BLOCK + 1_000): Evidence {
  return {
    launch, block, timestamp: 2_000_000_000, creationTimestamp: 1_999_990_000, transfers: w.transfers, swaps: w.swaps, positions: [],
    funding: w.funding, proceeds: [], history: w.history, fundingFrom: 0,
    code: { tokenTemplate: "lift-token", hookTemplate: null, tokenCodeHash: "0x", hookCodeHash: null },
  };
}

const POOL_STATE: Pool = { usdc: 25_000, tokens: 100_000_000, fee: 0.01, feeInPool: true };
const facts = async (w: World, pool: Pool = POOL_STATE) => (await computeFacts({ evidence: evidenceOf(w), ethCall: constantProduct(pool, w.balances), ownerCode: new Map() })).facts;

/** A world whose only insider is the creator, holding `share` of supply, plus the independent public. */
function soleInsider(share: number): World {
  const w = world();
  const keep = (transfer: TokenTransfer) => !/^0x(b0|f0)/.test(transfer.to.slice(0, 4)) && transfer.to !== CREATOR;
  w.transfers = w.transfers.filter(keep);
  w.swaps = w.swaps.filter((swap) => !/^0xbuy0x(b0|f0)/.test(swap.tx));
  w.funding = [];
  w.transfers.push({ block: LAUNCH_BLOCK, index: 1_000_000, tx: "0xlaunch", from: "0x0000000000000000000000000000000000000000", to: CREATOR, value: pct(share) });
  w.balances = new Map();
  for (const transfer of w.transfers) {
    w.balances.set(transfer.from, (w.balances.get(transfer.from) ?? 0n) - transfer.value);
    w.balances.set(transfer.to, (w.balances.get(transfer.to) ?? 0n) + transfer.value);
  }
  return w;
}

describe("v2 facts layer, acceptance against Appendix B", () => {
  it("reproduces friction 98.0 and the exits of 8% (30.3) and 20% (10.9) of supply", async () => {
    const eight = await facts(soleInsider(0.08));
    expect(eight.state).toBe("rated");
    expect(eight.friction!.toFixed(1)).toBe("98.0");
    expect(eight.recovery.ILower!.toFixed(1)).toBe("30.3");
    expect(eight.recovery.IPessimistic!.toFixed(1)).toBe("30.3");
    const twenty = await facts(soleInsider(0.2));
    expect(twenty.recovery.IPessimistic!.toFixed(1)).toBe("10.9");
    expect(twenty.floor.low!.toFixed(1)).toBe("10.9");
    expect(twenty.grade).toBe("E");
  });

  it("gives the worked example's floor interval when insiders sell address by address", async () => {
    // Appendix A.2 sells each insider's balance in turn; with fees retained in a constant-product pool that
    // returns slightly more to the reference position than one block sale (30.36 and 10.97 against 30.33 and 10.94).
    const result = await facts(world());
    expect(result.recovery.ILower!).toBeCloseTo(30.36, 1);
    expect(result.recovery.IPessimistic!).toBeCloseTo(10.97, 1);
    expect(result.floor.low).toBe(result.recovery.IPessimistic);
    expect(result.floor.high).toBe(result.recovery.ILower);
    expect(result.grade).toBe("E");
    expect(result.insiders.lowerCount).toBe(3);
    expect(result.insiders.pessimisticCount).toBe(9);
  });

  it("puts linked and fresh wallets in the right sets", () => {
    const w = world();
    const sets = insiderSets(evidenceOf(w), rolesFor(launch));
    expect([...sets.lower.keys()].sort()).toEqual([CREATOR, addr("b0", 1), addr("b0", 2)].sort());
    expect(sets.pessimistic.has(addr("f0", 1))).toBe(true);
    expect(sets.pessimistic.has(addr("a0", 1))).toBe(false);
    expect(sets.entitiesOutsideLower).toBe(18);
  });
});

describe("v2 propositions as properties", () => {
  it("splitting insider holdings across new addresses leaves the pessimistic balance and the floor's lower end unchanged (Proposition 2)", async () => {
    const before = await facts(world());
    const w = world();
    // Each bridge-funded wallet splits its 2% across 20 brand-new addresses.
    for (let i = 1; i <= 6; i++) {
      const wallet = addr("f0", i);
      const part = pct(0.02) / 20n;
      for (let k = 0; k < 20; k++) {
        const fresh = addr(`e${i}`, k + 1);
        w.transfers.push({ block: LAUNCH_BLOCK + 500, index: 10_000 + i * 100 + k, tx: `0xsplit${i}${k}`, from: wallet, to: fresh, value: part });
        w.balances.set(wallet, w.balances.get(wallet)! - part);
        w.balances.set(fresh, part);
      }
    }
    const after = await facts(w);
    expect(after.insiders.pessimisticBalance).toBe(before.insiders.pessimisticBalance);
    expect(Math.abs(after.floor.low! - before.floor.low!)).toBeLessThan(0.05);
  });

  it("inserting fresh funding hops leaves the pessimistic balance and the floor's lower end unchanged (Proposition 2)", async () => {
    const before = await facts(world());
    const w = world();
    w.funding = w.funding.flatMap((transfer) => transfer.from !== BRIDGE ? [transfer] : [
      { ...transfer, to: `${transfer.to.slice(0, 40)}99`, block: transfer.block - 5 },
      { ...transfer, from: `${transfer.to.slice(0, 40)}99`, index: transfer.index + 50_000 },
    ]);
    const after = await facts(w);
    expect(after.insiders.pessimisticBalance).toBe(before.insiders.pessimisticBalance);
    expect(after.floor.low).toBeCloseTo(before.floor.low!, 6);
  });

  it("a net purchase never raises the floor in a constant-product pool (Proposition 4)", async () => {
    for (const independent of [true, false]) {
      for (const usd of [100, 2_500, 20_000]) {
        const base = world();
        const before = await facts(base);
        const w = world();
        const buyer = addr("d0", 1);
        // The purchase moves the pool and puts the tokens in the buyer's hands.
        const after = usd * 0.99;
        const out = (POOL_STATE.tokens * after) / (POOL_STATE.usdc + after);
        const pool: Pool = { ...POOL_STATE, usdc: POOL_STATE.usdc + usd, tokens: POOL_STATE.tokens - out };
        const raw = BigInt(Math.round(out * 1e6)) * 10n ** 12n;
        w.transfers.push({ block: LAUNCH_BLOCK + 900, index: 99_999, tx: "0xnet", from: POOL, to: buyer, value: raw });
        w.swaps.push({ block: LAUNCH_BLOCK + 900, index: 99_998, tx: "0xnet", buy: true, usdc: BigInt(usd * 1e6), tokens: raw, sqrtPriceX96: 1n });
        w.balances.set(buyer, raw);
        if (independent) w.history[buyer] = { beforeMargin: 40, atCreation: 60 };
        const result = await facts(w, pool);
        expect(result.floor.low!).toBeLessThanOrEqual(before.floor.low! + 1e-9);
      }
    }
  });

  it("nothing in the market panel changes the floor: wash trading moves the panel only", async () => {
    const pool: Pool = { ...POOL_STATE, feeInPool: false };
    const before = await facts(world(), pool);
    const w = world();
    const washer = addr("a0", 1);
    for (let k = 0; k < 30; k++) {
      const value = pct(0.0001);
      w.transfers.push({ block: LAUNCH_BLOCK + 600 + k, index: 200_000 + k * 2, tx: `0xwb${k}`, from: POOL, to: washer, value });
      w.swaps.push({ block: LAUNCH_BLOCK + 600 + k, index: 200_001 + k * 2, tx: `0xwb${k}`, buy: true, usdc: 25_000_000n, tokens: value, sqrtPriceX96: 1n });
      w.transfers.push({ block: LAUNCH_BLOCK + 600 + k, index: 300_000 + k * 2, tx: `0xws${k}`, from: washer, to: POOL, value });
      w.swaps.push({ block: LAUNCH_BLOCK + 600 + k, index: 300_001 + k * 2, tx: `0xws${k}`, buy: false, usdc: 24_500_000n, tokens: value, sqrtPriceX96: 1n });
    }
    const after = await facts(w, pool);
    expect(after.floor).toEqual(before.floor);
    const roles = rolesFor(launch);
    const panelBefore = marketPanel(evidenceOf(world()), roles, insiderSets(evidenceOf(world()), roles), { feeRecycling: true, depth: before.depth });
    const panelAfter = marketPanel(evidenceOf(w), roles, insiderSets(evidenceOf(w), roles), { feeRecycling: true, depth: after.depth });
    expect(panelAfter.washShare).toBeGreaterThan(panelBefore.washShare);
  });

  it("splitting one buyer into linked wallets leaves effective participants unchanged", () => {
    const w = world();
    const roles = rolesFor(launch);
    const base = marketPanel(evidenceOf(w), roles, insiderSets(evidenceOf(w), roles), { feeRecycling: false, depth: null }).effectiveParticipants;
    // Thirty wallets funded by one independent wallet buy instead of it: one entity, one share.
    const v = world();
    const hub = addr("a0", 12);
    for (let k = 1; k <= 30; k++) {
      const wallet = addr("c1", k);
      v.funding.push({ block: LAUNCH_BLOCK + 300, index: 400_000 + k, tx: `0xsyb${k}`, from: hub, to: wallet, value: 2_000_000n });
      v.transfers.push({ block: LAUNCH_BLOCK + 400 + k, index: 410_000 + k, tx: `0xsb${k}`, from: POOL, to: wallet, value: pct(0.0001) / 30n });
      v.swaps.push({ block: LAUNCH_BLOCK + 400 + k, index: 420_000 + k, tx: `0xsb${k}`, buy: true, usdc: 100_000n, tokens: pct(0.0001) / 30n, sqrtPriceX96: 1n });
    }
    const split = marketPanel(evidenceOf(v), roles, insiderSets(evidenceOf(v), roles), { feeRecycling: false, depth: null }).effectiveParticipants;
    expect(split).toBeGreaterThan(0);
    expect(Math.abs(split - base)).toBeLessThan(0.5);
  });
});

describe("v2 states, grades and records", () => {
  it("abstains as too early under 60 seconds of age or 10 independent entities", async () => {
    const w = world();
    const young = await computeFacts({ evidence: { ...evidenceOf(w), creationTimestamp: 2_000_000_000 - 30 }, ethCall: constantProduct(POOL_STATE, w.balances), ownerCode: new Map() });
    expect(young.facts.state).toBe("too_early");
    expect(young.facts.grade).toBeNull();
  });

  it("marks code outside the registry unobservable with zero tradability recovery", async () => {
    const w = world();
    const evidence = { ...evidenceOf(w), code: { tokenTemplate: null, hookTemplate: null, tokenCodeHash: "0x", hookCodeHash: null } };
    const result = await computeFacts({ evidence, ethCall: constantProduct(POOL_STATE, w.balances), ownerCode: new Map() });
    expect(result.facts.state).toBe("unobservable");
    expect(result.facts.recovery.T).toBe(0);
  });

  it("grades the lower end of the floor in fixed bands", () => {
    expect([95, 90, 89.9, 75, 74, 50, 49, 20, 19.9, 0].map(gradeOf)).toEqual(["A", "A", "B", "B", "C", "C", "D", "D", "E", "E"]);
  });

  it("encodes records deterministically and proves inclusion", async () => {
    const result = await facts(world());
    const record = recordFromFacts(result, { pool: POOL, launchpad: "lift", landmark: 600 });
    expect(encodeRecord(record)).toBe(encodeRecord({ ...record }));
    const leaves = [leafOf(record), ...Array.from({ length: 6 }, (_, i) => leafOf({ ...record, block: record.block + i + 1 }))];
    const root = merkleRoot(leaves);
    for (const leaf of leaves) expect(verifyProof(root, leaf, merkleProof(leaves, leaf))).toBe(true);
    expect(verifyProof(root, leafOf({ ...record, floorLow: 50 }), merkleProof(leaves, leaves[0]))).toBe(false);
    expect(record.horizon).toBe(PARAMS.horizon);
  });
});
