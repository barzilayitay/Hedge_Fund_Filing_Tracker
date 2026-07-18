import { readFileSync } from "fs";
import { join } from "path";
import { parse13f } from "@/lib/edgar/parse13f";
import type { Parsed13F } from "@/lib/edgar/schemas13f";

/** Fixture access for the Phase 1 tests. Reads from disk only — never EDGAR. */

export const FIXTURE_DIR = join(__dirname, "..", "..", "fixtures", "13f");
export const REFERENCE_DIR = join(__dirname, "..", "..", "fixtures", "reference");
export const PRICES_DIR = join(__dirname, "..", "..", "fixtures", "prices");
export const COMPANYFACTS_DIR = join(__dirname, "..", "..", "fixtures", "companyfacts");

export interface ManifestEntry {
  label: string;
  cik: string;
  accession: string;
  formType: string;
  filedAt: string;
  periodOfReport: string;
  coverPage: string;
  informationTable: string;
  note: string;
}

export interface SpotCheck {
  rowIndex: number;
  nameOfIssuer: string;
  cusip: string;
  shareClass: string | null;
  putCall: "Put" | "Call" | null;
  shares: number | null;
  principalAmt: number | null;
  valueUsd: number;
}

export interface Expected {
  accession: string;
  cik: string;
  filerName: string;
  filerSlug: string;
  formType: string;
  periodOfReport: string;
  filedAt: string;
  isAmendment: boolean;
  amendmentType: "RESTATEMENT" | "NEW HOLDINGS" | null;
  rowCount: number;
  totalValueUsd: number;
  declaredByFiler: {
    entryTotal: number | null;
    valueTotal: number | null;
    valueUnits: string;
  };
  distinctCusips: number;
  spotChecks: SpotCheck[];
  warnings: string[];
}

export function readManifest(): ManifestEntry[] {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, "manifest.json"), "utf-8"),
  ) as ManifestEntry[];
}

export function manifestEntry(label: string): ManifestEntry {
  const entry = readManifest().find((e) => e.label === label);
  if (!entry) throw new Error(`No fixture labelled "${label}"`);
  return entry;
}

export function readCoverXml(label: string): string {
  return readFileSync(join(FIXTURE_DIR, `${label}.cover.xml`), "utf-8");
}

export function readInfoTableXml(label: string): string {
  return readFileSync(join(FIXTURE_DIR, `${label}.xml`), "utf-8");
}

export function readExpected(label: string): Expected {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, `${label}.expected.json`), "utf-8"),
  ) as Expected;
}

export function parseFixture(label: string): Parsed13F {
  const entry = manifestEntry(label);
  return parse13f(readCoverXml(label), readInfoTableXml(label), {
    accessionNo: entry.accession,
    filedAt: entry.filedAt,
  });
}

export function readCompanyTickersJson(): string {
  return readFileSync(join(REFERENCE_DIR, "company_tickers.json"), "utf-8");
}

export function read13fListText(): string {
  return readFileSync(join(REFERENCE_DIR, "13flist2026q1.txt"), "utf-8");
}

export interface SpotcheckSecurity {
  cusip: string;
  ticker: string;
  sector: string;
  cik: string;
  name: string;
}

/** The resolved cusip -> ticker/sector/cik cache the Phase 2 tests seed. */
export function readSpotcheckSecurities(): SpotcheckSecurity[] {
  return JSON.parse(
    readFileSync(join(REFERENCE_DIR, "spotcheck-securities.json"), "utf-8"),
  ) as SpotcheckSecurity[];
}

export function readPricesCsv(): string {
  return readFileSync(join(PRICES_DIR, "quarterly_prices.csv"), "utf-8");
}

export interface DiffExpected {
  cik: string;
  period_of_report: string;
  prior_period: string;
  portfolio_value: number;
  prior_portfolio_value: number;
  positions: Array<Record<string, unknown>>;
  summary: {
    current: Record<string, unknown>;
    prior: Record<string, unknown>;
  };
}

export function readDiffExpected(): DiffExpected {
  return JSON.parse(
    readFileSync(join(FIXTURE_DIR, "berkshire.diff.expected.json"), "utf-8"),
  ) as DiffExpected;
}
