/**
 * The v2 registry (paper Sections 5.3 and 9.4): hubs that end funding paths, contracts that lock
 * liquidity, and the token and hook templates of each supported launchpad with their privileged roles
 * and maximum fees. It is the one place human judgement enters the method. Every entry is dated and
 * carries its evidence; the full rationale is in docs/integrity-registry.md. Anything outside it is
 * unbounded: an unregistered token or hook makes a launch unobservable rather than rated.
 */
import { CHAIN, LAUNCHPADS } from "../launchpads";
import type { AddressRoles } from "./entities";
import type { LaunchInfo } from "./types";

export const REGISTRY_VERSION = "2026-10-11";

export interface HubEntry { address: string; label: string; kind: "system" | "dex" | "router" | "launchpad" | "bridge" | "exchange"; evidence: string }

/** Addresses that end a funding path and never link wallets. */
export const HUBS: HubEntry[] = [
  { address: "0x0000000000000000000000000000000000000000", label: "Zero address", kind: "system", evidence: "Mint and burn counterparty" },
  { address: "0x000000000000000000000000000000000000dead", label: "Dead address", kind: "system", evidence: "Burn address" },
  { address: CHAIN.usdc, label: "USDC", kind: "system", evidence: "Arc's USDC system contract" },
  { address: "0xfffffffffffffffffffffffffffffffffffffffe", label: "Native USDC transfer log emitter", kind: "system", evidence: "EIP-7708 mirror logs on Arc" },
  { address: CHAIN.poolManager, label: "Uniswap V4 PoolManager", kind: "dex", evidence: "Uniswap V4 deployment on Arc" },
  { address: CHAIN.v3Factory, label: "Uniswap V3 factory", kind: "dex", evidence: "Uniswap V3 deployment on Arc" },
  { address: CHAIN.v3PositionManager, label: "Uniswap V3 position manager", kind: "dex", evidence: "Uniswap V3 deployment on Arc" },
  { address: CHAIN.v4PositionManager, label: "Uniswap V4 position manager", kind: "dex", evidence: "Uniswap V4 deployment on Arc" },
  { address: CHAIN.universalRouter, label: "Uniswap Universal Router", kind: "router", evidence: "Uniswap deployment on Arc" },
  { address: CHAIN.v3Router, label: "Uniswap SwapRouter02", kind: "router", evidence: "Uniswap deployment on Arc" },
  { address: CHAIN.permit2.toLowerCase(), label: "Permit2", kind: "router", evidence: "Canonical Permit2 address" },
  { address: CHAIN.swapRouter.toLowerCase(), label: "Swap router", kind: "router", evidence: "Router used by DryDock's swap panel" },
  { address: "0xa13b8d54e2fd03319f0f7db036090bd593f53161", label: "Swap router (superseded)", kind: "router", evidence: "Earlier deployment of the same router, 19 September 2026" },
  { address: CHAIN.multicall3.toLowerCase(), label: "Multicall3", kind: "router", evidence: "Canonical Multicall3 address" },
  { address: "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d", label: "CCTP TokenMessengerV2", kind: "bridge", evidence: "Circle CCTP V2 canonical address; code present on Arc" },
  { address: "0x81d40f21f12a8f0e3252bccb954d722d4c464b64", label: "CCTP MessageTransmitterV2", kind: "bridge", evidence: "Circle CCTP V2 canonical address; code present on Arc" },
  ...LAUNCHPADS.flatMap((pad) => [
    ...pad.entry.map((address) => ({ address: address.toLowerCase(), label: `${pad.name} launch contract`, kind: "launchpad" as const, evidence: "Launchpad entry contract (SPEC §5)" })),
    ...Object.entries(pad.custody).map(([address, label]) => ({ address: address.toLowerCase(), label, kind: "launchpad" as const, evidence: "Launchpad custody contract (SPEC §5)" })),
  ]),
];

