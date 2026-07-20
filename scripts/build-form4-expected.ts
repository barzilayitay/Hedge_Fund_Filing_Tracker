/**
 * Generate fixtures/form4/<label>.expected.json for every Form 4 fixture.
 * Run via: npm run fixtures:form4:expected
 *
 * OFFLINE. Reads the committed fixture XML only — never EDGAR.
 *
 * Non-tautology: the per-filing counts (owner count, transaction count,
 * holdings-skipped) are computed here by an INDEPENDENT regex scan of the raw
 * XML, then cross-checked against parseForm4's own stats — generation FAILS if
 * they disagree, so a parser counting bug cannot be baked into the expected
 * files. The 2 spot-check transactions are taken from the parser output for a
 * regression baseline; the acceptance tests additionally hand-assert the
 * spec-critical fields (codes P/S/M/A/G, derivative underlying+expiry, 10b5-1,
 * null-vs-0 price, entity-owner link) with literal values.
 */
import { readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { parseForm4 } from "../lib/edgar/parseForm4";
import type { Form4Transaction } from "../lib/edgar/schemasForm4";

const DIR = join("fixtures", "form4");

/** Count non-overlapping occurrences of an opening tag. */
function countTag(xml: string, tag: string): number {
  const re = new RegExp(`<${tag}[\\s>]`, "g");
  return (xml.match(re) ?? []).length;
}

interface Form4Expected {
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

/** filedAt lives in the filename (…-YYYY-MM-DD); it is not in the document. */
function filedAtFromLabel(label: string): string {
  const m = label.match(/(\d{4}-\d{2}-\d{2})$/);
  if (!m) throw new Error(`Cannot derive filedAt from label "${label}"`);
  return m[1];
}

/** Pick up to 2 spot-check transactions: prefer one nonderiv + one deriv. */
function pickSpotChecks(txs: Form4Transaction[]): Form4Transaction[] {
  if (txs.length <= 2) return txs;
  const firstNon = txs.find((t) => t.tableType === "nonderiv");
  const firstDeriv = txs.find((t) => t.tableType === "deriv");
  if (firstNon && firstDeriv) return [firstNon, firstDeriv];
  return txs.slice(0, 2);
}

function build(label: string): Form4Expected {
  const xml = readFileSync(join(DIR, `${label}.xml`), "utf-8");
  const parsed = parseForm4(xml, {
    accessionNo: "9999999999-99-000001",
    filedAt: filedAtFromLabel(label),
  });

  // Independent regex counts.
  const ownerCount = countTag(xml, "reportingOwner");
  const rawTx =
    countTag(xml, "nonDerivativeTransaction") +
    countTag(xml, "derivativeTransaction");
  const rawHoldings =
    countTag(xml, "nonDerivativeHolding") + countTag(xml, "derivativeHolding");
  const transactionCount = rawTx * ownerCount;

  if (parsed.owners.length !== ownerCount) {
    throw new Error(
      `${label}: owner count mismatch (regex ${ownerCount} vs parser ${parsed.owners.length})`,
    );
  }
  if (parsed.stats.transactions !== transactionCount) {
    throw new Error(
      `${label}: transaction count mismatch (regex ${transactionCount} vs parser ${parsed.stats.transactions})`,
    );
  }
  if (parsed.stats.holdingsSkipped !== rawHoldings) {
    throw new Error(
      `${label}: holdings-skipped mismatch (regex ${rawHoldings} vs parser ${parsed.stats.holdingsSkipped})`,
    );
  }

  const distinctCodes = [
    ...new Set(
      parsed.transactions
        .map((t) => t.transactionCode)
        .filter((c): c is string => c !== null),
    ),
  ].sort();

  return {
    formType: parsed.filing.formType,
    periodOfReport: parsed.filing.periodOfReport,
    issuerCik: parsed.issuer.cik,
    issuerName: parsed.issuer.name,
    issuerTicker: parsed.issuer.ticker,
    ownerCount,
    ownerCiks: parsed.owners.map((o) => o.cik),
    transactionCount,
    holdingsSkipped: rawHoldings,
    is10b5One: parsed.is10b5One,
    distinctCodes,
    spotChecks: pickSpotChecks(parsed.transactions),
  };
}

function main(): void {
  const labels = readdirSync(DIR)
    .filter((f) => f.endsWith(".xml"))
    .map((f) => f.replace(/\.xml$/, ""))
    .sort();

  for (const label of labels) {
    const expected = build(label);
    const path = join(DIR, `${label}.expected.json`);
    writeFileSync(path, JSON.stringify(expected, null, 2) + "\n", "utf-8");
    console.log(
      `  ✓ ${label}: ${expected.transactionCount} tx, ${expected.holdingsSkipped} held, codes [${expected.distinctCodes.join(",")}]`,
    );
  }
  console.log(`\n✅ ${labels.length} Form 4 expected files written.`);
}

main();
