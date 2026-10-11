/**
 * Acceptance check: the floor is computed correctly for real launches on every launchpad.
 *
 * For one or more backfill records per launchpad it recomputes the facts at the record's block and checks:
 * (a) the 100 USDC round trip against the launchpad's fee arithmetic: pool fee both ways and the hook's
 *     buy and sell rates, read from the hook (a small purchase moves the price little, so the two must agree
 *     within the price impact of 100 USDC);
 * (b) internal consistency: insider exit at the pessimistic set never returns more than at the lower bound,
 *     neither returns more than friction, and the floor is the minimum of the event recoveries;
 * (c) for Uniswap V3 pools, an independent recomputation of the pessimistic insider exit with the pool's own
 *     liquidity arithmetic, walking every initialized tick (TickMath and SqrtPriceMath in exact integers).
 * Output: docs/integrity-launchpad-check.md.
 *
 *   npx tsx scripts/integrity/check-launchpads.ts
 */
import { writeFileSync } from "node:fs";
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { assessLaunch } from "../../lib/integrity";
import { multicall } from "../../lib/integrity/evidence";
import { sqrtRatioAtTick } from "../../lib/integrity/liquidity";
import { PARAMS } from "../../lib/integrity/params";
import type { LaunchInfo } from "../../lib/integrity/types";
import { CHAIN } from "../../lib/launchpads";
import { storeReader } from "./backfill/reader";
import { db } from "./backfill/store";
import { call } from "./archive";

const head = Number(await call<string>("eth_blockNumber", []));
const reader = storeReader(head);
const rows = db.prepare(`SELECT r.token, r.landmark, r.block, r.launchpad, r.state FROM records r
  WHERE r.landmark >= 0 AND r.state IN ('rated', 'too_early') ORDER BY (r.state = 'rated') DESC, r.block DESC`).all() as Array<{ token: string; landmark: number; block: number; launchpad: string; state: string }>;
const launches = new Map((JSON.parse((await import("node:fs")).readFileSync(`${process.env.HOME}/drydock-data/launch-integrity/launches.json`, "utf8")) as Array<Record<string, unknown>>).map((launch) => [launch.token as string, launch]));
const first = new Map((JSON.parse((db.prepare("SELECT v FROM kv WHERE k = 'first_trades'").get() as { v: string }).v) as Array<[string, number]>));

const pick = new Map<string, Array<(typeof rows)[number]>>();
for (const row of rows) { const list = pick.get(row.launchpad) ?? []; if (list.length < 3) list.push(row); pick.set(row.launchpad, list); }
const unobservable = db.prepare("SELECT launchpad, COUNT(*) AS n FROM records WHERE state = 'unobservable' GROUP BY launchpad").all() as Array<{ launchpad: string; n: number }>;

const hookAbi = parseAbi(["function totalFeeBps() view returns (uint256 onBuy, uint256 onSell)", "function buyTaxBps() view returns (uint256)", "function sellTaxBps() view returns (uint256)"]);
const arcora = parseAbi(["function FEE_BIPS() view returns (uint256)", "function creatorTax(address) view returns (bool,uint16,uint16,address,uint16,uint16,uint16,uint16)"]);
const o1 = parseAbi(["function poolConfig(bytes32) view returns (bool,bool,address,address,uint16,uint16,uint32,uint48)"]);
const v3 = parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)", "function liquidity() view returns (uint128)", "function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)", "function tickBitmap(int16) view returns (uint256)"]);

/** Sell fee and buy fee (bps) charged by the hook on top of the pool fee, from the hook itself. */
async function hookRates(launch: LaunchInfo, block: number) {
  const one = async (abi: never, fn: string, args: unknown[] = []) => {
    const [out] = await multicall(reader.ethCall, block, [{ target: launch.hooks, data: encodeFunctionData({ abi, functionName: fn, args } as never) }]);
    return out ? (decodeFunctionResult({ abi, functionName: fn, data: out } as never) as unknown) : null;
  };
  if (launch.protocol === "v3") return { buy: 0, sell: 0, source: "no hook" };
  if (launch.launchpad === "argus") {
    const buy = await one(hookAbi as never, "buyTaxBps"), sell = await one(hookAbi as never, "sellTaxBps");
    return { buy: Number(buy ?? 0), sell: Number(sell ?? 0), source: "buyTaxBps()/sellTaxBps()" };
  }
  if (launch.launchpad === "arcora") {
    const base = Number((await one(arcora as never, "FEE_BIPS")) ?? 0);
    const tax = (await one(arcora as never, "creatorTax", [launch.token])) as readonly [boolean, number, number] | null;
    return { buy: base + (tax?.[0] ? tax[1] : 0), sell: base + (tax?.[0] ? tax[2] : 0), source: "FEE_BIPS() + creatorTax()" };
  }
  if (launch.launchpad === "o1") {
    const config = (await one(o1 as never, "poolConfig", [launch.pool])) as readonly unknown[] | null;
    return { buy: Number(config?.[4] ?? 0), sell: Number(config?.[4] ?? 0), source: "poolConfig().baseFeeBps" };
  }
  return { buy: 0, sell: 0, source: "unknown" };
}

