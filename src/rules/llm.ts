import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pc from "picocolors";
import type { QaConfig } from "../config.js";
import { judgeRule, RULE_JUDGE_VERSION } from "../judge.js";
import { pool } from "../pool.js";
import type { Finding, LlmEnforcement, Rule } from "./types.js";
import { rulesForFile } from "./route.js";
import { ExceptionGate, type RefusedException } from "./exceptions.js";

export const LLM_LEDGER_PATH = ".qa/rules.json";

export type LlmVerdict = "ok" | "violated" | "not-applicable";

export interface LlmRuleRecord {
  ruleId: string;
  file: string;
  fileHash: string;
  /**
   * Hash of the rule's own prompt. Editing one rule's prompt re-judges that
   * rule everywhere and leaves every other rule's cached verdicts alone.
   */
  promptHash: string;
  /**
   * The rule judge's shared system prompt and schema version. The promptHash
   * above only covers the rule's own question, so without this a change to the
   * system prompt leaves every cached verdict looking fresh — which is exactly
   * what bumping a judge version is supposed to prevent.
   */
  judgeVersion: number;
  model: string;
  verdict: LlmVerdict;
  reason: string;
  line?: number;
  checkedAt: string;
}

export interface LlmLedger {
  version: 1;
  records: Record<string, LlmRuleRecord>;
}

function hash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Insensitive to line endings and trailing whitespace, and nothing else.
 *
 * The contract ledger collapses all whitespace, and copying that here was
 * tempting but wrong. Reformatting a repo is a one-time adoption cost, not an
 * ongoing one, and rolling out a whitespace-insensitive hash costs exactly one
 * full re-judge — the thing it is supposed to save. It would also let a
 * reformat move the lines a cached verdict cites, with nothing noticing.
 *
 * The case that is genuinely ongoing is CRLF. A Windows checkout under
 * `core.autocrlf` changes every byte in every file, so every verdict in the
 * committed ledger misses, that developer re-judges the repo, and the ledger
 * they commit then misses for everyone else. Normalising line endings and
 * trailing whitespace stops that, and cannot shift a line number, because
 * neither transformation adds or removes a line.
 */
export function hashFileContents(text: string): string {
  return hash(
    text
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t]+$/gm, "")
      .replace(/\n+$/, "\n"),
  );
}

function key(ruleId: string, file: string): string {
  return `${ruleId}\u0000${file}`;
}

export function loadLlmLedger(cwd: string): LlmLedger {
  const path = resolve(cwd, LLM_LEDGER_PATH);
  if (!existsSync(path)) return { version: 1, records: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version === 1 && parsed.records) return parsed as LlmLedger;
  } catch {
    // A corrupt ledger is a cache, not a source of truth. Rebuild it.
  }
  return { version: 1, records: {} };
}

