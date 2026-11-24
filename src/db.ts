/**
 * Postgres access. All queries are parameterised ($1, $2…), so user text is
 * never interpolated into SQL.
 *
 * Transactions use AsyncLocalStorage: inside `tx(async () => …)`, every
 * `all/get/run` call automatically uses the transaction's client, so service
 * code doesn't have to thread a client parameter around.
 */
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, PoolClient, QueryResultRow } from "pg";
import { config } from "./config";

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
const txClient = new AsyncLocalStorage<PoolClient>();

const conn = () => txClient.getStore() ?? pool;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;

export async function all<T extends QueryResultRow = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await conn().query<T>(sql, params)).rows;
}

export async function get<T extends QueryResultRow = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await conn().query<T>(sql, params)).rows[0];
}

export async function run(sql: string, params: unknown[] = []): Promise<{ rowCount: number; rows: Row[] }> {
  const r = await conn().query(sql, params);
  return { rowCount: r.rowCount ?? 0, rows: r.rows };
}

export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (txClient.getStore()) return fn(); // already in a transaction
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await txClient.run(client, fn);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function setting(key: string, fallback: string | null = null): Promise<string | null> {
  const row = await get<{ value: string }>("SELECT value FROM settings WHERE key = $1", [key]);
  return row ? row.value : fallback;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await run("INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);
}

/** Apply schema.sql (idempotent). Swap for a migration tool once the schema settles. */
export async function migrate(): Promise<void> {
  const sql = fs.readFileSync(path.join(config.root, "db", "schema.sql"), "utf8");
  await pool.query(sql);
}