/**
 * Exact-input swaps through a V3 pool's initialized ticks, in order, as UniswapV3Pool.swap computes them
 * (fee taken from the input, liquidity changing at each crossed tick). `sell` is true when the token goes in.
 */
async function v3Path(launch: LaunchInfo, block: number, steps: Array<{ sell: boolean; amount: bigint }>) {
  const read = async (fn: string, args: unknown[] = []) => {
    const [out] = await multicall(reader.ethCall, block, [{ target: launch.pool, data: encodeFunctionData({ abi: v3, functionName: fn, args } as never) }]);
    return decodeFunctionResult({ abi: v3, functionName: fn, data: out! } as never) as unknown;
  };
  const slot0 = (await read("slot0")) as readonly [bigint, number];
  let sqrtP = slot0[0];
  let tick = Number(slot0[1]);
  let liquidity = (await read("liquidity")) as bigint;
  const spacing = launch.tickSpacing, fee = BigInt(launch.fee), Q96 = 1n << 96n;
  const words = new Map<number, bigint>();
  const bitmap = async (word: number) => { if (!words.has(word)) words.set(word, (await read("tickBitmap", [word])) as bigint); return words.get(word)!; };
  const nets = new Map<number, bigint>();
  const netOf = async (t: number) => { if (!nets.has(t)) nets.set(t, ((await read("ticks", [t])) as readonly [bigint, bigint])[1]); return nets.get(t)!; };
  async function nextTick(zeroForOne: boolean): Promise<number | null> {
    let compressed = Math.floor(tick / spacing) + (zeroForOne ? 0 : 1);
    for (let guard = 0; guard < 400; guard++) {
      const word = compressed >> 8, bit = ((compressed % 256) + 256) % 256;
      const bits = await bitmap(word);
      if (zeroForOne) { for (let b = bit; b >= 0; b--) if ((bits >> BigInt(b)) & 1n) return (word * 256 + b) * spacing; compressed = word * 256 - 1; }
      else { for (let b = bit; b < 256; b++) if ((bits >> BigInt(b)) & 1n) return (word * 256 + b) * spacing; compressed = (word + 1) * 256; }
      if (Math.abs(compressed * spacing) > 887_272) return null;
    }
    return null;
  }
  const outs: bigint[] = [];
  for (const step of steps) {
    const zeroForOne = step.sell ? !launch.usdcIs0 : launch.usdcIs0; // currency0 goes in
    let remaining = step.amount, out = 0n;
    for (let guard = 0; remaining > 0n && guard < 2000; guard++) {
      const target = await nextTick(zeroForOne);
      if (target == null) break;
      const sqrtTarget = sqrtRatioAtTick(target);
      const afterFee = (remaining * (1_000_000n - fee)) / 1_000_000n;
      let sqrtNext: bigint, used: bigint, got = 0n;
      if (liquidity === 0n) { sqrtNext = sqrtTarget; used = 0n; }
      else if (zeroForOne) {
        const maxIn = (liquidity * Q96 * (sqrtP - sqrtTarget)) / (sqrtP * sqrtTarget);
        if (afterFee < maxIn) { sqrtNext = (liquidity * Q96 * sqrtP) / (liquidity * Q96 + afterFee * sqrtP); used = remaining; }
        else { sqrtNext = sqrtTarget; used = (maxIn * 1_000_000n) / (1_000_000n - fee) + 1n; }
        got = (liquidity * (sqrtP - sqrtNext)) / Q96;
      } else {
        const maxIn = (liquidity * (sqrtTarget - sqrtP)) / Q96;
        if (afterFee < maxIn) { sqrtNext = sqrtP + (afterFee * Q96) / liquidity; used = remaining; }
        else { sqrtNext = sqrtTarget; used = (maxIn * 1_000_000n) / (1_000_000n - fee) + 1n; }
        got = (liquidity * Q96 * (sqrtNext - sqrtP)) / (sqrtP * sqrtNext);
      }
      out += got;
      remaining = used >= remaining ? 0n : remaining - used;
      sqrtP = sqrtNext;
      if (sqrtNext === sqrtTarget) {
        const net = await netOf(target);
        liquidity = zeroForOne ? liquidity - net : liquidity + net;
        tick = zeroForOne ? target - 1 : target;
      }
    }
    outs.push(out);
  }
  return outs;
}