/** How a contract that owns liquidity was recognised as unable to withdraw it. */
export interface LockerEntry {
  label: string;
  /** Match by exact address, by EIP-1167 implementation, or by template hash of the runtime code. */
  address?: string; implementation?: string; templateHash?: string;
  /** When the lock ends: "never" for permanent locks. */
  unlock: "never";
  basis: "verified source" | "bytecode";
  evidence: string;
}

export const LOCKERS: LockerEntry[] = [
  { label: "lift.fun LP vault", address: "0x826d695e64a44c0347982eda6d3183f12eb1ac4f", unlock: "never", basis: "verified source", evidence: "LpVault (Sourcify): no function moves a position; collect() moves fees only" },
  { label: "lift.fun launch contract", address: "0x3f29dd25d1f6ad3d09d1d4a880f8a869e3039153", unlock: "never", basis: "bytecode", evidence: "Holds the position NFT only within the launch transaction, then deposits it in LpVault" },
  { label: "Tolly fee locker", address: "0xe20e4297759597da75c8998ee76ec900600ad920", unlock: "never", basis: "bytecode", evidence: "No call to decreaseLiquidity or any NFT transfer in its code; no DELEGATECALL" },
  { label: "ArcPad liquidity locker", address: "0x69a615dd32b89fe40d87b2e3123bae4162f2d450", unlock: "never", basis: "bytecode", evidence: "No call to decreaseLiquidity or any NFT transfer in its code; no DELEGATECALL" },
  { label: "Argus V4 hooked locker", implementation: "0xb2ed8112db1bc11f7e7ab7969c2a9d1f819cfc6a", unlock: "never", basis: "verified source", evidence: "ArgusV4HookedLocker (Sourcify, in the V4 portal's sources): no decrease path; fee collection is a zero-liquidity decrease" },
  { label: "Argus V5 locker", templateHash: "0x08b200453ce4c2c58c1e02bf544996ae0f68430f042579428ebf129e7febd461", unlock: "never", basis: "verified source", evidence: "ArgusV5Locker (Sourcify): add-only, a decrease reverts by name" },
  { label: "o1 Launchpad hook", address: "0x20eead6db6b3d0a4491e9073119dd0ebff166acc", unlock: "never", basis: "verified source", evidence: "LaunchHook (Sourcify): seeds its own positions and beforeRemoveLiquidity always reverts" },
  { label: "Arcora portal", address: "0xacff3358557519ff7e482c75df4a7153532d37fa", unlock: "never", basis: "verified source", evidence: "ArcoraHook.beforeRemoveLiquidity (Sourcify) reverts any removal by the portal" },
  { label: "Arcora hook", address: "0x3d90f1e09ae04e1f09b216acd6018a6598f1eacc", unlock: "never", basis: "verified source", evidence: "ArcoraHook (Sourcify) has no remove path for its own positions" },
];

/** A privileged parameter and the worst value its code allows without a timelock longer than the horizon. */
export interface Privilege { role: string; parameter: string; worst: string }

export interface TemplateEntry {
  id: string;
  launchpad: string;
  kind: "token" | "hook";
  label: string;
  match: { address?: string; implementation?: string; templateHash?: string };
  /** Source verified on Sourcify (exact or partial match). Unverified templates are never registered. */
  source: string;
  /** Privileged parameters that can change what a sale returns. Empty when none exist. */
  privileges: Privilege[];
  /** Highest total fee the code allows on a sale, basis points (pool fee excluded). */
  maxSellFeeBps: number;
  /** Swap fees or taxes paid to the creator (the market panel's fee-recycling flag). */
  feesToCreator: boolean;
  /**
   * Supply counters a real transfer into a holder raises (token storage slots, read through `getter`). A balance
   * placed by state override for a simulated seller must raise them too, or the token's own accounting reverts
   * the sale. Absent when balances are the only state a transfer touches.
   */
  plantedSupply?: { getter: string; slots: number[] };
  notes: string;
}

