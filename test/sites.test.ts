import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adaptersFor,
  DEFAULT_POLICY,
  parseSiteOverrides,
  policyFor,
  renderSiteTable,
} from "../src/sites";
import { loadConfig } from "../src/config";
import { runHook } from "../src/hook";
import type { Adapter } from "../src/rules/adapters/types";

function engine(tool: string, slow = false): Adapter {
  return {
    tool,
    slow,
    handles: () => true,
    run: async () => ({ status: "ran", findings: [] }),
    isLive: async () => true,
  };
}

const REGISTRY = [engine("eslint"), engine("gitleaks"), engine("opengrep", true)];
const tools = (adapters: Adapter[]) => adapters.map((a) => a.tool);

describe("the default policy", () => {
  it("keeps slow engines out of the per-edit hook and the commit hook", () => {
    expect(tools(adaptersFor(DEFAULT_POLICY.edit, REGISTRY))).toEqual(["eslint", "gitleaks"]);
    expect(tools(adaptersFor(DEFAULT_POLICY.commit, REGISTRY))).toEqual(["eslint", "gitleaks"]);
  });

  it("runs every engine at Stop and in CI", () => {
    expect(tools(adaptersFor(DEFAULT_POLICY.stop, REGISTRY))).toHaveLength(3);
    expect(tools(adaptersFor(DEFAULT_POLICY.ci, REGISTRY))).toHaveLength(3);
  });

  /**
   * By property, not by name: an engine added later that is marked slow stays
   * out of the fast call sites without anyone listing it as an exception.
   */
  it("excludes a newly added slow engine without naming it", () => {
    const registry = [...REGISTRY, engine("newscanner", true)];

    expect(tools(adaptersFor(DEFAULT_POLICY.edit, registry))).not.toContain("newscanner");
  });

  it.each(["edit", "commit"] as const)("never runs a model at %s", (site) => {
    expect(DEFAULT_POLICY[site].llm).toBe(false);
    expect(DEFAULT_POLICY[site].contracts).toBe(false);
  });
});

describe("repo overrides", () => {
  it("replaces only the cells a repo names", () => {
    const policy = policyFor("stop", parseSiteOverrides({ stop: { contracts: false } }));

    expect(policy).toEqual({ ...DEFAULT_POLICY.stop, contracts: false });
  });

  it("can put slow engines back on commit, or leave one out by name", () => {
    const overrides = parseSiteOverrides({
      commit: { scanners: "all" },
      ci: { skip: ["opengrep"] },
    });

    expect(tools(adaptersFor(policyFor("commit", overrides), REGISTRY))).toContain("opengrep");
    expect(tools(adaptersFor(policyFor("ci", overrides), REGISTRY))).not.toContain("opengrep");
  });

  /** A setting silently ignored is a check someone believes they changed. */
  it.each([
    [{ comit: {} }, 'unknown call site "comit"'],
    [{ stop: { scanner: "all" } }, "stop.scanner is not a setting"],
    [{ stop: { scanners: "some" } }, 'stop.scanners must be "fast" or "all"'],
    [{ ci: { skip: ["semgrep"] } }, 'unknown scanner "semgrep"'],
    [{ ci: { llm: "yes" } }, "ci.llm must be true or false"],
    [{ stop: "off" }, "stop must be a map of settings"],
  ])("refuses %j", (raw, message) => {
    expect(() => parseSiteOverrides(raw)).toThrow(message);
  });

  it.each([
    [{ edit: { llm: true } }, "the per-edit hook can run concurrently"],
    [{ edit: { contracts: true } }, "the per-edit hook can run concurrently"],
    [{ commit: { llm: true } }, "a commit must not cost money"],
  ])("refuses to put a model where an invariant forbids it: %j", (raw, why) => {
    expect(() => parseSiteOverrides(raw)).toThrow(why);
  });
});

describe("qa.config.yaml", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentic-qa-sites-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads callSites", () => {
    writeFileSync(join(dir, "qa.config.yaml"), "callSites:\n  commit:\n    scanners: all\n");

    expect(loadConfig(dir).callSites).toEqual({ commit: { scanners: "all" } });
  });

  it("fails to load when callSites is wrong, rather than ignoring it", () => {
    writeFileSync(join(dir, "qa.config.yaml"), "callSites:\n  edit:\n    llm: true\n");

    expect(() => loadConfig(dir)).toThrow("cannot be changed");
  });

  /**
   * A unit test of the table does not prove a call site reads it. The per-edit
   * hook, with eslint skipped by name, stays quiet about a rule only eslint
   * enforces.
   */
  it("is what the per-edit hook actually runs", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      output += String(chunk);
      return true;
    });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(
      join(dir, "auth.ts"),
      'import jwt from "jsonwebtoken";\n\nexport const check = (t: string) => jwt.verify(t, "k", { algorithms: ["none"] });\n',
    );

    await runHook(dir, "auth.ts");
    expect(output).toContain("sec.jwt.no-none-algorithm");

    output = "";
    writeFileSync(join(dir, "qa.config.yaml"), "callSites:\n  edit:\n    skip: [eslint]\n");
    await runHook(dir, "auth.ts");
    expect(output).not.toContain("sec.jwt.no-none-algorithm");
  });
});

/** The README's table is rendered from the defaults, so it cannot drift from them. */
describe("the README", () => {
  it("contains exactly the table the defaults produce", () => {
    const readme = readFileSync(join(__dirname, "..", "README.md"), "utf8");

    expect(readme).toContain(renderSiteTable());
  });
});
