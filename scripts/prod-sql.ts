/**
 * A production `Sql` backed by node-postgres, for the standalone loader CLIs.
 *
 * The `pg` driver is imported dynamically and is NOT a committed dependency:
 * the production `Sql` adapter is a Phase 4/6 deliverable (PROGRESS.md), and
 * these scripts are explicitly not exercised by tests. Until then this lets the
 * loaders run against a real database when `DATABASE_URL` and `pg` are present,
 * and fails with a clear message otherwise.
 */
import type { Sql } from "../lib/db/sql";

/** The slice of node-postgres we use, typed locally so `pg` need not be installed. */
interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}
interface PgClient extends PgQueryable {
  release(): void;
}
interface PgPool extends PgQueryable {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
interface PgModule {
  Pool: new (config: { connectionString: string }) => PgPool;
}

export async function makeProductionSql(): Promise<{ sql: Sql; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. These loaders write to a Postgres database; " +
        "set DATABASE_URL (and `npm i pg`) to run them. The production Sql " +
        "adapter lands in Phase 4/6.",
    );
  }

  // Variable specifier so tsc does not try to resolve the optional dependency.
  const spec = "pg";
  let pg: PgModule;
  try {
    pg = (await import(spec)) as unknown as PgModule;
  } catch {
    throw new Error("The 'pg' package is not installed. Run `npm i pg` to use these loaders.");
  }

  const pool = new pg.Pool({ connectionString: url });

  const wrap = (runner: PgQueryable): Sql => ({
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      const res = await runner.query(text, params);
      return res.rows as T[];
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(wrap(client));
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback");
        throw e;
      } finally {
        client.release();
      }
    },
  });

  return { sql: wrap(pool), close: () => pool.end() };
}
