import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import pc from "picocolors";
import { loadConfig, type QaConfig } from "./config.js";
import { loadRules } from "./rules/load.js";
import { selectFiles } from "./rules/select.js";
import { runMechanical, type Unenforced } from "./rules/mechanical.js";
import { runLlmRules } from "./rules/llm.js";
import type { Finding, Rule } from "./rules/types.js";
import type { Adapter } from "./rules/adapters/types.js";
import { checkContracts, report } from "./contracts/check.js";
import { adaptersFor, policyFor } from "./sites.js";

/**
 * The two call sites that gate by exit code: the commit hook and CI. Each reads
 * its row of the table in `src/sites.ts` rather than deciding for itself, which
 * is the point: before these existed, the commit hook ran whatever command
 * `init` had written into it, and CI ran whatever a workflow happened to list.
 */

export function stagedFiles(cwd: string): string[] {
  const out = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd,
    encoding: "utf8",
  });
  return out.split("\n").filter(Boolean);
}

/** Failing open locally is only acceptable if it is loud. */
export function printUnenforced(unenforced: Unenforced[]): void {
  for (const u of unenforced) {
    process.stderr.write(
      pc.yellow(`${u.tool} did not run: ${u.reason}\n`) +
        (u.rules.length ? pc.yellow(`  left unenforced: ${u.rules.join(", ")}\n`) : ""),
    );
  }
}

/**
 * Prints rule findings and returns whether any blocks: a corpus error, or any
 * gauntlet finding when the call site has opted in to enforcing the gauntlet.
 */
export function printFindings(
  findings: Finding[],
  rules: Rule[],
  files: string[],
  gauntletBlocks = false,
): boolean {
  const corpus = findings.filter((f) => f.origin === "corpus");
  const gauntlet = findings.filter((f) => f.origin === "gauntlet");

  for (const f of corpus) {
    const tag = f.severity === "error" ? pc.red("ERROR") : pc.yellow("WARN ");
    process.stdout.write(`${tag} ${pc.bold(f.file)}:${f.line}\n`);
    process.stdout.write(`  ${f.statement} ${pc.dim(`[${f.ruleId}]`)}\n`);
    process.stdout.write(`  ${pc.dim(f.excerpt)}\n\n`);
  }
  // One line each. Present only where a call site opted in, and then it blocks.
  for (const f of gauntlet) {
    process.stdout.write(
      `${pc.red("ERROR")} ${f.file}:${f.line} ${f.statement} ${pc.dim(`[${f.ruleId}]`)}\n`,
    );
  }
  if (gauntlet.length) process.stdout.write("\n");

  const errors = corpus.filter((f) => f.severity === "error").length;
  const gauntletNote = gauntletBlocks ? ` · ${gauntlet.length} gauntlet finding(s)` : "";
  process.stdout.write(
    pc.dim(
      `${rules.length} rules · ${files.length} files · ` +
        `${errors} error(s), ${corpus.length - errors} warning(s)${gauntletNote}\n`,
    ),
  );
  return errors > 0 || (gauntletBlocks && gauntlet.length > 0);
}

export interface GateOptions {
  /** The engine registry to choose from; every engine by default. Tests pass fakes. */
  registry?: Adapter[];
}

function load(cwd: string): { config: QaConfig; rules: Rule[] } {
  const config = loadConfig(cwd);
  const rules = loadRules(
    config.rules.paths.map((p) => resolve(cwd, p)),
    config.rules.packs,
  );
  return { config, rules };
}

/**
 * The commit hook: staged files, the commit row's scanners, never a model.
 * Exits 1 when a corpus error stands, which refuses the commit.
 */
export async function runCommit(cwd: string, options: GateOptions = {}): Promise<number> {
  const { config, rules } = load(cwd);
  const policy = policyFor("commit", config.callSites);

  // Narrowed by intersection, so the ignore list and the rules' own triggers
  // still apply to whatever happens to be staged.
  const files = await selectFiles(cwd, config, rules, stagedFiles(cwd));
  const result = await runMechanical(cwd, files, rules, {
    adapters: adaptersFor(policy, options.registry),
    gauntlet: policy.gauntlet,
  });

  printUnenforced(result.unenforced);
  return printFindings(result.findings, rules, files, policy.gauntlet) ? 1 : 0;
}

/**
 * Whether the judgment tiers can reach a model here. They ride on Claude Code's
 * login locally; a CI runner has none, so there they need an API key, and
 * without one they are skipped loudly rather than failed, so a fork's pull
 * request still gets the free tier.
 */
function judgmentAvailable(): boolean {
  return !process.env.CI || Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * CI: the whole repo, the ci row's scanners, and the judgment rules and test
 * contracts when the row says so. The authority, so it reports everything
 * rather than stopping at the first tier that fails. Exits 1 when any tier
 * found something that blocks.
 */
export async function runCi(cwd: string, options: GateOptions = {}): Promise<number> {
  const { config, rules } = load(cwd);
  const policy = policyFor("ci", config.callSites);

  const files = await selectFiles(cwd, config, rules);
  const result = await runMechanical(cwd, files, rules, {
    adapters: adaptersFor(policy, options.registry),
    gauntlet: policy.gauntlet,
  });
  const findings = [...result.findings];
  printUnenforced(result.unenforced);

  const wantsJudgment = policy.llm || policy.contracts;
  const canJudge = judgmentAvailable();
  if (wantsJudgment && !canJudge) {
    process.stderr.write(
      pc.yellow("judgment rules and test contracts skipped: no ANTHROPIC_API_KEY in CI\n"),
    );
  }

  if (policy.llm && canJudge) {
    const llm = await runLlmRules(cwd, files, rules, config);
    findings.push(...llm.findings);
    const cost = llm.costUsd > 0 ? ` · $${llm.costUsd.toFixed(3)}` : "";
    process.stderr.write(
      pc.dim(`llm tier: ${llm.judged} judged, ${llm.cached} cached, ${llm.skipped} skipped${cost}\n`),
    );
  }

  let failed = printFindings(findings, rules, files, policy.gauntlet);

  if (policy.contracts && canJudge) {
    const contracts = await checkContracts(config, { cwd, all: false, json: false });
    report(contracts, config);
    failed = failed || contracts.failed;
  }

  return failed ? 1 : 0;
}
