import { describe, it, expect } from "vitest";
import { parseExportParams } from "@/app/api/export/route";
import { assertLocalTarget } from "@/scripts/seed-dev";

/**
 * Pure-function coverage for the export route's query parsing/validation and the
 * seed-dev local-target guard. Neither needs a database or a running server.
 */

function params(qs: string): URL {
  return new URL(`http://localhost/api/export?${qs}`);
}

describe("parseExportParams", () => {
  it("accepts a well-formed request and defaults format to csv", () => {
    const r = parseExportParams(params("fund=berkshire-hathaway-inc&quarter=2026-03-31"));
    expect(r).toEqual({
      ok: true,
      fund: "berkshire-hathaway-inc",
      quarter: "2026-03-31",
      format: "csv",
    });
  });

  it("accepts tsv format", () => {
    const r = parseExportParams(params("fund=pershing-square&quarter=2026-03-31&format=tsv"));
    expect(r.ok && r.format).toBe("tsv");
  });

  it("rejects a missing fund", () => {
    const r = parseExportParams(params("quarter=2026-03-31"));
    expect(r).toEqual({ ok: false, error: "missing required query param: fund" });
  });

  it("rejects a fund that is not a slug (injection / header-spoof attempt)", () => {
    for (const bad of [
      'a"b',
      "a b",
      "Berkshire",
      "-leading",
      "trailing-",
      "a--b".replace("--b", "--b"), // double hyphen is not slugify output
      "a/b",
      "../etc",
    ]) {
      const r = parseExportParams(params(`fund=${encodeURIComponent(bad)}&quarter=2026-03-31`));
      expect(r.ok).toBe(false);
    }
  });

  it("rejects a missing or malformed quarter", () => {
    expect(parseExportParams(params("fund=x")).ok).toBe(false);
    expect(parseExportParams(params("fund=x&quarter=2026-3-1")).ok).toBe(false);
    expect(parseExportParams(params("fund=x&quarter=not-a-date")).ok).toBe(false);
  });

  it("rejects an unknown format", () => {
    const r = parseExportParams(params("fund=x&quarter=2026-03-31&format=xlsx"));
    expect(r).toEqual({ ok: false, error: "format must be csv or tsv" });
  });
});

describe("assertLocalTarget (seed-dev guard)", () => {
  it("allows localhost / 127.0.0.1 targets", () => {
    expect(() =>
      assertLocalTarget("postgres://postgres:postgres@127.0.0.1:54322/postgres", []),
    ).not.toThrow();
    expect(() =>
      assertLocalTarget("postgres://user@localhost:5432/db", []),
    ).not.toThrow();
  });

  it("refuses a non-local target", () => {
    expect(() =>
      assertLocalTarget("postgres://user:pw@db.prod.supabase.co:5432/postgres", []),
    ).toThrow(/refusing to seed a non-local database/i);
  });

  it("allows a non-local target only with the explicit override flag", () => {
    expect(() =>
      assertLocalTarget("postgres://user:pw@db.prod.supabase.co:5432/postgres", [
        "--i-know-what-im-doing",
      ]),
    ).not.toThrow();
  });

  it("refuses a malformed DATABASE_URL", () => {
    expect(() => assertLocalTarget("not a url", [])).toThrow(/not a valid url/i);
  });

  it("defers to makeProductionSql when DATABASE_URL is unset", () => {
    // No URL: the guard is a no-op (makeProductionSql raises its own error).
    expect(() => assertLocalTarget(undefined, [])).not.toThrow();
  });
});
