import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import {
  OPENFIGI_BATCH_SIZE,
  resolveCusips,
  seedCompanies,
  seedSecurities,
  type FigiMatch,
  type OpenFigiClient,
} from "@/lib/edgar/cusipMap";
import { load13f } from "@/lib/edgar/load13f";
import {
  buildTickerIndex,
  normalizeIssuerName,
  parse13fList,
  parseCompanyTickers,
} from "@/lib/edgar/secReference";
import { createTestDb, type TestDb } from "../helpers/db";
import {
  parseFixture,
  read13fListText,
  readCompanyTickersJson,
} from "../helpers/fixtures";

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

/** Records every batch it is asked for; never touches the network. */
function fakeFigi(
  matches: Record<string, FigiMatch> = {},
): OpenFigiClient & { batches: string[][] } {
  const batches: string[][] = [];
  return {
    batches,
    async mapCusips(cusips) {
      batches.push([...cusips]);
      return new Map(cusips.map((c) => [c, matches[c] ?? null]));
    },
  };
}

const APPLE = "037833100";
/** Not a real CUSIP; nothing can resolve it. */
const UNKNOWN = "ZZZ999999";

describe("SEC reference parsing", () => {
  it("parses the fixed-width 13(f) list", () => {
    const list = parse13fList(read13fListText());
    expect(list.length).toBeGreaterThan(20_000);

    const apple = list.find((e) => e.cusip === APPLE);
    expect(apple).toMatchObject({
      cusip: APPLE,
      issuer: "APPLE INC",
      securityClass: "COM",
      hasListedOption: true,
    });
  });

  it("parses company_tickers.json", () => {
    const tickers = parseCompanyTickers(readCompanyTickersJson());
    expect(tickers.length).toBeGreaterThan(10_000);
    expect(tickers).toContainEqual({
      cik: "0000320193",
      ticker: "AAPL",
      name: "Apple Inc.",
    });
  });

  it("folds issuer names so the two SEC files can be joined", () => {
    expect(normalizeIssuerName("Apple Inc.")).toBe("APPLE INC");
    expect(normalizeIssuerName("APPLE INC")).toBe("APPLE INC");
    expect(normalizeIssuerName("  Berkshire   Hathaway  Inc  ")).toBe(
      "BERKSHIRE HATHAWAY INC",
    );
  });

  it("treats a name owned by several tickers as ambiguous, not mapped", () => {
    // Alphabet files GOOG and GOOGL under one title.
    const index = buildTickerIndex(parseCompanyTickers(readCompanyTickersJson()));
    expect(index.get("ALPHABET INC")?.length).toBeGreaterThan(1);
  });
});

describe("seeding", () => {
  it("seeds companies from company_tickers.json, one row per issuer", async () => {
    const entries = parseCompanyTickers(readCompanyTickersJson());
    const distinctCiks = new Set(entries.map((e) => e.cik)).size;

    const n = await seedCompanies(db.sql, readCompanyTickersJson());

    // `companies` is keyed on CIK, so the file's multiple listings per issuer
    // (one per share class) collapse to one row each.
    expect(entries.length).toBeGreaterThan(distinctCiks);
    expect(n).toBe(distinctCiks);

    const [count] = await db.query<{ n: string }>(
      `select count(*)::text as n from companies`,
    );
    expect(Number(count.n)).toBe(distinctCiks);

    const [apple] = await db.query<{ ticker: string; name: string }>(
      `select ticker, name from companies where cik = '0000320193'`,
    );
    expect(apple).toMatchObject({ ticker: "AAPL", name: "Apple Inc." });
  });

  it("keeps one row for an issuer with several share classes", async () => {
    await seedCompanies(db.sql, readCompanyTickersJson());

    // Alphabet lists GOOGL and GOOG under a single CIK.
    const rows = await db.query<{ ticker: string }>(
      `select ticker from companies where cik = '0001652044'`,
    );
    expect(rows).toHaveLength(1);
    expect(["GOOGL", "GOOG"]).toContain(rows[0].ticker);
  });

  it("is idempotent when seeded twice", async () => {
    const first = await seedCompanies(db.sql, readCompanyTickersJson());
    const second = await seedCompanies(db.sql, readCompanyTickersJson());
    expect(second).toBe(first);

    const [count] = await db.query<{ n: string }>(
      `select count(*)::text as n from companies`,
    );
    expect(Number(count.n)).toBe(first);
  });

  it("seeds securities with CUSIPs from the 13(f) list", async () => {
    const stats = await seedSecurities(
      db.sql,
      read13fListText(),
      readCompanyTickersJson(),
    );
    expect(stats.total).toBeGreaterThan(20_000);
    expect(stats.mapped).toBeGreaterThan(5_000);

    const [apple] = await db.query<{ ticker: string; mapping_status: string }>(
      `select ticker, mapping_status from securities where cusip = $1`,
      [APPLE],
    );
    expect(apple).toMatchObject({ ticker: "AAPL", mapping_status: "mapped" });
  });

  it("marks a security whose name maps to several tickers as ambiguous", async () => {
    await seedSecurities(db.sql, read13fListText(), readCompanyTickersJson());

    // Alphabet class C.
    const [row] = await db.query<{ ticker: string | null; mapping_status: string }>(
      `select ticker, mapping_status from securities where cusip = '02079K107'`,
    );
    expect(row.mapping_status).toBe("ambiguous");
    expect(row.ticker).toBeNull();
  });

  it("is idempotent and never downgrades an already-mapped row", async () => {
    await seedSecurities(db.sql, read13fListText(), readCompanyTickersJson());
    await db.query(
      `update securities set ticker = 'FIGI', mapping_status = 'mapped'
        where cusip = '02079K107'`,
    );

    await seedSecurities(db.sql, read13fListText(), readCompanyTickersJson());

    const [row] = await db.query<{ ticker: string; mapping_status: string }>(
      `select ticker, mapping_status from securities where cusip = '02079K107'`,
    );
    expect(row).toMatchObject({ ticker: "FIGI", mapping_status: "mapped" });
  });
});

