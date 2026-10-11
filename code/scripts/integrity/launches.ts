/** Shared definitions for the backfill: the population's first block and the launch record discover.ts writes. */
export const MAINNET_OPEN_BLOCK = 21_068_653; // first block with timestamp >= 2026-09-16T00:00:00Z
/** Last block of the backfill population (2026-10-07T23:59:59Z): committed records begin on 8 October 2026. */
export const POPULATION_END_BLOCK = 24_812_189;

export interface DiscoveredLaunch {
  token: string; launchpad: string; creator: string; protocol: "v3" | "v4"; pool: string; fee: number; tickSpacing: number;
  hooks: string; usdcIs0: boolean; decimals: number; supply: string; block: number; tx: string; txIndex: number; symbol: string; name: string;
}

/**
 * The backfill sample (paper Section 8.2): every traded launch of a launchpad with at most SAMPLE_CAP traded
 * launches, and SAMPLE_CAP launches drawn uniformly from each larger one by a seeded hash of the token address.
 * Scanning every token's transfers for 48 hours after its first trade would download every Transfer log on
 * Arc; the sample keeps each window to one address-filtered query. Fixed before any record was computed.
 */
export const SAMPLE_CAP = 3_000;
export const SAMPLE_SEED = "launch-integrity-backfill-v1";

export function backfillSample<T extends { token: string; launchpad: string }>(traded: T[], rank: (token: string) => string): T[] {
  const pads = new Map<string, T[]>();
  for (const launch of traded) { if (!pads.has(launch.launchpad)) pads.set(launch.launchpad, []); pads.get(launch.launchpad)!.push(launch); }
  return [...pads.values()].flatMap((list) => (list.length <= SAMPLE_CAP ? list : [...list].sort((a, b) => (rank(a.token) < rank(b.token) ? -1 : 1)).slice(0, SAMPLE_CAP)));
}
