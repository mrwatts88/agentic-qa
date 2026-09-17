import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Rule } from "../src/rules/types";
import { loadRules } from "../src/rules/load";
import { ruleAppliesTo, triggerGlobs, normalise } from "../src/rules/route";
import { runMechanical } from "../src/rules/mechanical";

/** The pattern tier alone, with no engines, so linter output cannot leak in. */
async function patterns(cwd: string, files: string[], rules: Rule[]) {
  return (await runMechanical(cwd, files, rules, { adapters: [] })).findings;
}

let dir: string;

function rule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "test.rule",
    statement: "Do not do the thing.",
    tier: "mechanical",
    pack: "test",
    severity: "error",
    rationale: "because it breaks",
    triggers: { paths: ["**/*.ts"] },
    enforcement: { kind: "pattern", pattern: "forbidden" },
    ...overrides,
  } as Rule;
}

function write(relative: string, contents: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-rules-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the bundled rule corpus", () => {
  it("loads every bundled pack", () => {
    const packs = new Set(loadRules().map((r) => r.pack));

    expect([...packs].sort()).toEqual([
      "backend",
      "data",
      "frontend",
      "security",
      "testing",
    ]);
  });

  /**
   * A mistyped path in rules.paths used to contribute nothing at all and say
   * nothing about it, which is a set of rules everyone believes is protecting
   * them. Strict for the same reason a malformed rule is.
   */
  it("refuses a rules directory that does not exist", () => {
    expect(() => loadRules([join(dir, "typo")])).toThrow(/not found/);
  });

  it("gives every rule an enforcement its tier can actually run", () => {
    const rules = loadRules();
    const mechanical = rules.filter((r) => r.tier === "mechanical");
    const llm = rules.filter((r) => r.tier === "llm");

    expect(mechanical.length).toBeGreaterThan(0);
    expect(llm.length).toBeGreaterThan(0);
    expect(
      mechanical.every((r) => ["pattern", "external"].includes(r.enforcement.kind)),
    ).toBe(true);
    expect(llm.every((r) => r.enforcement.kind === "llm")).toBe(true);
    // No rule may carry a tier the runner does not know how to execute.
    expect(mechanical.length + llm.length).toBe(rules.length);
  });

  it("filters to the requested packs and leaves the rest out", () => {
    const all = loadRules();
    const only = loadRules([], ["testing"]);

    expect(only.length).toBeGreaterThan(0);
    // Something was actually excluded, so a no-op filter would fail here.
    expect(only.length).toBeLessThan(all.length);
    expect(only.every((r) => r.pack === "testing")).toBe(true);
  });

  it("rejects a malformed rule loudly instead of silently dropping it", () => {
    write(
      "extra/bad.yaml",
      "pack: bad\nrules:\n  - id: bad.rule\n    statement: x\n    tier: nonsense\n    severity: error\n    rationale: y\n    triggers:\n      paths: ['**/*']\n    enforcement:\n      kind: pattern\n      pattern: x\n",
    );

    expect(() => loadRules([join(dir, "extra")])).toThrow(/tier must be/);
  });

  /**
   * Regression. Only the main pattern was compiled at load time, so a broken
   * companion pattern loaded cleanly and then threw the first time it met a
   * file it applied to. JavaScript has no inline (?i) group, which is exactly
   * how it happened.
   */
  it("rejects a rule whose companion pattern is not a valid regex", () => {
    write(
      "extra/bad.yaml",
      "pack: bad\nrules:\n  - id: bad.companion\n    statement: x\n    tier: mechanical\n    severity: error\n    rationale: y\n    triggers:\n      paths: ['**/*.ts']\n    enforcement:\n      kind: pattern\n      pattern: forbidden\n      requireFilePattern: '(?i)password'\n",
    );

    expect(() => loadRules([join(dir, "extra")])).toThrow(
      /invalid regex in requireFilePattern/,
    );
  });
});

describe("routing", () => {
  it("applies a rule to a file its trigger glob matches", () => {
    expect(ruleAppliesTo(rule(), "api/handlers.ts")).toBe(true);
  });

  it("does not apply a rule triggered on **/*.ts to a .tf file", () => {
    expect(ruleAppliesTo(rule(), "infra/main.tf")).toBe(false);
  });

  /**
   * This is how a layering rule works: the same construct is a violation in a
   * handler and correct in the repository layer.
   */
  it("lets an exclude glob win over a matching trigger glob", () => {
    const layered = rule({
      triggers: { paths: ["**/*.ts"], excludePaths: ["**/repositories/**"] },
    });

    expect(ruleAppliesTo(layered, "api/handlers.ts")).toBe(true);
    expect(ruleAppliesTo(layered, "api/repositories/userRepo.ts")).toBe(false);
  });

  it("treats windows-style separators the same as posix ones", () => {
    expect(normalise("api\\repositories\\userRepo.ts")).toBe(
      "api/repositories/userRepo.ts",
    );
  });

  it("collects the trigger globs so only relevant paths get walked", () => {
    const globs = triggerGlobs([rule(), rule({ triggers: { paths: ["**/*.tf"] } })]);

    expect(globs).toContain("**/*.ts");
    expect(globs).toContain("**/*.tf");
  });
});

