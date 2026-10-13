/**
 * Layer 1, the facts layer (paper Section 5.2, Appendix A.2): friction, the losses given each
 * structural event and the structural floor, with the state that says whether a number may be shown.
 */
import { insiderSets } from "./entities";
import { gradeOf, PARAMS, type State } from "./params";
import { isLocker, rolesFor, templateById } from "./registry";
import { exitScenario, findBalanceSlot, liquiditySteps, per100, runScenarios, type EthCall, type Scenario } from "./simulate";
import { VERSIONS } from "./versions";
import type { Evidence, Facts, InsiderSets, LiquidityPosition } from "./types";

export interface FactsInput {
  evidence: Evidence;
  ethCall: EthCall;
  /** What the gatherer learned about each liquidity owner's code (EIP-1167 target and template hash). */
  ownerCode: Map<string, { implementation: string | null; templateHash: string | null; isContract: boolean }>;
}

export interface FactsResult { facts: Facts; sets: InsiderSets; withdrawable: LiquidityPosition[] }

/** True when every privileged path of the token and hook is in the registry; otherwise the launch is unobservable. */
export function boundedCode(evidence: Evidence) {
  const tokenOk = evidence.code.tokenTemplate != null;
  const hookOk = evidence.launch.protocol === "v3" || evidence.launch.hooks === "0x0000000000000000000000000000000000000000" || evidence.code.hookTemplate != null;
  return { bounded: tokenOk && hookOk, token: tokenOk, hook: hookOk };
}

