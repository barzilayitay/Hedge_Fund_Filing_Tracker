/**
 * Download the 13F fixture documents and reference data used by Phase 1.
 * Run via: npm run fixtures:13f
 *
 * Phase 0's `npm run fixtures` resolved filings as "the N most recent 13F-HR"
 * and saved information tables only. That has two problems for Phase 1:
 *
 *   1. The parser also needs the cover page (primary_doc.xml): it carries the
 *      filer CIK, period_of_report (which decides the pre-2023 $-thousands
 *      conversion), filed_at and, on a 13F-HR/A, the amendmentType.
 *   2. "Most recent" moves, so the fixture set was not reproducible.
 *
 * This script works from an explicit list of pinned accessions and writes
 * fixtures/13f/manifest.json, so the set is stable. Information tables that
 * already exist on disk are left alone — re-running must not churn fixtures
 * whose expected.json values were verified by hand.
 *
 * Network required. Never run from tests.
 */
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
// edgarFetch is the only permitted way to call sec.gov (CLAUDE.md rule 1).
import { edgarFetch } from "../lib/edgar/client";

// edgarFetch reads the User-Agent from the environment on each call; fall back
// to the documented .env.example value so the script works without a local .env.
process.env.EDGAR_USER_AGENT ??=
  "HedgeFundFilingTracker barzilay.itay@gmail.com";

const EDGAR_BASE = "https://www.sec.gov/Archives/edgar/data";
const FIXTURE_DIR = join("fixtures", "13f");
const REFERENCE_DIR = join("fixtures", "reference");

/**
 * Every 13F fixture, pinned to the exact accession it was downloaded from.
 * `note` explains why the fixture is in the set — keep it accurate; Phase 0
 * shipped two fixtures whose *names* claimed an amendment type the filings
 * did not actually have.
 */
interface PinnedFixture {
  label: string;
  cik: string;
  accession: string;
  note: string;
}

const FIXTURES: PinnedFixture[] = [
  {
    label: "brk-2026-02-17",
    cik: "1067983",
    accession: "0001193125-26-054580",
    note: "Berkshire Hathaway, quarter 1 of 2 consecutive quarters",
  },
  {
    label: "brk-2026-05-15",
    cik: "1067983",
    accession: "0001193125-26-226661",
    note: "Berkshire Hathaway, quarter 2 of 2 consecutive quarters",
  },
  {
    label: "psh-2026-05-15",
    cik: "1336528",
    accession: "0001172661-26-002336",
    note: "Pershing Square, single quarter",
  },
  {
    label: "appaloosa-2026-05-15",
    cik: "1656456",
    accession: "0001656456-26-000002",
    note: "Appaloosa Management, small filer (31 positions)",
  },
  {
    label: "brk-pre2023-2022-11-14",
    cik: "1067983",
    accession: "0000950123-22-012275",
    note: "period 2022-09-30: values in $ thousands, proves unit conversion",
  },
  {
    label: "gfi-restatement-original-2025-02-12",
    cik: "1688774",
    accession: "0001688774-25-000001",
    note: "RESTATEMENT pair, original. period 2024-12-31, total 871,073",
  },
  {
    label: "gfi-restatement-amendment-2025-06-10",
    cik: "1688774",
    accession: "0001688774-25-000011",
    note:
      "RESTATEMENT pair, /A. Restates the original's values from $ thousands " +
      "to whole dollars, so the /A total (871,072,606) differs ~1000x from " +
      "the original — supersession is unambiguous.",
  },
  {
    label: "brk-newholdings-original-2024-02-14",
    cik: "1067983",
    accession: "0000950123-24-002518",
    note: "NEW HOLDINGS pair, original. period 2023-12-31",
  },
  {
    label: "brk-newholdings-amendment-2024-05-15",
    cik: "1067983",
    accession: "0000950123-24-005664",
    note: "NEW HOLDINGS pair, /A. Adds 1 previously confidential holding",
  },
  {
    label: "brk-newholdings-q1-2025-original-2025-05-15",
    cik: "1067983",
    accession: "0000950123-25-005701",
    note:
      "Second NEW HOLDINGS pair, original. period 2025-03-31. Phase 0 named " +
      "this 'restatement-*'; the /A is in fact amendmentType NEW HOLDINGS.",
  },
  {
    label: "brk-newholdings-q1-2025-amendment-2025-08-14",
    cik: "1067983",
    accession: "0000950123-25-008361",
    note:
      "Second NEW HOLDINGS pair, /A. Adds 4 previously confidential holdings",
  },
];

/** SEC reference data seeded into `companies` and `securities`. */
const REFERENCE_FILES = [
  {
    url: "https://www.sec.gov/files/company_tickers.json",
    file: "company_tickers.json",
    note: "cik -> ticker + name. Seeds `companies`. Contains no CUSIPs.",
  },
  {
    url: "https://www.sec.gov/files/investment/13flist2026q1.txt",
    file: "13flist2026q1.txt",
    note: "Official List of Section 13(f) Securities: cusip -> issuer + class.",
  },
];

