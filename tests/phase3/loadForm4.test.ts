import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { loadForm4 } from "@/lib/edgar/loadForm4";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  parseForm4Fixture,
  readForm4Expected,
  readForm4Manifest,
} from "../helpers/form4";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});
beforeEach(async () => {
  await db.reset();
});
afterAll(async () => {
  await db.close();
});

async function snapshot(): Promise<Record<string, unknown[]>> {
  const tables = [
    "filings",
    "insiders",
    "insider_relationships",
    "form4_transactions",
  ];
  const out: Record<string, unknown[]> = {};
  for (const table of tables) {
    out[table] = await db.query(
      `select to_jsonb(t) - 'created_at' - 'updated_at' as row
         from ${table} t
        order by (to_jsonb(t) - 'created_at' - 'updated_at')::text`,
    );
  }
  return out;
}

describe("loadForm4", () => {
  it("loads a filing, its owners, relationships and transactions", async () => {
    const label = "tsla-insider-6-2026-04-02";
    const parsed = parseForm4Fixture(label);
    const expected = readForm4Expected(label);

    const result = await loadForm4(db.sql, parsed);
    expect(result.transactionsLoaded).toBe(expected.transactionCount);

    const [filing] = await db.query<{ form_type: string; cik: string }>(
      `select form_type, cik from filings where accession_no = $1`,
      [parsed.filing.accessionNo],
    );
    // filings.cik is the ISSUER for a Form 4.
    expect(filing).toMatchObject({ form_type: "4", cik: expected.issuerCik });

    const [tx] = await db.query<{ n: string }>(
      `select count(*)::text as n from form4_transactions where accession_no = $1`,
      [parsed.filing.accessionNo],
    );
    expect(Number(tx.n)).toBe(expected.transactionCount);

    const [ins] = await db.query<{ n: string }>(
      `select count(*)::text as n from insiders`,
    );
    expect(Number(ins.n)).toBe(expected.ownerCount);

    const [rel] = await db.query<{ n: string }>(
      `select count(*)::text as n from insider_relationships`,
    );
    expect(Number(rel.n)).toBe(expected.ownerCount);
  });

  it("is idempotent: loading the same filing twice changes nothing", async () => {
    const parsed = parseForm4Fixture("psh-entity-2026-06-08");
    await loadForm4(db.sql, parsed);
    const first = await snapshot();
    await loadForm4(db.sql, parsed);
    expect(await snapshot()).toEqual(first);
  });

  it("re-loading after tampering restores the transactions", async () => {
    const parsed = parseForm4Fixture("tsla-insider-6-2026-04-02");
    await loadForm4(db.sql, parsed);
    const original = await snapshot();

    await db.query(`update form4_transactions set shares = 1, price = 1`);
    await db.query(
      `delete from form4_transactions where table_type = 'deriv'`,
    );

    await loadForm4(db.sql, parsed);
    expect(await snapshot()).toEqual(original);
  });

  it("removes rows left over when a filing re-parses to fewer rows", async () => {
    const parsed = parseForm4Fixture("tsla-insider-4-2026-05-04"); // 18 tx
    await loadForm4(db.sql, parsed);

    const shorter = { ...parsed, transactions: parsed.transactions.slice(0, 5) };
    await loadForm4(db.sql, shorter);

    const [row] = await db.query<{ n: string }>(
      `select count(*)::text as n from form4_transactions`,
    );
    expect(Number(row.n)).toBe(5);
  });

  it("loads every fixture and matches its expected transaction count", async () => {
    for (const m of readForm4Manifest()) {
      await db.reset();
      const expected = readForm4Expected(m.label);
      await loadForm4(db.sql, parseForm4Fixture(m.label));
      const [row] = await db.query<{ n: string }>(
        `select count(*)::text as n from form4_transactions`,
      );
      expect(Number(row.n), m.label).toBe(expected.transactionCount);
    }
  });

  it("does not contaminate the 13F aggregation view", async () => {
    // Loading Form 4 rows adds form_type='4' rows to the shared filings table;
    // holdings_13f_agg filters form_type like '13F-HR%', so it stays empty.
    await loadForm4(db.sql, parseForm4Fixture("aapl-insider-4-2026-05-12"));
    const [agg] = await db.query<{ n: string }>(
      `select count(*)::text as n from holdings_13f_agg`,
    );
    expect(Number(agg.n)).toBe(0);

    // The Form 4 filing IS present in the shared table and filings_effective.
    const [eff] = await db.query<{ n: string }>(
      `select count(*)::text as n from filings_effective where form_type = '4'`,
    );
    expect(Number(eff.n)).toBe(1);
  });
});
