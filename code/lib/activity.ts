const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
/** Linear position between `bad` (0) and `good` (1). */
const scale = (value: number, bad: number, good: number) => clamp((value - bad) / (good - bad));

/** Activity rank for the launches list, from feed data alone. It sorts by trading activity and says nothing about structure. */
export function heat(row: { vol1h: number; buys1h: number; sells1h: number; liquidity: number; mcap: number; change1h: number; athMcap: number; ts: number }, now = Date.now() / 1000) {
  const trades = row.buys1h + row.sells1h;
  const pressure = trades ? row.buys1h / trades : 0.5;
  const depth = scale(Math.log10(Math.max(row.liquidity, 1)), Math.log10(300), Math.log10(20_000));
  const activity = scale(Math.log10(Math.max(row.vol1h, 1)), Math.log10(50), Math.log10(20_000));
  const trend = scale(row.change1h, -30, 40);
  const drawdown = row.athMcap > 0 ? 1 - row.mcap / row.athMcap : 0;
  const fresh = now - row.ts < 3600 ? 0.1 : 0;
  return Math.round(100 * clamp(0.35 * activity + 0.2 * depth + 0.2 * pressure + 0.15 * trend + 0.1 * (1 - drawdown) + fresh));
}
