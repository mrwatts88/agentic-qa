#!/usr/bin/env node
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import pc from "picocolors";
import { loadConfig } from "./config.js";
import { checkContracts, report } from "./contracts/check.js";
import { runEval } from "./contracts/evaluate.js";

const USAGE = `agentic-qa - rule enforcement for AI-written code

Usage:
  agentic-qa contracts [options]    verify tests assert what their descriptions claim
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

  if (command !== "contracts") {
    process.stderr.write(pc.red(`unknown command: ${command}\n\n`) + USAGE);
    return 1;
  }

  const config = loadConfig(cwd);
  if (values.model) config.judge.model = values.model;
  if (values.concurrency) config.judge.concurrency = Number(values.concurrency);

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
