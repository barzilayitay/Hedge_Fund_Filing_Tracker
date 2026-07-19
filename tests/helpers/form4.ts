import { readFileSync } from "fs";
import { join } from "path";
import { parseForm4 } from "@/lib/edgar/parseForm4";
import type { Form4Transaction, ParsedForm4 } from "@/lib/edgar/schemasForm4";

/** Fixture access for the Phase 3 tests. Reads from disk only — never EDGAR. */

export const FORM4_DIR = join(__dirname, "..", "..", "fixtures", "form4");

export interface Form4ManifestEntry {
  label: string;
  issuerCik: string;
  accession: string;
  formType: string;
  filedAt: string;
  periodOfReport: string;
  ownerCiks: string[];
  note: string;
  /** True while the manifest holds placeholder accessions (pre-fetch). */
  placeholder?: boolean;
}

export interface Form4Expected {
  formType: string;
  periodOfReport: string;
  issuerCik: string;
  issuerName: string;
  issuerTicker: string | null;
  ownerCount: number;
  ownerCiks: string[];
  transactionCount: number;
  holdingsSkipped: number;
  is10b5One: boolean;
  distinctCodes: string[];
  spotChecks: Form4Transaction[];
}

export function readForm4Manifest(): Form4ManifestEntry[] {
  return JSON.parse(
    readFileSync(join(FORM4_DIR, "manifest.json"), "utf-8"),
  ) as Form4ManifestEntry[];
}

export function form4ManifestEntry(label: string): Form4ManifestEntry {
  const entry = readForm4Manifest().find((e) => e.label === label);
  if (!entry) throw new Error(`No Form 4 fixture labelled "${label}"`);
  return entry;
}

export function readForm4Xml(label: string): string {
  return readFileSync(join(FORM4_DIR, `${label}.xml`), "utf-8");
}

export function readForm4Expected(label: string): Form4Expected {
  return JSON.parse(
    readFileSync(join(FORM4_DIR, `${label}.expected.json`), "utf-8"),
  ) as Form4Expected;
}

export function parseForm4Fixture(label: string): ParsedForm4 {
  const entry = form4ManifestEntry(label);
  return parseForm4(readForm4Xml(label), {
    accessionNo: entry.accession,
    filedAt: entry.filedAt,
  });
}
