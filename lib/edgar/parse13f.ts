import { XMLParser } from "fast-xml-parser";
import {
  parsed13fSchema,
  type AmendmentType,
  type Holding,
  type Parsed13F,
} from "./schemas13f";

/**
 * Pure 13F parser: (cover XML, information-table XML) -> validated rows.
 * All IO lives in the client/poller layer.
 */

/** Cover page (primary_doc.xml) namespace. */
export const COVER_NS = "http://www.sec.gov/edgar/thirteenffiler";
/** Information table namespace. */
export const INFOTABLE_NS =
  "http://www.sec.gov/edgar/document/thirteenf/informationtable";

/**
 * Values switched from $ thousands to whole dollars for periods ending on or
 * after this date (SEC technical amendment; ARCHITECTURE.md decision 4).
 */
const WHOLE_DOLLAR_FROM = "2023-01-01";

/**
 * Accession number and filing date are EDGAR *submission* metadata — they do
 * not appear anywhere in the filing's XML documents, so the caller (poller or
 * fixture manifest) must supply them.
 */
export interface SubmissionRef {
  accessionNo: string;
  filedAt: string;
}

// Keep every value a string: parsed numbers would drop the leading zeros that
// CUSIPs depend on and lose precision on large share counts.
const parser = new XMLParser({
  ignoreAttributes: true,
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

/** Detect documents by namespace rather than filename (filings differ). */
export function isCoverPage(xml: string): boolean {
  return xml.includes(COVER_NS);
}

export function isInformationTable(xml: string): boolean {
  return xml.includes(INFOTABLE_NS);
}

/** EDGAR dates are MM-DD-YYYY on 13F cover pages; some filers drop padding. */
function toIsoDate(raw: string, field: string): string {
  const t = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!m) throw new Error(`Unrecognized date in ${field}: "${raw}"`);
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function normalizeCik(raw: string): string {
  return raw.replace(/\D/g, "").padStart(10, "0");
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * CUSIPs arrive with dropped leading zeros or in lowercase. Normalize to
 * 9-char uppercase; the checksum is not recomputed (log-only per spec).
 */
export function normalizeCusip(raw: string): string {
  return raw.trim().toUpperCase().padStart(9, "0");
}

function normalizePutCall(raw: string | undefined): "Put" | "Call" | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === "put") return "Put";
  if (v === "call") return "Call";
  return null;
}

/** The information table is usually its own document but may be embedded. */
function findInformationTable(root: unknown): unknown {
  if (Array.isArray(root)) {
    for (const item of root) {
      const found = findInformationTable(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const node = asNode(root);
  if (!node) return undefined;
  if (node.informationTable !== undefined) return node.informationTable;
  for (const value of Object.values(node)) {
    const found = findInformationTable(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

function parseAmendmentType(
  raw: string | undefined,
  isAmendment: boolean,
  warnings: string[],
): AmendmentType | null {
  if (!isAmendment) {
    if (raw !== undefined) {
      warnings.push(
        `amendmentType "${raw}" present on a non-amendment filing; ignored`,
      );
    }
    return null;
  }

  const normalized = raw?.trim().toUpperCase().replace(/\s+/g, " ");
  if (normalized === "RESTATEMENT" || normalized === "NEW HOLDINGS") {
    return normalized;
  }

  // Conservative default: a RESTATEMENT supersedes the original, so treating
  // an unknown amendment this way can never double count (spec deliverable 3).
  warnings.push(
    raw === undefined
      ? "13F-HR/A has no amendmentType; defaulting to RESTATEMENT"
      : `13F-HR/A has unrecognized amendmentType "${raw}"; defaulting to RESTATEMENT`,
  );
  return "RESTATEMENT";
}

function parseHoldings(
  infoTableXml: string,
  periodOfReport: string,
  warnings: string[],
): Holding[] {
  const table = findInformationTable(parser.parse(infoTableXml));
  const rows = toArray(at(table, "infoTable"));

  // Pre-2023 filings report value in $ thousands.
  const multiplier = periodOfReport < WHOLE_DOLLAR_FROM ? 1000 : 1;

  return rows.map((raw, rowIndex): Holding => {
    const cusipRaw = str(at(raw, "cusip"));
    if (cusipRaw === undefined) {
      throw new Error(`Information table row ${rowIndex} has no cusip`);
    }
    const cusip = normalizeCusip(cusipRaw);
    if (!/^[0-9A-Z]{9}$/.test(cusip)) {
      throw new Error(`Row ${rowIndex}: unusable cusip "${cusipRaw}"`);
    }

    const value = num(at(raw, "value"));
    if (value === undefined) {
      throw new Error(`Row ${rowIndex} (${cusip}) has no value`);
    }

    const amount = num(at(raw, "shrsOrPrnAmt", "sshPrnamt"));
    if (amount === undefined) {
      throw new Error(`Row ${rowIndex} (${cusip}) has no sshPrnamt`);
    }

    // SH is a share count; PRN is a principal amount (e.g. convertible debt).
    const amountType = str(at(raw, "shrsOrPrnAmt", "sshPrnamtType"))?.toUpperCase();
    if (amountType !== "SH" && amountType !== "PRN") {
      warnings.push(
        `Row ${rowIndex} (${cusip}): unknown sshPrnamtType "${amountType}"; treated as SH`,
      );
    }
    const isPrincipal = amountType === "PRN";

    return {
      rowIndex,
      nameOfIssuer: str(at(raw, "nameOfIssuer")) ?? cusip,
      cusip,
      shareClass: str(at(raw, "titleOfClass")) ?? null,
      putCall: normalizePutCall(str(at(raw, "putCall"))),
      shares: isPrincipal ? null : amount,
      principalAmt: isPrincipal ? amount : null,
      valueUsd: value * multiplier,
      investmentDiscretion: str(at(raw, "investmentDiscretion")) ?? null,
      otherManager: str(at(raw, "otherManager")) ?? null,
    };
  });
}

/**
 * Parse a 13F-HR or 13F-HR/A.
 *
 * `infoTableXml` may be the cover page itself for filings that embed the
 * information table in the primary document — detection is by namespace.
 */
export function parse13f(
  coverXml: string,
  infoTableXml: string,
  ref: SubmissionRef,
): Parsed13F {
  if (!isCoverPage(coverXml)) {
    throw new Error(`Cover page XML does not declare ${COVER_NS}`);
  }
  if (!isInformationTable(infoTableXml)) {
    throw new Error(`Information table XML does not declare ${INFOTABLE_NS}`);
  }

  const warnings: string[] = [];
  const cover = at(parser.parse(coverXml), "edgarSubmission");
  if (cover === undefined) {
    throw new Error("Cover page has no edgarSubmission root");
  }

  const formType = str(at(cover, "headerData", "submissionType"));
  if (formType === undefined) {
    throw new Error("Cover page has no submissionType");
  }

  const cikRaw = str(
    at(cover, "headerData", "filerInfo", "filer", "credentials", "cik"),
  );
  if (cikRaw === undefined) throw new Error("Cover page has no filer cik");
  const cik = normalizeCik(cikRaw);

  const name = str(at(cover, "formData", "coverPage", "filingManager", "name"));
  if (name === undefined) throw new Error("Cover page has no filingManager name");

  // periodOfReport is the authority; reportCalendarOrQuarter repeats it.
  const periodRaw =
    str(at(cover, "headerData", "filerInfo", "periodOfReport")) ??
    str(at(cover, "formData", "coverPage", "reportCalendarOrQuarter"));
  if (periodRaw === undefined) {
    throw new Error("Cover page has no periodOfReport");
  }
  const periodOfReport = toIsoDate(periodRaw, "periodOfReport");

  const isAmendment =
    formType.endsWith("/A") ||
    str(at(cover, "formData", "coverPage", "isAmendment"))?.toLowerCase() ===
      "true";

  const amendmentType = parseAmendmentType(
    str(at(cover, "formData", "coverPage", "amendmentInfo", "amendmentType")),
    isAmendment,
    warnings,
  );

  const holdings = parseHoldings(infoTableXml, periodOfReport, warnings);

  return parsed13fSchema.parse({
    filer: { cik, name, slug: slugify(name) },
    filing: {
      accessionNo: ref.accessionNo,
      cik,
      formType,
      periodOfReport,
      filedAt: toIsoDate(ref.filedAt, "filedAt"),
      isAmendment,
      amendmentType,
    },
    holdings,
    declared: {
      entryTotal: num(at(cover, "formData", "summaryPage", "tableEntryTotal")) ?? null,
      valueTotal: num(at(cover, "formData", "summaryPage", "tableValueTotal")) ?? null,
    },
    warnings,
  } satisfies Parsed13F);
}
