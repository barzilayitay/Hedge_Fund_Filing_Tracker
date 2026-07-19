import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { loadForm4 } from "@/lib/edgar/loadForm4";
import { createTestDb, type TestDb } from "../helpers/db";
import { parseForm4Fixture } from "../helpers/form4";

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

/**
 * Synthetic transaction seeder — clearly-labelled test-only data, not a
 * committed fixture (fixture discipline: synthetic data lives next to its
 * test). Inserts a minimal filing + insiders + code-P transactions.
 */
async function seedPurchases(
  companyCik: string,
  buys: Array<{ insider: string; date: string; shares: number; price: number }>,
): Promise<void> {
  const accession = `9000000000-00-${companyCik.slice(-6)}`;
  await db.query(
    `insert into filers (cik, name, slug) values ($1, $1, $1)
       on conflict do nothing`,
    [companyCik],
  );
  await db.query(
    `insert into filings (accession_no, cik, form_type, period_of_report, filed_at)
     values ($1, $2, '4', $3, $3) on conflict do nothing`,
    [accession, companyCik, buys[0].date],
  );
  let row = 0;
  for (const b of buys) {
    await db.query(
      `insert into insiders (cik, name) values ($1, $1) on conflict do nothing`,
      [b.insider],
    );
    await db.query(
      `insert into form4_transactions (
         accession_no, insider_cik, company_cik, table_type, row_index,
         transaction_code, transaction_date, shares, price, acquired_disposed
       ) values ($1, $2, $3, 'nonderiv', $4, 'P', $5, $6, $7, 'A')`,
      [accession, b.insider, companyCik, row++, b.date, b.shares, b.price],
    );
  }
}

describe("insider_cluster_buys", () => {
  it("flags a company with 3 distinct insiders buying within 30 days", async () => {
    await seedPurchases("0000000111", [
      { insider: "0000000001", date: "2026-03-01", shares: 100, price: 10 },
      { insider: "0000000002", date: "2026-03-10", shares: 200, price: 10 },
      { insider: "0000000003", date: "2026-03-20", shares: 300, price: 10 },
    ]);

    const rows = await db.query<{
      company_cik: string;
      insider_count: string;
      total_value: string;
    }>(
      `select company_cik, insider_count::text, total_value::text
         from insider_cluster_buys where company_cik = '0000000111'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const anchor = rows.find((r) => Number(r.insider_count) >= 3);
    expect(anchor).toBeDefined();
    // (100+200+300) shares * $10 = 6000 within the window.
    expect(Number(anchor?.total_value)).toBe(6000);
  });

  it("does NOT flag a company with only 2 insiders buying", async () => {
    await seedPurchases("0000000222", [
      { insider: "0000000001", date: "2026-03-01", shares: 100, price: 10 },
      { insider: "0000000002", date: "2026-03-10", shares: 200, price: 10 },
    ]);
    const rows = await db.query(
      `select 1 from insider_cluster_buys where company_cik = '0000000222'`,
    );
    expect(rows).toHaveLength(0);
  });

  it("does NOT flag 3 insiders whose buys span more than 30 days", async () => {
    await seedPurchases("0000000333", [
      { insider: "0000000001", date: "2026-01-01", shares: 100, price: 10 },
      { insider: "0000000002", date: "2026-02-15", shares: 200, price: 10 },
      { insider: "0000000003", date: "2026-04-01", shares: 300, price: 10 },
    ]);
    const rows = await db.query(
      `select 1 from insider_cluster_buys where company_cik = '0000000333'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("insider_sentiment", () => {
  it("counts P as buys and open-market S as sells, splitting 10b5-1 sales", async () => {
    const accession = "9000000000-00-999001";
    await db.query(
      `insert into filers (cik, name, slug) values ('0000000900','c','c')
         on conflict do nothing`,
    );
    await db.query(
      `insert into filings (accession_no, cik, form_type, period_of_report, filed_at)
       values ($1, '0000000900', '4', '2026-03-01', '2026-03-01')`,
      [accession],
    );
    for (const cik of ["0000000801", "0000000802", "0000000803"]) {
      await db.query(
        `insert into insiders (cik, name) values ($1,$1) on conflict do nothing`,
        [cik],
      );
    }
    // 1 buy (P), 1 open-market sell (S), 1 planned sell (S + 10b5-1).
    await db.query(
      `insert into form4_transactions (accession_no, insider_cik, company_cik,
         table_type, row_index, transaction_code, transaction_date, shares,
         price, acquired_disposed, is_10b5_1) values
         ($1,'0000000801','0000000900','nonderiv',0,'P','2026-03-01',100,10,'A',false),
         ($1,'0000000802','0000000900','nonderiv',1,'S','2026-02-20',40,10,'D',false),
         ($1,'0000000803','0000000900','nonderiv',2,'S','2026-02-25',30,10,'D',true)`,
      [accession],
    );

    const [row] = await db.query<{
      buy_count: string;
      sell_count: string;
      planned_sell_count: string;
      net_value: string;
      planned_sell_value: string;
    }>(
      `select buy_count::text, sell_count::text, planned_sell_count::text,
              net_value::text, planned_sell_value::text
         from insider_sentiment where company_cik = '0000000900'`,
    );
    expect(Number(row.buy_count)).toBe(1);
    expect(Number(row.sell_count)).toBe(1); // 10b5-1 sale excluded
    expect(Number(row.planned_sell_count)).toBe(1);
    // net = P(1000) - open-market S(400); planned S excluded from net.
    expect(Number(row.net_value)).toBe(600);
    expect(Number(row.planned_sell_value)).toBe(300);
  });
});

describe("fund_realtime_activity", () => {
  it("surfaces a Form 4 whose reporting owner is a 13F filer", async () => {
    // Pershing Square Capital Management (13F filer) is a reporting owner on
    // the Howard Hughes joint Form 4.
    await db.query(
      `insert into filers (cik, name, slug)
       values ('0001336528', 'Pershing Square Capital Management, L.P.', 'pershing-square')`,
    );
    await loadForm4(db.sql, parseForm4Fixture("psh-entity-2026-06-08"));

    const rows = await db.query<{ fund_cik: string; company_cik: string }>(
      `select fund_cik, company_cik from fund_realtime_activity`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.fund_cik === "0001336528")).toBe(true);
    // The issuer is Howard Hughes Holdings.
    expect(rows[0].company_cik).toBe("0001981792");
  });

  it("is empty when no reporting owner matches a filer", async () => {
    await loadForm4(db.sql, parseForm4Fixture("aapl-insider-4-2026-05-12"));
    const rows = await db.query(`select 1 from fund_realtime_activity`);
    expect(rows).toHaveLength(0);
  });
});
