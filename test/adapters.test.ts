import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Rule } from "../src/rules/types";
import type { Adapter, ToolFinding, ToolRun } from "../src/rules/adapters/types";
import { loadRules } from "../src/rules/load";
import { runMechanical } from "../src/rules/mechanical";
import { ruleAppliesTo } from "../src/rules/route";
import { eslint } from "../src/rules/adapters/eslint";

let dir: string;

function write(relative: string, contents: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function external(overrides: Partial<Rule> = {}): Rule {
  return {
    id: "test.external",
    statement: "Do not do the thing.",
    tier: "mechanical",
    pack: "test",
    severity: "error",
    rationale: "because it breaks",
    triggers: { paths: ["**/*.ts"] },
    enforcement: { kind: "external", tool: "fake", rule: "no-thing" },
    ...overrides,
  } as Rule;
}

/** A tool that reports exactly what it is told to, and runs what it is told is live. */
function fake(
  findings: ToolFinding[],
  options: { run?: ToolRun; live?: boolean } = {},
): Adapter {
  return {
    tool: "fake",
    handles: (file) => file.endsWith(".ts"),
    run: async () => options.run ?? { status: "ran", findings },
    isLive: async () => options.live ?? true,
  };
}

const HIT = { rule: "no-thing", file: "a.ts", line: 1, message: "the tool says no" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-adapters-"));
  write("a.ts", "thing();\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the mechanical conductor", () => {
  it("blocks on a tool finding the corpus claims, with the corpus rule's own id and severity", async () => {
    const { findings } = await runMechanical(dir, ["a.ts"], [external()], {
      adapters: [fake([HIT])],
      ci: false,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "test.external",
        origin: "corpus",
        severity: "error",
        line: 1,
        excerpt: "thing();",
      }),
    ]);
  });

  /**
   * Filtering tool output down to the corpus would throw away thousands of
   * rules to keep a couple of dozen. Everything else is kept, and never blocks.
   */
  it("keeps an unclaimed tool finding as a gauntlet warning named after the tool", async () => {
    const { findings } = await runMechanical(dir, ["a.ts"], [], {
      adapters: [fake([HIT])],
      ci: false,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleId: "fake:no-thing",
        origin: "gauntlet",
        severity: "warn",
        statement: "the tool says no",
      }),
    ]);
  });

  /**
   * excludePaths is how a layering rule is expressed at all. A path the corpus
   * exempts is not a promise broken, so it must not block; the tool still
   * thinks something is wrong, so it stays visible as a warning.
   */
  it("demotes a claimed finding to a warning in a path the corpus rule excludes", async () => {
    const rule = external({ triggers: { paths: ["**/*.ts"], excludePaths: ["a.ts"] } });

    const { findings } = await runMechanical(dir, ["a.ts"], [rule], {
      adapters: [fake([HIT])],
      ci: false,
    });

    expect(findings.map((f) => [f.ruleId, f.origin])).toEqual([["fake:no-thing", "gauntlet"]]);
  });

  it("honours qa-ignore on a claimed finding by the corpus rule id", async () => {
    write("a.ts", "// qa-ignore: test.external - deliberate\nthing();\n");

    const { findings } = await runMechanical(dir, ["a.ts"], [external()], {
      adapters: [fake([{ ...HIT, line: 2 }])],
      ci: false,
    });

    expect(findings).toEqual([]);
  });

  /** One escape hatch for every engine, rather than one dialect per tool. */
  it("honours qa-ignore on a gauntlet finding by its tool-qualified id", async () => {
    write("a.ts", "thing(); // qa-ignore: fake:no-thing - deliberate\n");

    const { findings } = await runMechanical(dir, ["a.ts"], [], {
      adapters: [fake([HIT])],
      ci: false,
    });

    expect(findings).toEqual([]);
  });

  it("fails open locally when a tool cannot run, naming the rules left unenforced", async () => {
    const result = await runMechanical(dir, ["a.ts"], [external()], {
      adapters: [fake([], { run: { status: "unavailable", reason: "not installed" } })],
      ci: false,
    });

    expect(result.findings).toEqual([]);
    expect(result.unenforced).toEqual([
      { tool: "fake", reason: "not installed", rules: ["test.external"] },
    ]);
  });

  it("fails closed in CI when a tool cannot run", async () => {
    await expect(
      runMechanical(dir, ["a.ts"], [external()], {
        adapters: [fake([], { run: { status: "unavailable", reason: "not installed" } })],
        ci: true,
      }),
    ).rejects.toThrow(/required in CI.*test\.external/);
  });

  /**
   * The failure this design exists to prevent: a plugin is dropped, the rule
   * produces no findings, and no findings looks exactly like clean code.
   */
  it("refuses to run when a claimed rule is switched off, even outside CI", async () => {
    await expect(
      runMechanical(dir, ["a.ts"], [external()], {
        adapters: [fake([], { live: false })],
        ci: false,
      }),
    ).rejects.toThrow(/not running: test\.external \(fake no-thing/);
  });

  it("does not ask a tool about files it does not handle", async () => {
    write("main.tf", "thing\n");
    let ran = false;
    const adapter = { ...fake([]), run: async () => ((ran = true), { status: "ran" as const, findings: [] }) };

    await runMechanical(dir, ["main.tf"], [], { adapters: [adapter], ci: false });

    expect(ran).toBe(false);
  });
});

