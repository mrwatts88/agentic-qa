import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  committedOnly,
  ExceptionGate,
  HONOUR_ALL,
  uncommittedLines,
} from "../src/rules/exceptions";
import {
  hashFileContents,
  loadLlmLedger,
  runLlmRules,
  saveLlmLedger,
} from "../src/rules/llm";
import { loadConfig } from "../src/config";
import { RULE_JUDGE_VERSION } from "../src/judge";
import type { Rule } from "../src/rules/types";

const RULE = "fe.storage.no-token-in-local-storage";

let dir: string;

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function commit(): void {
  git("add", "-A");
  git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "c");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-exceptions-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("uncommittedLines", () => {
  it("treats every line of an untracked file as uncommitted", () => {
    git("init");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\n");

    expect(uncommittedLines(dir, "a.ts")).toBe("all");
  });

  it("treats every line as uncommitted in a repo with no commits", () => {
    git("init");
    writeFileSync(join(dir, "a.ts"), "one\n");
    git("add", "a.ts");

    expect(uncommittedLines(dir, "a.ts")).toBe("all");
  });

  it("names exactly the lines changed since HEAD, staged or not", () => {
    git("init");
    writeFileSync(join(dir, "a.ts"), "one\ntwo\nthree\nfour\n");
    commit();
    writeFileSync(join(dir, "a.ts"), "one\nTWO\nthree\nfour\nfive\nsix\n");
    git("add", "a.ts");
    writeFileSync(join(dir, "a.ts"), "one\nTWO\nthree\nfour\nfive\nsix\n");

    expect(uncommittedLines(dir, "a.ts")).toEqual(new Set([1, 4, 5]));
  });

  it("reports nothing for a file unchanged since HEAD", () => {
    git("init");
    writeFileSync(join(dir, "a.ts"), "one\n");
    commit();

    expect(uncommittedLines(dir, "a.ts")).toEqual(new Set());
  });
});

describe("committedOnly", () => {
  it("honours an exception that is already committed", () => {
    git("init");
    writeFileSync(join(dir, "a.ts"), `// qa-ignore: ${RULE} - demo\nx;\n`);
    commit();

    expect(committedOnly(dir).honours("a.ts", 0)).toBe(true);
  });

  it("refuses one added in the working tree, even to a committed file", () => {
    git("init");
    writeFileSync(join(dir, "a.ts"), "x;\n");
    commit();
    writeFileSync(join(dir, "a.ts"), `// qa-ignore: ${RULE} - this is test code\nx;\n`);

    expect(committedOnly(dir).honours("a.ts", 0)).toBe(false);
  });

  /** Staging is not approval: an agent can `git add` as easily as edit. */
  it("refuses one that is staged but not committed", () => {
    git("init");
    writeFileSync(join(dir, "a.ts"), "x;\n");
    commit();
    writeFileSync(join(dir, "a.ts"), `// qa-ignore: ${RULE}\nx;\n`);
    git("add", "a.ts");

    expect(committedOnly(dir).honours("a.ts", 0)).toBe(false);
  });

  /** Moving an approved comment onto different code is a new exception. */
  it("refuses a committed comment moved to another line", () => {
    git("init");
    writeFileSync(join(dir, "a.ts"), `// qa-ignore: ${RULE}\na;\nb;\n`);
    commit();
    writeFileSync(join(dir, "a.ts"), `a;\nb;\n// qa-ignore: ${RULE}\n`);

    expect(committedOnly(dir).honours("a.ts", 2)).toBe(false);
  });

  /** Nothing can be committed there, so refusing would remove the hatch. */
  it("honours everything outside a git repository", () => {
    writeFileSync(join(dir, "a.ts"), `// qa-ignore: ${RULE}\n`);

    expect(committedOnly(dir).honours("a.ts", 0)).toBe(true);
  });
});

describe("ExceptionGate", () => {
  const refuseAll = { honours: () => false };

  it("excuses a finding when the policy honours the comment", () => {
    const gate = new ExceptionGate(HONOUR_ALL);

    expect(gate.excusesAt("a.ts", [`x; // qa-ignore: ${RULE}`], 0, RULE)).toBe(true);
    expect(gate.refused()).toEqual([]);
  });

  it("records a refused exception with its 1-based line", () => {
    const gate = new ExceptionGate(refuseAll);

    expect(gate.excusesAt("a.ts", ["y;", `// qa-ignore: ${RULE}`, "x;"], 2, RULE)).toBe(false);
    expect(gate.refused()).toEqual([{ file: "a.ts", line: 2, ruleId: RULE }]);
  });

  it("records nothing when no comment names the rule", () => {
    const gate = new ExceptionGate(refuseAll);

    expect(gate.excusesInFile("a.ts", "x;\n", RULE)).toBe(false);
    expect(gate.refused()).toEqual([]);
  });

  it("lists a comment once however many findings it was offered against", () => {
    const gate = new ExceptionGate(refuseAll);
    const lines = [`// qa-ignore: ${RULE}`, "x;"];

    gate.excusesAt("a.ts", lines, 1, RULE);
    gate.excusesInFile("a.ts", lines.join("\n"), RULE);

    expect(gate.refused()).toHaveLength(1);
  });
});

/**
 * The judgment tier takes the same gate. A cached "violated" verdict stands in
 * for the judge, fresh for the file, the prompt, the judge version and the
 * model, so this never calls a model.
 */
describe("the judgment tier", () => {
  const PROMPT = "Does the handler check that the caller owns the record?";
  const rule: Rule = {
    id: "be.authz.ownership-check",
    statement: "Check ownership.",
    tier: "llm",
    pack: "backend",
    severity: "error",
    rationale: "",
    triggers: { paths: ["**/*.ts"] },
    enforcement: { kind: "llm", prompt: PROMPT },
  };
  const FILE = `// qa-ignore: ${rule.id} - the service checks it\nexport const handler = 1;\n`;

  function seedViolation(): void {
    const ledger = loadLlmLedger(dir);
    ledger.records[[rule.id, "handler.ts"].join(String.fromCharCode(0))] = {
      ruleId: rule.id,
      file: "handler.ts",
      fileHash: hashFileContents(FILE),
      promptHash: createHash("sha256").update(PROMPT).digest("hex").slice(0, 16),
      judgeVersion: RULE_JUDGE_VERSION,
      model: loadConfig(dir).judge.model,
      verdict: "violated",
      reason: "no ownership check",
      checkedAt: new Date().toISOString(),
    };
    saveLlmLedger(dir, ledger);
  }

  it("refuses an uncommitted exception to a judged violation", async () => {
    git("init");
    writeFileSync(join(dir, "handler.ts"), FILE);
    seedViolation();

    const gate = new ExceptionGate(committedOnly(dir));
    const result = await runLlmRules(dir, ["handler.ts"], [rule], loadConfig(dir), false, true, gate);

    expect(result.judged).toBe(0);
    expect(result.findings.map((f) => f.ruleId)).toEqual([rule.id]);
    expect(result.refused).toEqual([{ file: "handler.ts", line: 1, ruleId: rule.id }]);
  });

  it("honours the same exception at commit and in CI", async () => {
    git("init");
    writeFileSync(join(dir, "handler.ts"), FILE);
    seedViolation();

    const result = await runLlmRules(dir, ["handler.ts"], [rule], loadConfig(dir), false, true);

    expect(result.judged).toBe(0);
    expect(result.findings).toEqual([]);
  });
});
