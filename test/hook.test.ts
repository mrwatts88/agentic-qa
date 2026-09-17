import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runHook, changedFiles } from "../src/hook";

let dir: string;
let output: string;

function write(relative: string, contents: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-hook-"));
  output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
    output += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * PostToolUse fires after the tool has already run, so a non-zero exit cannot
 * undo anything and only stops the turn. Everything below pins the rule that
 * this hook reports rather than gates.
 */
describe("the PostToolUse hook", () => {
  it("exits zero when the changed code breaks a rule", async () => {
    git("init");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');

    await expect(runHook(dir)).resolves.toBe(0);
  });

  it("exits zero and says nothing when nothing is wrong", async () => {
    git("init");
    write("clean.ts", "export const total = 1 + 1;\n");

    const code = await runHook(dir);

    expect(code).toBe(0);
    expect(output).toBe("");
  });

  it("reports the violation to the model as PostToolUse additionalContext", async () => {
    git("init");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');

    await runHook(dir);
    const payload = JSON.parse(output);

    expect(payload.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(payload.hookSpecificOutput.additionalContext).toContain(
      "fe.storage.no-token-in-local-storage",
    );
    expect(payload.hookSpecificOutput.additionalContext).toContain("session.ts");
  });

  it("tells the model an exception is the person's to approve", async () => {
    git("init");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');

    await runHook(dir);
    const context = JSON.parse(output).hookSpecificOutput.additionalContext;

    expect(context).toContain("qa-ignore");
    expect(context).toContain("committed");
  });

  it("does not honour an exception the working tree added", async () => {
    git("init");
    write(
      "session.ts",
      '// qa-ignore: fe.storage.no-token-in-local-storage - fine\nlocalStorage.setItem("authToken", token);\n',
    );

    await runHook(dir);
    const context = JSON.parse(output).hookSpecificOutput.additionalContext;

    expect(context).toContain("rule violation(s)");
    expect(context).toContain("session.ts:1 qa-ignore for fe.storage.no-token-in-local-storage");
  });

  /**
   * Nagging about code the agent never touched is how a hook gets uninstalled.
   */
  it("stays quiet about a violation that was already committed", async () => {
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');
    git("add", "-A");
    git("commit", "-m", "pre-existing violation");

    const code = await runHook(dir);

    expect(code).toBe(0);
    expect(output).toBe("");
  });
});

/**
 * Seven edits in one batch produced seven identical warnings about the same
 * unrelated file. Reporting only on the file just edited is what keeps the
 * hook worth listening to.
 */
describe("scoping to the edited file", () => {
  it("reports a violation in the file that was just edited", async () => {
    git("init");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');

    await runHook(dir, join(dir, "session.ts"));

    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(
      "session.ts",
    );
  });

  it("stays quiet about a different file that also changed", async () => {
    git("init");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');
    write("clean.ts", "export const total = 1 + 1;\n");

    const code = await runHook(dir, join(dir, "clean.ts"));

    expect(code).toBe(0);
    expect(output).toBe("");
  });

  it("accepts a repo-relative path as well as an absolute one", async () => {
    git("init");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');

    await runHook(dir, "session.ts");

    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(
      "session.ts",
    );
  });

  it("falls back to the changed files when the path is outside the repo", async () => {
    git("init");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');

    await runHook(dir, "/somewhere/else/other.ts");

    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(
      "session.ts",
    );
  });
});

describe("changedFiles", () => {
  it("returns nothing outside a git repository, so the hook falls back", () => {
    expect(changedFiles(dir)).toBeUndefined();
  });

  it("lists a file the working tree has added", () => {
    git("init");
    write("a.ts", "export const a = 1;\n");

    expect(changedFiles(dir)).toContain("a.ts");
  });
});