export function saveLlmLedger(cwd: string, ledger: LlmLedger): void {
  const path = resolve(cwd, LLM_LEDGER_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const sorted: Record<string, LlmRuleRecord> = {};
  for (const k of Object.keys(ledger.records).sort()) sorted[k] = ledger.records[k];
  writeFileSync(path, JSON.stringify({ version: 1, records: sorted }, null, 2) + "\n");
}

/**
 * The invalidation rule for rule verdicts, kept out of the run loop so it can
 * be tested without a model. Re-judge when the file changed, when this rule's
 * own question changed, when the shared judge prompt or schema changed, or when
 * the model changed. A verdict is only meaningful relative to all four.
 */
export function needsRuleJudging(
  prior: LlmRuleRecord | undefined,
  next: { fileHash: string; promptHash: string; model: string },
): boolean {
  if (!prior) return true;
  if (prior.fileHash !== next.fileHash) return true;
  if (prior.promptHash !== next.promptHash) return true;
  if (prior.judgeVersion !== RULE_JUDGE_VERSION) return true;
  if (prior.model !== next.model) return true;
  return false;
}

/**
 * Drop verdicts about files that are gone. Returns how many were removed.
 *
 * Deliberately keyed on the file being absent rather than on it being outside
 * this run's scope: a narrowed run has no view of the rest of the repo, and
 * deleting a verdict because this run did not happen to look at it would make
 * the committed ledger depend on how it was last invoked.
 */
export function pruneMissing(cwd: string, ledger: LlmLedger): number {
  let removed = 0;
  for (const k of Object.keys(ledger.records)) {
    if (!existsSync(resolve(cwd, ledger.records[k].file))) {
      delete ledger.records[k];
      removed++;
    }
  }
  return removed;
}

interface Job {
  rule: Rule;
  file: string;
  text: string;
  fileHash: string;
  promptHash: string;
}

export interface LlmSummary {
  findings: Finding[];
  records: LlmRuleRecord[];
  judged: number;
  cached: number;
  skipped: number;
  costUsd: number;
  /** qa-ignore comments that matched a violation but did not count. */
  refused: RefusedException[];
  /** Judgments due but not started before the deadline. */
  unjudged: number;
  /** Judgments that were attempted and failed. */
  errors: string[];
}

export async function runLlmRules(
  cwd: string,
  files: string[],
  rules: Rule[],
  config: QaConfig,
  all = false,
  /** True when the caller narrowed the file set, which disables pruning. */
  scoped = false,
  /** Which exceptions count; every one unless an automatic call site says otherwise. */
  gate = new ExceptionGate(),
  /** Epoch ms after which no new judgment starts. */
  deadline?: number,
): Promise<LlmSummary> {
  const ledger = loadLlmLedger(cwd);
  const model = config.judge.model;

  const jobs: Job[] = [];
  let skipped = 0;

  for (const file of files) {
    const applicable = rulesForFile(file, rules).filter((r) => r.tier === "llm");
    if (!applicable.length) continue;

    const abs = resolve(cwd, file);
    let text: string;
    try {
      // A huge file is both expensive and badly judged. Skip it loudly.
      if (statSync(abs).size > config.rules.llm.maxFileBytes) {
        skipped += applicable.length;
        continue;
      }
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }

    const fileHash = hashFileContents(text);
    for (const rule of applicable) {
      const promptHash = hash((rule.enforcement as LlmEnforcement).prompt);
      const prior = ledger.records[key(rule.id, file)];
      if (!all && !needsRuleJudging(prior, { fileHash, promptHash, model })) continue;
      jobs.push({ rule, file, text, fileHash, promptHash });
    }
  }

  let costUsd = 0;
  let started = 0;
  const errors: string[] = [];

  await pool(jobs, config.judge.concurrency, async (job) => {
    started++;
    try {
      const result = await judgeRule(job.rule, job.file, job.text, config);
      costUsd += result.costUsd;
      ledger.records[key(job.rule.id, job.file)] = {
        ruleId: job.rule.id,
        file: job.file,
        fileHash: job.fileHash,
        promptHash: job.promptHash,
        judgeVersion: RULE_JUDGE_VERSION,
        model,
        verdict: result.verdict,
        reason: result.reason,
        line: result.line,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      errors.push(`${job.rule.id} on ${job.file}: ${(err as Error).message}`);
    }
  }, deadline);

  for (const err of errors) {
    process.stderr.write(pc.yellow(`rule judge error  ${err}\n`));
  }

  // Only on an unscoped run, for the same reason contracts prunes that way.
  if (!scoped) pruneMissing(cwd, ledger);

  saveLlmLedger(cwd, ledger);

  // Report from the ledger, so cached verdicts still gate the build.
  const relevant: LlmRuleRecord[] = [];
  for (const file of files) {
    for (const rule of rulesForFile(file, rules).filter((r) => r.tier === "llm")) {
      const record = ledger.records[key(rule.id, file)];
      if (record) relevant.push(record);
    }
  }

  const byId = new Map(rules.map((r) => [r.id, r]));
  const findings: Finding[] = relevant
    .filter((r) => r.verdict === "violated")
    // Re-read here rather than reusing the judged text: a cached verdict never
    // loaded its file, and an exception has to work whether or not the verdict
    // happened to be fresh.
    .filter((r) => {
      try {
        return !gate.excusesInFile(r.file, readFileSync(resolve(cwd, r.file), "utf8"), r.ruleId);
      } catch {
        return true;
      }
    })
    .map((r) => {
      const rule = byId.get(r.ruleId);
      return {
        ruleId: r.ruleId,
        origin: "corpus" as const,
        statement: rule?.statement ?? r.ruleId,
        severity: rule?.severity ?? "error",
        file: r.file,
        line: r.line ?? 1,
        excerpt: r.reason,
        rationale: rule?.rationale ?? "",
      };
    });

  return {
    findings,
    records: relevant,
    judged: jobs.length,
    cached: relevant.length - jobs.length > 0 ? relevant.length - jobs.length : 0,
    skipped,
    costUsd,
    refused: gate.refused(),
    unjudged: jobs.length - started,
    errors,
  };
}
