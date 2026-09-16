import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, installHooks, type InitOptions } from "../src/init";

let dir: string;
let ci: string | undefined;

/** Both call sites, as the documented quick start asks for them. */
const BOTH: InitOptions = { gitHook: true, claudeHook: true, force: false };
/** Bare `init`: the command line, and nothing that touches anything else. */
const NEITHER: InitOptions = { gitHook: false, claudeHook: false, force: false };
/** Bringing a repo set up by an older version back up to date. */
const FORCE: InitOptions = { gitHook: true, claudeHook: true, force: true };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-init-"));
  // installHooks deliberately no-ops under CI, and these tests run there.
  ci = process.env.CI;
  delete process.env.CI;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ci === undefined) delete process.env.CI;
  else process.env.CI = ci;
});

function gitInit(at: string): void {
  execFileSync("git", ["init", "-q"], { cwd: at });
}

function pkg(contents: object): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify(contents, null, 2) + "\n");
}

function hooksPath(at: string): string | undefined {
  try {
    return execFileSync("git", ["config", "core.hooksPath"], {
      cwd: at,
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
}

describe("init", () => {
  it("writes the config, which is the tool's own file", () => {
    const result = runInit(dir, "npx agentic-qa", NEITHER);

    expect(result.written).toContain("qa.config.yaml");
  });

  /**
   * A setup command that rewrites someone's git configuration and agent
   * settings because they typed six words is the kind of unrequested
   * helpfulness this tool exists to catch.
   */
  it("installs neither call site unless asked", () => {
    gitInit(dir);
    pkg({ name: "demo", scripts: { test: "vitest" } });

    const result = runInit(dir, "npx agentic-qa", NEITHER);

    expect(existsSync(join(dir, ".claude/settings.json"))).toBe(false);
    expect(existsSync(join(dir, "hooks/pre-commit"))).toBe(false);
    expect(hooksPath(dir)).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts)
      .toEqual({ test: "vitest" });
    expect(result.updated).toEqual([]);
  });

  it("takes one call site without the other", () => {
    gitInit(dir);

    runInit(dir, "npx agentic-qa", { gitHook: false, claudeHook: true });

    expect(existsSync(join(dir, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(dir, "hooks/pre-commit"))).toBe(false);
    expect(hooksPath(dir)).toBeUndefined();
  });

  it("registers the agent hook on Edit and Write", () => {
    runInit(dir, "npx agentic-qa", BOTH);
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude/settings.json"), "utf8"),
    );

    const entry = settings.hooks.PostToolUse[0];
    expect(entry.matcher).toBe("Edit|Write");
    expect(entry.hooks[0].command).toBe("npx agentic-qa hook");
  });

  /**
   * A hook under .git/hooks is untracked, so it reaches whoever ran init and
   * nobody else, which makes the commit gate per-developer rather than
   * per-repo. The hook has to land somewhere git will carry to a clone.
   */
  it("puts the commit hook in a tracked directory, not in .git/hooks", () => {
    const result = runInit(dir, "npx agentic-qa", BOTH);

    expect(result.written).toContain(join("hooks", "pre-commit"));
    expect(result.written).not.toContain(join(".git", "hooks", "pre-commit"));
  });

  it("installs a commit hook that runs only the free mechanical tier", () => {
    runInit(dir, "npx agentic-qa", BOTH);
    const hook = readFileSync(join(dir, "hooks/pre-commit"), "utf8");

    expect(hook).toContain("rules --staged");
    // A commit must not wait on a model, cost money, or need the network.
    expect(hook).not.toContain("--llm");
  });

  it("makes the commit hook executable, or git will ignore it", () => {
    runInit(dir, "npx agentic-qa", BOTH);
    const mode = statSync(join(dir, "hooks/pre-commit")).mode;

    expect(mode & 0o111).not.toBe(0);
  });

  it("points core.hooksPath at the tracked directory", () => {
    gitInit(dir);

    runInit(dir, "npx agentic-qa", BOTH);

    expect(hooksPath(dir)).toBe("hooks");
  });

  /**
   * The hook file is tracked, so it is written regardless; only the git config
   * that activates it needs a repository.
   */
  it("still writes the hook outside a git repository, and says what it skipped", () => {
    const result = runInit(dir, "npx agentic-qa", BOTH);

    expect(result.written).toContain(join("hooks", "pre-commit"));
    expect(result.skipped.map((s) => s.path)).toContain("core.hooksPath");
  });

  it("adds a prepare script so a clone gets the hooks from npm install alone", () => {
    pkg({ name: "demo", scripts: { test: "vitest" } });

    const result = runInit(dir, "npx agentic-qa", BOTH);
    const written = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

    expect(written.scripts.prepare).toContain("install-hooks");
    // npm ci --omit=dev runs prepare with the tool absent. That must not fail
    // the install.
    expect(written.scripts.prepare).toContain("|| true");
    expect(written.scripts.test).toBe("vitest");
    expect(result.updated).toContain("package.json");
  });

  /**
   * Appending to a script someone else wrote is more invasive than writing a
   * file, and init does not do invasive. It reports the line instead.
   */
  it("leaves an existing prepare script alone and prints the line to add", () => {
    pkg({ name: "demo", scripts: { prepare: "npm run build" } });

    const result = runInit(dir, "npx agentic-qa", BOTH);
    const written = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

    expect(written.scripts.prepare).toBe("npm run build");
    const skip = result.skipped.find((s) => s.path === "package.json");
    expect(skip?.why).toContain("install-hooks");
  });

  it("does not report anything to do when prepare already installs the hooks", () => {
    pkg({ name: "demo", scripts: { prepare: "npx agentic-qa install-hooks || true" } });

    const result = runInit(dir, "npx agentic-qa", BOTH);

    expect(result.updated).not.toContain("package.json");
    const skip = result.skipped.find((s) => s.path === "package.json");
    expect(skip?.why).toContain("already");
  });

  /**
   * Replacing someone's existing hook or settings would be exactly the kind of
   * destructive helpfulness this tool is meant to catch.
   */
  it("leaves an existing settings file untouched and says so", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude/settings.json"), '{"mine":true}\n');

    const result = runInit(dir, "npx agentic-qa", BOTH);

    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe(
      '{"mine":true}\n',
    );
    expect(result.skipped.map((s) => s.path)).toContain(
      join(".claude", "settings.json"),
    );
  });

  /**
   * Once core.hooksPath moves, git stops reading .git/hooks entirely, so a
   * copy an earlier init left there silently stops running.
   */
  it("reports a hook left in .git/hooks by an earlier version as now inert", () => {
    gitInit(dir);
    mkdirSync(join(dir, ".git/hooks"), { recursive: true });
    writeFileSync(
      join(dir, ".git/hooks/pre-commit"),
      "#!/bin/sh\n# Installed by agentic-qa.\nexec npx agentic-qa rules --staged\n",
    );

    const result = runInit(dir, "npx agentic-qa", BOTH);
    const skip = result.skipped.find((s) => s.path === ".git/hooks/pre-commit");

    expect(skip?.why).toContain("inert");
  });

  /**
   * The case this exists for: a repo set up before the Stop hook existed keeps
   * its old settings file, looks perfectly installed, and silently lacks a call
   * site. Leaving it alone is right by default and wrong forever.
   */
  it("replaces stale hook wiring when forced", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude/settings.json"), '{"hooks":{}}\n');

    const result = runInit(dir, "npx agentic-qa", FORCE);
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude/settings.json"), "utf8"),
    );

    expect(result.replaced).toContain(join(".claude", "settings.json"));
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("npx agentic-qa stop");
  });

  /**
   * The config is seeded once and then belongs to the repo — its globs, its
   * ignore list, its budget. Replacing that to pick up a new hook would be a
   * trade nobody asked for.
   */
  it("never replaces qa.config.yaml, even when forced", () => {
    writeFileSync(join(dir, "qa.config.yaml"), "testGlobs:\n  - \"mine/**\"\n");

    const result = runInit(dir, "npx agentic-qa", FORCE);

    expect(readFileSync(join(dir, "qa.config.yaml"), "utf8")).toContain("mine/**");
    expect(result.replaced).not.toContain("qa.config.yaml");
  });

  /**
   * It did exactly this on a real repo: reported the config as skipped, told
   * the reader to re-run with --force, and printed that in the output of the
   * run where they had just passed --force. Advertising a flag that cannot
   * touch the file is how a report teaches people to stop reading it.
   */
  it("does not offer --force for the one file --force will never replace", () => {
    writeFileSync(join(dir, "qa.config.yaml"), 'testGlobs:\n  - "mine/**"\n');

    const result = runInit(dir, "npx agentic-qa", FORCE);
    const skip = result.skipped.find((s) => s.path === "qa.config.yaml");

    expect(skip?.why).not.toContain("--force");
  });

  /** --force owns the tool's own boilerplate, not a script someone wrote. */
  it("leaves an existing prepare script alone even when forced", () => {
    pkg({ name: "demo", scripts: { prepare: "npm run build" } });

    runInit(dir, "npx agentic-qa", FORCE);
    const written = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

    expect(written.scripts.prepare).toBe("npm run build");
  });

  /** Silence about being out of date is the failure mode --force answers. */
  it("points at --force when it leaves something alone", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude/settings.json"), '{"mine":true}\n');

    const result = runInit(dir, "npx agentic-qa", BOTH);
    const skip = result.skipped.find(
      (s) => s.path === join(".claude", "settings.json"),
    );

    expect(result.replaced).toEqual([]);
    expect(skip?.why).toContain("--force");
  });

  it("installs the Stop hook without the mechanical-only flag", () => {
    runInit(dir, "npx agentic-qa", BOTH);
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude/settings.json"), "utf8"),
    );

    const stop = settings.hooks.Stop[0];
    // Stop fires once per turn for the main agent, so it is the one call site
    // where the tiers that cost money belong.
    expect(stop.hooks[0].command).toBe("npx agentic-qa stop");
    expect(stop.matcher).toBeUndefined();
  });

  it("uses the runner it was given, so a repo can point at a local build", () => {
    runInit(dir, "node dist/cli.js", BOTH);
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude/settings.json"), "utf8"),
    );

    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(
      "node dist/cli.js hook",
    );
    expect(readFileSync(join(dir, "hooks/pre-commit"), "utf8")).toContain(
      "node dist/cli.js rules --staged",
    );
  });
});

describe("installHooks", () => {
  it("is a no-op in CI, where hooks do nothing and the install must not fail", () => {
    gitInit(dir);
    mkdirSync(join(dir, "hooks"), { recursive: true });
    process.env.CI = "true";

    const result = installHooks(dir);

    expect(result.installed).toBe(false);
    expect(hooksPath(dir)).toBeUndefined();
  });

  it("is a no-op outside a git repository rather than an error", () => {
    mkdirSync(join(dir, "hooks"), { recursive: true });

    expect(installHooks(dir).installed).toBe(false);
  });

  it("is a no-op when there is no hooks directory to point at", () => {
    gitInit(dir);

    expect(installHooks(dir).installed).toBe(false);
  });
});
