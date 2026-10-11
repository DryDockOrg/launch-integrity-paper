/**
 * Forecast records and their commitment (paper Section 9.2, Appendix A.3).
 *
 * A record is ABI-encoded with fixed-point integers so that anyone can recompute its leaf in Solidity or
 * any language. Leaves are double-hashed and the tree hashes sorted pairs, which makes proofs verifiable
 * with OpenZeppelin's MerkleProof.verify against the root posted to the ForecastLedger.
 */
import { concat, encodeAbiParameters, keccak256, type Hex } from "viem";
import { PARAMS, type State } from "./params";
import type { Facts } from "./types";

export const STATES: State[] = ["rated", "too_early", "unobservable", "low_confidence"];
/** Encodes "no value" in every numeric field. */
export const NONE = 0xffffffffn;

export interface ForecastRecord {
  token: string;
  /** V3 pool address or V4 pool id, as 32 bytes. */
  pool: Hex;
  launchpad: string;
  block: number;
  /** Landmark age after the first trade, seconds. */
  landmark: number;
  horizon: number;
  specHash: Hex; paramsHash: Hex; registryHash: Hex;
  /** Recoveries in USDC per 100, and losses as fractions: null where the state withholds them. */
  friction: number | null;
  lossT: number | null; lossL: number | null; lossILower: number | null; lossIPessimistic: number | null;
  floorLow: number | null; floorHigh: number | null;
  piT: [number, number] | null; piL: [number, number] | null; piI: [number, number] | null;
  score: [number, number] | null;
  state: State;
  /** Model version that issued the probabilities (zero at Stage 0). */
  model: Hex;
}

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
/** Fractions and per-100 values as parts per million; null as NONE. */
const ppm = (value: number | null) => (value == null || !Number.isFinite(value) ? NONE : BigInt(Math.round(Math.max(0, value) * 1_000_000)));
const per100ppm = (value: number | null) => (value == null || !Number.isFinite(value) ? NONE : BigInt(Math.round(Math.max(0, value) * 10_000)));
const pair = (value: [number, number] | null) => [ppm(value?.[0] ?? null), ppm(value?.[1] ?? null)] as const;

export function recordFromFacts(facts: Facts, extra: { pool: string; launchpad: string; landmark: number }): ForecastRecord {
  const shown = facts.state === "rated";
  return {
    token: facts.token, pool: (extra.pool.length === 42 ? `0x${extra.pool.slice(2).padStart(64, "0")}` : extra.pool) as Hex, launchpad: extra.launchpad,
    block: facts.block, landmark: extra.landmark, horizon: PARAMS.horizon,
    specHash: facts.versions.spec, paramsHash: facts.versions.params, registryHash: facts.versions.registry,
    friction: facts.friction,
    lossT: shown ? facts.loss.T : null, lossL: shown ? facts.loss.L : null, lossILower: shown ? facts.loss.ILower : null, lossIPessimistic: shown ? facts.loss.IPessimistic : null,
    floorLow: shown ? facts.floor.low : null, floorHigh: shown ? facts.floor.high : null,
    piT: null, piL: null, piI: null, score: null,
    state: facts.state, model: ZERO32,
  };
}

const RECORD_TYPES = [
  { type: "address" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint32" }, { type: "uint32" },
  { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
  { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" },
  { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" },
  { type: "uint8" }, { type: "bytes32" },
] as const;

/** abi.encode(token, pool, block, landmark, horizon, spec, params, registry, friction, losses..., floors, pi intervals, score, state, model). */
export function encodeRecord(record: ForecastRecord): Hex {
  return encodeAbiParameters(RECORD_TYPES, [
    record.token as Hex, record.pool, BigInt(record.block), record.landmark, record.horizon,
    record.specHash, record.paramsHash, record.registryHash,
    per100ppm(record.friction), ppm(record.lossT), ppm(record.lossL), ppm(record.lossILower), ppm(record.lossIPessimistic),
    per100ppm(record.floorLow), per100ppm(record.floorHigh),
    ...pair(record.piT), ...pair(record.piL), ...pair(record.piI), ...pair(record.score ? [record.score[0] / 100, record.score[1] / 100] : null),
    STATES.indexOf(record.state), record.model,
  ]);
}

export const leafOf = (record: ForecastRecord): Hex => keccak256(keccak256(encodeRecord(record)));

const hashPair = (a: Hex, b: Hex): Hex => keccak256(a.toLowerCase() < b.toLowerCase() ? concat([a, b]) : concat([b, a]));

/** Merkle root over leaves sorted ascending; a single leaf is its own root. */
export function merkleRoot(leaves: Hex[]): Hex {
  if (!leaves.length) return ZERO32;
  let level = [...leaves].sort();
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let index = 0; index < level.length; index += 2) next.push(index + 1 < level.length ? hashPair(level[index], level[index + 1]) : level[index]);
    level = next;
  }
  return level[0];
}

/** Sibling path for `leaf`; verify by folding hashPair over it. */
export function merkleProof(leaves: Hex[], leaf: Hex): Hex[] {
  let level = [...leaves].sort();
  let index = level.indexOf(leaf);
  if (index < 0) throw new Error("leaf not in tree");
  const proof: Hex[] = [];
  while (level.length > 1) {
    const sibling = index ^ 1;
    if (sibling < level.length) proof.push(level[sibling]);
    const next: Hex[] = [];
    for (let position = 0; position < level.length; position += 2) next.push(position + 1 < level.length ? hashPair(level[position], level[position + 1]) : level[position]);
    level = next;
    index = Math.floor(index / 2);
  }
  return proof;
}

export function verifyProof(root: Hex, leaf: Hex, proof: Hex[]) {
  return proof.reduce((node, sibling) => hashPair(node, sibling), leaf) === root;
}
