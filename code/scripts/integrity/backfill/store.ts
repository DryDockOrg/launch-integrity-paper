/**
 * Local store for the v2 backfill: every log the backfill reads, indexed the way the facts layer asks for
 * it, in one SQLite file. The backfill's ChainReader answers log queries from here, so the retrospective
 * records come from exactly the same code that issues live records.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { DATA_DIR } from "../archive";

export const db = new DatabaseSync(join(DATA_DIR, "backfill.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 60000;
  CREATE TABLE IF NOT EXISTS logs (
    kind TEXT NOT NULL,          -- swap | modify | transfer | usdc
    key TEXT NOT NULL,           -- pool (swaps, liquidity), token (transfers), or '' (usdc)
    block INTEGER NOT NULL, idx INTEGER NOT NULL, tx TEXT NOT NULL,
    address TEXT NOT NULL, topics TEXT NOT NULL, data TEXT NOT NULL,
    t1 TEXT, t2 TEXT,
    PRIMARY KEY (kind, block, idx)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS logs_key ON logs(kind, key, block);
  CREATE INDEX IF NOT EXISTS logs_t2 ON logs(kind, t2, block);
  CREATE INDEX IF NOT EXISTS logs_t1 ON logs(kind, t1, block);
  CREATE TABLE IF NOT EXISTS scanned (kind TEXT NOT NULL, scope TEXT NOT NULL, low INTEGER NOT NULL, high INTEGER NOT NULL, PRIMARY KEY (kind, scope, low));
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  -- USDC moves of at least 1 USDC whose sender is not a hub (ERC-20 and native mirror rows, deduplicated on read).
  CREATE TABLE IF NOT EXISTS usdc (block INTEGER NOT NULL, idx INTEGER NOT NULL, tx TEXT NOT NULL, src TEXT NOT NULL, dst TEXT NOT NULL, value INTEGER NOT NULL, native INTEGER NOT NULL, PRIMARY KEY (block, idx)) WITHOUT ROWID;
`);

const insert = db.prepare("INSERT OR IGNORE INTO logs (kind, key, block, idx, tx, address, topics, data, t1, t2) VALUES (?,?,?,?,?,?,?,?,?,?)");
export function putLogs(kind: string, rows: Array<{ key: string; block: number; idx: number; tx: string; address: string; topics: string[]; data: string }>) {
  db.exec("BEGIN");
  try {
    for (const row of rows) insert.run(kind, row.key, row.block, row.idx, row.tx, row.address, JSON.stringify(row.topics), row.data, row.topics[1] ?? null, row.topics[2] ?? null);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

const markScanned = db.prepare("INSERT OR REPLACE INTO scanned (kind, scope, low, high) VALUES (?,?,?,?)");
export const markDone = (kind: string, scope: string, low: number, high: number) => markScanned.run(kind, scope, low, high);
const isScanned = db.prepare("SELECT 1 FROM scanned WHERE kind = ? AND scope = ? AND low = ?");
export const done = (kind: string, scope: string, low: number) => Boolean(isScanned.get(kind, scope, low));

export function getKv<T>(key: string): T | null {
  const row = db.prepare("SELECT v FROM kv WHERE k = ?").get(key) as { v: string } | undefined;
  return row ? (JSON.parse(row.v) as T) : null;
}
export function setKv(key: string, value: unknown) {
  db.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").run(key, JSON.stringify(value));
}

const insertUsdc = db.prepare("INSERT OR IGNORE INTO usdc (block, idx, tx, src, dst, value, native) VALUES (?,?,?,?,?,?,?)");
export function putUsdc(rows: Array<{ block: number; idx: number; tx: string; src: string; dst: string; value: bigint; native: boolean }>) {
  db.exec("BEGIN");
  try {
    for (const row of rows) insertUsdc.run(row.block, row.idx, row.tx, row.src, row.dst, row.value, row.native ? 1 : 0);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
/** Indexes for the USDC table, built once after the scan (building them during it would slow inserts). */
export function indexUsdc() {
  db.exec("CREATE INDEX IF NOT EXISTS usdc_dst ON usdc(dst, block); CREATE INDEX IF NOT EXISTS usdc_src ON usdc(src, block);");
}
