import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const FIXTURES_DIR = join(__dirname, "..", "fixtures");

function listFixtures(subdir: string): string[] {
  const dir = join(FIXTURES_DIR, subdir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".xml"))
    .map((f) => join(dir, f));
}

describe("13F fixtures", () => {
  const files = listFixtures("13f");

  it("has at least 9 fixture files", () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  it.each(files.map((f) => [f.split(/[/\\]/).pop(), f]))(
    "%s is non-empty valid XML",
    (_name, filePath) => {
      const content = readFileSync(filePath as string, "utf-8");
      expect(content.length).toBeGreaterThan(100);
      expect(content).toMatch(/<informationTable/i);
    },
  );

  it("has an expected.json stub for each XML", () => {
    for (const xmlPath of files) {
      const jsonPath = xmlPath.replace(".xml", ".expected.json");
      expect(existsSync(jsonPath), `Missing ${jsonPath}`).toBe(true);
    }
  });
});

describe("Form 4 fixtures", () => {
  const files = listFixtures("form4");

  it("has at least 20 fixture files", () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files.map((f) => [f.split(/[/\\]/).pop(), f]))(
    "%s is non-empty valid XML",
    (_name, filePath) => {
      const content = readFileSync(filePath as string, "utf-8");
      expect(content.length).toBeGreaterThan(100);
      expect(content).toMatch(/<ownershipDocument/i);
    },
  );

  it("has an expected.json stub for each XML", () => {
    for (const xmlPath of files) {
      const jsonPath = xmlPath.replace(".xml", ".expected.json");
      expect(existsSync(jsonPath), `Missing ${jsonPath}`).toBe(true);
    }
  });

  it("covers transaction codes P, S, M, A, G", () => {
    const allContent = files
      .map((f) => readFileSync(f, "utf-8"))
      .join("\n");
    for (const code of ["P", "S", "M", "A", "G"]) {
      expect(
        allContent.includes(`transactionCode>${code}`),
        `Missing transaction code ${code}`,
      ).toBe(true);
    }
  });

  it("has at least one filing with a derivative table", () => {
    const hasDerivative = files.some((f) =>
      readFileSync(f, "utf-8").includes("derivativeTransaction"),
    );
    expect(hasDerivative).toBe(true);
  });

  it("has at least one filing with the 10b5-1 flag", () => {
    const has10b5 = files.some((f) => {
      const content = readFileSync(f, "utf-8");
      return content.includes("aff10b5") || content.includes("Rule10b5");
    });
    expect(has10b5).toBe(true);
  });

  it("has at least one filing by an entity (10% owner fund)", () => {
    const hasEntityOwner = files.some((f) => {
      const content = readFileSync(f, "utf-8");
      return (
        (content.includes("isTenPercentOwner>1") ||
          content.includes("isTenPercentOwner>true")) &&
        (content.includes("Pershing Square Capital") ||
          content.includes("LLC") ||
          content.includes("L.P."))
      );
    });
    expect(hasEntityOwner).toBe(true);
  });
});
