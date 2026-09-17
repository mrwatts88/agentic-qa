import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { judgedLines, runStop } from "../src/stop";
import { defaultAdapters } from "../src/rules/adapters/index";
import type { Adapter } from "../src/rules/adapters/types";

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
// The fast engines only: the slow ones download their binaries on first use,
// which a unit test must not do. Their behaviour is covered in adapters.test.ts.
const FIRST = { stopHookActive: false, judgment: false, adapters: defaultAdapters({ fast: true }) };
/** The second: a Stop hook has already held this turn once. */
const AGAIN = { stopHookActive: true, judgment: false, adapters: defaultAdapters({ fast: true }) };

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

    // Top level. Nested in hookSpecificOutput, Claude Code ignores it: this
    // test used to assert the nested shape, and the hook never blocked.
    expect(payload.decision).toBe("block");
    expect(payload.reason).toContain("fe.storage.no-token-in-local-storage");
    expect(payload.hookSpecificOutput).toBeUndefined();
  });

  /**
   * `git status` reports a new directory as the directory, not the files in it,
   * so a file created in a folder the repo did not have yet went unchecked.
   */
  it("checks a file created in a new directory", async () => {
    git("init");
    write("web/auth/session.ts", 'localStorage.setItem("authToken", token);\n');

    await runStop(dir, FIRST);

    expect(JSON.parse(output).reason).toContain("web/auth/session.ts");
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

    expect(JSON.parse(output).reason).toContain("qa-ignore");
  });

  /**
   * Observed in the first headless run of a blocking Stop hook: the agent's
   * cheapest way out was a one-line exception with a false reason. Writing one
   * must not release the block, and the person must see that it was tried.
   */
  describe("exceptions written during the turn", () => {
    const EXCUSED =
      '// qa-ignore: fe.storage.no-token-in-local-storage - this is test code\n' +
      'localStorage.setItem("authToken", token);\n';

    /** The person hears only if the block does not work, on the second pass. */
    it("still blocks, and tells only the agent on the first pass", async () => {
      git("init");
      write("session.ts", EXCUSED);

      await runStop(dir, FIRST);
      const payload = JSON.parse(output);

      expect(payload.decision).toBe("block");
      expect(payload.reason).toContain("session.ts:1 qa-ignore for fe.storage.no-token-in-local-storage");
      expect(payload.systemMessage).toBeUndefined();
    });

    it("shows the attempt to the person on the pass that lets the turn end", async () => {
      git("init");
      write("session.ts", EXCUSED);

      await runStop(dir, AGAIN);
      const payload = JSON.parse(output);

      expect(payload.decision).toBeUndefined();
      expect(payload.systemMessage).toContain("session.ts:1 qa-ignore for fe.storage.no-token-in-local-storage");
    });

    it("honours an exception once a person has committed it", async () => {
      git("init");
      write("session.ts", EXCUSED);
      git("add", "-A");
      git("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-m", "approved");
      // The file changes elsewhere, so it is in this turn's scope again.
      write("session.ts", `${EXCUSED}export const later = 1;\n`);

      await runStop(dir, FIRST);

      expect(output).toBe("");
    });
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

    expect(payload.decision).toBeUndefined();
    // additionalContext would continue the agent, which is a second block by
    // another name. systemMessage reaches the person and lets the turn end.
    expect(payload.hookSpecificOutput).toBeUndefined();
    expect(payload.systemMessage).toContain("fe.storage.no-token-in-local-storage");
  });

  it("says nothing at all when the turn is clean", async () => {
    git("init");
    write("clean.ts", "export const total = 1 + 1;\n");

    const code = await runStop(dir, FIRST);

    expect(code).toBe(0);
    expect(output).toBe("");
  });

  /**
   * A hook matching Edit and Write would never see a file changed any other
   * way. The working tree does not care how a file came to be different.
   */
  it("sees a change regardless of how it was made", async () => {
    git("init");
    execFileSync("sh", ["-c", 'printf \'localStorage.setItem("authToken", t);\n\' > shell.ts'], {
      cwd: dir,
    });

    await runStop(dir, FIRST);

    expect(JSON.parse(output).reason).toContain("shell.ts");
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
   * Unvetted scanner output shown to the agent taught it to skip hook output
   * altogether. The gauntlet is `agentic-qa gauntlet`, run by a person.
   */
  describe("scanner findings the corpus does not claim", () => {
    const scanner: Adapter = {
      tool: "slowscan",
      handles: () => true,
      run: async () => ({
        status: "ran",
        findings: [{ rule: "open-redirect", file: "app.ts", line: 1, message: "Redirect from user input." }],
      }),
      isLive: async () => true,
    };
    it("say nothing to anyone on a clean turn", async () => {
      git("init");
      write("app.ts", "export const redirect = 1;\n");

      await runStop(dir, { ...FIRST, adapters: [scanner] });

      expect(output).toBe("");
    });

    it("stay out of a block", async () => {
      git("init");
      write("app.ts", 'localStorage.setItem("authToken", token);\n');

      await runStop(dir, { ...FIRST, adapters: [...defaultAdapters({ fast: true }), scanner] });
      const payload = JSON.parse(output);

      expect(payload.decision).toBe("block");
      expect(payload.reason).not.toContain("open-redirect");
    });
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
    expect(payload.decision).toBeUndefined();
    expect(payload.hookSpecificOutput).toBeUndefined();
    expect(payload.systemMessage).toContain("could not run");
  });

  /**
   * The statement alone names a principle, not a fix. The judge's reason is the
   * only part that says what it saw in this file, so a block without it leaves
   * the agent guessing.
   */
  it("tells the agent what the judge saw and why the rule matters", () => {
    const text = judgedLines({
      file: "src/orders.ts",
      line: 12,
      statement: "Check that the record belongs to the caller",
      ruleId: "be.authz.ownership-check",
      excerpt: "loads the order by id but never checks it belongs to the caller",
      rationale: "Guessable ids let one user read another's orders.",
    });

    expect(text).toContain("src/orders.ts:12");
    expect(text).toContain("What the judge saw: loads the order by id");
    expect(text).toContain("Why it matters: Guessable ids");
  });
});
