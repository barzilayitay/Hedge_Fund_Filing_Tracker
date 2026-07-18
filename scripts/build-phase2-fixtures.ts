/**
 * ONE-TIME, network-required. Builds the frozen Phase 2 fixtures:
 *   - fixtures/reference/spotcheck-securities.json  (cusip -> ticker/sector/cik)
 *   - fixtures/prices/quarterly_prices.csv          (Yahoo quarter-end closes)
 *   - fixtures/companyfacts/CIK<10>.shares.json     (SEC shares outstanding)
 *
 * Run once, commit the output, then never re-run in CI or tests (hard rule 2).
 *
 *   EDGAR_USER_AGENT="App you@example.com" npx tsx scripts/build-phase2-fixtures.ts
 *
 * Provider note: the spec names Stooq, but Stooq now gates its CSV endpoint
 * behind a JavaScript proof-of-work bot-check, which we do not bypass. Yahoo's
 * public chart API is the "equivalent free provider" the spec permits. Recorded
 * in PROGRESS.md.
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  pickQuarterEndCloses,
  toPricesCsv,
  type QuarterEndPrice,
} from "../lib/analytics/prices";
import { fetchYahooDailyCloses, fetchSharesConcept } from "./providers";

const ROOT = join(__dirname, "..");
const REF_DIR = join(ROOT, "fixtures", "reference");
const PRICES_DIR = join(ROOT, "fixtures", "prices");
const FACTS_DIR = join(ROOT, "fixtures", "companyfacts");

/** Quarter-ends we seed prices for (prior/current Berkshire quarters + one back). */
const QUARTER_ENDS = ["2025-09-30", "2025-12-31", "2026-03-31"];

/**
 * Curated real cusip -> ticker/sector map for Berkshire's holdings. Clean-ticker
 * names only; Liberty tracking stocks and foreign ADRs are intentionally left
 * out so they remain unmapped in `securities` (exercises the unmapped-CUSIP
 * path). CIK and issuer name are resolved from company_tickers.json below.
 */
const CUSIP_MAP: Record<string, { ticker: string; sector: string }> = {
  "037833100": { ticker: "AAPL", sector: "Technology" },
  "025816109": { ticker: "AXP", sector: "Financials" },
  "191216100": { ticker: "KO", sector: "Consumer Staples" },
  "060505104": { ticker: "BAC", sector: "Financials" },
  "166764100": { ticker: "CVX", sector: "Energy" },
  "674599105": { ticker: "OXY", sector: "Energy" },
  "02079K305": { ticker: "GOOGL", sector: "Communication Services" },
  "02079K107": { ticker: "GOOG", sector: "Communication Services" },
  "H1467J104": { ticker: "CB", sector: "Financials" },
  "615369105": { ticker: "MCO", sector: "Financials" },
  "500754106": { ticker: "KHC", sector: "Consumer Staples" },
  "23918K108": { ticker: "DVA", sector: "Health Care" },
  "501044101": { ticker: "KR", sector: "Consumer Staples" },
  "829933100": { ticker: "SIRI", sector: "Communication Services" },
  "247361702": { ticker: "DAL", sector: "Industrials" },
  "92343E102": { ticker: "VRSN", sector: "Technology" },
  "14040H105": { ticker: "COF", sector: "Financials" },
  "650111107": { ticker: "NYT", sector: "Communication Services" },
  "02005N100": { ticker: "ALLY", sector: "Financials" },
  "526057104": { ticker: "LEN", sector: "Consumer Discretionary" },
  "670346105": { ticker: "NUE", sector: "Materials" },
  "546347105": { ticker: "LPX", sector: "Materials" },
  "21036P108": { ticker: "STZ", sector: "Consumer Staples" },
  "62944T105": { ticker: "NVR", sector: "Consumer Discretionary" },
  "55616P104": { ticker: "M", sector: "Consumer Discretionary" },
  "47233W109": { ticker: "JEF", sector: "Financials" },
  "023135106": { ticker: "AMZN", sector: "Consumer Discretionary" },
  "16119P108": { ticker: "CHTR", sector: "Communication Services" },
  "25754A201": { ticker: "DPZ", sector: "Consumer Discretionary" },
  "512816109": { ticker: "LAMR", sector: "Real Estate" },
  "57636Q104": { ticker: "MA", sector: "Financials" },
  "73278L105": { ticker: "POOL", sector: "Consumer Discretionary" },
  "91324P102": { ticker: "UNH", sector: "Health Care" },
  "92826C839": { ticker: "V", sector: "Financials" },
};

