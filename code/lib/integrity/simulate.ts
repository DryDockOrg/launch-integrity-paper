/**
 * Simulation of the reference position (paper Section 5.2, Appendix A.2).
 *
 * Every scenario is one eth_call at the forecast block. The simulator's code is placed with a state
 * override on the reference buyer and on each address whose action a scenario needs (an insider selling,
 * a liquidity owner withdrawing, a role holder changing a parameter), so the pool, its hook, the position
 * managers and the token enforce their own rules on the real address. A reverted sale records zero.
 */
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import { CHAIN } from "../launchpads";
import { PARAMS } from "./params";
import { SIMULATOR_ABI, SIMULATOR_CODE } from "./sim/artifacts";
import type { LaunchInfo, LiquidityPosition } from "./types";

/** A fresh address with no history on Arc acts as the reference buyer. */
export const REFERENCE_BUYER = "0x00000000000000000000000000000000dd0000a1";
/** Receives the balance of insiders beyond the individually simulated sellers. */
export const TAIL_SELLER = "0x00000000000000000000000000000000dd0000a2";
const GAS = 0x2faf080n; // 50M, the public nodes' eth_call cap
const NATIVE_FUNDS = 10n ** 30n; // 10^12 USDC in native 18-decimal units: never the binding constraint

export interface StateOverride { code?: Hex; balance?: bigint; stateDiff?: Record<Hex, Hex> }
/** Executes eth_call(to, data) at `block` with state overrides and returns the return data. */
export type EthCall = (request: { to: string; data: Hex; gas: bigint }, block: number, overrides: Record<string, StateOverride>) => Promise<Hex>;

/** Step kinds: 0 call as the actor, 1 sell its whole balance, 2 buy, 3 withdraw a V4 position, 4 mark its balance, 5 sell what arrived since the mark. */
export interface Step { kind: 0 | 1 | 2 | 3 | 4 | 5; actor: string; target: string; data: Hex; amount: bigint }
export interface Scenario { name: string; notional: bigint; steps: Step[]; actors: string[]; stateDiff?: Record<string, Record<Hex, Hex>> }
export interface Outcome { bought: boolean; tokens: bigint; recovered: bigint; sold: boolean; stepsFailed: bigint; eventUsdc: bigint }

const ZERO = "0x0000000000000000000000000000000000000000";

export function market(launch: LaunchInfo) {
  const token = launch.token as Hex;
  const usdc = CHAIN.usdc as Hex;
  return {
    v4: launch.protocol === "v4",
    pool: (launch.protocol === "v3" ? launch.pool : ZERO) as Hex,
    manager: CHAIN.poolManager as Hex,
    key: { currency0: launch.usdcIs0 ? usdc : token, currency1: launch.usdcIs0 ? token : usdc, fee: launch.fee, tickSpacing: launch.tickSpacing, hooks: launch.hooks as Hex },
    token, usdc, usdcIs0: launch.usdcIs0,
  };
}

/**
 * Runs scenarios with as few eth_calls as gas allows: scenarios are packed into one call until about 120
 * simulated sales would share it (the simulator isolates each scenario in a reverting sub-call, so they
 * never see each other's state). Code overrides for every actor of a call are applied together; an actor's
 * code only runs when a scenario calls it.
 */
/**
 * Value at `block` of `tokens` bought earlier and held, per 100 USDC of `notional` (Appendix A.5): bought here by
 * exact output and sold straight back, so the pool includes the position's own purchase. `ok` is false when the
 * position could not be bought or sold.
 */
export async function holdValue(ethCall: EthCall, launch: LaunchInfo, block: number, tokens: bigint, notional: bigint): Promise<{ ok: boolean; recovery: number }> {
  const data = encodeFunctionData({ abi: SIMULATOR_ABI, functionName: "holdValue", args: [market(launch), tokens] });
  const result = await ethCall({ to: REFERENCE_BUYER, data, gas: GAS }, block, { [REFERENCE_BUYER]: { code: SIMULATOR_CODE as Hex, balance: NATIVE_FUNDS } });
  const [ok, recovered] = decodeFunctionResult({ abi: SIMULATOR_ABI, functionName: "holdValue", data: result }) as readonly [boolean, bigint];
  return { ok, recovery: ok ? Number((recovered * 1_000_000n) / notional) / 10_000 : 0 };
}

