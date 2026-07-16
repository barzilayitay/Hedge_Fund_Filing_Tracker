import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import type { Sql } from "@/lib/db/sql";

/**
 * An embedded Postgres for the acceptance tests, built by running the real
 * migration files in order. Nothing is hand-written here: `filings_effective`,
 * the constraints and the upsert semantics under test are the same SQL that
 * ships to Supabase. No Docker and no network, so it runs in CI unchanged.
 */

const MIGRATIONS_DIR = join(__dirname, "..", "..", "supabase", "migrations");

type PgliteLike = Pick<PGlite, "query" | "exec">;

function wrap(db: PgliteLike, inTransaction: boolean): Sql {
  const sql: Sql = {
    async query<T>(text: string, params?: unknown[]): Promise<T[]> {
      const result = await db.query<T>(text, params as unknown[] | undefined);
      return result.rows;
    },
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      // PGlite has no savepoint-based nesting on its transaction handle; a
      // nested call just joins the transaction already in progress.
      if (inTransaction || !(db instanceof PGlite)) return fn(sql);
      const out = await db.transaction(async (tx) => fn(wrap(tx, true)));
      return out as T;
    },
  };
  return sql;
}

export interface TestDb {
  sql: Sql;
  /** Escape hatch for assertions that just need rows back. */
  query: <T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<T[]>;
  /** Empty every table. Cheaper than rebuilding the database per test. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/** Tables in the Phase 1 schema, emptied between tests. */
const TABLES = ["holdings_13f", "filings", "filers", "securities", "companies"];

export async function createTestDb(): Promise<TestDb> {
  const db = new PGlite();

  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of migrations) {
    const ddl = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    try {
      await db.exec(ddl);
    } catch (err) {
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    }
  }

  const sql = wrap(db, false);
  return {
    sql,
    query: (text, params) => sql.query(text, params),
    reset: async () => {
      await db.exec(`truncate ${TABLES.join(", ")} restart identity cascade`);
    },
    close: () => db.close(),
  };
}