interface CompanyTicker {
  cik_str: number;
  ticker: string;
  title: string;
}

interface ResolvedSecurity {
  cusip: string;
  ticker: string;
  sector: string;
  cik: string;
  name: string;
}

function resolveSecurities(): ResolvedSecurity[] {
  const raw = JSON.parse(
    readFileSync(join(REF_DIR, "company_tickers.json"), "utf-8"),
  ) as Record<string, CompanyTicker>;
  const byTicker = new Map<string, { cik: string; title: string }>();
  for (const k of Object.keys(raw)) {
    const e = raw[k];
    byTicker.set(e.ticker.toUpperCase(), {
      cik: String(e.cik_str).padStart(10, "0"),
      title: e.title,
    });
  }

  const out: ResolvedSecurity[] = [];
  for (const cusip of Object.keys(CUSIP_MAP)) {
    const { ticker, sector } = CUSIP_MAP[cusip];
    const hit = byTicker.get(ticker.toUpperCase());
    if (!hit) throw new Error(`ticker ${ticker} not found in company_tickers.json`);
    out.push({ cusip, ticker, sector, cik: hit.cik, name: hit.title });
  }
  out.sort((a, b) => a.cusip.localeCompare(b.cusip));
  return out;
}

const PRICE_START = "2025-09-16"; // ~14 days before the first quarter-end
const PRICE_END = QUARTER_ENDS[QUARTER_ENDS.length - 1];

async function main(): Promise<void> {
  mkdirSync(PRICES_DIR, { recursive: true });
  mkdirSync(FACTS_DIR, { recursive: true });

  const securities = resolveSecurities();
  writeFileSync(
    join(REF_DIR, "spotcheck-securities.json"),
    JSON.stringify(securities, null, 2) + "\n",
  );
  console.log(`spotcheck-securities.json: ${securities.length} securities`);

  // Prices (Yahoo).
  const priceRows: QuarterEndPrice[] = [];
  for (const s of securities) {
    try {
      const series = await fetchYahooDailyCloses(s.ticker, PRICE_START, PRICE_END);
      const picked = pickQuarterEndCloses(s.ticker, series, QUARTER_ENDS);
      priceRows.push(...picked);
      console.log(`  prices ${s.ticker}: ${picked.map((p) => `${p.quarterEnd}=${p.closePrice}`).join(" ")}`);
    } catch (e) {
      console.error(`  prices ${s.ticker} FAILED: ${(e as Error).message}`);
    }
    await sleep(300);
  }
  writeFileSync(join(PRICES_DIR, "quarterly_prices.csv"), toPricesCsv(priceRows));
  console.log(`quarterly_prices.csv: ${priceRows.length} rows`);

  // Shares outstanding (SEC), one file per issuer.
  const seenCik = new Set<string>();
  for (const s of securities) {
    if (seenCik.has(s.cik)) continue;
    seenCik.add(s.cik);
    try {
      const doc = await fetchSharesConcept(s.cik);
      writeFileSync(
        join(FACTS_DIR, `CIK${s.cik}.shares.json`),
        JSON.stringify(doc),
      );
      console.log(`  companyfacts CIK${s.cik} (${s.ticker}) ok`);
    } catch (e) {
      console.error(`  companyfacts CIK${s.cik} (${s.ticker}) FAILED: ${(e as Error).message}`);
    }
  }
  console.log(`companyfacts: ${seenCik.size} issuers`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
