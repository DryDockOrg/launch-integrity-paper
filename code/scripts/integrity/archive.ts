/**
 * Archive access for the backfill and audits. Endpoints come from the environment:
 * - ARC_ARCHIVE_RPCS: comma-separated archive nodes (full history and state), used as the fallback;
 * - ARC_CALL_RPC: the node that serves calls, historical state, transactions and logs (log queries are made in
 *   LOG_WINDOW-block windows, many in flight, because public nodes limit log ranges);
 * - ARC_RECENT_RPC: a node that accepts wide log ranges over recent history (optional; defaults to ARC_CALL_RPC).
 * The published records were computed against Arc's public RPC endpoints. Requests are retried on rate limits
 * with capped backoff, and log ranges are halved whenever an endpoint refuses them.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = process.env.INTEGRITY_DATA ?? join(homedir(), "drydock-data", "launch-integrity");
mkdirSync(DATA_DIR, { recursive: true });

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Set ${name} (see the README).`); return value; };
const CALLS = required("ARC_CALL_RPC");
const ARCHIVE = required("ARC_ARCHIVE_RPCS").split(",").map((url) => url.trim()).filter(Boolean);
const RECENT = process.env.ARC_RECENT_RPC ?? CALLS;

export interface RawLog { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string; transactionIndex: string }

class Endpoint {
  private active = 0;
  private queue: Array<() => void> = [];
  private last = 0;
  constructor(readonly url: string, private readonly concurrency: number, private readonly spacingMs: number) {}
  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    const wait = this.last + this.spacingMs - Date.now();
    this.last = Math.max(Date.now(), this.last + this.spacingMs);
    if (wait > 0) await sleep(wait);
    try { return await task(); } finally { this.active--; this.queue.shift()?.(); }
  }
}

const archive = ARCHIVE.map((url) => new Endpoint(url, 1, 250));
const recent = new Endpoint(RECENT, 3, 60);
const calls = new Endpoint(CALLS, 16, 0);
/** Public nodes refuse log ranges above about 100 blocks. */
export const LOG_WINDOW = 100;
let turn = 0;
export const stats = { requests: 0, retries: 0, methods: {} as Record<string, number>, busyMs: 0 };
const count = (method: string) => { stats.methods[method] = (stats.methods[method] ?? 0) + 1; };

export class RpcError extends Error { constructor(message: string, readonly code?: number) { super(message); } }

async function post(url: string, body: unknown, timeout = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal });
    const text = await response.text();
    try { return JSON.parse(text); } catch { throw new RpcError(`HTTP ${response.status}: ${text.slice(0, 120)}`, response.status); }
  } finally { clearTimeout(timer); }
}

const transient = (message: string) => /rate limit|429|timeout|aborted|terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|UND_ERR|fetch failed|502|503|504|socket|temporarily|internal error/i.test(message);

/** One JSON-RPC call against an archive endpoint, retried on transient failures. */
export async function call<T = unknown>(method: string, params: unknown[], options: { recent?: boolean } = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const endpoint = options.recent ? recent : attempt % 4 === 3 ? archive[turn++ % archive.length] : calls;
    try {
      stats.requests++; count(method);
      const reply = await endpoint.run(() => post(endpoint.url, { jsonrpc: "2.0", id: 1, method, params }));
      if (reply.error) throw new RpcError(String(reply.error.message), reply.error.code);
      return reply.result as T;
    } catch (error) {
      const message = `${String((error as Error).message ?? error)} ${String(((error as Error).cause as Error | undefined)?.message ?? "")}`;
      if (attempt < 40 && transient(message)) { stats.retries++; await sleep(Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))); continue; }
      throw error;
    }
  }
}

