import { resolve, relative } from "node:path";
import { glob } from "tinyglobby";
import pc from "picocolors";
import type { ContractRecord, ExtractedTest, Ledger } from "../types.js";
import type { QaConfig } from "../config.js";
import { extractTests } from "./extract.js";
import {
  bodyHash,
  descriptionHash,
  loadLedger,
  needsJudging,
  prune,
  saveLedger,
} from "./ledger.js";
import { judgeContract, JUDGE_VERSION } from "../judge.js";
import { pool } from "../pool.js";

export interface CheckOptions {
  cwd: string;
  all: boolean;
  /** Restrict to these repo-relative files (e.g. the staged set). */
  only?: string[];
  json: boolean;
}

export interface CheckSummary {
  checked: number;
  cached: number;
  violated: ContractRecord[];
  unverifiable: ContractRecord[];
  costUsd: number;
  failed: boolean;
}

/** Shared by every command that needs to know what tests exist. */
export async function collectTests(
  config: QaConfig,
  cwd: string,
  only?: string[],
): Promise<ExtractedTest[]> {
  const files = await glob(config.testGlobs, {
    cwd,
    ignore: config.ignore,
    absolute: false,
  });

  const scoped = only ? files.filter((f) => only.includes(f)) : files;

  const tests: ExtractedTest[] = [];
  for (const file of scoped) {
    tests.push(...extractTests(resolve(cwd, file), file));
  }
  return tests;
}

export async function checkContracts(
  config: QaConfig,
  options: CheckOptions,
): Promise<CheckSummary> {
  const tests = await collectTests(config, options.cwd, options.only);

  const ledger: Ledger = loadLedger(options.cwd);
  const model = config.judge.model;

  const pending = options.all
    ? tests
    : tests.filter((t) => needsJudging(t, ledger, model));

  if (!options.json && pending.length) {
    process.stderr.write(
      pc.dim(
        `judging ${pending.length} of ${tests.length} contracts (${tests.length - pending.length} cached)\n`,
      ),
    );
  }

  let costUsd = 0;
  const errors: string[] = [];

  await pool(pending, config.judge.concurrency, async (test) => {
    try {
      const result = await judgeContract(test, config);
      costUsd += result.costUsd;
      ledger.records[test.id] = {
        id: test.id,
        file: test.file,
        description: test.description,
        descriptionSource: test.descriptionSource,
        descriptionHash: descriptionHash(test),
        bodyHash: bodyHash(test),
        verdict: result.verdict,
        reason: result.reason,
        weakestAssertion: result.weakestAssertion,
        suggestedMutation: result.suggestedMutation,
        model,
        judgeVersion: JUDGE_VERSION,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      errors.push(`${test.id}: ${(err as Error).message}`);
    }
  });

  // Only prune when we looked at the whole suite; a scoped run has no view
  // of tests outside its scope and must not delete their verdicts.
  if (!options.only) prune(ledger, new Set(tests.map((t) => t.id)));
  saveLedger(options.cwd, ledger);

  const live = tests.map((t) => ledger.records[t.id]).filter(Boolean);
  const violated = live.filter((r) => r.verdict === "violated");
  const unverifiable = live.filter((r) => r.verdict === "unverifiable");

  for (const err of errors) {
    process.stderr.write(pc.yellow(`judge error  ${err}\n`));
  }

  return {
    checked: pending.length,
    cached: tests.length - pending.length,
    violated,
    unverifiable,
    costUsd,
    failed:
      violated.length > 0 ||
      (config.failOnUnverifiable && unverifiable.length > 0),
  };
}

export function report(summary: CheckSummary, config: QaConfig): void {
  const line = (r: ContractRecord, label: string, color: (s: string) => string) => {
    process.stdout.write(`${color(label)} ${pc.bold(r.file)}\n`);
    process.stdout.write(`  ${pc.dim("claims:")} ${r.description}\n`);
    process.stdout.write(`  ${pc.dim("why:")}    ${r.reason}\n`);
    if (r.suggestedMutation) {
      process.stdout.write(`  ${pc.dim("proof:")}  ${r.suggestedMutation}\n`);
    }
    process.stdout.write("\n");
  };

  for (const r of summary.violated) line(r, "VIOLATED", pc.red);
  for (const r of summary.unverifiable) {
    line(r, config.failOnUnverifiable ? "UNVERIFIABLE" : "VAGUE", pc.yellow);
  }

  const cost = summary.costUsd > 0 ? ` · $${summary.costUsd.toFixed(3)}` : "";
  process.stdout.write(
    pc.dim(
      `${summary.checked} judged, ${summary.cached} cached${cost} · ` +
        `${summary.violated.length} violated, ${summary.unverifiable.length} unverifiable\n`,
    ),
  );
}
