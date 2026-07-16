/**
 * Minimal SQL port.
 *
 * Ingestion writes normalized rows and reconciles amendments in SQL, and the
 * derived analytics live in migrations as views (ARCHITECTURE.md decision 2),
 * so the loader talks SQL rather than PostgREST. Keeping it behind this
 * interface lets the acceptance tests run the real statements against an
 * embedded Postgres without a network or Docker.
 */
export interface Sql {
  /** Positional parameters are $1, $2, ... (Postgres style). */
  query<T = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;

  /** Runs `fn` inside a transaction, rolling back if it throws. */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}
