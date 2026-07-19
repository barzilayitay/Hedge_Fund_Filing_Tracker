/**
 * Resolve and pin the Form 4 fixture documents used by Phase 3, and write
 * fixtures/form4/manifest.json with the REAL EDGAR accession numbers.
 * Run via: npm run fixtures:form4
 *
 * Replaces the Phase 0 scripts/fetch-fixtures.ts (deleted), whose Form 4 half
 * rolled its own rate limiter (violating hard rule 1) and recorded no
 * accessions. The 29 Form 4 fixture XML documents were already fetched in
 * Phase 0 and their expected.json values verified against those exact bytes, so
 * this script NEVER overwrites an existing .xml. It only discovers, for each
 * on-disk fixture, the accession it came from and records it in the manifest —
 * "re-pinning" the set.
 *
 * Discovery is deterministic: for each fixture it reads the issuer CIK and
 * periodOfReport from the XML and the filing date from the filename, queries
 * the issuer's submissions feed for a form-4 filing matching (filingDate,
 * reportDate), and — when a filer made several the same day — byte-verifies the
 * candidate's ownership document against the on-disk fixture.
 *
 * All EDGAR access goes through lib/edgar/client.ts (hard rule 1). A real
 * EDGAR_USER_AGENT with contact email is required; the script loads .env if
 * present and refuses to run with a placeholder (never sends a fake contact
 * email to sec.gov).
 *
 * Network required. Never run from tests.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { edgarFetch } from "../lib/edgar/client";
import { parseForm4 } from "../lib/edgar/parseForm4";

const FIXTURE_DIR = join("fixtures", "form4");
const EDGAR_BASE = "https://www.sec.gov/Archives/edgar/data";

/** Minimal .env loader: populate process.env for keys it does not already set. */
function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf-8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function requireUserAgent(): void {
  loadDotEnv();
  const ua = process.env.EDGAR_USER_AGENT;
  if (!ua || /your-email@example\.com/.test(ua)) {
    throw new Error(
      "EDGAR_USER_AGENT (with a real contact email) is required. Set it in " +
        ".env or the environment; a placeholder must not be sent to sec.gov.",
    );
  }
}

interface RecentSubmissions {
  filings: {
    recent: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      reportDate: string[];
      primaryDocument: string[];
    };
  };
}

interface FilingIndex {
  directory: { item: Array<{ name: string; type: string }> };
}

const feedCache = new Map<string, RecentSubmissions>();

async function fetchText(url: string): Promise<string> {
  const res = await edgarFetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function submissionsFeed(issuerCik: string): Promise<RecentSubmissions> {
  const padded = issuerCik.replace(/^0+/, "").padStart(10, "0");
  const cached = feedCache.get(padded);
  if (cached) return cached;
  const data = JSON.parse(
    await fetchText(`https://data.sec.gov/submissions/CIK${padded}.json`),
  ) as RecentSubmissions;
  feedCache.set(padded, data);
  return data;
}

function accessionDir(issuerCik: string, accession: string): string {
  const num = issuerCik.replace(/^0+/, "");
  return `${EDGAR_BASE}/${num}/${accession.replace(/-/g, "")}`;
}

/** Locate the ownership XML in a filing directory (not the xslF345 rendering). */
async function ownershipXmlUrl(dir: string): Promise<string | null> {
  const index = JSON.parse(await fetchText(`${dir}/index.json`)) as FilingIndex;
  const xmls = index.directory.item.filter(
    (f) => f.name.endsWith(".xml") && !f.name.startsWith("xslF"),
  );
  for (const f of xmls) {
    const body = await fetchText(`${dir}/${f.name}`);
    if (body.includes("<ownershipDocument")) return `${dir}/${f.name}`;
  }
  return null;
}

const normalize = (s: string): string => s.replace(/\s+/g, " ").trim();

interface ManifestEntry {
  label: string;
  issuerCik: string;
  accession: string;
  formType: string;
  filedAt: string;
  periodOfReport: string;
  ownerCiks: string[];
  note: string;
}

async function resolve(label: string): Promise<ManifestEntry> {
  const xml = readFileSync(join(FIXTURE_DIR, `${label}.xml`), "utf-8");
  const filedAt = label.match(/(\d{4}-\d{2}-\d{2})$/)?.[1];
  if (!filedAt) throw new Error(`Cannot derive filedAt from "${label}"`);

  // Parse for issuer + owners + period (accession is a throwaway here).
  const parsed = parseForm4(xml, { accessionNo: "0000000000-00-000000", filedAt });
  const issuerCik = parsed.issuer.cik;
  const period = parsed.filing.periodOfReport;

  const feed = (await submissionsFeed(issuerCik)).filings.recent;
  const candidates: string[] = [];
  for (let i = 0; i < feed.accessionNumber.length; i++) {
    if (
      feed.form[i].startsWith("4") &&
      feed.filingDate[i] === filedAt &&
      feed.reportDate[i] === period
    ) {
      candidates.push(feed.accessionNumber[i]);
    }
  }
  if (candidates.length === 0) {
    throw new Error(`${label}: no form-4 in ${issuerCik} feed for ${filedAt}/${period}`);
  }

  let accession = candidates[0];
  if (candidates.length > 1) {
    // Disambiguate by byte-verifying the ownership document.
    accession = "";
    for (const cand of candidates) {
      const url = await ownershipXmlUrl(accessionDir(issuerCik, cand));
      if (url && normalize(await fetchText(url)) === normalize(xml)) {
        accession = cand;
        break;
      }
    }
    if (!accession) {
      throw new Error(`${label}: ${candidates.length} candidates, none byte-matched`);
    }
  }

  const formType = candidates.includes(accession)
    ? feed.form[feed.accessionNumber.indexOf(accession)]
    : "4";

  console.log(`  ✓ ${label} → ${accession} (${formType}, ${filedAt}/${period})`);
  return {
    label,
    issuerCik,
    accession,
    formType,
    filedAt,
    periodOfReport: period,
    ownerCiks: parsed.owners.map((o) => o.cik),
    note: `${parsed.issuer.name} Form 4 (${parsed.owners.length} owner(s))`,
  };
}

async function main(): Promise<void> {
  requireUserAgent();

  const labels = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".xml"))
    .map((f) => f.replace(/\.xml$/, ""))
    .sort();

  console.log(`--- Re-pinning ${labels.length} Form 4 fixtures ---\n`);
  const manifest: ManifestEntry[] = [];
  for (const label of labels) {
    manifest.push(await resolve(label));
  }

  const path = join(FIXTURE_DIR, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`\n  ✓ ${path} (${manifest.length} entries, real accessions)`);
  console.log("\n✅ Form 4 fixtures re-pinned.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
