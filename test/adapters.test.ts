import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Rule } from "../src/rules/types";
import type { Adapter, ToolFinding, ToolRun } from "../src/rules/adapters/types";
import { loadRules } from "../src/rules/load";
import { runMechanical } from "../src/rules/mechanical";
import { ruleAppliesTo } from "../src/rules/route";
import { defaultAdapters } from "../src/rules/adapters/index";
import { dependencyCruiser } from "../src/rules/adapters/dependency-cruiser";
import { gitleaks } from "../src/rules/adapters/gitleaks";
import { binaryPath, GITLEAKS } from "../src/tools/provision";
import { execFileSync } from "node:child_process";

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

  // A claim with no fixture has nowhere to be proved.
  it("gives every claimed rule a violating fixture", () => {
    const proved = new Set(expected.violations.map((v) => v.rule));

    expect(claimed.map((r) => r.id).filter((id) => !proved.has(id))).toEqual([]);
  });

  // One row per claim per fixture, rather than a loop of assertions inside one
  // test: test.no-assertion-in-loop flagged exactly that here.
  const rows = claimed.flatMap((rule) =>
    expected.violations
      .filter((v) => v.rule === rule.id)
      .map((v) => [rule.id, v.file, rule] as const),
  );

  it.each(rows)("%s is live in the shipped config on %s", async (_id, file, rule) => {
    const enforcement = rule.enforcement as { tool: string; rule: string };
    const adapter = defaultAdapters().find((a) => a.tool === enforcement.tool);

    expect(adapter, `no adapter for ${enforcement.tool}`).toBeDefined();
    expect(ruleAppliesTo(rule, file)).toBe(true);
    await expect(adapter!.isLive(fixtures, enforcement.rule, file)).resolves.toBe(true);
  });
});

/**
 * The shapes a database import really takes, in the layout orders-admin uses.
 * The import-name pattern this replaced found two of these six.
 */
const RULE = "no-db-client-outside-repository";

// At module scope on purpose: test.no-conditional-logic reads indentation as
// "inside a test", so this guard nested in the describe below tripped it.
async function violations(files: string[]) {
  const run = await dependencyCruiser().run(dir, files);
  if (run.status !== "ran") throw new Error(run.reason);
  return run.findings.filter((f) => f.rule === RULE).map((f) => `${f.file}:${f.line}`).sort();
}

describe("the dependency-cruiser adapter", () => {
  beforeEach(() => {
    write("node_modules/pg/package.json", '{"name":"pg","main":"index.js"}');
    write("node_modules/pg/index.js", "module.exports = {};\n");
    write("src/db/client.ts", 'import pg from "pg";\nexport const pool = new pg.Pool();\n');
    write("src/repositories/customerRepo.ts", 'import { pool } from "../db/client.js";\nexport const find = () => pool;\n');
    write("src/services/customerService.ts", 'import * as repo from "../repositories/customerRepo.js";\nexport const get = () => repo.find();\n');
    write("src/handlers/localClient.ts", 'export const x = 1;\n\nimport { pool } from "../db/client.js";\nexport const h = pool;\n');
    write("src/handlers/pkg.ts", 'import pg from "pg";\nexport const h = pg;\n');
    write("src/handlers/requires.ts", 'const { Pool } = require("pg");\nexport const h = Pool;\n');
    write("src/handlers/dynamic.ts", 'export async function h() {\n  return import("pg");\n}\n');
    write("src/handlers/reexport.ts", 'export { pool } from "../db/client.js";\n');
    write("src/db/queries.ts", 'import pg from "pg";\nexport const q = pg;\n');
  });

  it("finds every way a handler reaches the database, on the line that does it", async () => {
    const found = await violations([
      "src/handlers/localClient.ts",
      "src/handlers/pkg.ts",
      "src/handlers/requires.ts",
      "src/handlers/dynamic.ts",
      "src/handlers/reexport.ts",
      "src/db/queries.ts",
    ]);

    expect(found).toEqual([
      "src/db/queries.ts:1",
      "src/handlers/dynamic.ts:2",
      "src/handlers/localClient.ts:3",
      "src/handlers/pkg.ts:1",
      "src/handlers/reexport.ts:1",
      "src/handlers/requires.ts:1",
    ]);
  });

  it("leaves the client module and the repository layer alone", async () => {
    expect(
      await violations(["src/db/client.ts", "src/repositories/customerRepo.ts", "src/services/customerService.ts"]),
    ).toEqual([]);
  });

  /** Following imports reaches files nobody asked about; they are not reported. */
  it("reports only on the files it was asked about, not the ones it followed into", async () => {
    write("src/handlers/entry.ts", 'import { h } from "./pkg.js";\nexport const e = h;\n');

    expect(await violations(["src/handlers/entry.ts"])).toEqual([]);
  });

  it("counts the rule as not live for a file its from-scope exempts", async () => {
    const adapter = dependencyCruiser();

    await expect(adapter.isLive(dir, RULE, "src/handlers/pkg.ts")).resolves.toBe(true);
    await expect(adapter.isLive(dir, RULE, "src/repositories/customerRepo.ts")).resolves.toBe(false);
    await expect(adapter.isLive(dir, "no-such-rule", "src/handlers/pkg.ts")).resolves.toBe(false);
  });
});

function installed(binary: string): boolean {
  try {
    execFileSync(binary, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Needs the real binary, provisioned or installed; tests never download it.
 * Skipped on a machine with neither, never in CI, which runs `setup` first:
 * CI is where a missing scanner is a repo problem, so there these must run.
 */
describe.skipIf(!existsSync(binaryPath(GITLEAKS)) && !installed("gitleaks") && !process.env.CI)("the gitleaks adapter", () => {
  beforeEach(() => {
    write("deploy.env", "AWS_ACCESS_KEY_ID=ASIAZ7QK3MXN4TPW2RVB\n");
    write("README.md", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n");
  });

  it("finds a temporary credential the AKIA-only pattern missed", async () => {
    const run = await gitleaks().run(dir, ["deploy.env"]);

    expect(run).toEqual({
      status: "ran",
      findings: [expect.objectContaining({ rule: "aws-access-token", file: "deploy.env", line: 1, redact: true })],
    });
  });

  it("leaves AWS's documentation example key alone", async () => {
    await expect(gitleaks().run(dir, ["README.md"])).resolves.toEqual({ status: "ran", findings: [] });
  });

  /** Every call site prints the excerpt: the terminal, CI logs, the agent. */
  it("never repeats the secret in what it reports", async () => {
    const { findings } = await runMechanical(dir, ["deploy.env"], [], {
      adapters: [gitleaks()],
      ci: false,
    });

    expect(findings).toHaveLength(1);
    expect(JSON.stringify(findings)).not.toContain("ASIAZ7QK3MXN4TPW2RVB");
  });

  it("counts the rule as not live on a file its own allowlist skips", async () => {
    await expect(gitleaks().isLive(dir, "aws-access-token", "deploy.env")).resolves.toBe(true);
    await expect(gitleaks().isLive(dir, "aws-access-token", "package-lock.json")).resolves.toBe(false);
    await expect(gitleaks().isLive(dir, "aws-access-token", "logo.PNG")).resolves.toBe(false);
    await expect(gitleaks().isLive(dir, "no-such-rule", "deploy.env")).resolves.toBe(false);
  });
});

describe("a scanner that is not installed", () => {
  it("is reported as unavailable, never as a clean run", async () => {
    const run = await gitleaks(undefined, "gitleaks-that-does-not-exist").run(dir, ["a.ts"]);

    expect(run).toEqual({ status: "unavailable", reason: "gitleaks is not installed" });
  });
});
