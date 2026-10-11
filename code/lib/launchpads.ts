import type { Address } from "viem";

/**
 * Shared chain constants and the launchpad registry. A launchpad is listed only when
 * the swap router can route every token it launches: canonical Uniswap V3 USDC pools, or V4
 * ERC-20 USDC pools whose hook the router allows (`isHookAllowed`).
 */
export const CHAIN = {
  id: 5042,
  usdc: "0x3600000000000000000000000000000000000000",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  v3Factory: "0xf0db7b58379503491d857db50ac9ece64c653918",
  v3PositionManager: "0x39654a85a4c05127f5fd6ed22caec077a0fb1377",
  v3Router: "0x53bf6b0684ec7ef91e1387da3d1a1769bc5a6f77",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  v4PositionManager: "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b",
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  universalRouter: "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  swapRouter: "0x5b86f1e5d95eFe358004B4484bF0a8C386c419a8",
} as const satisfies Record<string, Address | number>;

export const EXPLORER = "https://explorer.arc.io";


export type Protocol = "v3" | "v4";

export interface Launchpad {
  id: string;
  name: string;
  url: string;
  protocol: Protocol;
  /** Contracts a launch transaction is sent to. Pool creation in such a transaction is attributed to this launchpad. */
  entry: readonly Address[];
  /** V4 hooks shared by every launch of this launchpad; pools using them are attributed without the entry check. */
  hooks?: readonly Address[];
  /** Launchpad-owned contracts that hold liquidity positions or fees (labelled in holder and custody views). */
  custody: Readonly<Record<string, string>>;
  model: string;
  /** Fee or tax mechanics a trader should know before buying; shown on token pages. */
  fees?: string;
  /** Extra caution for very young tokens (e.g. anti-snipe surcharges), shown while the token is under an hour old. */
  launchWarning?: string;
}

export const LAUNCHPADS: readonly Launchpad[] = [
  {
    id: "lift",
    name: "lift.fun",
    url: "https://lift.fun",
    protocol: "v3",
    entry: ["0x3f29dd25d1f6ad3d09d1d4a880f8a869e3039153"],
    custody: {
      "0x98015dda2b8810ab67903c726a0e424d6d51b1a9": "lift.fun fee locker",
      "0x826d695e64a44c0347982eda6d3183f12eb1ac4f": "lift.fun LP vault",
    },
    model: "Instant launches straight into a 1% Uniswap V3 pool paired with USDC. Liquidity is held by the launchpad.",
  },
  {
    id: "tolly",
    name: "Tolly",
    url: "https://tolly.xyz",
    protocol: "v3",
    entry: ["0xcad7ee36ac193bf2eddb7b3e2736c5bdb8269c8b"],
    custody: { "0xe20e4297759597da75c8998ee76ec900600ad920": "Tolly fee locker" },
    model: "Instant launches into a 1% Uniswap V3 USDC pool with liquidity locked by the launchpad.",
  },
  {
    id: "arcpad",
    name: "ArcPad",
    url: "https://arcpad.meme",
    protocol: "v3",
    entry: ["0x24196CD6e534cfCE8F480B53E70809b68Ea86F29"],
    custody: {},
    model: "Single-sided Uniswap V3 USDC pools: the full supply starts in the pool and price rises as people buy.",
  },
  {
    id: "argus",
    name: "Argus",
    url: "https://argus.world",
    protocol: "v4",
    entry: ["0xB021Be536808f551b31789422Fd28a6c9c6e97Da", "0xeed7559b8a6abf64427dc41cb5cc6400109c5d93"], // V4 portal and V5 portal
    custody: {},
    model: "The most active launchpad on Arc. Each token gets a Uniswap V4 USDC pool with its own hook, which can apply creator-set buy and sell taxes.",
  },
  {
    id: "sashimi",
    name: "Sashimi",
    url: "https://sashimi.fun",
    protocol: "v3",
    entry: ["0x5b7bf9bd9c35a845ec1d469ed58616e7076a6f5c", "0x88af410d58fd5dc0ec24c3979668c02bb940c3a7"],
    custody: { "0x68f108487e3cbf75d749b9291071ce0e3b1e0487": "Sashimi liquidity locker" },
    model: "Tokens start on a bonding curve and appear here once they graduate into a Uniswap V3 USDC pool.",
  },
  {
    id: "arcora",
    name: "Arcora",
    url: "https://arcora.fun",
    protocol: "v4",
    entry: ["0xacff3358557519ff7e482c75df4a7153532d37fa"],
    custody: {},
    model: "Uniswap V4 USDC pools with a shared hook. Each token can carry a creator tax, set once at launch.",
    fees: "1% fee in USDC on every swap, plus a creator tax of up to 10% set once per token.",
  },
  {
    id: "o1",
    name: "o1 Launchpad",
    url: "https://launch.o1.exchange",
    protocol: "v4",
    entry: ["0xee3e862efde6dcd6df5648af0e2731b9d1df4605"],
    custody: {},
    model: "Uniswap V4 USDC pools with a shared hook. Fees are fixed per pool at launch.",
    fees: "Swap fee fixed per pool at launch, capped at 10%.",
    launchWarning: "o1 applies an anti-snipe surcharge right after launch that can start as high as 99% and falls over a set window. Buying in the first minutes can cost far more than the price suggests.",
  },
];

