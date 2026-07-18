import { describe, it, expect } from "vitest";
import {
  pickQuarterEndCloses,
  toPricesCsv,
  parsePricesCsv,
  round4,
  type DailyClose,
} from "@/lib/analytics/prices";
import { pickSharesOutstanding } from "@/lib/analytics/companyfacts";

describe("pickQuarterEndCloses", () => {
  const series: DailyClose[] = [
    { date: "2025-12-29", close: 100 },
    { date: "2025-12-30", close: 101 },
    { date: "2025-12-31", close: 102.5 },
    { date: "2026-01-02", close: 110 },
    { date: "2026-03-31", close: 120.1234 },
  ];

  it("takes the close on the quarter-end date when present", () => {
    const out = pickQuarterEndCloses("X", series, ["2025-12-31", "2026-03-31"]);
    expect(out).toEqual([
      { ticker: "X", quarterEnd: "2025-12-31", closePrice: 102.5 },
      { ticker: "X", quarterEnd: "2026-03-31", closePrice: 120.1234 },
    ]);
  });

  it("falls back to the last trading day before a weekend quarter-end", () => {
    // 2025-06-30-style: quarter-end has no bar, use the prior day.
    const out = pickQuarterEndCloses("X", series, ["2026-01-03"]);
    expect(out).toEqual([{ ticker: "X", quarterEnd: "2026-01-03", closePrice: 110 }]);
  });

  it("omits a quarter that predates all available data", () => {
    const out = pickQuarterEndCloses("X", series, ["2025-09-30"]);
    expect(out).toEqual([]);
  });

  it("ignores non-finite closes", () => {
    const gappy: DailyClose[] = [
      { date: "2025-12-30", close: NaN },
      { date: "2025-12-31", close: 50 },
    ];
    expect(pickQuarterEndCloses("X", gappy, ["2025-12-31"])[0].closePrice).toBe(50);
  });
});

describe("prices CSV round-trip", () => {
  it("serializes and parses back to the same rows, sorted", () => {
    const rows = [
      { ticker: "BBB", quarterEnd: "2025-12-31", closePrice: 2.5 },
      { ticker: "AAA", quarterEnd: "2026-03-31", closePrice: 9 },
      { ticker: "AAA", quarterEnd: "2025-12-31", closePrice: 8.25 },
    ];
    const csv = toPricesCsv(rows);
    expect(csv.split("\n")[0]).toBe("ticker,quarter_end,close_price");
    const parsed = parsePricesCsv(csv);
    expect(parsed).toEqual([
      { ticker: "AAA", quarterEnd: "2025-12-31", closePrice: 8.25 },
      { ticker: "AAA", quarterEnd: "2026-03-31", closePrice: 9 },
      { ticker: "BBB", quarterEnd: "2025-12-31", closePrice: 2.5 },
    ]);
  });

  it("skips blank and comment lines", () => {
    expect(parsePricesCsv("ticker,quarter_end,close_price\n\n# note\nX,2025-12-31,1\n")).toEqual([
      { ticker: "X", quarterEnd: "2025-12-31", closePrice: 1 },
    ]);
  });
});

describe("round4", () => {
  it("rounds to 4 decimals", () => {
    expect(round4(1.234567)).toBe(1.2346);
    expect(round4(120)).toBe(120);
  });
});

describe("pickSharesOutstanding", () => {
  it("takes the most recent figure from a company-concept document", () => {
    const doc = {
      units: {
        shares: [
          { end: "2025-10-17", val: 100 },
          { end: "2026-04-17", val: 130 },
          { end: "2026-01-16", val: 120 },
        ],
      },
    };
    expect(pickSharesOutstanding(doc)).toEqual({ value: 130, asof: "2026-04-17" });
  });

  it("reads the nested shape from a full companyfacts document", () => {
    const doc = {
      facts: {
        dei: {
          EntityCommonStockSharesOutstanding: {
            units: { shares: [{ end: "2026-01-01", val: 42 }] },
          },
        },
      },
    };
    expect(pickSharesOutstanding(doc)).toEqual({ value: 42, asof: "2026-01-01" });
  });

  it("returns null when there is no usable figure", () => {
    expect(pickSharesOutstanding({})).toBeNull();
    expect(pickSharesOutstanding({ units: { shares: [{ end: "2026-01-01" }] } })).toBeNull();
  });
});
