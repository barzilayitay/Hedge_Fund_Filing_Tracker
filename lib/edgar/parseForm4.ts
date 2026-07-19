import { XMLParser } from "fast-xml-parser";
import {
  parsedForm4Schema,
  type Form4Transaction,
  type Owner,
  type ParsedForm4,
  type TableType,
} from "./schemasForm4";

/**
 * Pure Form 4 parser: (ownershipDocument XML, submission ref) -> validated rows.
 * All IO lives in the client/poller layer.
 *
 * Joint filings (multiple reportingOwner blocks) fan out to one transaction row
 * per (owner, transaction) per the spec. Holdings-only rows (position
 * statements with no transactionCoding) are skipped but counted in stats.
 */

/**
 * Accession number and filing date are EDGAR *submission* metadata — they do
 * not appear in the ownershipDocument, so the caller (poller or fixture
 * manifest) must supply them. periodOfReport, by contrast, IS in the document.
 */
export interface Form4SubmissionRef {
  accessionNo: string;
  filedAt: string;
}

// Keep every leaf a string: parsed numbers would drop CUSIP/CIK leading zeros
// and lose precision. removeNSPrefix is irrelevant here (Form 4 is unprefixed)
// but kept consistent with parse13f.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

type Node = Record<string, unknown>;

function asNode(v: unknown): Node | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Node)
    : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t === "" ? undefined : t;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function num(v: unknown): number | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function at(root: unknown, ...keys: string[]): unknown {
  let cur: unknown = root;
  for (const k of keys) {
    const node = asNode(cur);
    if (!node) return undefined;
    cur = node[k];
  }
  return cur;
}

function toArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/** Detect the document by its root element rather than a filename. */
export function isOwnershipDocument(xml: string): boolean {
  return xml.includes("<ownershipDocument");
}

function normalizeCik(raw: string): string {
  return raw.replace(/\D/g, "").padStart(10, "0");
}

/** Form 4 dates are already ISO (YYYY-MM-DD) but validate defensively. */
function toIsoDate(raw: string, field: string): string {
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!m) throw new Error(`Unrecognized date in ${field}: "${raw}"`);
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

/** EDGAR booleans are 1/0 or true/false. */
function toBool(v: unknown): boolean {
  const s = str(v)?.toLowerCase();
  return s === "1" || s === "true";
}

/**
 * A `<value>` child holds the datum; a sibling `<footnoteId>` may reference a
 * footnote instead of (or in addition to) a value. Return the value string, or
 * undefined when only a footnote is present (spec: store null + footnote,
 * never 0).
 */
function valueOf(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  const n = asNode(node);
  if (!n) return str(node);
  return str(n.value);
}

/** Collect footnote ids referenced anywhere under a node (deep). */
function collectFootnoteIds(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectFootnoteIds(item, into);
    return;
  }
  const n = asNode(node);
  if (!n) return;
  for (const [key, value] of Object.entries(n)) {
    if (key === "footnoteId") {
      for (const fn of toArray(value)) {
        const id = str(at(fn, "@_id"));
        if (id) into.add(id);
      }
    } else {
      collectFootnoteIds(value, into);
    }
  }
}

/** Resolve the footnote ids referenced under a node to their text. */
function footnotesFor(
  node: unknown,
  allFootnotes: Record<string, string>,
): Record<string, string> {
  const ids = new Set<string>();
  collectFootnoteIds(node, ids);
  const out: Record<string, string> = {};
  for (const id of ids) {
    if (allFootnotes[id] !== undefined) out[id] = allFootnotes[id];
  }
  return out;
}

function parseFootnotes(doc: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const fn of toArray(at(doc, "footnotes", "footnote"))) {
    const id = str(at(fn, "@_id"));
    // Footnote text is the element's content; with attributes present,
    // fast-xml-parser puts it under #text, otherwise the node is the string.
    const text = str(at(fn, "#text")) ?? str(fn);
    if (id && text !== undefined) out[id] = text;
  }
  return out;
}