describe("loading external rules", () => {
  function pack(enforcement: string, tier = "mechanical", id = "bad.rule"): string {
    return `pack: bad\nrules:\n  - id: ${id}\n    statement: x\n    tier: ${tier}\n    severity: error\n    rationale: y\n    triggers:\n      paths: ['**/*.ts']\n    enforcement:\n${enforcement}`;
  }

  it("rejects a tool nothing knows how to run", () => {
    write("extra/bad.yaml", pack("      kind: external\n      tool: nonsense\n      rule: x\n"));

    expect(() => loadRules([join(dir, "extra")])).toThrow(/unknown tool 'nonsense'/);
  });

  it("rejects an external rule filed under the judgment tier", () => {
    write("extra/bad.yaml", pack("      kind: external\n      tool: eslint\n      rule: x\n", "llm"));

    expect(() => loadRules([join(dir, "extra")])).toThrow(/belongs to the mechanical tier/);
  });

  it("rejects a second rule claiming a tool rule the corpus already claims", () => {
    write(
      "extra/dup.yaml",
      pack("      kind: external\n      tool: eslint\n      rule: sonarjs/insecure-jwt-token\n", "mechanical", "local.jwt"),
    );

    expect(() => loadRules([join(dir, "extra")])).toThrow(/both claim eslint:sonarjs\/insecure-jwt-token/);
  });
});

/**
 * The coverage test for the configuration this package ships. The conductor
 * checks the same thing at runtime on the files it is given; this pins it here
 * too, so dropping a plugin fails this repo's own suite by name before it ever
 * reaches someone else's.
 */
describe("coverage of the bundled corpus", () => {
  const fixtures = resolve(__dirname, "../fixtures/rules");
  const expected = JSON.parse(readFileSync(join(fixtures, "expected.json"), "utf8")) as {
    violations: { rule: string; file: string }[];
  };
  const claimed = loadRules().filter((r) => r.enforcement.kind === "external");

  it("claims at least one tool rule, so this test is not vacuous", () => {
    expect(claimed.length).toBeGreaterThan(0);
  });

  it.each(claimed.map((r) => [r.id, r] as const))(
    "%s is live in the shipped eslint config on its violating fixture",
    async (_id, rule) => {
      const enforcement = rule.enforcement as { tool: string; rule: string };
      const violation = expected.violations.find((v) => v.rule === rule.id);

      // A claim with no fixture has nowhere to be proved.
      expect(violation, `${rule.id} has no violating fixture`).toBeDefined();
      expect(ruleAppliesTo(rule, violation!.file)).toBe(true);
      expect(enforcement.tool).toBe("eslint");
      await expect(eslint().isLive(fixtures, enforcement.rule, violation!.file)).resolves.toBe(true);
    },
  );
});