interface FilingIndex {
  directory: { item: Array<{ name: string; type: string }> };
}

interface RecentSubmissions {
  filings: {
    recent: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      reportDate: string[];
    };
  };
}

/** accession -> submission metadata that lives outside the filing documents. */
interface SubmissionMeta {
  formType: string;
  filedAt: string;
  periodOfReport: string;
}

const submissionCache = new Map<string, Map<string, SubmissionMeta>>();

/**
 * An accession number and filing date are EDGAR submission metadata: they
 * appear nowhere in primary_doc.xml, so the parser has to be told them. Read
 * them from the filer's submissions feed and record them in the manifest.
 */
async function submissionMeta(
  cik: string,
  accession: string,
): Promise<SubmissionMeta> {
  let byAccession = submissionCache.get(cik);
  if (!byAccession) {
    const padded = cik.replace(/^0+/, "").padStart(10, "0");
    const data = JSON.parse(
      await fetchText(`https://data.sec.gov/submissions/CIK${padded}.json`),
    ) as RecentSubmissions;
    const r = data.filings.recent;
    byAccession = new Map();
    for (let i = 0; i < r.accessionNumber.length; i++) {
      byAccession.set(r.accessionNumber[i], {
        formType: r.form[i],
        filedAt: r.filingDate[i],
        periodOfReport: r.reportDate[i],
      });
    }
    submissionCache.set(cik, byAccession);
  }

  const meta = byAccession.get(accession);
  if (!meta) {
    throw new Error(
      `Accession ${accession} not found in CIK ${cik} submissions feed`,
    );
  }
  return meta;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function accessionDir(cik: string, accession: string): string {
  return `${EDGAR_BASE}/${cik}/${accession.replace(/-/g, "")}`;
}

async function fetchText(url: string): Promise<string> {
  const res = await edgarFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/**
 * Locate the information table in a filing directory. Filings name this file
 * inconsistently, so prefer an explicit "infotable" name and otherwise take
 * the first XML that is not the cover page.
 */
async function findInfoTableUrl(dir: string): Promise<string> {
  const index = JSON.parse(await fetchText(`${dir}/index.json`)) as FilingIndex;
  const items = index.directory.item;

  const named = items.find(
    (f) => f.name.toLowerCase().includes("infotable") && f.name.endsWith(".xml"),
  );
  if (named) return `${dir}/${named.name}`;

  const other = items.find(
    (f) => f.name.endsWith(".xml") && f.name !== "primary_doc.xml",
  );
  if (!other) throw new Error(`No information table found in ${dir}`);
  return `${dir}/${other.name}`;
}

interface ManifestEntry {
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

async function downloadFixture(f: PinnedFixture): Promise<ManifestEntry> {
  const dir = accessionDir(f.cik, f.accession);
  console.log(`${f.label}:`);

  const meta = await submissionMeta(f.cik, f.accession);
  console.log(
    `  · ${meta.formType} filed ${meta.filedAt} period ${meta.periodOfReport}`,
  );

  const coverPath = join(FIXTURE_DIR, `${f.label}.cover.xml`);
  const cover = await fetchText(`${dir}/primary_doc.xml`);
  writeFileSync(coverPath, cover, "utf-8");
  console.log(`  ✓ ${coverPath} (${cover.length} bytes)`);

  // Never re-download an information table we already have: its expected.json
  // was verified against those exact bytes.
  const infoPath = join(FIXTURE_DIR, `${f.label}.xml`);
  if (existsSync(infoPath)) {
    console.log(`  · ${infoPath} (exists, left alone)`);
  } else {
    const infoUrl = await findInfoTableUrl(dir);
    const info = await fetchText(infoUrl);
    writeFileSync(infoPath, info, "utf-8");
    console.log(`  ✓ ${infoPath} (${info.length} bytes)`);
  }

  return {
    label: f.label,
    cik: f.cik,
    accession: f.accession,
    formType: meta.formType,
    filedAt: meta.filedAt,
    periodOfReport: meta.periodOfReport,
    coverPage: `${f.label}.cover.xml`,
    informationTable: `${f.label}.xml`,
    note: f.note,
  };
}

async function main(): Promise<void> {
  ensureDir(FIXTURE_DIR);
  ensureDir(REFERENCE_DIR);

  console.log("--- 13F fixture documents ---\n");
  const manifest: ManifestEntry[] = [];
  for (const f of FIXTURES) {
    manifest.push(await downloadFixture(f));
  }

  manifest.sort((a, b) => a.label.localeCompare(b.label));
  const manifestPath = join(FIXTURE_DIR, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`\n  ✓ ${manifestPath} (${manifest.length} fixtures)`);

  console.log("\n--- SEC reference data ---\n");
  for (const r of REFERENCE_FILES) {
    const body = await fetchText(r.url);
    const path = join(REFERENCE_DIR, r.file);
    writeFileSync(path, body, "utf-8");
    console.log(`  ✓ ${path} (${body.length} bytes) — ${r.note}`);
  }

  console.log("\n✅ 13F fixtures complete.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
