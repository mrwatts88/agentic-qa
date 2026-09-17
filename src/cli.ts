#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import pc from "picocolors";
import { loadConfig } from "./config.js";
import { checkContracts, collectTests, report } from "./contracts/check.js";
import { runEval } from "./contracts/evaluate.js";
import { groundAll } from "./contracts/mutate.js";
import { loadLedger, saveLedger } from "./contracts/ledger.js";
import { loadRules } from "./rules/load.js";
import { runHook, readHookPayload } from "./hook.js";
import { runStop } from "./stop.js";
import { runInit, installHooks, prepareLine } from "./init.js";
import { selectFiles } from "./rules/select.js";
import { runMechanical } from "./rules/mechanical.js";
import { evaluateRules, evaluateLlmRules } from "./rules/evaluate.js";
import { runLlmRules } from "./rules/llm.js";

const USAGE = `agentic-qa - rule enforcement for AI-written code

Usage:
  agentic-qa init [options]         write qa.config.yaml; add call sites only if asked
  agentic-qa install-hooks          point core.hooksPath at hooks/ (run from prepare)
  agentic-qa hook                   PostToolUse hook: report on what just changed
  agentic-qa stop                   Stop hook: check the whole turn, block once on findings
  agentic-qa rules [options]        check changed code against the rules corpus
  agentic-qa rules --llm            also run the rules that need a model's judgment
  agentic-qa contracts [options]    verify tests assert what their descriptions claim
  agentic-qa mutate [options]       break the code on purpose and check the tests notice
  agentic-qa eval [options]         score the judge against known-correct verdicts

Options:
  --git-hook          (init) commit gate: tracked hooks/pre-commit + prepare script
  --claude-hook       (init) Claude Code PostToolUse and Stop hooks in .claude/settings.json
  --force             (init) replace existing hook wiring; never touches qa.config.yaml
  --all               re-judge every contract, ignoring the cached ledger
  --staged            only tests in files staged in git
  --model <name>      override judge model (haiku | sonnet | opus)
  --concurrency N     parallel judge processes
  --json              machine-readable output
  --file <path>       restrict to a single file, for cheap iteration
  --runner <cmd>      how installed hooks invoke this tool (default: npx agentic-qa)
  --expected <path>   expectations file for eval (default: expected.json)
  -h, --help
`;

