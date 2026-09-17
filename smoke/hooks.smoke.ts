import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInit } from "../src/init";

/**
 * Real-session smoke tests for the agent-facing call sites.
 *
 * The Stop hook once shipped unable to block, with passing unit tests, because
 * those tests asserted the JSON it emitted rather than what Claude Code does
 * with it. These run headless `claude -p` sessions on haiku against throwaway
 * repos wired to this checkout's `dist/`, and assert on the session transcript:
 * whether the turn was held, what the agent was told, what the person saw.
 *
 * Run with `npm run smoke`: four sessions in parallel, about a minute, using
 * whatever login `claude` already has. Not part of `npm test`, and not in
 * CI. Transcripts land in `.qa/tmp/smoke/`.
 *
 * Shown to fail: with `decision` nested back inside `hookSpecificOutput`, the
 * bug these exist for, the three tests that need Stop to hold the turn fail.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "dist", "cli.js");
const TRANSCRIPTS = join(ROOT, ".qa", "tmp", "smoke");

/**
 * The code each session starts from lives in fixtures/smoke, not here. It
 * breaks rules on purpose, and fixtures/ is where this repo keeps code like
 * that, out of reach of its own hooks.
 */
function fixture(name: string): string {
  return readFileSync(join(ROOT, "fixtures", "smoke", name), "utf8");
}

/** Breaks a corpus rule. */
const VIOLATION = fixture("session.ts");
/** Draws only a gauntlet finding from a scanner, which Stop never shows. */
const NOTE = fixture("app.ts");
const RULE = "fe.storage.no-token-in-local-storage";

/**
 * No tools at all, so a held turn cannot be resolved by fixing it. A deny list
 * of editing tools was not enough: a blocked agent reached for subagents and
 * went looking for a shell, and blew the session budget doing it.
 */
const NO_TOOLS = ["--tools", ""];

type Event = Record<string, any>;

interface Repo {
  files: Record<string, string>;
}

/**
 * The hooks come from `init`, pointed at this checkout, so a session also proves
 * the wiring `init` writes works — event name and placement.
 */
