/**
 * Pure parsers for the SEC reference files committed under fixtures/reference.
 *
 * Two files, because neither is sufficient alone:
 *  - company_tickers.json: cik -> ticker + name. No CUSIPs at all.
 *  - Official List of Section 13(f) Securities: cusip -> issuer + class.
 *    No tickers.
 *
 * Joining them on issuer name is what gives a CUSIP -> ticker seed; anything
 * that does not join cleanly is left for OpenFIGI to resolve at runtime.
 */

/** One row of the Official List of Section 13(f) Securities. */
export interface ThirteenFListEntry {
  cusip: string;
  issuer: string;
  securityClass: string;
  /** The list flags issuers that have listed options with an asterisk. */
  hasListedOption: boolean;
  status: string;
}

/** One entry of company_tickers.json. */
export interface CompanyTickerEntry {
  cik: string;
  ticker: string;
  name: string;
}

/**
 * The 13(f) list is fixed-width, 80 columns, no header:
 *   0-8   CUSIP
 *   9     '*' when the issuer has listed options
 *   10-39 issuer name
 *   40-78 security class / description
 *   79    status
 */
export function parse13fList(text: string): ThirteenFListEntry[] {
  const entries: ThirteenFListEntry[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    // Tolerate short lines rather than slicing past the end.
    if (line.length < 40) continue;

    const cusip = line.slice(0, 9).trim().toUpperCase();
    if (!/^[0-9A-Z]{9}$/.test(cusip)) continue;

    entries.push({
      cusip,
      hasListedOption: line[9] === "*",
      issuer: line.slice(10, 40).trim(),
      securityClass: line.slice(40, 79).trim(),
      status: line.slice(79).trim(),
    });
  }

  return entries;
}

/** company_tickers.json is an object keyed by row number, not an array. */
export function parseCompanyTickers(json: string): CompanyTickerEntry[] {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null) {
    throw new Error("company_tickers.json is not an object");
  }

  const entries: CompanyTickerEntry[] = [];
  for (const value of Object.values(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const row = value as Record<string, unknown>;
    const cikRaw = row.cik_str;
    const ticker = row.ticker;
    const title = row.title;
    if (
      (typeof cikRaw !== "number" && typeof cikRaw !== "string") ||
      typeof ticker !== "string" ||
      typeof title !== "string"
    ) {
      continue;
    }
    entries.push({
      cik: String(cikRaw).replace(/\D/g, "").padStart(10, "0"),
      ticker: ticker.trim().toUpperCase(),
      name: title.trim(),
    });
  }
  return entries;
}

/**
 * Fold issuer names to a comparable form: "Apple Inc." and "APPLE INC" both
 * become "APPLE INC". Deliberately conservative — no suffix stripping or fuzzy
 * matching, because a CUSIP mapped to the *wrong* ticker is worse than one
 * left unmapped, and OpenFIGI resolves whatever does not match.
 */
export function normalizeIssuerName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * normalized issuer name -> tickers. A name mapping to more than one ticker
 * (share classes, e.g. Alphabet's GOOG and GOOGL) is ambiguous, not mapped.
 */
export function buildTickerIndex(
  entries: CompanyTickerEntry[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const e of entries) {
    const key = normalizeIssuerName(e.name);
    const tickers = index.get(key);
    if (tickers) {
      if (!tickers.includes(e.ticker)) tickers.push(e.ticker);
    } else {
      index.set(key, [e.ticker]);
    }
  }
  return index;
}

export type MappingStatus = "mapped" | "unmapped" | "ambiguous";

export interface SeedSecurity {
  cusip: string;
  ticker: string | null;
  name: string;
  mappingStatus: MappingStatus;
}

/** Join the 13(f) list to the ticker index to produce securities seed rows. */
export function buildSecuritySeed(
  list: ThirteenFListEntry[],
  tickerIndex: Map<string, string[]>,
): SeedSecurity[] {
  return list.map((entry) => {
    const tickers = tickerIndex.get(normalizeIssuerName(entry.issuer));

    if (!tickers || tickers.length === 0) {
      return {
        cusip: entry.cusip,
        ticker: null,
        name: entry.issuer,
        mappingStatus: "unmapped",
      };
    }
    if (tickers.length > 1) {
      return {
        cusip: entry.cusip,
        ticker: null,
        name: entry.issuer,
        mappingStatus: "ambiguous",
      };
    }
    return {
      cusip: entry.cusip,
      ticker: tickers[0],
      name: entry.issuer,
      mappingStatus: "mapped",
    };
  });
}