function stagedFiles(cwd: string): string[] {
  const out = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: "boolean", default: false },
      staged: { type: "boolean", default: false },
      "git-hook": { type: "boolean", default: false },
      "claude-hook": { type: "boolean", default: false },
      mechanical: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      model: { type: "string" },
      concurrency: { type: "string" },
      expected: { type: "string" },
      llm: { type: "boolean", default: false },
      file: { type: "string" },
      runner: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const cwd = process.cwd();

  if (command === "eval") {
    return runEval(cwd, values.expected ?? "expected.json") ? 0 : 1;
  }

  // Claude Code runs hooks in the session's current directory, which drifts
  // whenever the agent cd's into a subdirectory. The checks are keyed on the
  // repo root (config, globs, git's root-relative paths), so the hooks anchor
  // there rather than wherever the shell happened to be left.
  const hookCwd = process.env.CLAUDE_PROJECT_DIR || cwd;

  // Always succeeds: it reports to the agent, it does not gate anything.
  if (command === "hook") {
    const { filePath } = await readHookPayload();
    return runHook(hookCwd, filePath);
  }

  // Also always exits zero: it blocks through the decision field, not the exit
  // code, so a crash here can never trap a turn.
  if (command === "stop") {
    const { stopHookActive } = await readHookPayload();
    return runStop(hookCwd, {
      stopHookActive: stopHookActive ?? false,
      judgment: !values.mechanical,
    });
  }

  // Runs from the repo's prepare script on every npm install, so it must stay
  // quiet and must never fail an install.
  if (command === "install-hooks") {
    const result = installHooks(cwd);
    if (result.installed) process.stderr.write(pc.dim(`agentic-qa: ${result.why}\n`));
    return 0;
  }

  if (command === "init") {
    const runner = values.runner ?? "npx agentic-qa";
    const gitHook = values["git-hook"];
    const claudeHook = values["claude-hook"];
    const result = runInit(cwd, runner, { gitHook, claudeHook, force: values.force });

    for (const path of result.written) {
      process.stdout.write(`${pc.green("wrote")}   ${path}\n`);
    }
    for (const path of result.replaced) {
      process.stdout.write(`${pc.green("replaced")} ${path}\n`);
    }
    for (const path of result.updated) {
      process.stdout.write(`${pc.green("set")}     ${path}\n`);
    }
    for (const skip of result.skipped) {
      process.stdout.write(`${pc.yellow("skipped")} ${skip.path} ${pc.dim(`(${skip.why})`)}\n`);
    }

    // Leaving a file alone is the safe default, but it is silent about being
    // out of date: a repo set up by an older version keeps its old hook wiring
    // and looks perfectly installed. Say so.
    const stale = result.skipped.filter((s) => s.why.includes("--force"));
    if (stale.length) {
      process.stdout.write(
        pc.yellow(
          `\n${stale.length} existing file(s) left alone, so this repo may be missing\n` +
            "call sites added since it was set up. Re-run with --force to replace\n" +
            "them. qa.config.yaml is never replaced.\n",
        ),
      );
    }

    if (gitHook) {
      process.stdout.write(
        pc.dim(
          "\nCommit hooks/pre-commit. It is tracked on purpose: a hook under\n" +
            ".git/hooks reaches only whoever ran init, so the gate would be\n" +
            "per-developer. The prepare script points core.hooksPath at it on\n" +
            `every npm install: ${prepareLine(runner)}\n` +
            "It runs the free mechanical tier only.\n",
        ),
      );
    }

    // Nothing is installed that was not asked for, so say what was not.
    if (!gitHook || !claudeHook) {
      const offer = [
        gitHook ? null : "  --git-hook      gate commits on the free mechanical tier",
        claudeHook ? null : "  --claude-hook   report violations back to Claude after each edit",
      ].filter(Boolean);
      process.stdout.write(
        pc.dim(`\nNot installed. Re-run init with a flag to opt in:\n${offer.join("\n")}\n`),
      );
    }

    process.stdout.write(
      pc.dim("\nRun the judgment rules in CI with: agentic-qa rules --llm\n"),
    );
    return 0;
  }

  if (command !== "contracts" && command !== "mutate" && command !== "rules") {
    process.stderr.write(pc.red(`unknown command: ${command}\n\n`) + USAGE);
    return 1;
  }

  const config = loadConfig(cwd);
  if (values.model) config.judge.model = values.model;
  if (values.concurrency) config.judge.concurrency = Number(values.concurrency);

  if (command === "rules") {
    const rules = loadRules(
      config.rules.paths.map((p) => resolve(cwd, p)),
      config.rules.packs,
    );

    // Walks only the paths some active rule cares about, and narrows by
    // intersection so --staged still respects the ignore list.
    const files = await selectFiles(
      cwd,
      config,
      rules,
      values.staged ? stagedFiles(cwd) : undefined,
    );

    const mechanical = await runMechanical(cwd, files, rules);
    const findings = mechanical.findings;

    // Failing open locally is only acceptable if it is loud.
    for (const u of mechanical.unenforced) {
      process.stderr.write(
        pc.yellow(`${u.tool} did not run: ${u.reason}\n`) +
          (u.rules.length
            ? pc.yellow(`  left unenforced: ${u.rules.join(", ")}\n`)
            : ""),
      );
    }

    // Opt-in: the llm tier costs money, so it never runs in a pre-commit hook.
    if (values.llm) {
      const llm = await runLlmRules(cwd, files, rules, config, values.all, values.staged);
      findings.push(...llm.findings);

      if (values.expected) {
        return evaluateLlmRules(cwd, values.expected, llm.records) ? 0 : 1;
      }

      const cost = llm.costUsd > 0 ? ` · $${llm.costUsd.toFixed(3)}` : "";
      process.stderr.write(
        pc.dim(
          `llm tier: ${llm.judged} judged, ${llm.cached} cached, ` +
            `${llm.skipped} skipped${cost}\n`,
        ),
      );
    }

    const corpus = findings.filter((f) => f.origin === "corpus");
    const gauntlet = findings.filter((f) => f.origin === "gauntlet");

    // Scored against the corpus only. A clean control promises that no corpus
    // rule fires on it; nothing ever promised the gauntlet would stay quiet.
    if (values.expected) {
      return evaluateRules(cwd, values.expected, corpus) ? 0 : 1;
    }

    if (values.json) {
      process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
    } else {
      for (const f of corpus) {
        const tag = f.severity === "error" ? pc.red("ERROR") : pc.yellow("WARN ");
        process.stdout.write(`${tag} ${pc.bold(f.file)}:${f.line}\n`);
        process.stdout.write(`  ${f.statement} ${pc.dim(`[${f.ruleId}]`)}\n`);
        process.stdout.write(`  ${pc.dim(f.excerpt)}\n\n`);
      }
      // One line each: the gauntlet is there to be seen, not to dominate.
      for (const f of gauntlet) {
        process.stdout.write(
          `${pc.dim("note ")} ${f.file}:${f.line} ${f.statement} ${pc.dim(`[${f.ruleId}]`)}\n`,
        );
      }
      if (gauntlet.length) process.stdout.write("\n");

      const errors = corpus.filter((f) => f.severity === "error").length;
      process.stdout.write(
        pc.dim(
          `${rules.length} rules · ${files.length} files · ` +
            `${errors} error(s), ${corpus.length - errors} warning(s) · ` +
            `${gauntlet.length} gauntlet note(s), not blocking\n`,
        ),
      );
    }

    return corpus.some((f) => f.severity === "error") ? 1 : 0;
  }

  if (command === "mutate") {
    const tests = await collectTests(
      config,
      cwd,
      values.staged ? stagedFiles(cwd) : undefined,
    );
    const ledger = loadLedger(cwd);
    const summary = await groundAll(tests, ledger, config, cwd, values.all);
    saveLedger(cwd, ledger);

    const cost = summary.costUsd > 0 ? ` · $${summary.costUsd.toFixed(3)}` : "";
    process.stdout.write(
      pc.dim(
        `${summary.confirmed} confirmed, ${summary.refuted} refuted, ` +
          `${summary.skipped} skipped${cost}\n`,
      ),
    );
    // A refuted verdict means the judge was wrong, which is worth failing on.
    return summary.refuted > 0 ? 1 : 0;
  }

  const only = values.file
    ? [values.file]
    : values.staged
      ? stagedFiles(cwd)
      : undefined;

  const summary = await checkContracts(config, {
    cwd,
    all: values.all,
    only,
    json: values.json,
  });

  if (values.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } else {
    report(summary, config);
  }

  return summary.failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(pc.red(`${err.stack ?? err}\n`));
    process.exit(2);
  },
);