function parseOwners(doc: unknown, warnings: string[]): Owner[] {
  const owners: Owner[] = [];
  for (const ro of toArray(at(doc, "reportingOwner"))) {
    const cikRaw = str(at(ro, "reportingOwnerId", "rptOwnerCik"));
    if (cikRaw === undefined) {
      warnings.push("reportingOwner with no rptOwnerCik; skipped");
      continue;
    }
    const name = str(at(ro, "reportingOwnerId", "rptOwnerName"));
    const rel = at(ro, "reportingOwnerRelationship");
    owners.push({
      cik: normalizeCik(cikRaw),
      // Entity owners have rptOwnerName but no name parts; use the CIK as a
      // last resort so the row still validates.
      name: name ?? normalizeCik(cikRaw),
      isOfficer: toBool(at(rel, "isOfficer")),
      isDirector: toBool(at(rel, "isDirector")),
      isTenPct: toBool(at(rel, "isTenPercentOwner")),
      isOther: toBool(at(rel, "isOther")),
      officerTitle: str(at(rel, "officerTitle")) ?? null,
      otherText: str(at(rel, "otherText")) ?? null,
    });
  }
  return owners;
}

/** Acquired/disposed and direct/indirect are single-letter enums; validate. */
function acquiredDisposed(v: string | undefined): "A" | "D" | null {
  const s = v?.toUpperCase();
  return s === "A" || s === "D" ? s : null;
}
function directIndirect(v: string | undefined): "D" | "I" | null {
  const s = v?.toUpperCase();
  return s === "D" || s === "I" ? s : null;
}

interface RawTransaction {
  tableType: TableType;
  rowIndex: number;
  securityTitle: string | null;
  transactionCode: string | null;
  transactionDate: string | null;
  shares: number | null;
  price: number | null;
  acquiredDisposed: "A" | "D" | null;
  sharesOwnedAfter: number | null;
  directIndirect: "D" | "I" | null;
  natureOfOwnership: string | null;
  conversionOrExercisePrice: number | null;
  exerciseDate: string | null;
  expirationDate: string | null;
  underlyingSecurityTitle: string | null;
  underlyingShares: number | null;
  footnotes: Record<string, string>;
}

function parseDate(raw: unknown, field: string): string | null {
  const v = valueOf(raw);
  return v === undefined ? null : toIsoDate(v, field);
}

/**
 * Parse the transactions in one table (nonDerivative or derivative). Holdings
 * (nonDerivativeHolding / derivativeHolding) are position statements with no
 * transactionCoding — skipped but counted.
 */
function parseTable(
  tableNode: unknown,
  tableType: TableType,
  transactionKey: string,
  allFootnotes: Record<string, string>,
  holdingKey: string,
): { transactions: RawTransaction[]; holdingsSkipped: number } {
  const transactions: RawTransaction[] = [];
  const rawRows = toArray(at(tableNode, transactionKey));

  rawRows.forEach((row, rowIndex) => {
    const amounts = at(row, "transactionAmounts");
    const coding = at(row, "transactionCoding");
    const underlying = at(row, "underlyingSecurity");

    transactions.push({
      tableType,
      rowIndex,
      securityTitle: valueOf(at(row, "securityTitle")) ?? null,
      transactionCode: str(at(coding, "transactionCode")) ?? null,
      transactionDate: parseDate(at(row, "transactionDate"), "transactionDate"),
      shares: num(valueOf(at(amounts, "transactionShares"))) ?? null,
      // Distinguish absent (footnoted -> null) from a real 0 price.
      price:
        valueOf(at(amounts, "transactionPricePerShare")) === undefined
          ? null
          : (num(valueOf(at(amounts, "transactionPricePerShare"))) ?? null),
      acquiredDisposed: acquiredDisposed(
        valueOf(at(amounts, "transactionAcquiredDisposedCode")),
      ),
      sharesOwnedAfter:
        num(
          valueOf(
            at(row, "postTransactionAmounts", "sharesOwnedFollowingTransaction"),
          ),
        ) ?? null,
      directIndirect: directIndirect(
        valueOf(at(row, "ownershipNature", "directOrIndirectOwnership")),
      ),
      natureOfOwnership:
        valueOf(at(row, "ownershipNature", "natureOfOwnership")) ?? null,
      conversionOrExercisePrice:
        tableType === "deriv"
          ? (num(valueOf(at(row, "conversionOrExercisePrice"))) ?? null)
          : null,
      exerciseDate:
        tableType === "deriv"
          ? parseDate(at(row, "exerciseDate"), "exerciseDate")
          : null,
      expirationDate:
        tableType === "deriv"
          ? parseDate(at(row, "expirationDate"), "expirationDate")
          : null,
      underlyingSecurityTitle:
        tableType === "deriv"
          ? (valueOf(at(underlying, "underlyingSecurityTitle")) ?? null)
          : null,
      underlyingShares:
        tableType === "deriv"
          ? (num(valueOf(at(underlying, "underlyingSecurityShares"))) ?? null)
          : null,
      footnotes: footnotesFor(row, allFootnotes),
    });
  });

  const holdingsSkipped = toArray(at(tableNode, holdingKey)).length;
  return { transactions, holdingsSkipped };
}

