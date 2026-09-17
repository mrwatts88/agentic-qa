import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { loadRules } from "./rules/load.js";
import { selectFiles } from "./rules/select.js";
import { runMechanical } from "./rules/mechanical.js";
import type { Adapter } from "./rules/adapters/types.js";
import type { Finding } from "./rules/types.js";
import { adaptersFor, policyFor } from "./sites.js";
import { runLlmRules } from "./rules/llm.js";
import { checkContracts } from "./contracts/check.js";
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
 * It blocks at most once per turn. `stop_hook_active` is true when a Stop hook
 * has already blocked, and blocking again from there is how a session ends up
 * unable to finish. On the second pass it reports the same findings and lets
 * the turn end, so the worst case is one wasted round trip rather than a trap.
 */
export interface StopOptions {
  /** True when a Stop hook has already blocked the agent this turn. */
  stopHookActive: boolean;
  /**
   * False switches off the judgment rules and test contracts whatever the
   * call-site policy says: `--mechanical`, an override of the same table.
   */
  judgment?: boolean;
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

/** Notes from the slow engines. Stop stops showing notes at all: ROADMAP Next 1. */
const NOTE_LIMIT = 15;

/**
 * A judged finding, worded so the agent can act on it. The statement names the
 * principle; only the judge's reason says what it saw in this file, and the
 * rationale says why it matters. Without them a block reads as "you broke rule
 * X" with nothing to fix.
 */
export function judgedLines(f: Pick<Finding, "file" | "line" | "statement" | "ruleId" | "excerpt" | "rationale">): string {
  return [
    `- ${f.file}:${f.line} ${f.statement} [${f.ruleId}]`,
    ...(f.excerpt ? [`  What the judge saw: ${f.excerpt}`] : []),
    ...(f.rationale ? [`  Why it matters: ${f.rationale}`] : []),
  ].join("\n");
}

function noteLines(notes: Finding[]): string[] {
  const shown = notes.slice(0, NOTE_LIMIT).map((f) => `- ${f.file}:${f.line} ${f.statement} [${f.ruleId}]`);
  const more = notes.length - shown.length;
  return more > 0 ? [...shown, `- ...and ${more} more (run: agentic-qa rules)`] : shown;
}

export async function runStop(cwd: string, options: StopOptions): Promise<number> {
  try {
    const config = loadConfig(cwd);
    const rules = loadRules(
      config.rules.paths.map((p) => resolve(cwd, p)),
      config.rules.packs,
    );

    // What this turn touched, however it touched it. Outside a git repo there
    // is no such thing, and judging the entire repo on every turn would be an
    // unpleasant surprise on someone's bill, so the paid tiers stay off.
    const scope = changedFiles(cwd);
    const files = await selectFiles(cwd, config, rules, scope);
    if (!files.length) return 0;

    const policy = policyFor("stop", config.callSites);
    const adapters = options.adapters ?? adaptersFor(policy);
    // One gate for both tiers, so an exception refused by either is listed once.
    const gate = new ExceptionGate(committedOnly(cwd));
    const result = await runMechanical(cwd, files, rules, { adapters, exceptions: gate });

    const findings: string[] = [];
    const mechanical = result.findings.filter((f) => f.origin === "corpus");
    for (const f of mechanical) {
      findings.push(`- ${f.file}:${f.line} ${f.statement} [${f.ruleId}]`);
    }

    // Only the slow engines' notes, a leftover from when the per-edit hook showed
    // the fast ones. Due to go: automatic call sites report the corpus only.
    const slowTools = new Set(adapters.filter((a) => a.slow).map((a) => `${a.tool}:`));
    const notes = result.findings.filter(
      (f) => f.origin === "gauntlet" && [...slowTools].some((t) => f.ruleId.startsWith(t)),
    );

    // The enforcement ladder, applied at runtime rather than only when a rule
    // is written: there is no point paying a model to judge code that already
    // fails a pattern, and the pattern findings are the ones worth fixing first.
    const blocked = mechanical.some((f) => f.severity === "error");
    const judgment = options.judgment !== false;
    if (!blocked && judgment && scope) {
      if (policy.llm) {
        const llm = await runLlmRules(cwd, files, rules, config, false, true, gate);
        for (const f of llm.findings) findings.push(judgedLines(f));
      }

      if (policy.contracts) {
        const contracts = await checkContracts(config, {
          cwd,
          all: false,
          only: scope,
          json: true,
        });
        for (const r of contracts.violated) {
          findings.push(`- ${r.file} claims "${r.description}" — ${r.reason}`);
        }
      }
    }

    const unenforced = result.unenforced.map(
      (u) => `${u.tool} did not run (${u.reason})${u.rules.length ? `; unchecked: ${u.rules.join(", ")}` : ""}`,
    );

    // Shown to the person on every pass, blocked or not: an attempted exception
    // is exactly the thing they need to see rather than find later in a diff.
    const refused = gate.refused();
    const refusedSection = refused.length
      ? [
          `agentic-qa: ${refused.length} qa-ignore comment(s) are not committed, so they were not honoured:`,
          ...refusedLines(refused),
          "An exception takes effect once you commit it.",
        ]
      : [];

    const noteSection = notes.length
      ? [`Scanners also noted ${notes.length} thing(s). These never block:`, ...noteLines(notes)]
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
          ...(noteSection.length ? ["", ...noteSection] : []),
        ].join("\n"),
        ...(refusedSection.length ? { systemMessage: refusedSection.join("\n") } : {}),
      });
      return 0;
    }

    // Nothing to hold the turn for, or it has already been held once. Tell the
    // person and let the turn end: blocking again is how a session becomes
    // unable to finish, and anything addressed to the agent would continue it.
    const message = [
      ...(findings.length
        ? [
            `agentic-qa: ${findings.length} problem(s) still stand after this turn was held once:`,
            ...findings,
          ]
        : []),
      ...refusedSection,
      ...(noteSection.length ? [`agentic-qa: ${noteSection[0]}`, ...noteSection.slice(1)] : []),
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
