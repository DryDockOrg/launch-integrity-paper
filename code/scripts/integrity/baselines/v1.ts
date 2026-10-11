/**
 * DryDock v1, retired on 8 October 2026 and kept only as the baselines B1 and B2 of the v2 validation
 * (paper Section 7.3). `assess` is the code that ran from 7 October; with `version: "2026-10-01"` it is
 * the version the paper's audit read (no trading-costs factor, no holder-breadth discount). The score is
 * points over attainable points scaled to 100, then capped. Nothing on the site imports this file.
 */
import type { CreatorLaunch } from "../../../lib/api";
import type { Dossier } from "../../../lib/dossier";
import { creatorSummary } from "../../../lib/api";

/** v1's wallet classes, including the two v2 retired. */
export interface WalletProfile { address: string; kind: "bot" | "sniper" | "profitable" | "losing" | "flipper" | "new"; launches: number; sniped: number; wins: number; losses: number; pnl: number; medianHoldMinutes: number | null }

export type Verdict = "strong" | "speculative" | "risky" | "avoid";
export type Tone = "good" | "neutral" | "bad";

export interface Factor { id: string; label: string; points: number; max: number; tone: Tone; detail: string }
export interface Note { tone: Tone; text: string }

export interface Assessment {
  score: number; // 0-100
  verdict: Verdict;
  headline: string;
  factors: Factor[];
  reasons: Note[]; // why it could work
  risks: Note[]; // why it could fail
  holderSignals: Note[]; // what someone already holding should watch or act on
  caps: string[];
  wallets: WalletSummary | null;
}

export interface WalletSummary {
  profiled: number;
  snipers: number; sniperShare: number;
  profitableHolding: number; profitableShare: number; profitableExited: number;
  losingHolding: number;
}

export interface Context {
  dossier: Dossier;
  liquidity: number; // USDC
  marketCap: number;
  creatorLaunches: CreatorLaunch[]; // earlier launches by the same creator
  profiles?: Map<string, WalletProfile>;
  baseRate?: { reached: number; doubled: number } | null; // launches that reached this market cap, and of those how many doubled from it
  creatorProfile?: WalletProfile;
  /** Code version: "2026-10-07" (the last v1, default) or "2026-10-01" (the version the audit read). */
  version?: "2026-10-01" | "2026-10-07";
  /** Clock for time-dependent checks; defaults to now. */
  now?: number;
}

export const VERDICT_LABEL: Record<Verdict, string> = { strong: "Strong setup", speculative: "Speculative", risky: "High risk", avoid: "Avoid" };