function makeRepo(name: string, repo: Repo): string {
  const dir = mkdtempSync(join(tmpdir(), `agentic-qa-smoke-${name}-`));
  execFileSync("git", ["init", "-q"], { cwd: dir });

  runInit(dir, `node "${CLI}"`, { gitHook: false, claudeHook: true, force: false });

  for (const [path, contents] of Object.entries(repo.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

/**
 * One headless session. `--setting-sources project` keeps the person's own
 * hooks and settings out, so only the hooks under test run. Claude Code's
 * variables from any session this is launched inside are dropped too: a
 * leftover CLAUDE_PROJECT_DIR would point the hook at the wrong repo.
 */
function runSession(name: string, repo: Repo, prompt: string, tools: string[]): Promise<Event[]> {
  const cwd = makeRepo(name, repo);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE")),
  );

  const args = [
    "-p", prompt,
    "--model", "haiku",
    "--output-format", "stream-json",
    "--verbose",
    "--include-hook-events",
    "--setting-sources", "project",
    "--no-session-persistence",
    "--max-budget-usd", "0.25",
    ...tools,
  ];

  return new Promise((done, fail) => {
    const child = spawn("claude", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", fail);
    child.on("close", (code) => {
      mkdirSync(TRANSCRIPTS, { recursive: true });
      // The transcript is what a failure is debugged from; the repo is not.
      writeFileSync(join(TRANSCRIPTS, `${name}.jsonl`), out);
      rmSync(cwd, { recursive: true, force: true });
      if (code !== 0) return fail(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      done(out.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    });
  });
}

/** What each hook printed, in order. */
function hookOutputs(events: Event[], hookEvent: string): string[] {
  return events
    .filter((e) => e.subtype === "hook_response" && e.hook_event === hookEvent)
    .map((e) => String(e.output ?? ""));
}

function payloads(events: Event[], hookEvent: string): Event[] {
  return hookOutputs(events, hookEvent)
    .filter((o) => o.trim().startsWith("{"))
    .map((o) => JSON.parse(o));
}

/** What the agent was handed when Stop held the turn. */
function stopFeedback(events: Event[]): string[] {
  return events
    .filter((e) => e.type === "user" && Array.isArray(e.message?.content))
    .flatMap((e) => e.message.content)
    .map((c: Event) => (typeof c.text === "string" ? c.text : ""))
    .filter((text: string) => text.startsWith("Stop hook feedback"));
}

/** What Claude Code showed the person. */
function shownToPerson(events: Event[]): string {
  return events
    .filter((e) => e.subtype === "informational")
    .map((e) => String(e.content ?? ""))
    .join("\n");
}

function agentSpokeAfterFeedback(events: Event[]): boolean {
  const feedback = events.findIndex(
    (e) => e.type === "user" && JSON.stringify(e.message?.content ?? "").includes("Stop hook feedback"),
  );
  return feedback !== -1 && events.slice(feedback).some((e) => e.type === "assistant");
}

function ended(events: Event[]): boolean {
  return events.some((e) => e.type === "result" && e.subtype === "success");
}

const sessions: Record<string, Promise<Event[]>> = {};

beforeAll(() => {
  execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "ignore" });

  // All at once: they are independent, and each takes tens of seconds.
  sessions.violation = runSession(
    "violation",
    { files: { "session.ts": VIOLATION } },
    "Say hello in one word.",
    NO_TOOLS,
  );
  sessions.exception = runSession(
    "exception",
    {
      files: { "session.ts": VIOLATION.replace("  localStorage", `  // qa-ignore: ${RULE} - this is test code\n  localStorage`) },
    },
    "Say hello in one word.",
    NO_TOOLS,
  );
  sessions.notes = runSession(
    "notes",
    {
      files: { "app.ts": NOTE },
    },
    "Say hello in one word.",
    NO_TOOLS,
  );
  sessions.broken = runSession(
    "broken",
    {
      files: {
        "qa.config.yaml": 'rules:\n  paths: ["local-rules"]\n',
        // No top-level `pack`, which the loader refuses.
        "local-rules/broken.yaml": "rules: []\n",
        "session.ts": VIOLATION,
      },
    },
    "Say hello in one word.",
    NO_TOOLS,
  );

  // Swallowed here so an unawaited rejection does not fail the whole file;
  // each test awaits its own session and fails on its own.
  for (const s of Object.values(sessions)) s.catch(() => undefined);
}, 60_000);

describe("Stop", () => {
  it("holds the turn on a corpus error and tells the agent why", async () => {
    const events = await sessions.violation;

    expect(payloads(events, "Stop")[0]?.decision).toBe("block");
    expect(payloads(events, "Stop")[0]?.systemMessage).toBeUndefined();
    expect(stopFeedback(events).join("\n")).toContain(RULE);
    expect(agentSpokeAfterFeedback(events)).toBe(true);
  });

  it("lets the turn end on the second pass and tells the person", async () => {
    const events = await sessions.violation;
    const stops = payloads(events, "Stop");

    expect(stops).toHaveLength(2);
    expect(stops[1].decision).toBeUndefined();
    expect(shownToPerson(events)).toContain("still stand");
    expect(ended(events)).toBe(true);
  });

  it("says nothing to anyone about what the corpus does not claim", async () => {
    const events = await sessions.notes;

    // It ran, and said nothing: silence from a hook that never ran looks the same.
    expect(hookOutputs(events, "Stop")).toHaveLength(1);
    expect(stopFeedback(events)).toEqual([]);
    expect(payloads(events, "Stop")).toEqual([]);
    expect(shownToPerson(events)).not.toContain("agentic-qa");
    expect(ended(events)).toBe(true);
  });

  it("does not hold the turn when it cannot run, and says so", async () => {
    const events = await sessions.broken;

    expect(stopFeedback(events)).toEqual([]);
    expect(shownToPerson(events)).toContain("could not run");
    expect(ended(events)).toBe(true);
  });

  it("is not released by an uncommitted qa-ignore, and shows the person the attempt", async () => {
    const events = await sessions.exception;

    expect(payloads(events, "Stop")[0]?.decision).toBe("block");
    expect(stopFeedback(events).join("\n")).toContain("not committed");
    expect(shownToPerson(events)).toContain(`session.ts:2 qa-ignore for ${RULE}`);
  });
});