/** Up to ten calls in one HTTP request (the archive endpoints' batch limit). Results keep their order; failures are null. */
export async function batch<T = unknown>(requests: Array<{ method: string; params: unknown[] }>): Promise<Array<T | null>> {
  const slices: Array<Array<{ method: string; params: unknown[] }>> = [];
  for (let index = 0; index < requests.length; index += 10) slices.push(requests.slice(index, index + 10));
  const answers = await Promise.all(slices.map((slice) => batchSlice<T>(slice)));
  return answers.flat();
}

async function batchSlice<T>(slice: Array<{ method: string; params: unknown[] }>): Promise<Array<T | null>> {
  for (let attempt = 0; ; attempt++) {
    const endpoint = calls;
    try {
      stats.requests++; count(`batch:${slice[0].method}`);
      const reply = await endpoint.run(() => post(endpoint.url, slice.map((request, id) => ({ jsonrpc: "2.0", id, ...request }))));
      if (!Array.isArray(reply)) throw new RpcError(String(reply?.error?.message ?? "batch failed"));
      const byId = new Map<number, { result?: T; error?: { message: string } }>((reply as Array<{ id: number; result?: T; error?: { message: string } }>).map((item) => [item.id, item]));
      if (slice.some((_, id) => transient(String(byId.get(id)?.error?.message ?? "")))) throw new RpcError("rate limit in batch");
      return slice.map((_, id) => byId.get(id)?.result ?? null);
    } catch (error) {
      const message = `${String((error as Error).message ?? error)} ${String(((error as Error).cause as Error | undefined)?.message ?? "")}`;
      if (attempt < 40 && transient(message)) { stats.retries++; await sleep(Math.min(30_000, 500 * 2 ** Math.min(attempt, 6))); continue; }
      throw error;
    }
  }
}

const tooMany = (message: string) => /range too large|max results|too many|exceed|limit|ranges over/i.test(message) && !/rate limit/i.test(message);

/**
 * Logs for [from, to], in windows of at most `window` blocks, halving any window an endpoint refuses.
 * `recent` sends the query to the deep-range node (only valid inside its retained history).
 */
export async function logs(filter: { address?: string | string[]; topics?: Array<string | string[] | null> }, from: number, to: number, window = LOG_WINDOW, options: { recent?: boolean } = {}): Promise<RawLog[]> {
  const ranges: Array<[number, number]> = [];
  for (let low = from; low <= to; low += window) ranges.push([low, Math.min(to, low + window - 1)]);
  const parts = await Promise.all(ranges.map(([low, high]) => range(filter, low, high, options)));
  let out: RawLog[] = [];
  for (const part of parts) out = out.concat(part);
  out.sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  return out;
}

async function range(filter: object, from: number, to: number, options: { recent?: boolean }): Promise<RawLog[]> {
  try {
    return await call<RawLog[]>("eth_getLogs", [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }], options);
  } catch (error) {
    const message = `${String((error as Error).message ?? error)} ${String(((error as Error).cause as Error | undefined)?.message ?? "")}`;
    if (to > from && tooMany(message)) {
      const middle = Math.floor((from + to) / 2);
      return (await range(filter, from, middle, options)).concat(await range(filter, middle + 1, to, options));
    }
    throw error;
  }
}

export const hex = (value: number | bigint) => `0x${value.toString(16)}`;
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const topicAddress = (topic: string) => `0x${topic.slice(26)}`.toLowerCase();
export const padAddress = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** Block timestamps, cached; `blockAt` finds the first block at or after a timestamp by bisection. */
const times = new Map<number, number>();
export async function timeOf(block: number) {
  const known = times.get(block);
  if (known != null) return known;
  const result = await call<{ timestamp: string }>("eth_getBlockByNumber", [hex(block), false]);
  const value = Number(result.timestamp);
  times.set(block, value);
  return value;
}
export async function blockAt(timestamp: number, low = 1, high?: number) {
  high ??= Number(await call<string>("eth_blockNumber", []));
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((await timeOf(middle)) < timestamp) low = middle + 1; else high = middle;
  }
  return low;
}
