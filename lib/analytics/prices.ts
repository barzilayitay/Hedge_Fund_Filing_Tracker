/**
 * Pure helpers for quarter-end price data.
 *
 * The IO (fetching a daily series from a free provider) lives in scripts/.
 * These functions only reshape already-fetched data, so they are unit-tested
 * offline like the parsers.
 */

/** One trading day's close. */
export interface DailyClose {
  /** ISO date, YYYY-MM-DD. */
  date: string;
  close: number;
}

export interface QuarterEndPrice {
  ticker: string;
  /** Quarter-end date, YYYY-MM-DD (may be a weekend; see note below). */
  quarterEnd: string;
  closePrice: number;
}

/**
 * For each requested quarter-end, pick the last available close on or before
 * it. Quarter-ends can fall on a weekend/holiday (e.g. 2024-06-30 is a Sunday),
 * so we never require an exact-date match — we take the most recent trading day
 * up to and including the quarter-end, which is the quarter's closing price.
 */
export function pickQuarterEndCloses(
  ticker: string,
  series: DailyClose[],
  quarterEnds: string[],
): QuarterEndPrice[] {
  const sorted = [...series]
    .filter((d) => Number.isFinite(d.close))
    .sort((a, b) => a.date.localeCompare(b.date));

  const out: QuarterEndPrice[] = [];
  for (const qe of quarterEnds) {
    let best: DailyClose | null = null;
    for (const d of sorted) {
      if (d.date <= qe) best = d;
      else break;
    }
    if (best) {
      out.push({ ticker, quarterEnd: qe, closePrice: round4(best.close) });
    }
  }
  return out;
}

/** Round to 4 decimal places, matching the acceptance-test tolerance. */
export function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** Serialize quarter-end prices to the committed CSV shape. */
export function toPricesCsv(rows: QuarterEndPrice[]): string {
  const sorted = [...rows].sort(
    (a, b) =>
      a.ticker.localeCompare(b.ticker) || a.quarterEnd.localeCompare(b.quarterEnd),
  );
  const lines = ["ticker,quarter_end,close_price"];
  for (const r of sorted) {
    lines.push(`${r.ticker},${r.quarterEnd},${r.closePrice}`);
  }
  return lines.join("\n") + "\n";
}

/** Parse the committed CSV back into rows. Ignores blank/comment lines. */
export function parsePricesCsv(csv: string): QuarterEndPrice[] {
  const rows: QuarterEndPrice[] = [];
  const lines = csv.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("ticker,")) continue; // header
    const [ticker, quarterEnd, closePrice] = trimmed.split(",");
    rows.push({ ticker, quarterEnd, closePrice: Number(closePrice) });
  }
  return rows;
}
