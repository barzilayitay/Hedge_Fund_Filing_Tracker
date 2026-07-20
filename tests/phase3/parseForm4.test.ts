import { describe, it, expect } from "vitest";
import { parseForm4 } from "@/lib/edgar/parseForm4";
import {
  parseForm4Fixture,
  readForm4Expected,
  readForm4Manifest,
} from "../helpers/form4";

/**
 * Parser acceptance. Every fixture must parse and match its expected file
 * (counts + spot-check field sets). The expected files' COUNTS were derived by
 * an independent regex scan (scripts/build-form4-expected.ts), so a parser
 * counting bug cannot hide. The blocks after the fixture sweep hand-assert the
 * spec-critical behaviours with literal values.
 */

const labels = readForm4Manifest().map((m) => m.label);

describe("parseForm4 — every fixture", () => {
  it.each(labels)("%s matches its expected file", (label) => {
    const parsed = parseForm4Fixture(label);
    const expected = readForm4Expected(label);

    expect(parsed.filing.formType).toBe(expected.formType);
    expect(parsed.filing.periodOfReport).toBe(expected.periodOfReport);
    expect(parsed.issuer.cik).toBe(expected.issuerCik);
    expect(parsed.issuer.name).toBe(expected.issuerName);
    expect(parsed.owners.map((o) => o.cik)).toEqual(expected.ownerCiks);
    expect(parsed.stats.transactions).toBe(expected.transactionCount);
    expect(parsed.stats.holdingsSkipped).toBe(expected.holdingsSkipped);
    expect(parsed.is10b5One).toBe(expected.is10b5One);

    // Each spot-check must equal the parsed transaction at its coordinates.
    for (const spot of expected.spotChecks) {
      const match = parsed.transactions.find(
        (t) =>
          t.ownerCik === spot.ownerCik &&
          t.tableType === spot.tableType &&
          t.rowIndex === spot.rowIndex,
      );
      expect(match, `${label} ${spot.tableType}#${spot.rowIndex}`).toEqual(spot);
    }
  });
});

describe("parseForm4 — spec-critical behaviours", () => {
  it("covers transaction codes P, S, M, A, G across fixtures", () => {
    const codes = new Set<string>();
    for (const label of labels) {
      for (const t of parseForm4Fixture(label).transactions) {
        if (t.transactionCode) codes.add(t.transactionCode);
      }
    }
    for (const code of ["P", "S", "M", "A", "G"]) {
      expect(codes.has(code), `code ${code} present`).toBe(true);
    }
  });

  it("parses derivative rows with underlying security and expiry", () => {
    const parsed = parseForm4Fixture("tsla-insider-6-2026-04-02");
    const deriv = parsed.transactions.find((t) => t.tableType === "deriv");
    expect(deriv).toBeDefined();
    expect(deriv?.underlyingSecurityTitle).toBe("Common Stock");
    expect(deriv?.underlyingShares).toBe(20000);
    expect(deriv?.expirationDate).toBe("2028-08-20");
    expect(deriv?.conversionOrExercisePrice).toBe(20.57);
  });

  it("sets is10b5One on a 10b5-1 filing and every row it emits", () => {
    const parsed = parseForm4Fixture("aapl-insider-4-2026-05-12");
    expect(parsed.is10b5One).toBe(true);
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.transactions[0].transactionCode).toBe("S");
    expect(parsed.transactions[0].is10b5One).toBe(true);
  });

  it("keeps price null vs 0 distinct, and footnoted amounts null", () => {
    // A $0 award reports price 0 — never coerced to null.
    const award = parseForm4Fixture("msft-insider-4-2026-06-12").transactions[0];
    expect(award.transactionCode).toBe("A");
    expect(award.price).toBe(0);
    // Its conversion price / exercise+expiry are footnoted (no <value>) -> null.
    expect(award.conversionOrExercisePrice).toBeNull();
    expect(award.exerciseDate).toBeNull();
    expect(award.expirationDate).toBeNull();

    // An option exercise (M) omits pricePerShare entirely -> null, not 0.
    const exercise = parseForm4Fixture("aapl-insider-1-2026-06-17").transactions.find(
      (t) => t.tableType === "nonderiv" && t.transactionCode === "M",
    );
    expect(exercise?.price).toBeNull();
  });

  it("resolves footnote references on the rows that cite them", () => {
    const s = parseForm4Fixture("aapl-insider-4-2026-05-12").transactions[0];
    expect(s.footnotes.F1).toMatch(/Rule 10b5-1 trading plan/);
  });

  it("fans a joint filing out to one row per (owner, transaction)", () => {
    const parsed = parseForm4Fixture("psh-entity-2026-06-08");
    expect(parsed.owners.length).toBe(6);
    // 6 owners x 1 transaction row = 6 emitted rows.
    expect(parsed.stats.transactions).toBe(6);
    const owners = new Set(parsed.transactions.map((t) => t.ownerCik));
    expect(owners.size).toBe(6);
    // The 13F fund Pershing Square Capital Management is one of the owners.
    expect(owners.has("0001336528")).toBe(true);
  });

  it("skips holdings-only rows but counts them", () => {
    // msft-insider-1 is a single nonDerivativeHolding, no transactions.
    const parsed = parseForm4Fixture("msft-insider-1-2026-07-01");
    expect(parsed.stats.transactions).toBe(0);
    expect(parsed.stats.holdingsSkipped).toBe(1);
  });

  it("handles an entity reporting owner (name, no individual parts)", () => {
    const parsed = parseForm4Fixture("psh-entity-2026-06-08");
    const entity = parsed.owners.find((o) => o.cik === "0001336528");
    expect(entity?.name).toBe("Pershing Square Capital Management, L.P.");
  });

  it("rejects XML that is not an ownershipDocument", () => {
    expect(() => parseForm4("<foo/>", { accessionNo: "0000000000-00-000000", filedAt: "2026-01-01" })).toThrow();
  });
});
