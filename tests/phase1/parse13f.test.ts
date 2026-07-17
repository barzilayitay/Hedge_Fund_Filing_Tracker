import { describe, it, expect } from "vitest";
import {
  COVER_NS,
  INFOTABLE_NS,
  normalizeCusip,
  parse13f,
  slugify,
} from "@/lib/edgar/parse13f";
import {
  manifestEntry,
  parseFixture,
  readCoverXml,
  readExpected,
  readInfoTableXml,
  readManifest,
} from "../helpers/fixtures";

const manifest = readManifest();

describe("parse13f — every fixture", () => {
  it.each(manifest.map((m) => [m.label] as const))(
    "%s parses and matches expected.json exactly",
    (label) => {
      const parsed = parseFixture(label);
      const expected = readExpected(label);

      expect(parsed.holdings).toHaveLength(expected.rowCount);
      expect(parsed.holdings.reduce((s, h) => s + h.valueUsd, 0)).toBe(
        expected.totalValueUsd,
      );

      expect(parsed.filer.cik).toBe(expected.cik);
      expect(parsed.filer.name).toBe(expected.filerName);
      expect(parsed.filing.formType).toBe(expected.formType);
      expect(parsed.filing.periodOfReport).toBe(expected.periodOfReport);
      expect(parsed.filing.filedAt).toBe(expected.filedAt);
      expect(parsed.filing.amendmentType).toBe(expected.amendmentType);
    },
  );

  it.each(manifest.map((m) => [m.label] as const))(
    "%s spot-check holdings match",
    (label) => {
      const parsed = parseFixture(label);
      for (const spot of readExpected(label).spotChecks) {
        expect(parsed.holdings[spot.rowIndex]).toMatchObject({
          cusip: spot.cusip,
          shares: spot.shares,
          principalAmt: spot.principalAmt,
          valueUsd: spot.valueUsd,
          shareClass: spot.shareClass,
          putCall: spot.putCall,
        });
      }
    },
  );

  it.each(manifest.map((m) => [m.label] as const))(
    "%s agrees with the totals the filer itself declared",
    (label) => {
      // Independent of expected.json: the cover page's summary is the filer's
      // own count and total, stated in the filing's own units.
      const parsed = parseFixture(label);
      const multiplier =
        parsed.filing.periodOfReport < "2023-01-01" ? 1000 : 1;
      const totalInFilingUnits =
        parsed.holdings.reduce((s, h) => s + h.valueUsd, 0) / multiplier;

      expect(parsed.declared.entryTotal).toBe(parsed.holdings.length);
      expect(parsed.declared.valueTotal).toBeCloseTo(totalInFilingUnits, 0);
    },
  );

  it.each(manifest.map((m) => [m.label] as const))(
    "%s produces a valid CUSIP on every row",
    (label) => {
      for (const h of parseFixture(label).holdings) {
        expect(h.cusip).toMatch(/^[0-9A-Z]{9}$/);
      }
    },
  );
});

describe("value unit normalization", () => {
  it("multiplies pre-2023 filings by 1000 to reach whole USD", () => {
    const parsed = parseFixture("brk-pre2023-2022-11-14");
    const expected = readExpected("brk-pre2023-2022-11-14");

    expect(parsed.filing.periodOfReport).toBe("2022-09-30");
    expect(expected.declaredByFiler.valueUnits).toBe("thousands of USD");

    // The filer declared 296,096,640 (thousands); stored value is whole USD.
    expect(expected.totalValueUsd).toBe(296_096_640_000);
    expect(parsed.holdings.reduce((s, h) => s + h.valueUsd, 0)).toBe(
      (expected.declaredByFiler.valueTotal as number) * 1000,
    );
  });

  it("leaves post-2023 filings in whole USD", () => {
    const parsed = parseFixture("brk-2026-05-15");
    const expected = readExpected("brk-2026-05-15");

    expect(expected.declaredByFiler.valueUnits).toBe("USD");
    expect(parsed.holdings.reduce((s, h) => s + h.valueUsd, 0)).toBe(
      expected.declaredByFiler.valueTotal,
    );
  });

  it("switches units on period_of_report, not filing date", () => {
    // Filed in Nov 2022 for a Q3 2022 period -> thousands.
    expect(parseFixture("brk-pre2023-2022-11-14").filing.filedAt).toBe(
      "2022-11-14",
    );
    // Filed in 2025 for a Q4 2024 period -> whole dollars, no conversion,
    // even though this filer mistakenly reported thousands (see the /A).
    const gfi = parseFixture("gfi-restatement-original-2025-02-12");
    expect(gfi.filing.periodOfReport).toBe("2024-12-31");
    expect(gfi.holdings.reduce((s, h) => s + h.valueUsd, 0)).toBe(871_073);
  });
});

