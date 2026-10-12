# Codebook

Data for *Calibrated Launch Integrity* (Ghasemlu, 2026), working paper version of 12 October 2026.
Chain: Arc mainnet (chainId 5042). Addresses are lowercase hex. Blocks are Arc block numbers; `ts` is a Unix
timestamp (seconds, UTC). Recoveries are in USDC per 100 USDC of the reference position. Written by
`analysis/dataset.py`; every number in Section 8 of the paper is computed from these files by `analysis/results.py`.

## launches.csv.gz

Every launch on the seven launchpads DryDock lists, created from 16 September 2026 00:00 UTC (block 21,068,653)
to 7 October 2026 23:59:59 UTC (block 24,812,189). 202,944 rows.

| Column | Meaning |
| --- | --- |
| `token` | Token contract |
| `launchpad` | `argus`, `lift`, `tolly`, `o1`, `arcpad`, `arcora` or `sashimi` |
| `creator` | Address that sent the creating transaction |
| `protocol` | `v3` (Uniswap V3 pool) or `v4` (Uniswap V4 pool) |
| `pool` | V3 pool address, or V4 pool id |
| `fee` | Pool fee in hundredths of a basis point (10000 = 1%) |
| `hooks` | V4 hook contract (zero address for none and for V3) |
| `block`, `tx` | Creation block and transaction |
| `symbol` | Token symbol as read on chain |
| `first_trade` | Block of the pool's first swap; empty if it never traded within the scanned range |
| `traded` | Whether `first_trade` is set |

## records.csv.gz

Retrospective records (paper deviation D1): five per launch, for a fixed sample of 9,475 traded launches (D11),
computed after their outcomes by the same code that issues live records, under method 2.0.3. 47,375 rows.

| Column | Meaning |
| --- | --- |
| `token`, `launchpad`, `creator` | As in `launches.csv.gz` |
| `landmark` | Seconds after the first trade: 60, 600, 3600, 21600 or 86400 (−1 marks a launch that failed to compute; none did) |
| `block`, `ts` | Forecast block and its timestamp |
| `state` | `rated`, `too_early` or `unobservable` (Section 5.6) |
| `state_reason` | Why a record abstains |
| `grade` | A–E grade of the floor's lower end (rated records only) |
| `leaf` | Merkle leaf of the encoded record (Appendix A.4) |
| `friction` | Recovery of a 100 USDC round trip with no event |
| `depth` | Recovery of a 1,000 USDC round trip, per 100 |
| `recovery_T`, `recovery_L` | Recovery after the tradability and liquidity events |
| `recovery_ILower`, `recovery_IPessimistic` | Recovery after an exit by the lower-bound and the pessimistic insider set |
| `floor_low`, `floor_high` | Structural floor interval (minimum recovery across events, at each insider bound) |
| `holders` | Holders at the forecast block |
| `lower_count`, `pessimistic_count` | Holders in each insider set |
| `entities_outside_lower` | Independent purchasing entities outside the lower bound (ratings need 10) |
| `lower_take_usdc`, `pessimistic_take_usdc` | USDC each set's exit would take from the pool |
| `history_pass_share` | Share of holders passing the address-history margin |
| `withdrawable_positions` | Liquidity positions their owners could withdraw |
| `flags` | Notes from the facts layer, `;`-separated |
| `token_template`, `hook_template` | Registry template matched (empty when unregistered) |
| `recovery_at_horizon` | Value of the reference position 24 hours after the forecast (rated records) |
| `severe_loss` | `recovery_at_horizon` ≤ 20 |
| `horizon_block` | First block at least 24 hours after the forecast |
| `insider_outflow` | Net tokens the pessimistic set sold or sent out by the horizon, as a share of its balance |
| `liquidity_withdrawn` | Quote-side liquidity withdrawn by the horizon, as a share of that at the forecast |
| `fired_T`, `fired_L`, `fired_I` | Whether each event fired before the horizon (Appendix A.5) |
| `event_block_*` | Block at which the event fired |
| `realised_*` | Realised recovery at the event: value at the firing block over value at the block before, × 100 |
| `v1_score_1001`, `v1_score_1007` | v1 score under the 1 October and 7 October rules (baselines B1, B2; rated records) |
| `v1_factors_1007` | v1 factor points under the 7 October rule, JSON |
| `error` | Error text, if any part failed (none did) |
| `retrospective` | Always true in this file |

## committed.csv.gz

Records issued live from 8 October 2026 and batched for the ForecastLedger, as published by DryDock's API on
12 October 2026. 17,793 rows. No root had been posted on chain at download, so none counts as committed in time (D8).

| Column | Meaning |
| --- | --- |
| `batch`, `root` | Batch sequence number and its Merkle root |
| `tx`, `committed_block` | Transaction and block of the root's commitment (empty until posted) |
| `id` | Record id |
| `token`, `launchpad`, `landmark`, `block`, `leaf`, `state`, `floor_low`, `floor_high` | As in `records.csv.gz` |
| `resolution` | Resolution JSON, once resolved (rated records only, D14) |