const byEntry = new Map(LAUNCHPADS.flatMap((pad) => pad.entry.map((address) => [address.toLowerCase(), pad] as const)));
export const launchpadForEntry = (to: string | null | undefined) => (to ? byEntry.get(to.toLowerCase()) : undefined);
const byHook = new Map(LAUNCHPADS.flatMap((pad) => (pad.hooks ?? []).map((hook) => [hook.toLowerCase(), pad] as const)));
export const launchpadForHook = (hooks: string | null | undefined) => (hooks ? byHook.get(hooks.toLowerCase()) : undefined);
export const launchpadById = (id: string | null | undefined) => LAUNCHPADS.find((pad) => pad.id === id);

/** Well-known addresses that are never "holders" in the trader sense. */
export const KNOWN_ADDRESSES: Readonly<Record<string, string>> = {
  "0x0000000000000000000000000000000000000000": "Zero address (burned)",
  "0x000000000000000000000000000000000000dead": "Dead address (burned)",
  [CHAIN.poolManager]: "Uniswap V4 PoolManager (pool liquidity)",
  [CHAIN.v3PositionManager]: "Uniswap V3 position manager",
  [CHAIN.v4PositionManager]: "Uniswap V4 position manager",
  [CHAIN.universalRouter]: "Uniswap Universal Router",
  [CHAIN.v3Router]: "Uniswap SwapRouter02",
  [CHAIN.permit2.toLowerCase()]: "Permit2",
  [CHAIN.swapRouter.toLowerCase()]: "Swap router",
  ...Object.assign({}, ...LAUNCHPADS.map((pad) => pad.custody)),
};

/** V4 hook permission bits that let a hook change swap amounts (beforeSwap/afterSwap and their deltas). */
export const SWAP_HOOK_FLAGS = 0xccn;
export const hookTouchesSwaps = (hooks: string) => (BigInt(hooks) & SWAP_HOOK_FLAGS) !== 0n;

/** Price of one whole token in USDC from a Uniswap sqrtPriceX96. USDC has 6 decimals. */
export function sqrtPriceToUsdc(sqrtPriceX96: bigint, usdcIs0: boolean, tokenDecimals: number) {
  if (sqrtPriceX96 <= 0n) return 0;
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2; // token1 per token0 in raw units
  const scale = 10 ** (tokenDecimals - 6);
  const result = usdcIs0 ? scale / ratio : ratio * scale;
  return Number.isFinite(result) && result > 0 ? result : 0;
}

/**
 * USDC-side and signed direction of a swap. V3 amounts are pool deltas (positive = paid into the pool);
 * V4 amounts are swapper deltas (negative = paid by the swapper). Verified against USDC transfer logs.
 */
export function swapSide(protocol: Protocol, usdcDelta: bigint) {
  const buy = protocol === "v3" ? usdcDelta > 0n : usdcDelta < 0n;
  const abs = usdcDelta < 0n ? -usdcDelta : usdcDelta;
  return { buy, usd: Number(abs) / 1e6 };
}