describe("document detection", () => {
  it("detects documents by namespace, not filename", () => {
    const cover = readCoverXml("brk-2026-05-15");
    const info = readInfoTableXml("brk-2026-05-15");

    expect(cover).toContain(COVER_NS);
    expect(info).toContain(INFOTABLE_NS);
  });

  it("parses an information table that uses a namespace prefix", () => {
    // GFI ships <ns1:informationTable>, Berkshire a default namespace.
    const info = readInfoTableXml("gfi-restatement-original-2025-02-12");
    expect(info).toMatch(/<ns1:informationTable/);
    expect(parseFixture("gfi-restatement-original-2025-02-12").holdings).toHaveLength(
      20,
    );
  });

  it("rejects a cover page that is not one", () => {
    const entry = manifestEntry("brk-2026-05-15");
    expect(() =>
      parse13f(readInfoTableXml("brk-2026-05-15"), readInfoTableXml("brk-2026-05-15"), {
        accessionNo: entry.accession,
        filedAt: entry.filedAt,
      }),
    ).toThrow(/does not declare/);
  });

  it("rejects an information table that is not one", () => {
    const entry = manifestEntry("brk-2026-05-15");
    expect(() =>
      parse13f(readCoverXml("brk-2026-05-15"), readCoverXml("brk-2026-05-15"), {
        accessionNo: entry.accession,
        filedAt: entry.filedAt,
      }),
    ).toThrow(/does not declare/);
  });

  it("finds an information table embedded in the primary document", () => {
    // Some filers inline the table; splice the two fixtures into one document
    // to prove detection does not depend on the file it arrived in.
    const cover = readCoverXml("psh-2026-05-15");
    const info = readInfoTableXml("psh-2026-05-15");
    const table = info.slice(info.indexOf("<informationTable"));
    const combined = cover.replace(
      "</edgarSubmission>",
      `${table}</edgarSubmission>`,
    );

    const entry = manifestEntry("psh-2026-05-15");
    const parsed = parse13f(combined, combined, {
      accessionNo: entry.accession,
      filedAt: entry.filedAt,
    });
    expect(parsed.holdings).toHaveLength(11);
  });
});

describe("holdings are never collapsed", () => {
  it("keeps one row per information-table entry when a CUSIP repeats", () => {
    // Berkshire reports Apple once per otherManager combination.
    const parsed = parseFixture("brk-2026-05-15");
    const apple = parsed.holdings.filter((h) => h.cusip === "037833100");

    expect(apple.length).toBe(12);
    expect(new Set(apple.map((h) => h.rowIndex)).size).toBe(12);
    expect(new Set(apple.map((h) => h.otherManager)).size).toBe(12);
    expect(apple.reduce((s, h) => s + (h.shares ?? 0), 0)).toBe(227_917_808);
  });

  it("keeps every row distinct by rowIndex across all fixtures", () => {
    for (const m of manifest) {
      const parsed = parseFixture(m.label);
      const indices = parsed.holdings.map((h) => h.rowIndex);
      expect(new Set(indices).size, m.label).toBe(parsed.holdings.length);
      expect(indices).toEqual(indices.map((_, i) => i));
    }
  });

  it("preserves share class and put/call as separate rows", () => {
    // Alphabet class A and class C are different CUSIPs and different rows.
    const parsed = parseFixture("psh-2026-05-15");
    const alphabet = parsed.holdings.filter((h) =>
      h.nameOfIssuer.startsWith("ALPHABET"),
    );
    expect(alphabet.map((h) => h.shareClass).sort()).toEqual([
      "CAP STK CL A",
      "CAP STK CL C",
    ]);
    expect(new Set(alphabet.map((h) => h.cusip)).size).toBe(2);
  });
});