export const TEMPLATES: TemplateEntry[] = [
  {
    id: "lift-token", launchpad: "lift", kind: "token", label: "lift.fun LaunchToken", match: { templateHash: "0x1a2a66547c78f4bd2fdb393f9d4777ffd36eb21e000be0b541f7817f3a23a897" },
    source: "LaunchToken, Sourcify 0x86fa149d4665ab8780fca00bf5cc9739846b0087", privileges: [], maxSellFeeBps: 0, feesToCreator: true,
    notes: "Fixed supply, no owner, no mint, no pause, no blocklist, no transfer tax. Pool fees are split by FeeLocker with a creator share fixed at launch.",
  },
  {
    id: "tolly-token", launchpad: "tolly", kind: "token", label: "TollyToken", match: { templateHash: "0x19ee1bdc473ca3d91e25700715295100e1c5f93eae664f6d6db26ea00d5bb13c" },
    source: "TollyToken, Sourcify 0xb2c834177d77fe0c22152d25162e956c89e0ff31", privileges: [], maxSellFeeBps: 0, feesToCreator: true,
    notes: "OpenZeppelin ERC-20 without owner; a max-wallet cap applies only during a fixed anti-snipe window after launch.",
  },
  {
    id: "argus-v4-token", launchpad: "argus", kind: "token", label: "ArgusV4LaunchToken7", match: { implementation: "0x1b74922c01ddfd9c77b37d02c0a236611e8fe500" },
    source: "ArgusV4LaunchToken7, Sourcify 0x1b74922c01ddfd9c77b37d02c0a236611e8fe500", privileges: [], maxSellFeeBps: 0, feesToCreator: true,
    notes: "EIP-1167 clone; no mint and no owner power. A reward tracker is notified on transfers inside a gas-capped try.",
  },
  {
    id: "argus-v5-token", launchpad: "argus", kind: "token", label: "ArgusV5RewardedToken", match: { templateHash: "0x90618541698189fee3aadc15d9fae92fb1716ecfeb26cd5576790a980d30035e" },
    source: "ArgusV5RewardedToken, Sourcify 0xf720bbadb4fc2f551e6c86b90fce0fbd24a34f82", privileges: [], maxSellFeeBps: 0, feesToCreator: true,
    plantedSupply: { getter: "eligibleSupply", slots: [18, 5] },
    notes: "No owner power over transfers. A transfer between a reward-eligible holder and an excluded address (the pool) moves `eligibleSupply` (slot 18, mirrored in the reward state at slot 5) and reverts on underflow.",
  },
  {
    id: "argus-v4-hook", launchpad: "argus", kind: "hook", label: "ArgusV4TaxHook", match: { templateHash: "0x01c0ed85ab9475893b901b8f0075fa48de426c56a0a6bed3b5cda478dde4927f" },
    source: "ArgusV4TaxHook, Sourcify 0x399218a6395d79c695ad4e95d53a6ed3914f2044", privileges: [], maxSellFeeBps: 0, feesToCreator: true,
    notes: "Buy and sell taxes are immutables set at deployment and cannot be raised; a launch surcharge decays with time, not by any call.",
  },
  {
    id: "argus-v5-hook", launchpad: "argus", kind: "hook", label: "ArgusV5TaxHook", match: { templateHash: "0xd39ec9e9c783551617277cfdfc21fffd510d6af57f7f242a5527a98a5b4e96c9" },
    source: "ArgusV5TaxHook, Sourcify 0x4b971e33fc4bf201c39128a3a61c3223b3ce60cc", privileges: [], maxSellFeeBps: 0, feesToCreator: true,
    notes: "Per-token immutables are splitter, buy tax, sell tax and quote asset; no setter changes a rate.",
  },
  {
    id: "arcora-token", launchpad: "arcora", kind: "token", label: "ArcoraToken", match: { templateHash: "0x0c9b0e8bec2e3bf4d4fe31127f19996f5cb7999bf74fe002afdfaf2fe09b3764" },
    source: "ArcoraToken, Sourcify 0xf129686cc0212481e0637010e35142296d864444", privileges: [], maxSellFeeBps: 0, feesToCreator: true,
    notes: "No owner, mint, pause or blocklist. Every transfer notifies the dividend distributor, whose onTransfer has no privileged path that can make it revert.",
  },
  {
    id: "arcora-hook", launchpad: "arcora", kind: "hook", label: "ArcoraHook", match: { address: "0x3d90f1e09ae04e1f09b216acd6018a6598f1eacc" },
    source: "ArcoraHook, Sourcify 0x3d90f1e09ae04e1f09b216acd6018a6598f1eacc",
    privileges: [{ role: "governor (timelock)", parameter: "guard parameters and external LP hold period", worst: "No effect on swap fees or on sales" }],
    maxSellFeeBps: 1100, feesToCreator: true,
    notes: "1% USDC fee plus a creator tax of at most 10%, set once per token at launch (setCreatorTax reverts AlreadyConfigured).",
  },
  {
    id: "o1-hook", launchpad: "o1", kind: "hook", label: "o1 LaunchHook", match: { address: "0x20eead6db6b3d0a4491e9073119dd0ebff166acc" },
    source: "LaunchHook, Sourcify 0x20eead6db6b3d0a4491e9073119dd0ebff166acc",
    privileges: [{ role: "factory", parameter: "creator fee recipient", worst: "Redirects fees only; rates are frozen per pool at registration" }],
    maxSellFeeBps: 1000, feesToCreator: true,
    notes: "Base fee frozen per pool, at most 10%; an anti-snipe surcharge falls over a fixed window after launch.",
  },
];

