import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { loadRules } from "./rules/load.js";
import { selectFiles } from "./rules/select.js";
import { runMechanical } from "./rules/mechanical.js";
import type { Adapter } from "./rules/adapters/types.js";
import { adaptersFor, policyFor } from "./sites.js";
import { changedFiles, EXCEPTIONS_ARE_APPROVED, refusedLines } from "./hook.js";
import { committedOnly, ExceptionGate } from "./rules/exceptions.js";

/**
 * The turn boundary: a Stop hook that runs when the agent finishes responding.
 *
 * The only agent-facing call site. Stop fires before the agent hands control
 * back, so blocking it means the agent fixes the problem while it still holds
 * the context that produced it.
 *
 * It checks the working tree, not a list of edits, so a change made any way —
 * a `sed` in Bash, a generator, a lockfile rewritten by an install — is seen.
 *
 * Mechanical rules only. Judging a turn's changes took minutes and dozens of
 * model calls in a real session, overran the hook's timeout and checked
 * nothing; judgment runs on demand and in CI instead.
 *
 * It blocks at most once per turn. `stop_hook_active` is true when a Stop hook
 * has already blocked, and blocking again from there is how a session ends up
 * unable to finish. On the second pass it reports the same findings and lets
 * the turn end, so the worst case is one wasted round trip rather than a trap.
 */
export interface StopOptions {
  /** True when a Stop hook has already blocked the agent this turn. */
  stopHookActive: boolean;
  /** The engines to run; the policy's by default. Tests pass the fast ones. */
  adapters?: Adapter[];
}

/**
 * The output shapes, each verified against a real headless Claude Code run
 * rather than read off a page, because the first version got them wrong and
 * its tests only checked what it emitted:
 *
 * - top-level `decision: "block"` with `reason` holds the turn. Nested inside
 *   `hookSpecificOutput`, as this hook shipped for a while, it is ignored, so
 *   the hook looked wired and never blocked anything.
 * - `hookSpecificOutput.additionalContext` also keeps the agent going. It is
 *   not a passive note, so it is never used for anything that must not hold
 *   the turn.
 * - `systemMessage` is shown to the person and lets the turn end.
 */
function emit(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

const FIX_OR_EXCUSE = `Fix these before finishing.\n${EXCEPTIONS_ARE_APPROVED}`;

export async function runStop(cwd: string, options: StopOptions): Promise<number> {
  try {
    const config = loadConfig(cwd);
    const rules = loadRules(
      config.rules.paths.map((p) => resolve(cwd, p)),
      config.rules.packs,
    );

    // What this turn touched, however it touched it.
    const scope = changedFiles(cwd);
    const files = await selectFiles(cwd, config, rules, scope);
    if (!files.length) return 0;

    const policy = policyFor("stop", config.callSites);
    const adapters = options.adapters ?? adaptersFor(policy);
    const gate = new ExceptionGate(committedOnly(cwd));
    // The corpus only. Unvetted scanner output shown to the agent taught it to
    // skip hook output altogether; that is `agentic-qa gauntlet`, run by a person.
    const result = await runMechanical(cwd, files, rules, {
      adapters,
      exceptions: gate,
      gauntlet: false,
    });

    const findings = result.findings
      .filter((f) => f.origin === "corpus")
      .map((f) => `- ${f.file}:${f.line} ${f.statement} [${f.ruleId}]`);

    const unenforced = result.unenforced.map(
      (u) => `${u.tool} did not run (${u.reason})${u.rules.length ? `; unchecked: ${u.rules.join(", ")}` : ""}`,
    );

    // An attempted exception is exactly what the person needs to see rather than
    // find later in a diff. It always comes with a finding that still stands, so
    // it reaches them with the second pass.
    const refused = gate.refused();
    const refusedSection = refused.length
      ? [
          `agentic-qa: ${refused.length} qa-ignore comment(s) are not committed, so they were not honoured:`,
          ...refusedLines(refused),
          "An exception takes effect once you commit it.",
        ]
      : [];

    if (findings.length && !options.stopHookActive) {
      const summary = `agentic-qa found ${findings.length} problem(s) in what this turn changed:`;
      emit({
        decision: "block",
        reason: [
          summary, "", ...findings, "", FIX_OR_EXCUSE,
          ...(refused.length
            ? ["", "These qa-ignore comments are not committed, so they do not count:", ...refusedLines(refused)]
            : []),
        ].join("\n"),
      });
      return 0;
    }

    // Nothing to hold the turn for, or it has already been held once. The person
    // hears only when a block did not work, or when a check could not run; a
    // clean turn says nothing. Blocking again is how a session becomes unable
    // to finish, and anything addressed to the agent would continue it.
    const message = [
      ...(findings.length
        ? [
            `agentic-qa: ${findings.length} problem(s) still stand after this turn was held once:`,
            ...findings,
          ]
        : []),
      ...refusedSection,
      ...unenforced.map((u) => `agentic-qa: ${u}`),
    ];
    if (message.length) emit({ systemMessage: message.join("\n") });
  } catch (err) {
    // Never block on our own failure: a checker that traps the turn when it
    // breaks is worse than no checker. Surfaced, though, because silence from
    // a checker reads as approval.
    emit({ systemMessage: `agentic-qa could not run: ${(err as Error).message}` });
  }

  return 0;
}
