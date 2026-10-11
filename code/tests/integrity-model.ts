/**
 * A constant-product stand-in for the EVM, for tests of the v2 pipeline. It answers the same eth_calls
 * the engine sends (the simulator's `run` and the balance-slot probe) by executing the scenarios against
 * a constant-product pool, so scenario construction, insider sets and the floor are tested end to end
 * against the closed forms of the paper's Appendix B.
 */
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, keccak256, parseAbi, type Hex } from "viem";
import { SIMULATOR_ABI } from "../lib/integrity/sim/artifacts";
import { REFERENCE_BUYER, type EthCall } from "../lib/integrity/simulate";

export interface Pool { usdc: number; tokens: number; fee: number; feeInPool: boolean }

const balanceOf = parseAbi(["function balanceOf(address) view returns (uint256)"]);
export const slotOf = (holder: string) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder as Hex, 0n]));
const UNIT = 10n ** 18n;
const toTokens = (raw: bigint) => Number(raw) / 1e18;
const toRaw = (tokens: number) => BigInt(Math.round(tokens * 1e6)) * 10n ** 12n;

/** eth_call against a constant-product pool and a balance table (raw token units, 18 decimals). */
export function constantProduct(initial: Pool, balances: Map<string, bigint>): EthCall {
  return async (request, _block, overrides) => {
    const diffs = Object.values(overrides).flatMap((override) => Object.entries(override.stateDiff ?? {}));
    if (request.data.startsWith("0x70a08231")) {
      const { args } = decodeFunctionData({ abi: balanceOf, data: request.data });
      const hit = diffs.find(([slot]) => slot === slotOf(args[0]));
      return encodeFunctionResult({ abi: balanceOf, functionName: "balanceOf", result: hit ? BigInt(hit[1]) : balances.get(args[0].toLowerCase()) ?? 0n });
    }
    const { args } = decodeFunctionData({ abi: SIMULATOR_ABI, data: request.data });
    const [, scenarios] = args as unknown as [unknown, Array<{ notional: bigint; steps: Array<{ kind: number; actor: string; amount: bigint }> }>];
    const outcomes = scenarios.map((scenario) => {
      const pool = { ...initial };
      const held = new Map(balances);
      for (const [slot, value] of diffs) for (const holder of [REFERENCE_BUYER, "0x00000000000000000000000000000000dd0000a2"]) if (slot === slotOf(holder)) held.set(holder, BigInt(value));
      const buy = (usd: number) => { const after = usd * (1 - pool.fee); const out = (pool.tokens * after) / (pool.usdc + after); pool.usdc += pool.feeInPool ? usd : after; pool.tokens -= out; return out; };
      const sell = (tokens: number) => { const after = tokens * (1 - pool.fee); const out = (pool.usdc * after) / (pool.tokens + after); pool.usdc -= out; pool.tokens += pool.feeInPool ? tokens : after; return out; };
      let tokens = 0n;
      if (scenario.notional === 0n) tokens = held.get(REFERENCE_BUYER) ?? 0n;
      else tokens = toRaw(buy(Number(scenario.notional) / 1e6));
      let eventUsdc = 0;
      for (const step of scenario.steps) {
        const actor = step.actor.toLowerCase();
        if (step.kind === 1) { const balance = held.get(actor) ?? 0n; if (balance > 0n) { eventUsdc += sell(toTokens(balance)); held.set(actor, 0n); } }
        if (step.kind === 2) held.set(actor, (held.get(actor) ?? 0n) + toRaw(buy(Number(step.amount) / 1e6)));
      }
      const recovered = tokens > 0n ? sell(toTokens(tokens)) : 0;
      return { bought: true, tokens, recovered: BigInt(Math.floor(recovered * 1e6)), sold: tokens > 0n, stepsFailed: 0n, eventUsdc: BigInt(Math.floor(eventUsdc * 1e6)) };
    });
    return encodeFunctionResult({ abi: SIMULATOR_ABI, functionName: "run", result: outcomes as never });
  };
}

export { UNIT };
