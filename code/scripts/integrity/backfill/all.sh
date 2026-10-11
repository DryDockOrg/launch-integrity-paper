#!/bin/sh
# The whole backfill from public Arc nodes, in order. Every step resumes where it stopped, so the script
# can be restarted at any point (the systemd unit beside it restarts it on failure).
#
#   INTEGRITY_DATA=/path/to/data scripts/integrity/backfill/all.sh
set -e
cd "$(dirname "$0")/../../.."
step() { echo "== $1 $(date -u +%FT%TZ)"; }
step discover;  npx tsx scripts/integrity/discover.ts
step pools;     npx tsx scripts/integrity/backfill/scan.ts pools
step usdc;      npx tsx scripts/integrity/backfill/scan.ts usdc
step transfers; npx tsx scripts/integrity/backfill/scan.ts transfers
step records;   npx tsx scripts/integrity/backfill/run.ts
step finished