/**
 * Parse a Form 4 (or 4/A). `ref` supplies the accession + filed date, which are
 * submission metadata absent from the document.
 */
export function parseForm4(xml: string, ref: Form4SubmissionRef): ParsedForm4 {
  if (!isOwnershipDocument(xml)) {
    throw new Error("XML is not an ownershipDocument");
  }

  const warnings: string[] = [];
  const doc = at(parser.parse(xml), "ownershipDocument");
  if (doc === undefined) {
    throw new Error("No ownershipDocument root");
  }

  const documentType = str(at(doc, "documentType")) ?? "4";
  const formType = documentType.startsWith("4") ? documentType : `4`;
  const isAmendment = str(at(doc, "documentType"))?.includes("/A") ?? false;

  const issuerCikRaw = str(at(doc, "issuer", "issuerCik"));
  if (issuerCikRaw === undefined) throw new Error("No issuerCik");
  const issuerCik = normalizeCik(issuerCikRaw);

  const issuerName = str(at(doc, "issuer", "issuerName"));
  if (issuerName === undefined) throw new Error("No issuerName");

  const periodRaw = str(at(doc, "periodOfReport"));
  if (periodRaw === undefined) throw new Error("No periodOfReport");
  const periodOfReport = toIsoDate(periodRaw, "periodOfReport");

  const owners = parseOwners(doc, warnings);
  if (owners.length === 0) throw new Error("Form 4 has no reporting owners");

  const allFootnotes = parseFootnotes(doc);
  const is10b5One = toBool(at(doc, "aff10b5One"));

  const nonDeriv = parseTable(
    at(doc, "nonDerivativeTable"),
    "nonderiv",
    "nonDerivativeTransaction",
    allFootnotes,
    "nonDerivativeHolding",
  );
  const deriv = parseTable(
    at(doc, "derivativeTable"),
    "deriv",
    "derivativeTransaction",
    allFootnotes,
    "derivativeHolding",
  );

  const rawTransactions = [...nonDeriv.transactions, ...deriv.transactions];
  const holdingsSkipped = nonDeriv.holdingsSkipped + deriv.holdingsSkipped;

  // Fan out to one row per (owner, transaction).
  const transactions: Form4Transaction[] = [];
  for (const owner of owners) {
    for (const t of rawTransactions) {
      transactions.push({
        ownerCik: owner.cik,
        tableType: t.tableType,
        rowIndex: t.rowIndex,
        securityTitle: t.securityTitle,
        transactionCode: t.transactionCode,
        transactionDate: t.transactionDate,
        shares: t.shares,
        price: t.price,
        acquiredDisposed: t.acquiredDisposed,
        sharesOwnedAfter: t.sharesOwnedAfter,
        directIndirect: t.directIndirect,
        natureOfOwnership: t.natureOfOwnership,
        is10b5One,
        conversionOrExercisePrice: t.conversionOrExercisePrice,
        exerciseDate: t.exerciseDate,
        expirationDate: t.expirationDate,
        underlyingSecurityTitle: t.underlyingSecurityTitle,
        underlyingShares: t.underlyingShares,
        footnotes: t.footnotes,
      });
    }
  }

  return parsedForm4Schema.parse({
    filing: {
      accessionNo: ref.accessionNo,
      formType,
      periodOfReport,
      filedAt: toIsoDate(ref.filedAt, "filedAt"),
      isAmendment,
      issuerCik,
    },
    issuer: {
      cik: issuerCik,
      name: issuerName,
      ticker: str(at(doc, "issuer", "issuerTradingSymbol")) ?? null,
    },
    owners,
    transactions,
    footnotes: allFootnotes,
    is10b5One,
    stats: {
      // transactions is the emitted (fanned-out) row count; holdingsSkipped is
      // the raw number of holdings-only rows in the document (not fanned).
      transactions: transactions.length,
      holdingsSkipped,
    },
    warnings,
  } satisfies ParsedForm4);
}