/** Code kind of each address at `block` (0 none, 1 EIP-7702 delegation, 2 contract), one call per 400 addresses. */
export async function codeKinds(ethCall: EthCall, addresses: string[], block: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let index = 0; index < addresses.length; index += 400) {
    const chunk = addresses.slice(index, index + 400);
    const data = encodeFunctionData({ abi: SIMULATOR_ABI, functionName: "codeKinds", args: [chunk as Hex[]] });
    const result = await ethCall({ to: REFERENCE_BUYER, data, gas: GAS }, block, { [REFERENCE_BUYER]: { code: SIMULATOR_CODE as Hex } });
    const kinds = decodeFunctionResult({ abi: SIMULATOR_ABI, functionName: "codeKinds", data: result }) as readonly number[];
    chunk.forEach((address, position) => out.set(address, Number(kinds[position])));
  }
  return out;
}

export async function runScenarios(ethCall: EthCall, launch: LaunchInfo, block: number, scenarios: Scenario[]): Promise<Outcome[]> {
  const m = market(launch);
  const groups: Array<{ scenarios: Scenario[]; indexes: number[] }> = [];
  scenarios.forEach((scenario, index) => {
    const weight = scenario.steps.length + 2;
    const last = groups[groups.length - 1];
    const conflict = last && scenario.stateDiff && last.scenarios.some((other) => other.stateDiff);
    if (last && !conflict && last.scenarios.reduce((sum, item) => sum + item.steps.length + 2, 0) + weight <= 124) { last.scenarios.push(scenario); last.indexes.push(index); }
    else groups.push({ scenarios: [scenario], indexes: [index] });
  });
  const out: Outcome[] = new Array(scenarios.length);
  await Promise.all(groups.map(async (group) => {
    const overrides: Record<string, StateOverride> = { [REFERENCE_BUYER]: { code: SIMULATOR_CODE as Hex, balance: NATIVE_FUNDS } };
    for (const scenario of group.scenarios) {
      for (const actor of scenario.actors) overrides[actor] = { ...(overrides[actor] ?? {}), code: SIMULATOR_CODE as Hex };
      for (const [address, diff] of Object.entries(scenario.stateDiff ?? {})) overrides[address] = { ...(overrides[address] ?? {}), stateDiff: { ...(overrides[address]?.stateDiff ?? {}), ...diff } };
    }
    const data = encodeFunctionData({ abi: SIMULATOR_ABI, functionName: "run", args: [m, group.scenarios.map((scenario) => ({ notional: scenario.notional, steps: scenario.steps.map((step) => ({ ...step, actor: step.actor as Hex, target: step.target as Hex })) }))] });
    const result = await ethCall({ to: REFERENCE_BUYER, data, gas: GAS }, block, overrides);
    const outcomes = decodeFunctionResult({ abi: SIMULATOR_ABI, functionName: "run", data: result }) as readonly Outcome[];
    group.indexes.forEach((index, position) => { out[index] = outcomes[position]; });
  }));
  return out;
}

/** Recovery per 100 USDC of notional. */
export const per100 = (outcome: Outcome, notional: bigint) => (outcome.bought && outcome.sold ? (Number(outcome.recovered) / Number(notional)) * 100 : 0);

// ---- Liquidity withdrawal steps -------------------------------------------------------------------

const npmAbi = parseAbi([
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) returns (uint256,uint256)",
  "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) returns (uint256,uint256)",
]);
const posmAbi = parseAbi(["function modifyLiquidities(bytes unlockData,uint256 deadline)"]);
const v3PoolAbi = parseAbi([
  "function burn(int24 tickLower,int24 tickUpper,uint128 amount) returns (uint256,uint256)",
  "function collect(address recipient,int24 tickLower,int24 tickUpper,uint128 amount0Requested,uint128 amount1Requested) returns (uint128,uint128)",
]);
const MAX128 = (1n << 128n) - 1n;
const DEADLINE = (1n << 64n) - 1n;

