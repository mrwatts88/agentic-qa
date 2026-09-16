import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/init";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-init-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("init", () => {
  it("writes the config and the agent hook settings", () => {
    const result = runInit(dir, "npx agentic-qa");

    expect(result.written).toContain("qa.config.yaml");
    expect(result.written).toContain(join(".claude", "settings.json"));
  });

  it("registers the agent hook on Edit and Write", () => {
    runInit(dir, "npx agentic-qa");
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude/settings.json"), "utf8"),
    );

    const entry = settings.hooks.PostToolUse[0];
    expect(entry.matcher).toBe("Edit|Write");
    expect(entry.hooks[0].command).toBe("npx agentic-qa hook");
  });

  it("installs a git hook that runs only the free mechanical tier", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });

    runInit(dir, "npx agentic-qa");
    const hook = readFileSync(join(dir, ".git/hooks/pre-commit"), "utf8");

    expect(hook).toContain("rules --staged");
    // A commit must not wait on a model, cost money, or need the network.
    expect(hook).not.toContain("--llm");
  });

  it("makes the git hook executable, or git will ignore it", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });

    runInit(dir, "npx agentic-qa");
    const mode = statSync(join(dir, ".git/hooks/pre-commit")).mode;

    expect(mode & 0o111).not.toBe(0);
  });

  it("skips the git hook when the directory is not a git repository", () => {
    const result = runInit(dir, "npx agentic-qa");

    expect(result.written).not.toContain(join(".git", "hooks", "pre-commit"));
    expect(result.skipped.map((s) => s.path)).toContain(".git/hooks/pre-commit");
  });

  /**
   * Replacing someone's existing hook or settings would be exactly the kind of
   * destructive helpfulness this tool is meant to catch.
   */
  it("leaves an existing settings file untouched and says so", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude/settings.json"), '{"mine":true}\n');

    const result = runInit(dir, "npx agentic-qa");

    expect(readFileSync(join(dir, ".claude/settings.json"), "utf8")).toBe(
      '{"mine":true}\n',
    );
    expect(result.skipped.map((s) => s.path)).toContain(
      join(".claude", "settings.json"),
    );
  });

  it("uses the runner it was given, so a repo can point at a local build", () => {
    runInit(dir, "node dist/cli.js");
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude/settings.json"), "utf8"),
    );

    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe(
      "node dist/cli.js hook",
    );
  });
});
