import { describe, expect, it } from "vitest";
import type { Dossier } from "@/lib/dossier";
import { heat } from "@/lib/activity";
import { assess } from "../scripts/integrity/baselines/v1";

const flow = (buys: number, sells: number, buyers: number) => ({ buys, sells, buyUsd: buys * 50, sellUsd: sells * 50, buyers, sellers: Math.round(buyers / 2) });
function dossier(overrides: Partial<Dossier> = {}, market: Partial<Dossier["market"]> = {}): Dossier {
  return {
    head: 1, partial: false, trades: [], holders: [], holderCount: 200, top10Share: 0.12, launchAllocation: [],
    creator: { launchShare: 0, boughtTokens: 0, soldTokens: 0, peak: 0, holds: 0, holdsShare: 0, firstSell: null, sellUsd: 0, buyUsd: 0, earlyBuyUsd: 0, minutesToFirstSell: null },
    early: [], sameBlockBuyers: 0, clusters: [], custody: { kind: "launchpad", owner: null, label: "" }, hook: null,
    flow: { m15: flow(20, 5, 15), h1: flow(60, 20, 40), h6: flow(200, 90, 120), h24: flow(400, 200, 200) },
    market: { price: 1, athPrice: 1.1, drawdown: 0.09, change5m: 0.02, change1h: 0.25, change6h: 0.6, insiderShare: 0.02, earlyShare: 0.01, earlyExited: 0.5, washShare: 0.05, top3VolumeShare: 0.2, newHolders1h: 30, newHolders6h: 120, medianBuy1h: 40, acceleration: 1.8, ...market },
    fees: { poolBps: 100, buyTaxBps: 0, sellTaxBps: 0, antiSnipe: null },
    ...overrides,
  };
}

describe("assessment", () => {
  it("rates a well-distributed, liquid, active launch as strong", () => {
    const result = assess({ dossier: dossier(), liquidity: 40_000, marketCap: 200_000, creatorLaunches: [] });
    expect(result.verdict).toBe("strong");
    expect(result.risks).toHaveLength(0);
  });

  it("caps the score when a wallet can pull liquidity, whatever else looks good", () => {
    const result = assess({ dossier: dossier({ custody: { kind: "wallet", owner: "0x1", label: "" } }), liquidity: 40_000, marketCap: 200_000, creatorLaunches: [] });
    expect(result.score).toBeLessThanOrEqual(25);
    expect(result.verdict).toBe("avoid");
  });

  it("caps heavy insider supply and thin liquidity", () => {
    expect(assess({ dossier: dossier({}, { insiderShare: 0.45 }), liquidity: 40_000, marketCap: 200_000, creatorLaunches: [] }).score).toBeLessThanOrEqual(30);
    expect(assess({ dossier: dossier(), liquidity: 400, marketCap: 5_000, creatorLaunches: [] }).score).toBeLessThanOrEqual(40);
  });

  it("does not present a collapsed token's empty insider wallets as a strength", () => {
    const result = assess({ dossier: dossier({ early: [{ address: "0x2", block: 1, offset: 0, spent: 5, bought: 10, holds: 0, holdsShare: 0, funder: null }] }, { drawdown: 0.9, change1h: -0.5 }), liquidity: 5_000, marketCap: 10_000, creatorLaunches: [] });
    expect(result.reasons.some((note) => note.text.includes("Insiders hold only"))).toBe(false);
    expect(result.risks.some((note) => note.text.includes("already sold out"))).toBe(true);
  });
});

describe("activity score", () => {
  it("ranks an active, liquid, rising launch above a quiet one", () => {
    const now = 2_000_000;
    const active = heat({ vol1h: 15_000, buys1h: 120, sells1h: 40, liquidity: 20_000, mcap: 150_000, change1h: 35, athMcap: 160_000, ts: now - 7200 }, now);
    const quiet = heat({ vol1h: 20, buys1h: 1, sells1h: 3, liquidity: 200, mcap: 2_000, change1h: -20, athMcap: 9_000, ts: now - 7200 }, now);
    expect(active).toBeGreaterThan(70);
    expect(quiet).toBeLessThan(25);
  });
});

describe("creator behaviour", () => {
  it("flags and caps a creator who snipes their own launches and dumps within minutes", () => {
    const base = dossier();
    const result = assess({
      dossier: { ...base, creator: { ...base.creator, earlyBuyUsd: 2500, buyUsd: 2500, minutesToFirstSell: 3, soldTokens: 10, peak: 10 } },
      liquidity: 40_000, marketCap: 200_000, creatorLaunches: [],
      creatorProfile: { address: "0x9", kind: "sniper", launches: 8, sniped: 8, wins: 7, losses: 1, pnl: 7400, medianHoldMinutes: 3 },
    });
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.risks.some((note) => note.text.includes("pump-and-dump"))).toBe(true);
    expect(result.holderSignals.some((note) => note.text.includes("creator has already sold"))).toBe(true);
  });
});

describe("trading costs", () => {
  it("warns about heavy taxes and caps a punitive sell tax", () => {
    const result = assess({ dossier: dossier({ fees: { poolBps: 100, buyTaxBps: 500, sellTaxBps: 2500, antiSnipe: null } }), liquidity: 40_000, marketCap: 200_000, creatorLaunches: [] });
    expect(result.score).toBeLessThanOrEqual(35);
    expect(result.risks.some((note) => note.text.includes("break even"))).toBe(true);
  });
  it("flags an active anti-snipe surcharge", () => {
    const result = assess({ dossier: dossier({ fees: { poolBps: 0, buyTaxBps: 100, sellTaxBps: 100, antiSnipe: { startBps: 9900, endsAt: Date.now() / 1000 + 600 } } }), liquidity: 40_000, marketCap: 200_000, creatorLaunches: [] });
    expect(result.risks.some((note) => note.text.includes("anti-snipe"))).toBe(true);
  });
});

describe("thin holder base", () => {
  it("does not reward distribution or empty insider wallets when the creator and early buyers have left", () => {
    const base = dossier({ holderCount: 2, top10Share: 0 }, { insiderShare: 0, earlyExited: 1, drawdown: 0.4 });
    const result = assess({ dossier: { ...base, creator: { ...base.creator, peak: 10, soldTokens: 10 } }, liquidity: 220, marketCap: 2500, creatorLaunches: [] });
    expect(result.factors.find((factor) => factor.id === "top10")!.points).toBeLessThan(2);
    expect(result.reasons.some((note) => note.text.includes("Insiders hold only"))).toBe(false);
  });
});