/** Every registry entry, hashed into each forecast record. */
export const REGISTRY = { version: REGISTRY_VERSION, hubs: HUBS, lockers: LOCKERS, templates: TEMPLATES };

const hubSet = new Set(HUBS.map((hub) => hub.address.toLowerCase()));
const lockerAddresses = new Set(LOCKERS.flatMap((locker) => (locker.address ? [locker.address.toLowerCase()] : [])));
const launchpadAddresses = new Set(LAUNCHPADS.flatMap((pad) => [...pad.entry, ...Object.keys(pad.custody)].map((address) => address.toLowerCase())));
const BURN = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead"]);

export const isHub = (address: string) => hubSet.has(address.toLowerCase());

/** Address roles for one launch. `lockedContracts` adds per-launch lockers recognised by code (clones, templates). */
export function rolesFor(launch: LaunchInfo, lockedContracts: Iterable<string> = []): AddressRoles {
  const marketAddress = launch.protocol === "v3" ? launch.pool.toLowerCase() : CHAIN.poolManager.toLowerCase();
  const locked = new Set([...lockedContracts].map((address) => address.toLowerCase()));
  const hook = launch.hooks.toLowerCase();
  return {
    isMarket: (address) => address === marketAddress,
    isInfrastructure: (address) => hubSet.has(address) || lockerAddresses.has(address) || locked.has(address) || BURN.has(address) || address === hook || address === launch.token,
    isLaunchpad: (address) => launchpadAddresses.has(address),
    isHub: (address) => hubSet.has(address),
  };
}

/** Is a liquidity owner a recognised lock? `facts` carries what the evidence gatherer learned about its code. */
export function isLocker(owner: string, facts: { implementation: string | null; templateHash: string | null }) {
  const address = owner.toLowerCase();
  if (BURN.has(address)) return true;
  return LOCKERS.some((locker) =>
    (locker.address && locker.address === address)
    || (locker.implementation && facts.implementation === locker.implementation)
    || (locker.templateHash && facts.templateHash === locker.templateHash));
}

export const templateById = (id: string | null | undefined) => TEMPLATES.find((template) => template.id === id) ?? null;

export function templateFor(kind: "token" | "hook", facts: { address: string; implementation: string | null; templateHash: string }) {
  return TEMPLATES.find((template) => template.kind === kind && (
    (template.match.address && template.match.address === facts.address.toLowerCase())
    || (template.match.implementation && template.match.implementation === facts.implementation)
    || (template.match.templateHash && template.match.templateHash === facts.templateHash))) ?? null;
}
