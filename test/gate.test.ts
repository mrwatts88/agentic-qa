import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCi, runCommit } from "../src/gate";
import { defaultAdapters } from "../src/rules/adapters/index";
import type { Adapter } from "../src/rules/adapters/types";

let dir: string;
let stdout: string;
let stderr: string;
let env: NodeJS.ProcessEnv;

function write(relative: string, contents: string): void {
  mkdirSync(dirname(join(dir, relative)), { recursive: true });
  writeFileSync(join(dir, relative), contents);
}

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

/**
 * A slow engine that records whether it was asked to run. Named for gitleaks,
 * whose rules the corpus claims on every file, because the call sites run only
 * engines that enforce a corpus rule on what they check.
 */
function slowEngine(tool = "gitleaks"): Adapter & { ran: boolean } {
  const engine = {
    tool,
    slow: true,
    ran: false,
    handles: () => true,
    run: async () => {
      engine.ran = true;
      return { status: "ran" as const, findings: [] };
    },
    isLive: async () => true,
  };
  return engine;
}

const VIOLATION = 'localStorage.setItem("authToken", token);\n';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-gate-"));
  stdout = "";
  stderr = "";
  env = { ...process.env };
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => {
    stderr += String(chunk);
    return true;
  });
  git("init", "-q");
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = env;
  rmSync(dir, { recursive: true, force: true });
});

describe("the commit call site", () => {
  it("refuses a commit whose staged code breaks a rule", async () => {
    write("session.ts", VIOLATION);
    git("add", "session.ts");

    await expect(runCommit(dir, { registry: [] })).resolves.toBe(1);
    expect(stdout).toContain("fe.storage.no-token-in-local-storage");
  });

  it("ignores a violation that is not staged", async () => {
    write("session.ts", VIOLATION);
    write("clean.ts", "export const a = 1;\n");
    git("add", "clean.ts");

    await expect(runCommit(dir, { registry: [] })).resolves.toBe(0);
  });

  /** Every commit would otherwise pay seconds for opengrep, unasked. */
  it("leaves slow engines out by default", async () => {
    const slow = slowEngine();
    write("app.ts", "export const a = 1;\n");
    git("add", "app.ts");

    await runCommit(dir, { registry: [...defaultAdapters({ fast: true }), slow] });

    expect(slow.ran).toBe(false);
  });

  it("runs them when the repo's config puts them back", async () => {
    const slow = slowEngine();
    write("qa.config.yaml", "callSites:\n  commit:\n    scanners: all\n");
    write("app.ts", "export const a = 1;\n");
    git("add", "app.ts");

    await runCommit(dir, { registry: [slow] });

    expect(slow.ran).toBe(true);
  });
});

describe("what the call sites report", () => {
  /** A scanner finding no corpus rule claims. */
  const unclaimed: Adapter = {
    tool: "eslint",
    handles: () => true,
    run: async () => ({
      status: "ran",
      findings: [{ rule: "sonarjs/no-nested-conditional", file: "app.ts", line: 1, message: "Nested ternary." }],
    }),
    isLive: async () => true,
  };

  it("leaves out what the corpus does not claim, and does not block on it", async () => {
    write("app.ts", "export const a = 1;\n");
    git("add", "app.ts");

    await expect(runCommit(dir, { registry: [unclaimed] })).resolves.toBe(0);
    expect(stdout).not.toContain("no-nested-conditional");
  });

  it("does not run an engine that enforces no corpus rule on the files", async () => {
    const slow = slowEngine("opengrep");
    write("qa.config.yaml", "callSites:\n  ci:\n    llm: false\n    contracts: false\n");
    write("app.ts", "export const a = 1;\n");

    await runCi(dir, { registry: [slow] });

    expect(slow.ran).toBe(false);
  });

  it("blocks on the gauntlet at commit once a repo opts in", async () => {
    write("qa.config.yaml", "callSites:\n  commit:\n    gauntlet: true\n");
    write("app.ts", "export const a = 1;\n");
    git("add", "app.ts");

    await expect(runCommit(dir, { registry: [unclaimed] })).resolves.toBe(1);
    expect(stdout).toContain("eslint:sonarjs/no-nested-conditional");
  });
});

describe("the CI call site", () => {
  it("fails on a rule violation anywhere in the repo, and runs slow engines", async () => {
    const slow = slowEngine();
    write("qa.config.yaml", "callSites:\n  ci:\n    llm: false\n    contracts: false\n");
    write("session.ts", VIOLATION);

    await expect(runCi(dir, { registry: [slow] })).resolves.toBe(1);
    expect(slow.ran).toBe(true);
  });

  /**
   * A fork's pull request has no secrets. The judgment tiers are skipped loudly
   * rather than failed, so it still gets the free tier.
   */
  it("skips the judgment tiers in CI without a key, and says so", async () => {
    process.env.CI = "true";
    delete process.env.ANTHROPIC_API_KEY;
    write("clean.ts", "export const a = 1;\n");

    await expect(runCi(dir, { registry: [] })).resolves.toBe(0);
    expect(stderr).toContain("no ANTHROPIC_API_KEY");
  });
});
