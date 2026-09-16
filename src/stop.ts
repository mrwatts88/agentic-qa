import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { loadRules } from "./rules/load.js";
import { selectFiles } from "./rules/select.js";
import { runMechanical } from "./rules/mechanical.js";
import { runLlmRules } from "./rules/llm.js";
import { checkContracts } from "./contracts/check.js";
import { changedFiles } from "./hook.js";

/**
 * The turn boundary: a Stop hook that runs when the agent finishes responding.
 *
 * This is the only agent-facing call site that can actually gate. PostToolUse
 * fires after a tool has already run, so it can report and nothing more; Stop
 * fires before the agent hands control back, so blocking it means the agent
 * fixes the problem while it still holds the context that produced it.
 *
 * It sees the whole turn rather than one file, which closes the hole in the
 * per-edit hook: that one matches Edit and Write, so anything changed another
 * way — a `sed` in Bash, a generator, a lockfile rewritten by an install —
 * never reaches it. The working tree does not care how a file was changed.
 *
 * It blocks at most once per turn. `stop_hook_active` is true when a Stop hook
 * has already blocked, and blocking again from there is how a session ends up
 * unable to finish. On the second pass it reports the same findings and lets
 * the turn end, so the worst case is one wasted round trip rather than a trap.
 */
export interface StopOptions {
  /** True when a Stop hook has already blocked the agent this turn. */
  stopHookActive: boolean;
  /** Whether to run the tiers that cost money and need the network. */
  judgment: boolean;
}

function emit(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

const FIX_OR_EXCUSE = [
  "Fix these before finishing. If one is genuinely intended, record it with a",
  "comment naming the rule, for example:",
  "  // qa-ignore: <rule-id> - why this case is different",
].join("\n");

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

    const findings: string[] = [];

    const mechanical = runMechanical(cwd, files, rules);
    for (const f of mechanical) {
      findings.push(`- ${f.file}:${f.line} ${f.statement} [${f.ruleId}]`);
    }

    // The enforcement ladder, applied at runtime rather than only when a rule
    // is written: there is no point paying a model to judge code that already
    // fails a pattern, and the pattern findings are the ones worth fixing first.
    const blocked = mechanical.some((f) => f.severity === "error");
    if (!blocked && options.judgment && scope) {
      const llm = await runLlmRules(cwd, files, rules, config, false, true);
      for (const f of llm.findings) {
        findings.push(`- ${f.file}:${f.line} ${f.statement} [${f.ruleId}]`);
      }

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

    if (!findings.length) return 0;

    const summary = `agentic-qa found ${findings.length} problem(s) in what this turn changed:`;

    if (options.stopHookActive) {
      // Already blocked once this turn. Say it again and get out of the way.
      emit({
        hookSpecificOutput: { hookEventName: "Stop" },
        additionalContext: [
          summary,
          "",
          ...findings,
          "",
          "Reported rather than blocked: this turn has already been held once.",
        ].join("\n"),
      });
      return 0;
    }

    emit({
      hookSpecificOutput: {
        hookEventName: "Stop",
        decision: "block",
        reason: [summary, "", ...findings, "", FIX_OR_EXCUSE].join("\n"),
      },
    });
  } catch (err) {
    // Never block on our own failure: a checker that traps the turn when it
    // breaks is worse than no checker. Surfaced, though, because silence from
    // a checker reads as approval.
    emit({
      hookSpecificOutput: { hookEventName: "Stop" },
      additionalContext: `agentic-qa could not run: ${(err as Error).message}`,
    });
  }

  return 0;
}
