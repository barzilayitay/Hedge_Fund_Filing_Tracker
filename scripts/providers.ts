/**
 * Network IO for the price / shares-outstanding data providers. Kept apart from
 * the pure reshaping helpers in lib/analytics so those stay unit-testable and
 * this stays out of the test path (hard rule 2 — tests never hit the network).
 */
import { edgarFetch } from "../lib/edgar/client";
import type { DailyClose } from "../lib/analytics/prices";

/**
 * Daily closes from Yahoo's public chart API.
 *
 * The spec names Stooq, but Stooq now gates its CSV endpoint behind a
 * JavaScript proof-of-work bot-check, which we do not bypass. Yahoo's chart API
 * is the "equivalent free provider" the spec permits (PROGRESS.md records this).
 */
export async function fetchYahooDailyCloses(
  ticker: string,
  startISO: string,
  endISO: string,
): Promise<DailyClose[]> {
  const p1 = Math.floor(new Date(`${startISO}T00:00:00Z`).getTime() / 1000);
  const p2 = Math.floor(new Date(`${endISO}T00:00:00Z`).getTime() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker,
  )}?period1=${p1}&period2=${p2}&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${ticker}`);
  const j = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: (number | null)[] }> };
      }>;
    };
  };
  const r = j.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  const series: DailyClose[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c === "number") {
      series.push({
        date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
        close: c,
      });
    }
  }
  return series;
}

/**
 * SEC company-concept document for dei:EntityCommonStockSharesOutstanding.
 * Goes through the rate-limited EDGAR client (hard rule 1).
 */
export async function fetchSharesConcept(cik: string): Promise<unknown> {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/dei/EntityCommonStockSharesOutstanding.json`;
  const res = await edgarFetch(url);
  if (!res.ok) throw new Error(`SEC HTTP ${res.status} for CIK${cik}`);
  return res.json();
}