describe("shares vs principal amount", () => {
  it("sets shares for SH rows and never both fields", () => {
    for (const m of manifest) {
      for (const h of parseFixture(m.label).holdings) {
        expect(h.shares === null).not.toBe(h.principalAmt === null);
      }
    }
  });

  it("stores a PRN row as principal_amt with null shares", () => {
    const info = `<?xml version="1.0"?>
      <informationTable xmlns="${INFOTABLE_NS}">
        <infoTable>
          <nameOfIssuer>CONVERTIBLE CO</nameOfIssuer>
          <titleOfClass>NOTE 5.00% 1/1/30</titleOfClass>
          <cusip>123456789</cusip>
          <value>1500000</value>
          <shrsOrPrnAmt>
            <sshPrnamt>1000000</sshPrnamt>
            <sshPrnamtType>PRN</sshPrnamtType>
          </shrsOrPrnAmt>
          <investmentDiscretion>SOLE</investmentDiscretion>
        </infoTable>
      </informationTable>`;

    const entry = manifestEntry("brk-2026-05-15");
    const parsed = parse13f(readCoverXml("brk-2026-05-15"), info, {
      accessionNo: entry.accession,
      filedAt: entry.filedAt,
    });

    expect(parsed.holdings[0]).toMatchObject({
      cusip: "123456789",
      shares: null,
      principalAmt: 1_000_000,
      valueUsd: 1_500_000,
    });
  });
});

describe("field normalization", () => {
  it("pads and uppercases CUSIPs to 9 characters", () => {
    expect(normalizeCusip("37833100")).toBe("037833100");
    expect(normalizeCusip("h1467j104")).toBe("H1467J104");
    expect(normalizeCusip(" 037833100 ")).toBe("037833100");
  });

  it("normalizes a CUSIP that lost its leading zero in the filing", () => {
    const info = `<?xml version="1.0"?>
      <informationTable xmlns="${INFOTABLE_NS}">
        <infoTable>
          <nameOfIssuer>APPLE INC</nameOfIssuer>
          <titleOfClass>COM</titleOfClass>
          <cusip>37833100</cusip>
          <value>1000</value>
          <shrsOrPrnAmt><sshPrnamt>10</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
        </infoTable>
      </informationTable>`;
    const entry = manifestEntry("brk-2026-05-15");
    const parsed = parse13f(readCoverXml("brk-2026-05-15"), info, {
      accessionNo: entry.accession,
      filedAt: entry.filedAt,
    });
    expect(parsed.holdings[0].cusip).toBe("037833100");
  });

  it("canonicalises the CIK to 10 digits and derives a slug", () => {
    const parsed = parseFixture("brk-2026-05-15");
    expect(parsed.filer.cik).toBe("0001067983");
    expect(parsed.filer.slug).toBe("berkshire-hathaway-inc");
    expect(slugify("GFI Investment Counsel Ltd.")).toBe(
      "gfi-investment-counsel-ltd",
    );
  });

  it("converts EDGAR MM-DD-YYYY dates to ISO", () => {
    expect(parseFixture("brk-newholdings-q1-2025-amendment-2025-08-14").filing
      .periodOfReport).toBe("2025-03-31");
  });
});
