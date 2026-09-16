import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runStop } from "../src/stop";

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

/** The first firing of a turn: nothing has blocked yet. */
const FIRST = { stopHookActive: false, judgment: false };
/** The second: a Stop hook has already held this turn once. */
const AGAIN = { stopHookActive: true, judgment: false };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-stop-"));
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

describe("the Stop hook", () => {
  it("blocks the agent from finishing while a violation stands", async () => {
    git("init");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');

    await runStop(dir, FIRST);
    const payload = JSON.parse(output);

    expect(payload.hookSpecificOutput.hookEventName).toBe("Stop");
    expect(payload.hookSpecificOutput.decision).toBe("block");
    expect(payload.hookSpecificOutput.reason).toContain(
      "fe.storage.no-token-in-local-storage",
    );
  });

  /**
   * Blocking is done through the decision field, never the exit code. A crash
   * or a non-zero exit here would stop the turn without saying why, so the
   * process must always succeed and let the payload do the gating.
   */
  it("exits zero even when it blocks", async () => {
    git("init");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');

    await expect(runStop(dir, FIRST)).resolves.toBe(0);
  });

  it("tells the agent how to record a deliberate exception", async () => {
    git("init");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');

    await runStop(dir, FIRST);

    expect(JSON.parse(output).hookSpecificOutput.reason).toContain("qa-ignore");
  });

  /**
   * The whole point of stop_hook_active. Blocking a second time is how a
   * session ends up unable to finish, so the second pass says the same thing
   * and lets go.
   */
  it("reports without blocking once it has already held the turn", async () => {
    git("init");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');

    await runStop(dir, AGAIN);
    const payload = JSON.parse(output);

    expect(payload.hookSpecificOutput.decision).toBeUndefined();
    expect(payload.additionalContext).toContain(
      "fe.storage.no-token-in-local-storage",
    );
  });

  it("says nothing at all when the turn is clean", async () => {
    git("init");
    write("clean.ts", "export const total = 1 + 1;\n");

    const code = await runStop(dir, FIRST);

    expect(code).toBe(0);
    expect(output).toBe("");
  });

  /**
   * The hole this call site exists to close: PostToolUse matches Edit and
   * Write, so a file changed any other way is never checked. The working tree
   * does not care how a file came to be different.
   */
  it("sees a change regardless of how it was made", async () => {
    git("init");
    execFileSync("sh", ["-c", 'printf \'localStorage.setItem("authToken", t);\n\' > shell.ts'], {
      cwd: dir,
    });

    await runStop(dir, FIRST);

    expect(JSON.parse(output).hookSpecificOutput.reason).toContain("shell.ts");
  });

  /** Complaining about code this turn never touched is how a hook dies. */
  it("stays quiet about a violation that was already committed", async () => {
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');
    git("add", "-A");
    git("commit", "-m", "pre-existing violation");

    const code = await runStop(dir, FIRST);

    expect(code).toBe(0);
    expect(output).toBe("");
  });

  /**
   * A checker that traps the turn when it breaks is worse than no checker: the
   * agent cannot fix a broken rules corpus, so blocking on one is a dead end.
   * It still has to say so, because silence from a checker reads as approval.
   */
  it("reports rather than blocks when it cannot run at all", async () => {
    git("init");
    write("qa.config.yaml", 'rules:\n  paths: ["local-rules"]\n');
    // A rule file with no top-level `pack`, which the loader refuses.
    write("local-rules/broken.yaml", "rules: []\n");
    write("session.ts", 'localStorage.setItem("authToken", token);\n');

    const code = await runStop(dir, FIRST);
    const payload = JSON.parse(output);

    expect(code).toBe(0);
    expect(payload.hookSpecificOutput.decision).toBeUndefined();
    expect(payload.additionalContext).toContain("could not run");
  });
});
