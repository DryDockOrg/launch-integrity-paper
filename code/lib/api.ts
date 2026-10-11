export const API = process.env.NEXT_PUBLIC_API_URL ?? "https://api.drydockprotocol.org";

export interface FeedRow {
  token: string; symbol: string; name: string; launchpad: string; creator: string;
  protocol: "v3" | "v4"; pool: string; ts: number;
  price: number; mcap: number; athMcap: number; liquidity: number;
  vol1h: number; vol24h: number; buys1h: number; sells1h: number; buys24h: number; sells24h: number;
  change1h: number; change24h: number; lastTrade: number; spark: number[];
  creatorLaunches: number; creatorBest: number; updated: number;
  /** Latest v2 record: landmark age, state, grade and floor interval (USDC per 100). */
  integrity?: { landmark: number; state: string; grade: string | null; floorLow: number | null; floorHigh: number | null } | null;
}

export interface Status {
  ok: boolean; at: number; head: number; cursor: number; lag: number; launches: number; clients: number;
  lastTick: number; gapBlocks: number; error?: string;
  budget: { day: string; d1Rows: number; doRows: number; d1Limit: number; doLimit: number; paused: string[] };
  launchpads: Array<{ id: string; tracked: number }>;
}

/** A launch as stored in the D1 catalog. */
export interface LaunchRecord {
  token: string; launchpad: string; creator: string; symbol: string; name: string; decimals: number; supply: number;
  protocol: "v3" | "v4"; pool: string; fee: number; tick_spacing: number; hooks: string; usdc_is0: number;
  block: number; tx: string; ts: number; price: number; ath_mcap: number; liquidity: number; volume: number;
  trades: number; last_trade: number; creator_launches: number; creator_best: number;
}

export interface CreatorLaunch {
  token: string; launchpad: string; symbol: string; name: string; ts: number; price: number; supply: number;
  ath_mcap: number; liquidity: number; volume: number; trades: number; last_trade: number;
}

export interface Creator { address: string; launches: CreatorLaunch[] }

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`);
  if (response.status === 404) throw new NotFound();
  if (!response.ok) throw new Error(`DryDock API returned ${response.status}.`);
  return response.json() as Promise<T>;
}

export class NotFound extends Error { constructor() { super("Not found"); } }

export const fetchToken = (token: string) => get<{ launch: LaunchRecord; creator: Creator; partial?: boolean }>(`/v1/token/${token.toLowerCase()}`);
export const fetchCreator = (creator: string) => get<Creator>(`/v1/creator/${creator.toLowerCase()}`);
export const fetchLaunchpadCounts = () => get<{ launchpads: Array<{ launchpad: string; total: number; day: number; week: number; over100k: number; since: number }> }>("/v1/launchpads");

/** Catalog rows for up to 100 tokens per request; unknown tokens are simply absent. */
export async function fetchLaunches(tokens: string[]) {
  const unique = [...new Set(tokens.map((token) => token.toLowerCase()))].sort();
  const found: LaunchRecord[] = [];
  for (let index = 0; index < unique.length; index += 100) {
    found.push(...(await get<{ launches: LaunchRecord[] }>(`/v1/launches?tokens=${unique.slice(index, index + 100).join(",")}`)).launches);
  }
  return found;
}

/** A creator's outcome summary, used on Discover rows and the token page. */
export function creatorSummary(launches: Array<Pick<CreatorLaunch, "ath_mcap" | "liquidity" | "last_trade" | "ts">>, now = Date.now() / 1000) {
  const total = launches.length;
  const reached10k = launches.filter((launch) => launch.ath_mcap >= 10_000).length;
  const reached100k = launches.filter((launch) => launch.ath_mcap >= 100_000).length;
  const alive = launches.filter((launch) => now - launch.last_trade < 86_400).length;
  const best = launches.reduce((max, launch) => Math.max(max, launch.ath_mcap), 0);
  const recent = launches.filter((launch) => now - launch.ts < 86_400).length;
  return { total, reached10k, reached100k, alive, best, recent };
}

export interface Outcomes { ladder: number[]; launchpads: Record<string, { total: number; reached: number[] }> }
export const fetchOutcomes = () => get<Outcomes>("/v1/outcomes");

/** Of launches on a launchpad that reached `mcap`, how many went on to reach twice that. */
export function baseRate(outcomes: Outcomes | undefined, launchpad: string, mcap: number) {
  const pad = outcomes?.launchpads[launchpad];
  if (!pad || mcap <= 0) return null;
  const index = (value: number) => { let found = -1; outcomes!.ladder.forEach((step, position) => { if (step <= value) found = position; }); return found; };
  const at = index(mcap), twice = index(mcap * 2);
  if (at < 0 || twice < 0) return null;
  // Only meaningful above the typical launch's peak; below that, almost every launch "reached" it at birth.
  if (pad.reached[at] > pad.total / 2) return null;
  return { reached: pad.reached[at], doubled: pad.reached[twice] };
}
