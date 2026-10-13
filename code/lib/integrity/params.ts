/**
 * Constants of the v2 method (Calibrated Launch Integrity, Appendix A.1), with the one change the
 * implementation forced: the funding lookback. Every value here enters `PARAMS_HASH`, which every
 * forecast record carries, so a change to any of them is a new parameter version.
 */
export const SPEC_VERSION = "2.1.0";

export const PARAMS = {
  /** Reference notional, USDC with 6 decimals. */
  notional: 100_000_000n,
  /** Notional of the depth line in the market panel. */
  depthNotional: 1_000_000_000n,
  /** Primary horizon in seconds. Secondary horizons (1 h, 7 d) are reported in the dataset only. */
  horizon: 86_400,
  secondaryHorizons: [3_600, 604_800],
  /** Token ages after the first trade at which forecasts are issued and evaluated, seconds. */
  landmarks: [60, 600, 3_600, 21_600, 86_400],
  /** Recovery drop, in points per 100, that defines a tradability event. */
  tradabilityDrop: 20,
  /** Share of quote-side liquidity withdrawn that defines a liquidity event. */
  liquidityShare: 0.5,
  /** Share of the pessimistic set's tokens net-sold that defines an insider exit. */
  insiderShare: 0.5,
  /** Severe loss: the reference position returns this many USDC or fewer at the horizon. */
  severeLossUsdc: 20,
  /** Launch window for the independence test, blocks (about ten seconds on Arc). */
  launchWindowBlocks: 20,
  /** Funding-path depth for the lower-bound set. */
  fundingDepth: 3,
  /**
   * Funding lookback before a wallet's first purchase, in blocks (86,400 blocks is about 12 hours).
   * Appendix A.1 of the paper's first version set 7 days; public Arc log history keeps about 42 hours,
   * so a 7-day trace cannot be computed at forecast time and the records would not be reproducible.
   * 12 hours is the longest fixed lookback that fits that history at every landmark (deviation D2).
   */
  fundingLookbackBlocks: 86_400,
  /** Address history required for independence: activity this long before token creation... */
  historyMargin: 2_592_000,
  /** ...and at least this many transactions sent before token creation. */
  historyMinTx: 10,
  /** Transfers below this (USDC, 6 decimals) never create a link. */
  dustUsdc: 1_000_000n,
  /** A transfer creates a link only if it carries at least this share of what the recipient then spent or forwarded. */
  materialShare: 0.5,
  /**
   * Below these the state is "too early". Appendix A.1 first said 120 blocks, meaning about a minute; Arc
   * makes about 1.97 blocks a second, so a record at the 1-minute landmark was 118 blocks old and could
   * never be rated. The age is therefore measured in block time (deviation D3).
   */
  minAgeSeconds: 60,
  minEntities: 10,
  /** Probability interval width above which the state is "low confidence" (Stage 1 and later). */
  maxIntervalWidth: 0.4,
  /** Blocks between Merkle-root postings, about five minutes. */
  commitInterval: 600,
  /** A record counts as committed only if its root was posted within this many blocks of its forecast block. */
  commitDeadline: 1_200,
  /** Resolved forecasts a model version needs in shadow before it can be promoted. */
  shadowLength: 1_000,
  /** Stage 1 sample-size gates (Section 7.5). */
  gates: { resolved: 2_000, clusters: 500, eventsPerChannel: 100, perLaunchpad: 300 },
  /** Grade bands on the lower end of the floor, USDC per 100. */
  grades: [["A", 90], ["B", 75], ["C", 50], ["D", 20], ["E", 0]] as const,
  /** When more than this share of a launchpad's launches share one grade, the interval and its percentile are shown instead. */
  gradeConcentration: 0.8,
  /** Wallet skill label (Section 5.8). */
  skill: { windowDays: 30, minLaunches: 20, margin: 0.05, priorWeight: 20, posterior: 0.95, fdr: 0.1 },
  /** Insider sellers simulated one by one; the rest of a larger set is sold as one block (deviation D4). */
  maxIndividualSellers: 100,
} as const;

export type Grade = (typeof PARAMS.grades)[number][0];
export type State = "rated" | "too_early" | "unobservable" | "low_confidence";
export type Channel = "T" | "L" | "I";
export type Stage = 0 | 1 | 2;

/** Arc produces about two blocks per second; used only to size block ranges, never in a computation. */
export const BLOCKS_PER_SECOND = 2;

export function gradeOf(floorLow: number): Grade {
  for (const [grade, threshold] of PARAMS.grades) if (floorLow >= threshold) return grade;
  return "E";
}

/** JSON with bigints as decimal strings and keys in sorted order, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])]));
  }
  return value;
}