describe("the mechanical runner", () => {
  it("reports a file and line for a matching pattern", async () => {
    write("a.ts", "const ok = 1;\nconst bad = forbidden();\n");

    const [finding] = await patterns(dir, ["a.ts"], [rule()]);

    expect(finding.ruleId).toBe("test.rule");
    expect(finding.file).toBe("a.ts");
    expect(finding.line).toBe(2);
    expect(finding.excerpt).toContain("forbidden");
  });

  /**
   * Regression. A pattern starting with \s{4,} could begin matching on the
   * blank line above, reporting the wrong line and an empty excerpt.
   */
  it("reports the line the match is actually on, not a blank line above it", async () => {
    write("a.ts", "describe(() => {\n  it(() => {\n\n    if (x) {\n    }\n  });\n});\n");

    const indented = rule({
      enforcement: {
        kind: "pattern",
        pattern: "^[ \\t]{4,}(if|for|while)\\s*\\(",
        flags: "m",
      },
    });
    const [finding] = await patterns(dir, ["a.ts"], [indented]);

    expect(finding.line).toBe(4);
    expect(finding.excerpt).toContain("if (x)");
  });

  it("stays silent when the file also contains the exempting pattern", async () => {
    write("a.ts", "const bad = forbidden();\nconst safe = validate(bad);\n");

    const conditional = rule({
      enforcement: {
        kind: "pattern",
        pattern: "forbidden",
        unlessFilePattern: "validate\\(",
      },
    });

    expect(await patterns(dir, ["a.ts"], [conditional])).toEqual([]);
  });

  /**
   * The positive counterpart: some constructs are wrong only in company. A
   * fast hash is right for a cache key and wrong for a password, and the file
   * is the only context a pattern rule has to tell them apart.
   */
  it("stays silent when the required companion pattern is absent", async () => {
    write("a.ts", "const key = forbidden();\n");

    const conditional = rule({
      enforcement: {
        kind: "pattern",
        pattern: "forbidden",
        requireFilePattern: "password",
      },
    });

    expect(await patterns(dir, ["a.ts"], [conditional])).toEqual([]);
  });

  it("fires when the required companion pattern is present", async () => {
    write("a.ts", "const password = input;\nconst key = forbidden();\n");

    const conditional = rule({
      enforcement: {
        kind: "pattern",
        pattern: "forbidden",
        requireFilePattern: "password",
      },
    });

    expect(await patterns(dir, ["a.ts"], [conditional])).toHaveLength(1);
  });

  it("still fires when the exempting pattern is absent", async () => {
    write("a.ts", "const bad = forbidden();\n");

    const conditional = rule({
      enforcement: {
        kind: "pattern",
        pattern: "forbidden",
        unlessFilePattern: "validate\\(",
      },
    });

    expect(await patterns(dir, ["a.ts"], [conditional])).toHaveLength(1);
  });

  it("reports a rule once per file however many times it matches", async () => {
    write("a.ts", "forbidden();\nforbidden();\nforbidden();\n");

    expect(await patterns(dir, ["a.ts"], [rule()])).toHaveLength(1);
  });

  it("skips a file no active rule applies to", async () => {
    write("main.tf", "forbidden\n");

    expect(await patterns(dir, ["main.tf"], [rule()])).toEqual([]);
  });
});

/**
 * Without a sanctioned way to opt out of one rule, the first false positive
 * gets the entire check disabled instead.
 */
describe("the qa-ignore escape hatch", () => {
  it("suppresses the named rule on the same line", async () => {
    write("a.ts", "const bad = forbidden(); // qa-ignore: test.rule - deliberate\n");

    expect(await patterns(dir, ["a.ts"], [rule()])).toEqual([]);
  });

  it("suppresses the named rule when the comment is on the line above", async () => {
    write("a.ts", "// qa-ignore: test.rule - deliberate\nconst bad = forbidden();\n");

    expect(await patterns(dir, ["a.ts"], [rule()])).toEqual([]);
  });

  it("does not suppress a different rule that happens to match the same line", async () => {
    write("a.ts", "const bad = forbidden(); // qa-ignore: some.other.rule\n");

    expect(await patterns(dir, ["a.ts"], [rule()])).toHaveLength(1);
  });
});

/**
 * The testing patterns are kept as regexes because no engine covers them, so
 * they carry the whole burden of telling a branch from `??`, `?.` and an
 * optional parameter, and an assertion loop from a setup loop. Each case is
 * one that a plausible version of the pattern got wrong.
 *
 * The cases live in JSON because these patterns match code inside string
 * literals too, so a table of them written here tripped the very rules it
 * tests.
 */
describe("the bundled test-shape patterns", () => {
  const testing = loadRules([], ["testing"]);
  const cases = JSON.parse(
    readFileSync(join(__dirname, "test-shape-cases.json"), "utf8"),
  ) as Record<string, { name: string; text: string; matches: number }[]>;

  const matches = (id: string, text: string): number => {
    const e = testing.find((r) => r.id === id)!.enforcement as { pattern: string; flags?: string };
    return [...text.matchAll(new RegExp(e.pattern, `${e.flags ?? ""}g`))].length;
  };

  const table = (id: string) => cases[id].map((c) => [c.name, c.text, c.matches] as const);

  it.each(table("test.no-conditional-logic"))(
    "test.no-conditional-logic on %s",
    (_name, text, want) => {
      expect(matches("test.no-conditional-logic", text)).toBe(want);
    },
  );

  it.each(table("test.no-assertion-in-loop"))(
    "test.no-assertion-in-loop on %s",
    (_name, text, want) => {
      expect(matches("test.no-assertion-in-loop", text)).toBe(want);
    },
  );
});
