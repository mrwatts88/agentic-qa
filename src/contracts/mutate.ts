import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import type { QaConfig } from "../config.js";
import type {
  ExtractedTest,
  Ledger,
  MutationOutcome,
  Verdict,
} from "../types.js";
import { proposeMutation, MUTATION_VERSION } from "../judge.js";
import { extractRelativeImports } from "./extract.js";

/**
 * Mutation grounding: turn a model's opinion into an experiment.
 *
 * The contract judge says whether a test would catch its described behavior
 * breaking. That is still a judgment. Here we break the behavior for real and
 * watch what the test does.
 *
 *   judge said "upheld"   -> the test MUST fail under mutation
 *   judge said "violated" -> the test MUST still pass under mutation
 *
 * When reality disagrees with the judge, the judge was wrong, and we would
 * rather know that than trust it.
 */

type AssertionStatus = "passed" | "failed" | "skipped" | "missing";

/**
 * Exit codes cannot be used here. vitest exits 0 when `-t` matches nothing, so
 * a selector typo would look exactly like "the test passed despite the
 * mutation", which would condemn a perfectly good test. The per-assertion
 * status in the JSON report is the only trustworthy signal.
 */
function runSingleTest(
  root: string,
  test: ExtractedTest,
): AssertionStatus {
  try {
    execFileSync(
      "npx",
      [
        "vitest",
        "run",
        "--root",
        root,
        "-t",
        test.title,
        "--reporter=json",
      ],
      { stdio: "ignore", timeout: 120_000 },
    );
  } catch {
    // A failing test exits non-zero. That is a result, not an error.
  }

  const reportPath = resolve(root, ".vitest/json/output.json");
  if (!existsSync(reportPath)) return "missing";

  let report: any;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    return "missing";
  }

  for (const file of report.testResults ?? []) {
    for (const assertion of file.assertionResults ?? []) {
      const ancestors: string[] = assertion.ancestorTitles ?? [];
      const sameSuite =
        ancestors.length === test.describePath.length &&
        ancestors.every((a, i) => a === test.describePath[i]);
      if (sameSuite && assertion.title === test.title) {
        return assertion.status as AssertionStatus;
      }
    }
  }

  return "missing";
}

/** Only mutate files git can restore if this process dies mid-run. */
function isTrackedAndClean(cwd: string, absFile: string): boolean {
  try {
    const out = execFileSync("git", ["status", "--porcelain", "--", absFile], {
      cwd,
      encoding: "utf8",
    });
    return out.trim() === "";
  } catch {
    return false;
  }
}

function skip(reason: string): MutationOutcome {
  return { status: "skipped", reason, checkedAt: new Date().toISOString() };
}

export async function groundContract(
  test: ExtractedTest,
  verdict: Verdict,
  config: QaConfig,
  cwd: string,
): Promise<MutationOutcome & { costUsd: number }> {
  const none = { costUsd: 0 };

  if (verdict === "unverifiable") {
    return {
      ...skip("description is unverifiable, there is nothing to break"),
      ...none,
    };
  }

  const testAbs = resolve(cwd, test.file);
  const candidates = extractRelativeImports(testAbs).filter((p) =>
    existsSync(p),
  );

  if (!candidates.length) {
    return { ...skip("no local implementation imports found"), ...none };
  }

  const sources = candidates.map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));

  let proposal;
  try {
    proposal = await proposeMutation(test, sources, config);
  } catch (err) {
    return { ...skip(`proposal failed: ${(err as Error).message}`), ...none };
  }

  const target = sources.find((s) => s.path === proposal.file);
  if (!target) {
    return {
      ...skip(`model named a file that was not offered: ${proposal.file}`),
      costUsd: proposal.costUsd,
    };
  }

  const occurrences = target.text.split(proposal.oldStr).length - 1;
  if (occurrences !== 1) {
    return {
      ...skip(
        `mutation snippet appears ${occurrences} times in ${target.path}, need exactly 1`,
      ),
      costUsd: proposal.costUsd,
    };
  }

  if (!isTrackedAndClean(cwd, target.path)) {
    return {
      ...skip(
        `${target.path} is untracked or has uncommitted changes, refusing to mutate it`,
      ),
      costUsd: proposal.costUsd,
    };
  }

  const original = target.text;
  const mutated = original.replace(proposal.oldStr, proposal.newStr);
  if (mutated === original) {
    return {
      ...skip("mutation produced no change"),
      costUsd: proposal.costUsd,
    };
  }

  let status: AssertionStatus;
  try {
    writeFileSync(target.path, mutated);
    status = runSingleTest(resolve(cwd, config.mutation.root), test);
  } finally {
    // Always restore, including on throw. git is the backstop, this is the belt.
    writeFileSync(target.path, original);
  }

  const checkedAt = new Date().toISOString();
  const common = {
    file: target.path,
    mutation: proposal.explanation,
    checkedAt,
    costUsd: proposal.costUsd,
  };

  if (status === "missing" || status === "skipped") {
    return {
      ...common,
      status: "skipped",
      reason: `the test did not run under mutation (status: ${status}), so nothing was measured`,
    };
  }

  const shouldFail = verdict === "upheld";
  const didFail = status === "failed";

  if (shouldFail === didFail) {
    return {
      ...common,
      status: "confirmed",
      reason: shouldFail
        ? "the test failed when the described behavior was broken, so it is real"
        : "the test still passed when the described behavior was broken, confirming it does not verify its description",
    };
  }

  return {
    ...common,
    status: "refuted",
    reason: shouldFail
      ? "the judge called this test real, but it still passed when the described behavior was broken"
      : "the judge called this test weak, but it failed when the described behavior was broken",
  };
}

export interface MutationSummary {
  confirmed: number;
  refuted: number;
  skipped: number;
  costUsd: number;
}

/**
 * Strictly serial. These write to real source files, so running two at once
 * would corrupt both.
 */
export async function groundAll(
  tests: ExtractedTest[],
  ledger: Ledger,
  config: QaConfig,
  cwd: string,
  all: boolean,
): Promise<MutationSummary> {
  const summary: MutationSummary = {
    confirmed: 0,
    refuted: 0,
    skipped: 0,
    costUsd: 0,
  };

  for (const test of tests) {
    const record = ledger.records[test.id];
    if (!record) continue;
    if (!all && record.mutation && record.mutationVersion === MUTATION_VERSION) {
      continue;
    }

    const outcome = await groundContract(test, record.verdict, config, cwd);
    summary.costUsd += outcome.costUsd;
    summary[outcome.status] += 1;

    record.mutation = {
      status: outcome.status,
      reason: outcome.reason,
      file: outcome.file,
      mutation: outcome.mutation,
      checkedAt: outcome.checkedAt,
    };
    record.mutationVersion = MUTATION_VERSION;

    const label =
      outcome.status === "confirmed"
        ? pc.green("CONFIRMED")
        : outcome.status === "refuted"
          ? pc.red("REFUTED  ")
          : pc.dim("SKIPPED  ");

    process.stdout.write(`${label} ${test.title}\n`);
    process.stdout.write(`  ${pc.dim(outcome.reason)}\n`);
    if (outcome.mutation) {
      process.stdout.write(`  ${pc.dim("broke:")} ${outcome.mutation}\n`);
    }
    process.stdout.write("\n");
  }

  return summary;
}
