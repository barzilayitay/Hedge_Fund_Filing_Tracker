import { describe, it, expect } from "vitest";
import { readdirSync } from "fs";
import { FORM4_DIR, readForm4Manifest } from "../helpers/form4";

/**
 * Manifest integrity, and the placeholder GATE.
 *
 * The Form 4 fixture manifest ships with PLACEHOLDER accession numbers
 * (9999999999-99-…) until a human runs `npm run fixtures:form4` (network,
 * EDGAR) to resolve the real, pinned accessions. This file keeps the suite RED
 * until that has happened, so a placeholder manifest can never be merged
 * silently. Once real accessions are committed, the gate turns green with no
 * code change.
 */

describe("form4 manifest", () => {
  it("has one entry per committed fixture XML", () => {
    const xmlLabels = readdirSync(FORM4_DIR)
      .filter((f) => f.endsWith(".xml"))
      .map((f) => f.replace(/\.xml$/, ""))
      .sort();
    const manifestLabels = readForm4Manifest()
      .map((e) => e.label)
      .sort();
    expect(manifestLabels).toEqual(xmlLabels);
  });

  it("every entry has valid submission metadata", () => {
    for (const e of readForm4Manifest()) {
      expect(e.accession, e.label).toMatch(/^\d{10}-\d{2}-\d{6}$/);
      expect(e.filedAt, e.label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.periodOfReport, e.label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.issuerCik, e.label).toMatch(/^\d{10}$/);
      expect(e.ownerCiks.length, e.label).toBeGreaterThan(0);
    }
  });

  // GATE — fails until `npm run fixtures:form4` replaces placeholders with the
  // real pinned accessions. Do not weaken or skip this test to go green.
  it("GATE: no placeholder accessions (run `npm run fixtures:form4`)", () => {
    const placeholders = readForm4Manifest().filter(
      (e) => e.placeholder === true || /^9999999999-99-/.test(e.accession),
    );
    expect(
      placeholders.map((e) => e.label),
      "placeholder manifest — run `npm run fixtures:form4` to pin real EDGAR accessions",
    ).toEqual([]);
  });
});
