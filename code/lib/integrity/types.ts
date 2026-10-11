import type { Grade, State, Stage } from "./params";

export type Hex = `0x${string}`;

/** A launch as the v2 method needs it. Addresses are lower case. */
export interface LaunchInfo {
  token: string;
  launchpad: string;
  creator: string;
  protocol: "v3" | "v4";
  /** V3 pool address, or the V4 pool id. */
  pool: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  usdcIs0: boolean;
  decimals: number;
  /** Total supply in raw units. */
  supply: bigint;
  /** Block of the launch transaction (pool creation). */
  block: number;
  tx: string;
  /** Block of the first swap, from which landmark ages are measured. */
  firstTradeBlock: number | null;
}

export interface TokenTransfer { block: number; index: number; tx: string; from: string; to: string; value: bigint }
/** A pool swap with the USDC and token legs as positive magnitudes. */
export interface PoolSwap { block: number; index: number; tx: string; buy: boolean; usdc: bigint; tokens: bigint; sqrtPriceX96: bigint }
/** USDC moved between two addresses (ERC-20 USDC or the native mirror, normalised to 6 decimals). */
export interface UsdcTransfer { block: number; index: number; tx: string; from: string; to: string; value: bigint }

/** A liquidity position in the main pool at the forecast block. */
export interface LiquidityPosition {
  /** "npm": V3 position NFT; "posm": V4 position NFT; "direct": a contract that called the pool or PoolManager itself. */
  manager: "npm" | "posm" | "direct";
  /** Who can act on it: the NFT owner, or the direct position's owner contract. */
  owner: string;
  tokenId: bigint | null;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  /** V4 position salt (the token id for PositionManager positions). */
  salt: Hex;
}

/** Nonces of an address at the two blocks the independence test reads; the second is null when the first already fails. */
export interface AddressHistory { beforeMargin: number; atCreation: number | null }

/** Everything the facts layer reads about one token at one forecast block. */
export interface Evidence {
  launch: LaunchInfo;
  /** Forecast block and its timestamp. */
  block: number;
  timestamp: number;
  /** Timestamp of the launch block (the history margin is measured back from it). */
  creationTimestamp: number;
  transfers: TokenTransfer[];
  swaps: PoolSwap[];
  positions: LiquidityPosition[];
  /** USDC transfers into wallets within the funding lookback, traced back hop by hop. */
  funding: UsdcTransfer[];
  /** USDC sent out by wallets after their first sale, up to the forecast block. */
  proceeds: UsdcTransfer[];
  history: Record<string, AddressHistory>;
  /** First block whose history the funding trace could read; later than the lookback start when history was truncated. */
  fundingFrom: number;
  /** Code facts about the token and hook (template ids from the registry, or null when unregistered). */
  code: { tokenTemplate: string | null; hookTemplate: string | null; tokenCodeHash: string; hookCodeHash: string | null };
}

export interface InsiderSets {
  /** Lower-bound set: creator and wallets tied to it by positive evidence, with balances at the forecast block. */
  lower: Map<string, bigint>;
  /** Pessimistic set: the lower-bound set plus every holder that fails the independence test. */
  pessimistic: Map<string, bigint>;
  /** Why each address is in a set. */
  reasons: Map<string, string[]>;
  /** Holders at the forecast block (balance > 0, infrastructure excluded). */
  holders: Map<string, bigint>;
  /** Independent trading entities: purchasers outside the lower-bound set, grouped by linked evidence. */
  entitiesOutsideLower: number;
  /** Evidence-graph component of every address seen, used to group wallets into entities. */
  component: Map<string, string>;
}

export interface Recovery {
  /** USDC returned per 100 USDC (or per notional, scaled to 100). */
  value: number;
  /** The reference purchase or sale reverted. */
  reverted: boolean;
}

export interface Facts {
  token: string;
  block: number;
  timestamp: number;
  state: State;
  /** Why the state is not "rated", in plain words. */
  stateReason: string | null;
  stage: Stage;
  friction: number | null; // USDC returned per 100 with no event
  /** Tokens the 100 USDC reference purchase returned, raw units (the position the resolver sells at the horizon). */
  referenceTokens: bigint | null;
  depth: number | null; // USDC returned per 100 on a 1,000 USDC round trip
  recovery: { T: number | null; L: number | null; ILower: number | null; IPessimistic: number | null };
  /** Losses given event, 0..1. */
  loss: { T: number | null; L: number | null; ILower: number | null; IPessimistic: number | null };
  floor: { low: number | null; high: number | null };
  grade: Grade | null;
  flags: string[];
  insiders: {
    lowerCount: number; pessimisticCount: number; holders: number; entitiesOutsideLower: number;
    lowerBalance: bigint; pessimisticBalance: bigint;
    /** USDC the insider sets would take out of the pool in the exit simulation. */
    lowerTakeUsdc: number; pessimisticTakeUsdc: number;
  };
  /** Positions the liquidity event withdrew, and the share of positions that stayed locked. */
  liquidity: { withdrawable: number; locked: number };
  fundingFrom: number;
  versions: { spec: Hex; params: Hex; registry: Hex };
}