export async function computeFacts({ evidence, ethCall, ownerCode }: FactsInput): Promise<FactsResult> {
  const { launch } = evidence;
  const flags: string[] = [];
  const lockedOwners = evidence.positions.filter((position) => isLocker(position.owner, ownerCode.get(position.owner) ?? { implementation: null, templateHash: null })).map((position) => position.owner);
  const roles = rolesFor(launch, lockedOwners);
  const sets = insiderSets(evidence, roles);
  const withdrawable = evidence.positions.filter((position) => !lockedOwners.includes(position.owner));
  const code = boundedCode(evidence);
  if (!code.token) flags.push("token code outside the registry");
  if (!code.hook) flags.push("hook code outside the registry");
  if (evidence.fundingFrom > launch.block - PARAMS.fundingLookbackBlocks) flags.push("funding history truncated");

  const base: Facts = {
    token: launch.token, block: evidence.block, timestamp: evidence.timestamp, state: "rated", stateReason: null, stage: 0,
    friction: null, referenceTokens: null, depth: null,
    recovery: { T: null, L: null, ILower: null, IPessimistic: null },
    loss: { T: null, L: null, ILower: null, IPessimistic: null },
    floor: { low: null, high: null }, grade: null, flags,
    insiders: {
      lowerCount: sets.lower.size, pessimisticCount: sets.pessimistic.size, holders: sets.holders.size, entitiesOutsideLower: sets.entitiesOutsideLower,
      lowerBalance: sum(sets.lower), pessimisticBalance: sum(sets.pessimistic), lowerTakeUsdc: 0, pessimisticTakeUsdc: 0,
    },
    liquidity: { withdrawable: withdrawable.length, locked: evidence.positions.length - withdrawable.length },
    fundingFrom: evidence.fundingFrom,
    versions: VERSIONS,
  };

  // Code outside the registry cannot be bounded: the tradability recovery is zero and the launch is unobservable.
  if (!code.bounded) return { facts: { ...base, state: "unobservable", stateReason: "The token or its hook is not a registered template, so what a privileged call could do cannot be bounded.", recovery: { ...base.recovery, T: 0 }, loss: { ...base.loss, T: 1 } }, sets, withdrawable };

  // Worst reachable privileged state. No registered template has a privilege that changes what a sale returns
  // (registry `privileges` lists the roles and why), so the event leaves state as it is.
  const tradabilitySteps: Scenario["steps"] = [];
  const liquidity = liquiditySteps(launch, withdrawable);
  const liquidityActors = [...new Set(withdrawable.map((position) => position.owner))];
  const slot = sets.pessimistic.size > PARAMS.maxIndividualSellers ? await findBalanceSlot(ethCall, launch.token, evidence.block, templateById(evidence.code.tokenTemplate)?.plantedSupply ?? null) : null;
  if (sets.pessimistic.size > PARAMS.maxIndividualSellers) flags.push(slot ? "large insider set sold as one block beyond the first 100 sellers" : "large insider set truncated to the gas limit");
  const scenarios: Scenario[] = [
    { name: "friction", notional: PARAMS.notional, steps: [], actors: [] },
    { name: "depth", notional: PARAMS.depthNotional, steps: [], actors: [] },
    { name: "T", notional: PARAMS.notional, steps: tradabilitySteps, actors: [] },
    { name: "L", notional: PARAMS.notional, steps: liquidity, actors: liquidityActors },
    exitScenario("ILower", sets.lower, slot, launch.token, launch, withdrawable),
    exitScenario("IPessimistic", sets.pessimistic, slot, launch.token, launch, withdrawable),
  ];
  // Events with nothing to do leave state as it is, so their recovery is the friction scenario's.
  const needed = scenarios.filter((scenario) => scenario.name === "friction" || scenario.steps.length > 0 || scenario.name === "depth");
  const ran = await runScenarios(ethCall, launch, evidence.block, needed);
  const byName = new Map(needed.map((scenario, index) => [scenario.name, ran[index]] as const));
  const [friction, depth, T, L, ILower, IPessimistic] = scenarios.map((scenario) => byName.get(scenario.name) ?? byName.get("friction")!);
  if (!friction.bought) {
    return { facts: { ...base, state: "unobservable", stateReason: "A 100 USDC purchase of the token reverts at this block, so there is no reference position to measure.", flags: [...flags, "reference purchase reverted"] }, sets, withdrawable };
  }
  if (L.stepsFailed !== 0n) flags.push("some liquidity could not be withdrawn in simulation");
  const recovery = {
    T: per100(T, PARAMS.notional), L: per100(L, PARAMS.notional),
    ILower: per100(ILower, PARAMS.notional), IPessimistic: per100(IPessimistic, PARAMS.notional),
  };
  const loss = { T: 1 - recovery.T / 100, L: 1 - recovery.L / 100, ILower: 1 - recovery.ILower / 100, IPessimistic: 1 - recovery.IPessimistic / 100 };
  const low = Math.min(recovery.T, recovery.L, recovery.IPessimistic);
  const high = Math.min(recovery.T, recovery.L, recovery.ILower);
  const age = evidence.timestamp - evidence.creationTimestamp;
  let state: State = "rated";
  let stateReason: string | null = null;
  if (age < PARAMS.minAgeSeconds) { state = "too_early"; stateReason = `The token is ${age} seconds old; ratings start at ${PARAMS.minAgeSeconds} seconds.`; }
  else if (sets.entitiesOutsideLower < PARAMS.minEntities) { state = "too_early"; stateReason = `${sets.entitiesOutsideLower} independent ${sets.entitiesOutsideLower === 1 ? "entity has" : "entities have"} bought outside the insider set; ratings start at ${PARAMS.minEntities}.`; }
  return {
    facts: {
      ...base, state, stateReason,
      friction: per100(friction, PARAMS.notional), referenceTokens: friction.tokens, depth: per100(depth, PARAMS.depthNotional),
      recovery, loss, floor: { low, high }, grade: state === "rated" ? gradeOf(low) : null,
      insiders: { ...base.insiders, lowerTakeUsdc: Number(ILower.eventUsdc) / 1e6, pessimisticTakeUsdc: Number(IPessimistic.eventUsdc) / 1e6 },
    },
    sets, withdrawable,
  };
}

const sum = (map: Map<string, bigint>) => [...map.values()].reduce((total, value) => total + value, 0n);
