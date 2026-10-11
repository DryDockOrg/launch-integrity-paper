/**
 * The backfill's ChainReader: logs come from the local store built by scan.ts (and must be covered by it),
 * everything else (calls, code, timestamps, transaction counts) from an archive node. Because the facts
 * layer only sees this interface, retrospective records are produced by the same code as live ones.
 */
import { CHAIN } from "../../../lib/launchpads";
import { NATIVE_EMITTER, TOPIC, type ChainReader, type LogFilter, type RawLog } from "../../../lib/integrity/evidence";
import type { StateOverride } from "../../../lib/integrity/simulate";
import { batch, call, hex } from "../archive";
import { db } from "./store";

const byKey = db.prepare("SELECT block, idx, tx, address, topics, data FROM logs WHERE kind = ? AND key = ? AND block BETWEEN ? AND ? ORDER BY block, idx");
const npmLogs = db.prepare("SELECT block, idx, tx, address, topics, data FROM logs WHERE kind = 'npm' AND block BETWEEN ? AND ? ORDER BY block, idx");
const usdcTo = db.prepare("SELECT block, idx, tx, src, dst, value, native FROM usdc WHERE dst = ? AND block BETWEEN ? AND ?");
const usdcInbound = db.prepare("SELECT block, idx, tx, src, dst, value, native FROM usdc WHERE dst = ? AND block BETWEEN ? AND ? AND value >= ? ORDER BY block, idx");
const usdcFrom = db.prepare("SELECT block, idx, tx, src, dst, value, native FROM usdc WHERE src = ? AND block BETWEEN ? AND ?");

type Row = { block: number; idx: number; tx: string; address: string; topics: string; data: string };
const toLog = (row: Row): RawLog => ({ address: row.address, topics: JSON.parse(row.topics), data: row.data, blockNumber: row.block, logIndex: row.idx, transactionHash: row.tx });
const pad = (address: string) => `0x${address.slice(2).padStart(64, "0")}`;
const usdcLog = (row: { block: number; idx: number; tx: string; src: string; dst: string; value: number | bigint; native: number }): RawLog => ({
  address: row.native ? NATIVE_EMITTER : CHAIN.usdc,
  topics: [TOPIC.transfer, pad(row.src), pad(row.dst)],
  data: `0x${(BigInt(row.value) * (row.native ? 1_000_000_000_000n : 1n)).toString(16).padStart(64, "0")}`,
  blockNumber: row.block, logIndex: row.idx, transactionHash: row.tx,
});
const asList = (value: string | string[] | null | undefined) => (value == null ? null : Array.isArray(value) ? value : [value]);

export class CoverageError extends Error {}

export function storeReader(head: number): ChainReader & { calls: number } {
  const times = new Map<number, number>();
  let calls = 0;
  const timestamp = async (block: number) => {
    const known = times.get(block);
    if (known != null) return known;
    calls++;
    const value = Number((await call<{ timestamp: string }>("eth_getBlockByNumber", [hex(block), false])).timestamp);
    times.set(block, value);
    return value;
  };
  return {
    get calls() { return calls; },
    async logs(filter: LogFilter, from: number, to: number) {
      const address = asList(filter.address)?.map((item) => item.toLowerCase()) ?? [];
      const topic0 = asList(filter.topics[0] as string | string[]) ?? [];
      if (address.length === 2 && address.includes(CHAIN.usdc) && address.includes(NATIVE_EMITTER)) {
        const recipients = asList(filter.topics[2] as string | string[] | null);
        const senders = asList(filter.topics[1] as string | string[] | null);
        const rows = recipients
          ? recipients.flatMap((topic) => usdcTo.all(`0x${topic.slice(26)}`, from, to) as never[])
          : (senders ?? []).flatMap((topic) => usdcFrom.all(`0x${topic.slice(26)}`, from, to) as never[]);
        return (rows as Array<Parameters<typeof usdcLog>[0]>).map(usdcLog).sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
      }
      if (address.length === 1 && address[0] === CHAIN.poolManager) {
        const pool = String(filter.topics[1]).toLowerCase();
        return (byKey.all("pool", pool, from, to) as Row[]).map(toLog).filter((log) => topic0.includes(log.topics[0]));
      }
      if (address.length === 1 && address[0] === CHAIN.v3PositionManager) return (npmLogs.all(from, to) as Row[]).map(toLog);
      if (address.length === 1 && topic0.length === 1 && topic0[0] === TOPIC.transfer) return (byKey.all("transfer", address[0], from, to) as Row[]).map(toLog);
      if (address.length === 1) return (byKey.all("pool", address[0], from, to) as Row[]).map(toLog).filter((log) => topic0.includes(log.topics[0]));
      throw new CoverageError(`log query outside the backfill store: ${JSON.stringify(filter).slice(0, 200)}`);
    },
    async usdcInbound(address, from, to, minimum) {
      return (usdcInbound.all(address.toLowerCase(), from, to, minimum) as Array<Parameters<typeof usdcLog>[0]>).map(usdcLog);
    },
    async ethCall(request, block, overrides) {
      calls++;
      const stateOverride: Record<string, unknown> = {};
      for (const [account, override] of Object.entries(overrides) as Array<[string, StateOverride]>) {
        stateOverride[account] = { ...(override.code ? { code: override.code } : {}), ...(override.balance != null ? { balance: hex(override.balance) } : {}), ...(override.stateDiff ? { stateDiff: override.stateDiff } : {}) };
      }
      return call("eth_call", [{ to: request.to, data: request.data, gas: hex(request.gas) }, hex(block), stateOverride]);
    },
    async code(account, block) { calls++; return call("eth_getCode", [account, hex(block)]); },
    timestamp,
    async blockAt(target) {
      let low = 1, high = head;
      let lowTs = await timestamp(low), highTs = await timestamp(high);
      if (target <= lowTs) return low;
      if (target > highTs) return high;
      while (high - low > 1) {
        const span = high - low;
        let probe = span > 64 ? Math.round(low + ((target - lowTs) / Math.max(1, highTs - lowTs)) * span) : Math.floor((low + high) / 2);
        probe = Math.min(high - 1, Math.max(low + 1, probe));
        const probeTs = await timestamp(probe);
        if (probeTs < target) { low = probe; lowTs = probeTs; } else { high = probe; highTs = probeTs; }
        if (span > 64 && high - low > span / 2) {
          const middle = Math.floor((low + high) / 2);
          const middleTs = await timestamp(middle);
          if (middleTs < target) { low = middle; lowTs = middleTs; } else { high = middle; highTs = middleTs; }
        }
      }
      return high;
    },
    async nonces(list) {
      calls += Math.ceil(list.length / 10);
      const answers = await batch<string>(list.map((item) => ({ method: "eth_getTransactionCount", params: [item.address, hex(item.block)] })));
      return answers.map((answer) => (answer == null ? null : Number(answer)));
    },
  };
}
