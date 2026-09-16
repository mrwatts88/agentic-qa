import { describe, it, expect } from "vitest";
import type { ContractRecord, ExtractedTest, Ledger } from "../src/types";
import {
  bodyHash,
  descriptionHash,
  needsJudging,
  prune,
} from "../src/contracts/ledger";
import { JUDGE_VERSION } from "../src/judge";

function test(overrides: Partial<ExtractedTest> = {}): ExtractedTest {
  return {
    id: "a.test.ts::suite > does a thing",
    file: "a.test.ts",
    describePath: ["suite"],
    title: "does a thing",
    description: "does a thing",
    descriptionSource: "title",
    body: "expect(result.ok).toBe(true);",
    line: 1,
    ...overrides,
  };
}

function ledgerFor(t: ExtractedTest, overrides: Partial<ContractRecord> = {}): Ledger {
  const record: ContractRecord = {
    id: t.id,
    file: t.file,
    description: t.description,
    descriptionSource: t.descriptionSource,
    descriptionHash: descriptionHash(t),
    bodyHash: bodyHash(t),
    verdict: "upheld",
    reason: "because",
    model: "haiku",
    judgeVersion: JUDGE_VERSION,
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
  return { version: 1, records: { [t.id]: record } };
}

describe("hashing", () => {
  it("ignores whitespace so reformatting a test does not trigger a re-judge", () => {
    const original = test({ body: "expect(a).toBe(1);" });
    const reformatted = test({ body: "  expect(a).toBe(1);\n\n" });

    expect(bodyHash(original)).toBe(bodyHash(reformatted));
  });

  it("changes when the meaning of the body changes", () => {
    const original = test({ body: "expect(a).toBe(1);" });
    const changed = test({ body: "expect(a).toBe(2);" });

    expect(bodyHash(original)).not.toBe(bodyHash(changed));
  });

  it("changes when the description changes", () => {
    expect(descriptionHash(test({ description: "one" }))).not.toBe(
      descriptionHash(test({ description: "two" })),
    );
  });
});

describe("needsJudging", () => {
  it("judges a test that has never been seen before", () => {
    const t = test();

    expect(needsJudging(t, { version: 1, records: {} }, "haiku")).toBe(true);
  });

  it("skips a test whose description, body, model and judge are all unchanged", () => {
    const t = test();

    expect(needsJudging(t, ledgerFor(t), "haiku")).toBe(false);
  });

  it("re-judges when the test body changed", () => {
    const t = test();
    const ledger = ledgerFor(t);
    const edited = test({ body: "expect(a).toBe(999);" });

    expect(needsJudging(edited, ledger, "haiku")).toBe(true);
  });

  it("re-judges when the description changed but the body did not", () => {
    const t = test();
    const ledger = ledgerFor(t);
    const reworded = test({ description: "does a completely different thing" });

    expect(needsJudging(reworded, ledger, "haiku")).toBe(true);
  });

  /**
   * A cached verdict is only meaningful relative to the prompt that produced
   * it, so bumping JUDGE_VERSION has to invalidate every stored verdict.
   */
  it("re-judges everything when the judge version moved on", () => {
    const t = test();
    const stale = ledgerFor(t, { judgeVersion: JUDGE_VERSION - 1 });

    expect(needsJudging(t, stale, "haiku")).toBe(true);
  });

  it("re-judges when a different model is asked for", () => {
    const t = test();

    expect(needsJudging(t, ledgerFor(t), "sonnet")).toBe(true);
  });
});

describe("prune", () => {
  it("drops records for tests that no longer exist and reports how many went", () => {
    const t = test();
    const ledger = ledgerFor(t);
    ledger.records["a.test.ts::suite > deleted test"] = {
      ...ledger.records[t.id],
      id: "a.test.ts::suite > deleted test",
    };

    const removed = prune(ledger, new Set([t.id]));

    expect(removed).toBe(1);
    expect(Object.keys(ledger.records)).toEqual([t.id]);
  });

  it("keeps every record when all of them are still live", () => {
    const t = test();
    const ledger = ledgerFor(t);

    expect(prune(ledger, new Set([t.id]))).toBe(0);
    expect(Object.keys(ledger.records)).toHaveLength(1);
  });
});
