import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContractRecord, Verdict } from "../src/types";
import { runEval } from "../src/contracts/evaluate";

let dir: string;
let output: string;

function record(id: string, verdict: Verdict): ContractRecord {
  return {
    id,
    file: "a.test.ts",
    description: "does a thing",
    descriptionSource: "title",
    descriptionHash: "aaaa",
    bodyHash: "bbbb",
    verdict,
    reason: "because",
    model: "haiku",
    judgeVersion: 1,
    checkedAt: new Date().toISOString(),
  };
}

/** Write a ledger and an expectations file into the temp repo. */
function seed(
  ledgerVerdicts: Record<string, Verdict>,
  expected: Record<string, Verdict>,
): void {
  const records: Record<string, ContractRecord> = {};
  for (const [id, verdict] of Object.entries(ledgerVerdicts)) {
    records[id] = record(id, verdict);
  }

  mkdirSync(join(dir, ".qa"), { recursive: true });
  writeFileSync(
    join(dir, ".qa/contracts.json"),
    JSON.stringify({ version: 1, records }),
  );
  writeFileSync(join(dir, "expected.json"), JSON.stringify({ expected }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-eval-"));
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("runEval", () => {
  it("passes when every verdict matches the known-correct answer", () => {
    seed(
      { "a.test.ts::one": "upheld", "a.test.ts::two": "violated" },
      { "a.test.ts::one": "upheld", "a.test.ts::two": "violated" },
    );

    expect(runEval(dir, "expected.json")).toBe(true);
    expect(output).toContain("2/2 match");
  });

  it("fails when the judge disagrees with the known-correct answer", () => {
    seed({ "a.test.ts::one": "violated" }, { "a.test.ts::one": "upheld" });

    expect(runEval(dir, "expected.json")).toBe(false);
  });

  /**
   * Condemning a good test is the error that gets the whole system switched
   * off, so it has to be counted and called out separately from a miss.
   */
  it("reports a condemned good test as a false positive", () => {
    seed({ "a.test.ts::one": "violated" }, { "a.test.ts::one": "upheld" });

    runEval(dir, "expected.json");

    expect(output).toContain("1 false positive(s)");
    expect(output).toContain("0 false negative(s)");
  });

  it("reports a weak test that was waved through as a false negative", () => {
    seed({ "a.test.ts::one": "upheld" }, { "a.test.ts::one": "violated" });

    runEval(dir, "expected.json");

    expect(output).toContain("0 false positive(s)");
    expect(output).toContain("1 false negative(s)");
  });

  it("counts an expected test that the ledger has no verdict for as a mismatch", () => {
    seed({}, { "a.test.ts::missing": "upheld" });

    expect(runEval(dir, "expected.json")).toBe(false);
    expect(output).toContain("MISSING");
  });

  it("fails rather than reporting a clean score when there is no expectations file", () => {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(
      join(dir, ".qa/contracts.json"),
      JSON.stringify({ version: 1, records: {} }),
    );

    expect(runEval(dir, "expected.json")).toBe(false);
  });
});