describe("resolveCusips", () => {
  it("resolves known CUSIPs from the seed without calling OpenFIGI", async () => {
    await seedSecurities(db.sql, read13fListText(), readCompanyTickersJson());
    const figi = fakeFigi();

    const resolved = await resolveCusips(db.sql, [APPLE], figi);

    expect(resolved.get(APPLE)).toMatchObject({
      cusip: APPLE,
      ticker: "AAPL",
      mappingStatus: "mapped",
    });
    expect(figi.batches).toEqual([]);
  });

  it("sends unknown CUSIPs to OpenFIGI and persists the result", async () => {
    const figi = fakeFigi({ [APPLE]: { ticker: "AAPL", name: "Apple Inc." } });

    const resolved = await resolveCusips(db.sql, [APPLE], figi);

    expect(figi.batches).toEqual([[APPLE]]);
    expect(resolved.get(APPLE)).toMatchObject({
      ticker: "AAPL",
      mappingStatus: "mapped",
    });

    const [row] = await db.query<{ ticker: string; mapping_status: string }>(
      `select ticker, mapping_status from securities where cusip = $1`,
      [APPLE],
    );
    expect(row).toMatchObject({ ticker: "AAPL", mapping_status: "mapped" });
  });

  it("persists a CUSIP OpenFIGI cannot match as unmapped", async () => {
    const figi = fakeFigi();

    const resolved = await resolveCusips(db.sql, [UNKNOWN], figi);

    expect(resolved.get(UNKNOWN)).toMatchObject({
      cusip: UNKNOWN,
      ticker: null,
      mappingStatus: "unmapped",
    });

    const [row] = await db.query<{ mapping_status: string }>(
      `select mapping_status from securities where cusip = $1`,
      [UNKNOWN],
    );
    expect(row.mapping_status).toBe("unmapped");
  });

  it("batches OpenFIGI lookups at 100 CUSIPs per request", async () => {
    const cusips = Array.from({ length: 250 }, (_, i) =>
      `TEST${String(i).padStart(5, "0")}`,
    );
    const figi = fakeFigi();

    await resolveCusips(db.sql, cusips, figi);

    expect(figi.batches.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(figi.batches.every((b) => b.length <= OPENFIGI_BATCH_SIZE)).toBe(true);
  });

  it("normalizes and de-duplicates CUSIPs before looking them up", async () => {
    const figi = fakeFigi();
    await resolveCusips(db.sql, ["37833100", "037833100", "037833100"], figi);
    expect(figi.batches).toEqual([[APPLE]]);
  });

  it("retries a previously unmapped CUSIP on the next run", async () => {
    const missed = fakeFigi();
    await resolveCusips(db.sql, [APPLE], missed);

    const found = fakeFigi({ [APPLE]: { ticker: "AAPL", name: "Apple Inc." } });
    const resolved = await resolveCusips(db.sql, [APPLE], found);

    expect(found.batches).toEqual([[APPLE]]);
    expect(resolved.get(APPLE)?.mappingStatus).toBe("mapped");
  });
});

describe("unmapped CUSIPs never block ingestion", () => {
  it("keeps the holding row for a CUSIP that cannot be resolved", async () => {
    // Load a real filing, then resolve its CUSIPs with an OpenFIGI that
    // matches nothing at all.
    const parsed = parseFixture("psh-2026-05-15");
    await load13f(db.sql, parsed);

    const cusips = parsed.holdings.map((h) => h.cusip);
    await resolveCusips(db.sql, cusips, fakeFigi());

    const [holdings] = await db.query<{ n: string }>(
      `select count(*)::text as n from holdings_13f`,
    );
    expect(Number(holdings.n)).toBe(parsed.holdings.length);

    const [unmapped] = await db.query<{ n: string }>(
      `select count(*)::text as n from securities where mapping_status = 'unmapped'`,
    );
    expect(Number(unmapped.n)).toBe(new Set(cusips).size);
  });

  it("keeps a holding whose CUSIP is absent from the 13(f) list", async () => {
    await seedSecurities(db.sql, read13fListText(), readCompanyTickersJson());

    // The 2022 filing holds names that have since left the list.
    const parsed = parseFixture("brk-pre2023-2022-11-14");
    await load13f(db.sql, parsed);

    const [row] = await db.query<{ n: string }>(
      `select count(*)::text as n from holdings_13f`,
    );
    expect(Number(row.n)).toBe(parsed.holdings.length);
  });
});
