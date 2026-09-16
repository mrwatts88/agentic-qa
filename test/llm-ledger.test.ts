import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  needsRuleJudging,
  pruneMissing,
  loadLlmLedger,
  saveLlmLedger,
  LLM_LEDGER_PATH,
  type LlmLedger,
  type LlmRuleRecord,
} from "../src/rules/llm";
import { RULE_JUDGE_VERSION } from "../src/judge";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-llm-ledger-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CURRENT = { fileHash: "aaa", promptHash: "bbb", model: "haiku" };

function record(over: Partial<LlmRuleRecord> = {}): LlmRuleRecord {
  return {
    ruleId: "be.authz.ownership-check",
    file: "src/service.ts",
    fileHash: CURRENT.fileHash,
    promptHash: CURRENT.promptHash,
    judgeVersion: RULE_JUDGE_VERSION,
    model: CURRENT.model,
    verdict: "ok",
    reason: "scoped by account id",
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("needsRuleJudging", () => {
  it("judges a file it has never seen", () => {
    expect(needsRuleJudging(undefined, CURRENT)).toBe(true);
  });

  it("costs nothing when nothing that bears on the verdict changed", () => {
    expect(needsRuleJudging(record(), CURRENT)).toBe(false);
  });

  it("re-judges when the file changed", () => {
    expect(needsRuleJudging(record({ fileHash: "old" }), CURRENT)).toBe(true);
  });

  /** One rule's question changing must not invalidate every other rule. */
  it("re-judges when this rule's own question changed", () => {
    expect(needsRuleJudging(record({ promptHash: "old" }), CURRENT)).toBe(true);
  });

  it("re-judges when the model changed", () => {
    expect(needsRuleJudging(record(), { ...CURRENT, model: "sonnet" })).toBe(true);
  });

  /**
   * The regression this file exists for. The per-rule promptHash covers only
   * the rule's own question, so a change to the judge's shared system prompt or
   * schema was invisible: bumping the version left every cached verdict looking
   * fresh, which is the exact failure bumping a version is meant to prevent.
   */
  it("re-judges when the shared judge prompt or schema changed", () => {
    const stale = record({ judgeVersion: RULE_JUDGE_VERSION - 1 });

    expect(needsRuleJudging(stale, CURRENT)).toBe(true);
  });
});

describe("pruneMissing", () => {
  it("drops verdicts about files that no longer exist", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/kept.ts"), "export const a = 1;\n");

    const ledger: LlmLedger = {
      version: 1,
      records: {
        "r1 src/kept.ts": record({ file: "src/kept.ts" }),
        "r1 src/deleted.ts": record({ file: "src/deleted.ts" }),
      },
    };

    const removed = pruneMissing(dir, ledger);

    expect(removed).toBe(1);
    expect(Object.keys(ledger.records)).toEqual(["r1 src/kept.ts"]);
  });

  it("removes nothing when every file is still there", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/kept.ts"), "export const a = 1;\n");

    const ledger: LlmLedger = {
      version: 1,
      records: { "r1 src/kept.ts": record({ file: "src/kept.ts" }) },
    };

    expect(pruneMissing(dir, ledger)).toBe(0);
  });
});

describe("the ledger file", () => {
  it("survives a round trip", () => {
    const ledger: LlmLedger = { version: 1, records: { "r1 a.ts": record({ file: "a.ts" }) } };

    saveLlmLedger(dir, ledger);

    expect(loadLlmLedger(dir).records["r1 a.ts"].judgeVersion).toBe(RULE_JUDGE_VERSION);
  });

  it("sorts keys, so the committed diff is reviewable", () => {
    saveLlmLedger(dir, {
      version: 1,
      records: {
        "r2 b.ts": record({ file: "b.ts" }),
        "r1 a.ts": record({ file: "a.ts" }),
      },
    });

    const text = readFileSync(join(dir, LLM_LEDGER_PATH), "utf8");

    expect(text.indexOf("r1 a.ts")).toBeLessThan(text.indexOf("r2 b.ts"));
  });

  /** A cache that cannot be parsed is rebuilt, never treated as truth. */
  it("rebuilds rather than throwing when the file is corrupt", () => {
    mkdirSync(join(dir, ".qa"), { recursive: true });
    writeFileSync(join(dir, LLM_LEDGER_PATH), "{ not json");

    expect(loadLlmLedger(dir).records).toEqual({});
  });
});