const pct = (value: number, digits = 0) => `${(value * 100).toFixed(digits)}%`;
const usd = (value: number) => value >= 1000 ? `$${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : `$${value.toFixed(0)}`;
const minutes = (value: number) => value < 1 ? "under a minute" : value < 90 ? `${Math.round(value)} minute${Math.round(value) === 1 ? "" : "s"}` : `${(value / 60).toFixed(1)} hours`;
const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
/** Linear score: full points at `good`, none at `bad` (either direction). */
const scale = (value: number, bad: number, good: number) => clamp((value - bad) / (good - bad));

/** Turn the on-chain dossier into a scored, explained assessment. Thresholds follow common launch-trading practice. */
export function assess(context: Context): Assessment {
  const { dossier: d, liquidity, marketCap } = context;
  const m = d.market;
  const factors: Factor[] = [];
  const reasons: Note[] = [];
  const risks: Note[] = [];
  const holderSignals: Note[] = [];
  const caps: Array<[number, string]> = [];
  const add = (factor: Omit<Factor, "tone">) => {
    const ratio = factor.max ? factor.points / factor.max : 0;
    factors.push({ ...factor, points: Math.round(factor.points * 10) / 10, tone: ratio >= 0.7 ? "good" : ratio <= 0.3 ? "bad" : "neutral" });
  };

  // 1. Supply control: who can dump on you.
  const top10 = d.top10Share;
  const audited = context.version === "2026-10-01";
  const now = context.now ?? Date.now() / 1000;
  // Distribution only counts once there is a real holder base; two holders are not "well spread".
  const breadth = audited ? 1 : clamp(d.holderCount / 25);
  add({ id: "top10", label: "Top 10 holders", max: 10, points: 10 * scale(top10, 0.5, 0.15) * breadth, detail: `${pct(top10)} of supply outside the pool, across ${d.holderCount} holders` });
  const insiders = m.insiderShare;
  add({ id: "insiders", label: "Insider supply", max: 15, points: 15 * scale(insiders, 0.3, 0.03) * (audited ? 1 : 0.4 + 0.6 * breadth), detail: `${pct(insiders, 1)} held by the creator, launch-window buyers, and wallets sharing their funders` });
  if (insiders > 0.3) caps.push([30, "Insiders hold more than 30% of supply"]);
  const creatorExited = d.creator.peak > 0 && d.creator.soldTokens / d.creator.peak > 0.5;
  const collapsed = audited ? m.drawdown > 0.6 : m.drawdown > 0.6 || ((creatorExited || m.earlyExited > 0.6) && d.holderCount < 25);
  if (insiders >= 0.15) risks.push({ tone: "bad", text: `Insiders still hold ${pct(insiders)} of supply. That stock was bought at the lowest prices and can be sold into any rally.` });
  else if (insiders < 0.05 && collapsed && d.early.length >= 1) risks.push({ tone: "bad", text: "Insiders have already sold out, and the price fell with them." });
  else if (insiders < 0.05 && !collapsed) reasons.push({ tone: "good", text: `Insiders hold only ${pct(insiders, 1)} of supply, so there is little cheap stock left to dump.` });
  if (top10 > 0.4) risks.push({ tone: "bad", text: `The ten largest holders control ${pct(top10)} of supply.` });
  else if (top10 < 0.2 && d.holderCount >= 30 && !collapsed) reasons.push({ tone: "good", text: `Supply is spread out: ${d.holderCount} holders, top ten hold ${pct(top10)}.` });
  if (d.clusters.length) {
    const funded = d.clusters.reduce((sum, cluster) => sum + cluster.wallets.length, 0);
    risks.push({ tone: "bad", text: `${funded} launch-window buyers were funded by ${d.clusters.length === 1 ? "one shared wallet" : `${d.clusters.length} shared wallets`}${d.clusters.some((cluster) => cluster.label === "Creator") ? ", including the creator" : ""}. That is the signature of a bundled launch.` });
  }

  // 2. Creator.
  const history = creatorSummary(context.creatorLaunches);
  let creatorPoints = 6;
  if (history.total >= 5 && history.reached10k === 0) { creatorPoints = 0; risks.push({ tone: "bad", text: `The creator launched ${history.total} earlier tokens and none reached a $10k market cap.` }); }
  else if (history.reached100k > 0) { creatorPoints = 10; reasons.push({ tone: "good", text: `The creator has launched a token that reached $100k before (best peak ${usd(history.best)}).` }); }
  else if (history.total >= 20) { creatorPoints = 2; risks.push({ tone: "bad", text: `The creator is a serial launcher: ${history.total} earlier tokens, best peak ${usd(history.best)}.` }); }
  const creatorSold = d.creator.peak > 0 ? d.creator.soldTokens / d.creator.peak : 0;
  const creatorProfile = context.creatorProfile;
  if (d.creator.earlyBuyUsd >= 50 && d.creator.minutesToFirstSell != null && d.creator.minutesToFirstSell < 30) {
    creatorPoints = 0;
    risks.push({ tone: "bad", text: `The creator bought ${usd(d.creator.earlyBuyUsd)} of their own token at launch and started selling ${minutes(d.creator.minutesToFirstSell)} later.` });
  }
  if (creatorProfile && creatorProfile.launches >= 3 && creatorProfile.medianHoldMinutes != null && creatorProfile.medianHoldMinutes < 30 && creatorProfile.sniped >= 2) {
    creatorPoints = 0;
    caps.push([30, "The creator repeatedly buys early and sells within minutes"]);
    risks.push({ tone: "bad", text: `Across ${creatorProfile.launches} launches in the last day, the creator's wallet bought in the first seconds and sold after a median of ${minutes(creatorProfile.medianHoldMinutes)}${creatorProfile.pnl > 0 ? `, ending ${usd(creatorProfile.pnl)} ahead` : ""}. That is a pump-and-dump pattern.` });
  }
  if (creatorSold > 0.5) { creatorPoints = Math.max(0, creatorPoints - 6); risks.push({ tone: "bad", text: `The creator has sold ${pct(Math.min(1, creatorSold))} of their peak holding (${usd(d.creator.sellUsd)}).` }); }
  if (creatorSold > 0.5 && d.creator.holdsShare > 0.05) caps.push([35, "The creator is selling and still holds over 5%"]);
  add({ id: "creator", label: "Creator", max: 10, points: creatorPoints, detail: history.total ? `${history.total} earlier launches, best peak ${usd(history.best)}` : "First launch seen from this wallet" });

  // 3. Exit liquidity.
  const depth = liquidity;
  const ratio = marketCap > 0 ? depth / marketCap : 0;
  add({ id: "liquidity", label: "Liquidity depth", max: 10, points: 10 * scale(Math.log10(Math.max(depth, 1)), Math.log10(500), Math.log10(25_000)), detail: `${usd(depth)} of USDC in the pool, ${pct(ratio)} of market cap` });
  const impact = depth > 0 ? 500 / (depth + 500) : 1;
  if (depth < 1000) { caps.push([40, "Less than $1k of liquidity: exits are expensive"]); risks.push({ tone: "bad", text: `Only ${usd(depth)} of USDC in the pool. Selling $500 would move the price about ${pct(impact)}.` }); }
  let custodyPoints = 5;
  if (d.custody.kind === "wallet") { custodyPoints = 0; caps.push([25, "A wallet controls the liquidity position and can withdraw it"]); risks.push({ tone: "bad", text: "A regular wallet holds the liquidity position and can pull it at any time." }); }
  else if (d.custody.kind === "burned" || d.custody.kind === "launchpad") { reasons.push({ tone: "good", text: d.custody.kind === "burned" ? "Liquidity is burned and cannot be withdrawn." : "Liquidity is held by the launchpad, not by a wallet." }); }
  else if (d.custody.kind === "contract") custodyPoints = 3;
  add({ id: "custody", label: "Liquidity custody", max: 5, points: custodyPoints, detail: d.custody.kind === "burned" ? "Burned" : d.custody.kind === "launchpad" ? "Held by the launchpad" : d.custody.kind === "wallet" ? "Held by a wallet" : d.custody.kind === "contract" ? "Held by a contract" : "Not identified" });

  // Trading costs: hook taxes, pool fee, and the 0.5% swap fee on both legs.
  const f = d.fees;
  if (audited) { /* the trading-costs factor and the sell-tax cap arrived on 7 October */ }
  else if (f.buyTaxBps != null && f.sellTaxBps != null) {
    const roundTrip = f.buyTaxBps + f.sellTaxBps + 2 * f.poolBps + 100;
    add({ id: "costs", label: "Trading costs", max: 5, points: 5 * scale(roundTrip, 2500, 300), detail: `${(f.buyTaxBps / 100).toFixed(1)}% buy tax, ${(f.sellTaxBps / 100).toFixed(1)}% sell tax, ${(f.poolBps / 100).toFixed(2)}% pool fee` });
    if (f.buyTaxBps + f.sellTaxBps >= 1000) risks.push({ tone: "bad", text: `Taxes take ${(f.buyTaxBps / 100).toFixed(1)}% on every buy and ${(f.sellTaxBps / 100).toFixed(1)}% on every sell. A round trip needs roughly a ${(roundTrip / 100).toFixed(0)}% gain just to break even.` });
    if (f.sellTaxBps >= 2000) caps.push([35, "Sell tax of 20% or more"]);
  } else {
    add({ id: "costs", label: "Trading costs", max: 5, points: 2, detail: "The hook's taxes could not be read" });
  }
  if (!audited && f.antiSnipe && f.antiSnipe.endsAt > now) {
    const left = (f.antiSnipe.endsAt - now) / 60;
    risks.push({ tone: "bad", text: `An anti-snipe surcharge that started at ${(f.antiSnipe.startBps / 100).toFixed(0)}% is still active for about ${minutes(left)}. Buying now costs far more than the quoted price suggests.` });
  }

  // 4. Demand quality.
  const h1 = d.flow.h1;
  add({ id: "buyers", label: "Real buyers", max: 10, points: 10 * scale(h1.buyers, 2, 30), detail: `${h1.buyers} distinct buyers in the last hour` });
  const pressure = h1.buyUsd + h1.sellUsd > 0 ? h1.buyUsd / (h1.buyUsd + h1.sellUsd) : 0.5;
  add({ id: "pressure", label: "Buy pressure", max: 5, points: 5 * scale(pressure, 0.35, 0.65), detail: `${pct(pressure)} of the last hour's volume was buying` });
  const organic = 1 - Math.max(m.washShare, m.top3VolumeShare > 0.6 ? m.top3VolumeShare - 0.3 : 0);
  add({ id: "organic", label: "Organic volume", max: 5, points: 5 * scale(organic, 0.4, 0.9), detail: `${pct(m.washShare)} of 24h volume looks like wash trading; top 3 wallets made ${pct(m.top3VolumeShare)}` });
  if (m.washShare > 0.3) risks.push({ tone: "bad", text: `${pct(m.washShare)} of volume comes from wallets buying and selling the same amounts back and forth. Real demand is lower than the volume suggests.` });
  if (h1.buyers >= 20 && pressure > 0.55 && m.change1h > -0.2) reasons.push({ tone: "good", text: `${h1.buyers} different wallets bought in the last hour, with buyers outspending sellers ${usd(h1.buyUsd)} to ${usd(h1.sellUsd)}.` });
  if (m.newHolders1h >= 15 && m.change1h > -0.2) reasons.push({ tone: "good", text: `${m.newHolders1h} new holders in the last hour.` });

  // 5. Momentum.
  const accel = m.acceleration;
  const momentum = 4 * scale(m.change1h, -0.3, 0.3) + 3 * scale(1 - m.drawdown, 0.3, 0.8) + 3 * scale(accel, 0.5, 1.5);
  add({ id: "momentum", label: "Momentum", max: 10, points: momentum, detail: `${m.change1h >= 0 ? "+" : ""}${pct(m.change1h)} in 1h, ${pct(m.drawdown)} below peak, volume pace ${accel.toFixed(1)}x the hourly average` });
  if (m.drawdown > 0.7) risks.push({ tone: "bad", text: `Price is ${pct(m.drawdown)} below its peak. Most launches that fall this far do not recover.` });
  if (accel >= 1.5 && m.change1h > 0) reasons.push({ tone: "good", text: `Volume over the last 15 minutes is running ${accel.toFixed(1)}x the hourly pace and price is rising.` });

  // 6. Who is in it: wallet behaviour across other launches.
  let wallets: WalletSummary | null = null;
  if (context.profiles?.size) {
    const share = (address: string) => d.holders.find((holder) => holder.address === address)?.share ?? 0;
    const profiled = [...context.profiles.values()];
    const snipers = profiled.filter((profile) => profile.kind === "sniper" || profile.kind === "bot");
    const profitable = profiled.filter((profile) => profile.kind === "profitable");
    const profitableHolding = profitable.filter((profile) => share(profile.address) > 0);
    wallets = {
      profiled: profiled.length,
      snipers: snipers.length, sniperShare: snipers.reduce((sum, profile) => sum + share(profile.address), 0),
      profitableHolding: profitableHolding.length, profitableShare: profitableHolding.reduce((sum, profile) => sum + share(profile.address), 0),
      profitableExited: profitable.length - profitableHolding.length,
      losingHolding: profiled.filter((profile) => profile.kind === "losing" && share(profile.address) > 0).length,
    };
    const smart = 10 * clamp(wallets.profitableHolding / 3) - 10 * clamp(wallets.sniperShare / 0.2) * 0.6;
    add({ id: "wallets", label: "Smart money", max: 10, points: clamp(smart + 3, 0, 10), detail: `${wallets.profitableHolding} profitable traders holding, ${wallets.snipers} snipers holding ${pct(wallets.sniperShare, 1)}` });
    if (wallets.profitableHolding >= 2) reasons.push({ tone: "good", text: `${wallets.profitableHolding} wallets with a winning record on other launches currently hold it.` });
    if (wallets.sniperShare > 0.05) risks.push({ tone: "bad", text: `Snipers and trading bots hold ${pct(wallets.sniperShare, 1)} of supply. They usually sell into the first rally.` });
    if (wallets.profitableExited >= 2) holderSignals.push({ tone: "bad", text: `${wallets.profitableExited} wallets with a winning record have already sold out.` });
  }

  // 7. History: what usually happens from here.
  if (context.baseRate && context.baseRate.reached >= 20) {
    const rate = context.baseRate.doubled / context.baseRate.reached;
    (rate >= 0.3 ? reasons : risks).push({ tone: rate >= 0.3 ? "good" : "neutral", text: `Of ${context.baseRate.reached} launches on this launchpad that reached ${usd(marketCap)}, ${pct(rate)} went on to double from there.` });
  }

  // Holder guidance: concrete sell signals.
  if (d.creator.soldTokens > 0 && d.creator.firstSell && now - d.creator.firstSell < 3600) holderSignals.push({ tone: "bad", text: "The creator started selling within the last hour." });
  if (d.flow.h1.sellUsd > d.flow.h1.buyUsd * 1.5 && d.flow.h1.sellUsd > 200) holderSignals.push({ tone: "bad", text: `Sellers outweighed buyers ${usd(d.flow.h1.sellUsd)} to ${usd(d.flow.h1.buyUsd)} over the last hour.` });
  if (m.earlyExited > 0.6 && d.early.length >= 3) holderSignals.push({ tone: "neutral", text: `${pct(m.earlyExited)} of launch-window buyers have fully exited. Their selling is mostly done.` });
  if (creatorSold > 0.5) holderSignals.push({ tone: "bad", text: `The creator has already sold ${pct(Math.min(1, creatorSold))} of their peak holding.` });
  if (m.drawdown > 0.5) holderSignals.push({ tone: "bad", text: `Price is ${pct(m.drawdown)} below its peak${m.change1h < 0 ? " and still falling" : ""}.` });
  if (wallets && wallets.sniperShare > 0.05) holderSignals.push({ tone: "bad", text: `Snipers and bots still hold ${pct(wallets.sniperShare, 1)} and tend to sell into any bounce.` });
  if (!holderSignals.length) holderSignals.push({ tone: "good", text: "No sell signals right now: the creator is not selling, price is near its highs, and flow is not turning negative." });

  const max = factors.reduce((sum, factor) => sum + factor.max, 0);
  let score = Math.round((factors.reduce((sum, factor) => sum + factor.points, 0) / max) * 100);
  const binding = caps.sort((a, b) => a[0] - b[0])[0];
  if (binding && score > binding[0]) score = binding[0];
  const verdict: Verdict = score >= 70 ? "strong" : score >= 50 ? "speculative" : score >= 30 ? "risky" : "avoid";
  const headline = verdict === "strong" ? "Healthy distribution and real demand. Still a launch: size accordingly."
    : verdict === "speculative" ? "Some real demand, with risks worth watching before sizing up."
    : verdict === "risky" ? "Structural risks outweigh the positives. Only for small, fast trades."
    : "Supply or liquidity is controlled by a few wallets. The odds favour the people who got in first.";
  return { score, verdict, headline, factors, reasons, risks, holderSignals, caps: caps.map(([, text]) => text), wallets };
}