export function withdrawalSteps(launch: LaunchInfo, position: LiquidityPosition): Step[] {
  const owner = position.owner;
  if (position.manager === "npm" && position.tokenId != null) {
    return [
      { kind: 0, actor: owner, target: CHAIN.v3PositionManager, amount: 0n, data: encodeFunctionData({ abi: npmAbi, functionName: "decreaseLiquidity", args: [{ tokenId: position.tokenId, liquidity: position.liquidity, amount0Min: 0n, amount1Min: 0n, deadline: DEADLINE }] }) },
      { kind: 0, actor: owner, target: CHAIN.v3PositionManager, amount: 0n, data: encodeFunctionData({ abi: npmAbi, functionName: "collect", args: [{ tokenId: position.tokenId, recipient: owner as Hex, amount0Max: MAX128, amount1Max: MAX128 }] }) },
    ];
  }
  if (position.manager === "posm" && position.tokenId != null) {
    const m = market(launch);
    const actions = "0x0111" as Hex; // DECREASE_LIQUIDITY, TAKE_PAIR
    const params = [
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }], [position.tokenId, position.liquidity, 0n, 0n, "0x"]),
      encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [m.key.currency0, m.key.currency1, owner as Hex]),
    ];
    const unlockData = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [actions, params]);
    return [{ kind: 0, actor: owner, target: CHAIN.v4PositionManager, amount: 0n, data: encodeFunctionData({ abi: posmAbi, functionName: "modifyLiquidities", args: [unlockData, DEADLINE] }) }];
  }
  if (launch.protocol === "v3") {
    return [
      { kind: 0, actor: owner, target: launch.pool, amount: 0n, data: encodeFunctionData({ abi: v3PoolAbi, functionName: "burn", args: [position.tickLower, position.tickUpper, position.liquidity] }) },
      { kind: 0, actor: owner, target: launch.pool, amount: 0n, data: encodeFunctionData({ abi: v3PoolAbi, functionName: "collect", args: [owner as Hex, position.tickLower, position.tickUpper, MAX128, MAX128] }) },
    ];
  }
  const data = encodeAbiParameters([{ type: "int24" }, { type: "int24" }, { type: "uint128" }, { type: "bytes32" }], [position.tickLower, position.tickUpper, position.liquidity, position.salt]);
  return [{ kind: 3, actor: owner, target: CHAIN.poolManager, amount: 0n, data }];
}

// ---- Insider exit ----------------------------------------------------------------------------------

/**
 * Sellers in descending order of balance, each selling its whole balance. Beyond the first
 * `maxIndividualSellers`, the remaining balance is credited to one extra seller through a storage
 * override of the token's balance mapping (when the slot is known), which keeps the call inside the gas cap.
 */
/**
 * Liquidity event (Appendix A.2, step 6): every withdrawable position is withdrawn by its owner, and each owner sells
 * what the withdrawal returned (method 2.1.0), never tokens it already held.
 */
export function liquiditySteps(launch: LaunchInfo, withdrawable: LiquidityPosition[]): Step[] {
  const owners = [...new Set(withdrawable.map((position) => position.owner))];
  return owners.flatMap((owner) => [
    { kind: 4 as const, actor: owner, target: ZERO, data: "0x" as Hex, amount: 0n },
    ...withdrawable.filter((position) => position.owner === owner).flatMap((position) => withdrawalSteps(launch, position)),
    { kind: 5 as const, actor: owner, target: ZERO, data: "0x" as Hex, amount: 0n },
  ]);
}

/**
 * Insider exit (Appendix A.2, step 7). Members sell largest first; a member that owns withdrawable positions first
 * withdraws them, so tokens parked in liquidity count toward its exit (method 2.1.0).
 */
