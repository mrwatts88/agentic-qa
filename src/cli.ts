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
import { triggerGlobs } from "./rules/route.js";
import { runMechanical } from "./rules/mechanical.js";
import { evaluateRules, evaluateLlmRules } from "./rules/evaluate.js";
import { runLlmRules } from "./rules/llm.js";
import { glob } from "tinyglobby";

const USAGE = `agentic-qa - rule enforcement for AI-written code

Usage:
  agentic-qa rules [options]        check changed code against the rules corpus
  agentic-qa rules --llm            also run the rules that need a model's judgment
  agentic-qa contracts [options]    verify tests assert what their descriptions claim
  agentic-qa mutate [options]       break the code on purpose and check the tests notice
  agentic-qa eval [options]         score the judge against known-correct verdicts

Options:
  --all               re-judge every contract, ignoring the cached ledger
  --staged            only tests in files staged in git
  --model <name>      override judge model (haiku | sonnet | opus)
  --concurrency N     parallel judge processes
  --json              machine-readable output
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
      json: { type: "boolean", default: false },
      model: { type: "string" },
      concurrency: { type: "string" },
      expected: { type: "string" },
      llm: { type: "boolean", default: false },
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

    // Only walk the paths some active rule actually cares about.
    const files = values.staged
      ? stagedFiles(cwd)
      : await glob(triggerGlobs(rules), {
          cwd,
          ignore: config.ignore,
          absolute: false,
        });

    const findings = runMechanical(cwd, files, rules);

    // Opt-in: the llm tier costs money, so it never runs in a pre-commit hook.
    if (values.llm) {
      const llm = await runLlmRules(cwd, files, rules, config, values.all);
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

    if (values.expected) {
      return evaluateRules(cwd, values.expected, findings) ? 0 : 1;
    }

    if (values.json) {
      process.stdout.write(JSON.stringify(findings, null, 2) + "\n");
    } else {
      for (const f of findings) {
        const tag = f.severity === "error" ? pc.red("ERROR") : pc.yellow("WARN ");
        process.stdout.write(`${tag} ${pc.bold(f.file)}:${f.line}\n`);
        process.stdout.write(`  ${f.statement} ${pc.dim(`[${f.ruleId}]`)}\n`);
        process.stdout.write(`  ${pc.dim(f.excerpt)}\n\n`);
      }
      const errors = findings.filter((f) => f.severity === "error").length;
      process.stdout.write(
        pc.dim(
          `${rules.length} rules · ${files.length} files · ` +
            `${errors} error(s), ${findings.length - errors} warning(s)\n`,
        ),
      );
    }

    return findings.some((f) => f.severity === "error") ? 1 : 0;
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

  const summary = await checkContracts(config, {
    cwd,
    all: values.all,
    only: values.staged ? stagedFiles(cwd) : undefined,
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