const lines: string[] = ["# v2 acceptance check on real launches", "", `Generated by \`scripts/integrity/check-launchpads.ts\` at block ${head} from backfill records.`, "",
  "| Launchpad | Token | Landmark | State | Friction | Expected from fees | Insider exit (pessimistic, lower) | Floor | V3 recomputation of the pessimistic exit | Checks |", "|---|---|---|---|---|---|---|---|---|---|"];
for (const [pad, list] of pick) {
  for (const row of list) {
    const raw = launches.get(row.token)!;
    const launch: LaunchInfo = { token: row.token, launchpad: pad, creator: raw.creator as string, protocol: raw.protocol as "v3" | "v4", pool: (raw.pool as string).toLowerCase(), fee: raw.fee as number, tickSpacing: raw.tickSpacing as number, hooks: raw.hooks as string, usdcIs0: raw.usdcIs0 as boolean, decimals: raw.decimals as number, supply: BigInt(raw.supply as string), block: raw.block as number, tx: raw.tx as string, firstTradeBlock: first.get((raw.pool as string).toLowerCase()) ?? null };
    const { facts, sets } = await assessLaunch(reader, launch, row.block);
    const rates = await hookRates(launch, row.block);
    const poolFee = launch.fee === 0x800000 ? 0 : launch.fee / 1_000_000;
    const expected = 100 * (1 - poolFee) ** 2 * (1 - rates.buy / 10_000) * (1 - rates.sell / 10_000);
    const checks: string[] = [];
    const friction = facts.friction ?? 0;
    checks.push(Math.abs(friction - expected) <= 0.6 ? "fees agree" : `fees differ by ${(friction - expected).toFixed(2)}`);
    const r = facts.recovery;
    if (r.IPessimistic != null && r.ILower != null) {
      checks.push(r.IPessimistic <= r.ILower + 1e-6 && r.ILower <= friction + 1e-6 ? "ordering holds" : "ordering fails");
      const floorOk = facts.floor.low === Math.min(r.T!, r.L!, r.IPessimistic) && facts.floor.high === Math.min(r.T!, r.L!, r.ILower);
      checks.push(floorOk ? "floor is the minimum" : "floor mismatch");
    }
    let independent = "not applicable (V4)";
    if (launch.protocol === "v3" && facts.referenceTokens && r.IPessimistic != null) {
      try {
        // Buy 100 USDC, sell each insider's balance largest first, then sell what the purchase returned.
        const balances = [...sets.pessimistic.values()].sort((a, b) => (a > b ? -1 : 1));
        const outs = await v3Path(launch, row.block, [{ sell: false, amount: PARAMS.notional }, ...balances.map((amount) => ({ sell: true, amount })), { sell: true, amount: facts.referenceTokens }]);
        const value = Number(outs[outs.length - 1]) / 1e6;
        independent = value.toFixed(2);
        const bought = Number(outs[0]) / Number(facts.referenceTokens);
        checks.push(Math.abs(bought - 1) < 0.001 ? "purchase size agrees" : `purchase size differs by ${(100 * (bought - 1)).toFixed(2)}%`);
        checks.push(Math.abs(value - r.IPessimistic) <= 0.5 ? "V3 arithmetic agrees" : `V3 arithmetic differs by ${(value - r.IPessimistic).toFixed(2)}`);
      } catch (error) { independent = `failed: ${String((error as Error).message).slice(0, 60)}`; }
    }
    lines.push(`| ${pad} | \`${row.token}\` | ${row.landmark}s | ${facts.state} | ${friction.toFixed(2)} | ${expected.toFixed(2)} (${rates.source}) | ${r.IPessimistic?.toFixed(2) ?? "—"}, ${r.ILower?.toFixed(2) ?? "—"} | ${facts.floor.low?.toFixed(2) ?? "—"} to ${facts.floor.high?.toFixed(2) ?? "—"} | ${independent} | ${checks.join("; ")} |`);
    console.log(lines[lines.length - 1]);
  }
}
lines.push("", "Unobservable records (token or hook outside the registry) by launchpad: " + (unobservable.map((row) => `${row.launchpad} ${row.n}`).join(", ") || "none") + ".", "",
  `Thresholds: friction must match the fee arithmetic within 0.6 points (the price impact of 100 USDC); notional ${Number(PARAMS.notional) / 1e6} USDC.`);
writeFileSync("docs/integrity-launchpad-check.md", lines.join("\n") + "\n");
void CHAIN; void call;