export function exitScenario(name: string, members: Map<string, bigint>, balanceSlot: BalanceSlot | null, token: string, launch?: LaunchInfo, withdrawable: LiquidityPosition[] = []): Scenario {
  const parked = withdrawable.filter((position) => members.has(position.owner));
  const owners = new Set(parked.map((position) => position.owner));
  const ordered = [...members.entries()].filter(([address, balance]) => balance > 0n || owners.has(address))
    // Owners of parked positions always sell individually (they must withdraw first), then the rest by balance.
    .sort((a, b) => (owners.has(a[0]) !== owners.has(b[0]) ? (owners.has(a[0]) ? -1 : 1) : a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] > b[1] ? -1 : 1));
  const individual = ordered.slice(0, PARAMS.maxIndividualSellers);
  const tail = ordered.slice(PARAMS.maxIndividualSellers);
  const steps: Step[] = individual.flatMap(([actor]): Step[] => [
    ...(launch ? parked.filter((position) => position.owner === actor).flatMap((position) => withdrawalSteps(launch, position)) : []),
    { kind: 1, actor, target: ZERO, data: "0x", amount: 0n },
  ]);
  const actors = individual.map(([actor]) => actor);
  let stateDiff: Scenario["stateDiff"];
  if (tail.length) {
    const total = tail.reduce((sum, [, balance]) => sum + balance, 0n);
    if (balanceSlot) {
      stateDiff = { [token]: balanceSlot.plant(TAIL_SELLER, total) };
      steps.push({ kind: 1, actor: TAIL_SELLER, target: ZERO, data: "0x", amount: 0n });
      actors.push(TAIL_SELLER);
    } else {
      // Without a known slot each remaining holder sells for itself, as far as gas allows.
      for (const [actor] of tail.slice(0, 150)) { steps.push({ kind: 1, actor, target: ZERO, data: "0x", amount: 0n }); actors.push(actor); }
    }
  }
  return { name, notional: PARAMS.notional, steps, actors, stateDiff };
}

// ---- Balance storage slot ---------------------------------------------------------------------------

export interface PlantedSupply { getter: string; slots: number[] }
/** A token's balance mapping at one block. `plant` gives the storage writes that credit `amount` to `holder` as a real transfer would. */
export interface BalanceSlot { slotOf(holder: string): Hex; plant(holder: string, amount: bigint): Record<Hex, Hex> }
const word = (value: bigint) => `0x${value.toString(16).padStart(64, "0")}` as Hex;
const slotHex = (slot: number) => word(BigInt(slot));

/** The balance mapping `slotOf` at `block`, with the template's supply counters read there so planted balances keep them consistent. */
export async function balanceSlotAt(ethCall: EthCall, token: string, block: number, slotOf: (holder: string) => Hex, supply: PlantedSupply | null = null): Promise<BalanceSlot> {
  let base = 0n;
  if (supply) {
    const abi = parseAbi([`function ${supply.getter}() view returns (uint256)`]);
    base = decodeFunctionResult({ abi, functionName: supply.getter, data: await ethCall({ to: token, data: encodeFunctionData({ abi, functionName: supply.getter }), gas: 1_000_000n }, block, {}) } as never) as bigint;
  }
  return {
    slotOf,
    plant(holder, amount) {
      const writes: Record<Hex, Hex> = { [slotOf(holder)]: word(amount) };
      for (const slot of supply?.slots ?? []) writes[slotHex(slot)] = word(base + amount);
      return writes;
    },
  };
}

/** OpenZeppelin's ERC-7201 namespace for upgradeable ERC20 storage; `_balances` is its first field. */
const OZ_ERC20_NAMESPACE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;
const balanceOfAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** Finds the balance mapping by writing a marker into candidate slots and reading it back with balanceOf. */
export async function findBalanceSlot(ethCall: EthCall, token: string, block: number, supply: PlantedSupply | null = null): Promise<BalanceSlot | null> {
  const probe = "0x00000000000000000000000000000000dd0000a3";
  const marker = 0x1234567890abcdefn;
  const candidates = [...Array.from({ length: 12 }, (_, index) => BigInt(index)), OZ_ERC20_NAMESPACE];
  for (const base of candidates) {
    const slotOf = (holder: string) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder as Hex, base]));
    try {
      const data = await ethCall({ to: token, data: encodeFunctionData({ abi: balanceOfAbi, functionName: "balanceOf", args: [probe] }), gas: 1_000_000n }, block,
        { [token]: { stateDiff: { [slotOf(probe)]: `0x${marker.toString(16).padStart(64, "0")}` as Hex } } });
      if (BigInt(data) === marker) return balanceSlotAt(ethCall, token, block, slotOf, supply);
    } catch { /* this candidate reverted; try the next */ }
  }
  return null;
}
