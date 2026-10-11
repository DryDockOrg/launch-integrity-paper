# Code

The code that produced the records analysed in the paper: the facts layer (simulation, insider sets, registry,
abstentions), forecast records and their Merkle commitment, the resolver, the backfill, and v1 kept runnable as
the baselines B1 and B2. It runs with Node 24.

This is a snapshot of DryDock's implementation at method 2.0.3. Some identifiers and comments were renamed to
neutral terms and the RPC endpoints moved to configuration; behaviour is unchanged. That was checked by recomputing
30 published records (21 of them rated, with resolutions) with this snapshot against the same chain data: every
record hash and every resolution is identical.

## Setup

```sh
npm ci
npm test            # Appendix B acceptance checks, Propositions 2 and 4, record encoding, v1 baseline
```

Endpoints come from the environment:

| Variable | What it must serve |
| --- | --- |
| `ARC_CALL_RPC` | Arc calls (`eth_call` with state overrides), historical state, transactions, and logs in 100-block windows |
| `ARC_ARCHIVE_RPCS` | Comma-separated Arc archive nodes, used as the fallback |
| `ARC_RECENT_RPC` | Optional: a node accepting wide log ranges over recent history |
| `INTEGRITY_DATA` | Directory for the backfill store (about 21 GB) |

## Reproducing the records

```sh
sh scripts/integrity/backfill/all.sh
```

runs, in order and resumably: `discover.ts` (every launch on the seven launchpads from 16 September to the end of
7 October 2026, written to `launches.json`), `backfill/scan.ts pools`, `usdc` and `transfers` (the local store of
pool events, USDC moves and the sampled tokens' transfers), and `backfill/run.ts` (five records per sampled launch,
their resolutions and v1 scores). The sample is fixed by `backfillSample` in `scripts/integrity/launches.ts`.
`../analysis/dataset.py` then writes the released CSV files from the store.

Other entry points: `scripts/compile-simulator.ts` (solc 0.8.30, the simulator and ledger in `lib/integrity/sim/`),
`scripts/integrity/spec-hash.ts` (the hash of Appendix A that every record carries), and
`scripts/integrity/check-launchpads.ts` (per-launchpad acceptance checks of the floor).
