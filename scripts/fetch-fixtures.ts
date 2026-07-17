/**
 * Download EDGAR fixtures for testing.
 * Run via: npm run fixtures
 *
 * Downloads 13F and Form 4 filings, saves XML + expected.json stubs.
 * Requires EDGAR_USER_AGENT env var.
 */
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const EDGAR_BASE = "https://www.sec.gov/Archives/edgar/data";
const SUBMISSIONS_BASE = "https://data.sec.gov/submissions";

const USER_AGENT =
  process.env.EDGAR_USER_AGENT ??
  "HedgeFundFilingTracker your-email@example.com";

const RATE_LIMIT_MS = 125; // 8 req/s

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let lastRequest = 0;
async function fetchEdgar(url: string): Promise<Response> {
  const now = Date.now();
  const wait = RATE_LIMIT_MS - (now - lastRequest);
  if (wait > 0) await sleep(wait);
  lastRequest = Date.now();

  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Encoding": "gzip, deflate",
    },
  });

  if (res.status === 429 || res.status === 403) {
    console.warn(`Rate limited (${res.status}), backing off 10s...`);
    await sleep(10_000);
    return fetchEdgar(url);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function writeFixture(dir: string, name: string, content: string): void {
  ensureDir(dir);
  const xmlPath = join(dir, `${name}.xml`);
  writeFileSync(xmlPath, content, "utf-8");
  console.log(`  ✓ ${xmlPath}`);

  const expectedPath = join(dir, `${name}.expected.json`);
  if (!existsSync(expectedPath)) {
    writeFileSync(
      expectedPath,
      JSON.stringify({ _stub: true, _note: "Fill in Phase 1/3" }, null, 2),
      "utf-8",
    );
  }
}

interface FilingIndex {
  directory: { item: Array<{ name: string; type: string }> };
}

async function getInfoTableUrl(
  accessionDir: string,
): Promise<string | null> {
  const indexUrl = `${accessionDir}/index.json`;
  const res = await fetchEdgar(indexUrl);
  const data = (await res.json()) as FilingIndex;
  const items = data.directory.item;

  const infoTable = items.find(
    (f) =>
      f.name.toLowerCase().includes("infotable") &&
      f.name.endsWith(".xml"),
  );
  if (infoTable) return `${accessionDir}/${infoTable.name}`;

  const xmlFiles = items.filter(
    (f) => f.name.endsWith(".xml") && f.name !== "primary_doc.xml",
  );
  for (const xmlFile of xmlFiles) {
    return `${accessionDir}/${xmlFile.name}`;
  }
  return null;
}

async function download13F(
  cik: string,
  accessionNo: string,
  label: string,
): Promise<void> {
  const accessionDir = `${EDGAR_BASE}/${cik}/${accessionNo.replace(/-/g, "")}`;
  const infoTableUrl = await getInfoTableUrl(accessionDir);
  if (!infoTableUrl) {
    console.error(`  ✗ Could not find infotable for ${label}`);
    return;
  }
  const res = await fetchEdgar(infoTableUrl);
  const xml = await res.text();
  writeFixture("fixtures/13f", label, xml);
}

async function downloadForm4(
  cik: string,
  accessionNo: string,
  label: string,
): Promise<void> {
  const accessionDir = `${EDGAR_BASE}/${cik}/${accessionNo.replace(/-/g, "")}`;
  const indexUrl = `${accessionDir}/index.json`;
  const res = await fetchEdgar(indexUrl);
  const data = (await res.json()) as FilingIndex;
  const items = data.directory.item;

  const primaryXml = items.find(
    (f) =>
      f.name.endsWith(".xml") &&
      !f.name.includes("R") &&
      f.type === "text/xml",
  );

  const xmlFile = primaryXml ?? items.find((f) => f.name.endsWith(".xml"));
  if (!xmlFile) {
    console.error(`  ✗ Could not find Form 4 XML for ${label}`);
    return;
  }

  const xmlRes = await fetchEdgar(`${accessionDir}/${xmlFile.name}`);
  const xml = await xmlRes.text();
  writeFixture("fixtures/form4", label, xml);
}

interface RecentSubmissions {
  filings: {
    recent: {
      accessionNumber: string[];
      form: string[];
      filingDate: string[];
      primaryDocument: string[];
    };
  };
}

async function getRecentFilings(
  cik: string,
  formType: string,
  count: number,
): Promise<Array<{ accession: string; date: string }>> {
  const paddedCik = cik.replace(/^0+/, "").padStart(10, "0");
  const url = `${SUBMISSIONS_BASE}/CIK${paddedCik}.json`;
  const res = await fetchEdgar(url);
  const data = (await res.json()) as RecentSubmissions;
  const recent = data.filings.recent;
  const results: Array<{ accession: string; date: string }> = [];

  for (let i = 0; i < recent.form.length && results.length < count; i++) {
    if (recent.form[i] === formType) {
      results.push({
        accession: recent.accessionNumber[i],
        date: recent.filingDate[i],
      });
    }
  }
  return results;
}

async function main(): Promise<void> {
  console.log("Fetching EDGAR fixtures...\n");

  // === 13F Fixtures ===
  console.log("--- 13F Fixtures ---");

  // Berkshire Hathaway (CIK 0001067983) — two consecutive quarters
  console.log("\nBerkshire Hathaway (two consecutive quarters):");
  const brkFilings = await getRecentFilings("0001067983", "13F-HR", 2);
  for (let i = 0; i < brkFilings.length; i++) {
    await download13F(
      "1067983",
      brkFilings[i].accession,
      `brk-${brkFilings[i].date}`,
    );
  }

  // Pershing Square (CIK 0001336528) — one quarter
  console.log("\nPershing Square (one quarter):");
  const pshFilings = await getRecentFilings("0001336528", "13F-HR", 1);
  if (pshFilings.length > 0) {
    await download13F("1336528", pshFilings[0].accession, `psh-${pshFilings[0].date}`);
  }

  // Small filer (<50 positions): Appaloosa Management (CIK 0001656456)
  console.log("\nAppaloosa Management (small filer):");
  const smallFilings = await getRecentFilings("0001656456", "13F-HR", 1);
  if (smallFilings.length > 0) {
    await download13F("1656456", smallFilings[0].accession, `appaloosa-${smallFilings[0].date}`);
  }

  // 13F-HR/A RESTATEMENT pair: BRK period 2025-03-31
  console.log("\n13F-HR/A RESTATEMENT pair (BRK Q1 2025):");
  await download13F(
    "1067983",
    "0000950123-25-005701",
    "brk-restatement-original-2025-05-15",
  );
  await download13F(
    "1067983",
    "0000950123-25-008361",
    "brk-restatement-amendment-2025-08-14",
  );

  // 13F-HR/A NEW HOLDINGS pair: BRK period 2023-12-31
  console.log("\n13F-HR/A NEW HOLDINGS pair (BRK Q4 2023):");
  await download13F(
    "1067983",
    "0000950123-24-002518",
    "brk-newholdings-original-2024-02-14",
  );
  await download13F(
    "1067983",
    "0000950123-24-005664",
    "brk-newholdings-amendment-2024-05-15",
  );

  // Pre-2023 filing (thousands-unit test case) — Berkshire Q3 2022
  // Period 2022-09-30, filed 2022-11-14
  console.log("\nPre-2023 filing (thousands unit):");
  await download13F(
    "1067983",
    "0000950123-22-012275",
    "brk-pre2023-2022-11-14",
  );

  // === Form 4 Fixtures ===
  console.log("\n--- Form 4 Fixtures ---");

  // We'll pull Form 4s from several well-known filers to cover
  // codes P, S, M, A, G; derivative tables; 10b5-1; entity filer

  // Apple insiders for variety of transaction codes
  console.log("\nApple insiders (CIK 320193):");
  const appleForm4s = await getRecentFilings("0000320193", "4", 8);
  for (let i = 0; i < appleForm4s.length; i++) {
    await downloadForm4(
      "320193",
      appleForm4s[i].accession,
      `aapl-insider-${i + 1}-${appleForm4s[i].date}`,
    );
  }

  // Tesla insiders (good for variety + Elon's large trades)
  console.log("\nTesla insiders (CIK 1318605):");
  const tslaForm4s = await getRecentFilings("0001318605", "4", 6);
  for (let i = 0; i < tslaForm4s.length; i++) {
    await downloadForm4(
      "1318605",
      tslaForm4s[i].accession,
      `tsla-insider-${i + 1}-${tslaForm4s[i].date}`,
    );
  }

  // JPMorgan (for 10% owner / entity filer Form 4s)
  console.log("\nJPMorgan insiders (CIK 19617):");
  const jpmForm4s = await getRecentFilings("0000019617", "4", 4);
  for (let i = 0; i < jpmForm4s.length; i++) {
    await downloadForm4(
      "19617",
      jpmForm4s[i].accession,
      `jpm-insider-${i + 1}-${jpmForm4s[i].date}`,
    );
  }

  // Microsoft (for derivative tables, 10b5-1 plans)
  console.log("\nMicrosoft insiders (CIK 789019):");
  const msftForm4s = await getRecentFilings("0000789019", "4", 4);
  for (let i = 0; i < msftForm4s.length; i++) {
    await downloadForm4(
      "789019",
      msftForm4s[i].accession,
      `msft-insider-${i + 1}-${msftForm4s[i].date}`,
    );
  }

  // Icahn Enterprises — 10% owner entity filer, purchase transactions
  console.log("\nIcahn Enterprises (CIK 813762, entity/10% owner):");
  const icahnForm4s = await getRecentFilings("0000813762", "4", 4);
  for (let i = 0; i < icahnForm4s.length; i++) {
    await downloadForm4(
      "813762",
      icahnForm4s[i].accession,
      `icahn-entity-${i + 1}-${icahnForm4s[i].date}`,
    );
  }

  console.log("\n✅ Fixtures download complete.");
  console.log(
    "Review the downloaded files to confirm they are valid XML.\n",
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
