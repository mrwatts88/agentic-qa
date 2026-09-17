import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Finding, PatternEnforcement, Rule } from "./types.js";
import type { Adapter } from "./adapters/types.js";
import { defaultAdapters } from "./adapters/index.js";
import { ruleAppliesTo, rulesForFile } from "./route.js";
import { ExceptionGate, type RefusedException } from "./exceptions.js";

/**
 * The free tier. Cost nothing and exactly repeatable. Most of a rules corpus
 * belongs here; paying a model to check something a linter can check is slower
 * and less complete.
 *
 * This is a conductor. Real engines do the finding, through adapters, and a
 * hand-written pattern is what a rule uses only when no engine covers it. What
 * stays here is everything that must be the same for every engine: which
 * findings the corpus promised and therefore block, qa-ignore, and refusing to
 * report a clean run for a tool that never ran.
 */

const WITHHELD = "(source line withheld: it contains a secret)";

/**
 * Patterns are matched against the whole file rather than line by line,
 * because some of them legitimately span a line break (an assertion followed
 * by the closing brace of its test, for instance). Line numbers are recovered
 * from the match offset.
 */
function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function patternFindings(
  rule: Rule,
  enforcement: PatternEnforcement,
  file: string,
  text: string,
  lines: string[],
  gate: ExceptionGate,
): Finding[] {
  // Companion patterns get the rule's own flags, so `flags: i` applies to them
  // too. `g` is stripped because a global regex makes `.test` stateful through
  // lastIndex, which would make these checks alternate between calls.
  const companionFlags = `${(enforcement.flags ?? "").replace(/g/g, "")}m`;

  if (enforcement.unlessFilePattern) {
    const exempt = new RegExp(enforcement.unlessFilePattern, companionFlags);
    if (exempt.test(text)) return [];
  }

  if (enforcement.requireFilePattern) {
    const required = new RegExp(enforcement.requireFilePattern, companionFlags);
    if (!required.test(text)) return [];
  }

  const flags = enforcement.flags ?? "";
  const regex = new RegExp(
    enforcement.pattern,
    flags.includes("g") ? flags : `${flags}g`,
  );

  const findings: Finding[] = [];
  for (const match of text.matchAll(regex)) {
    const line = lineOf(text, match.index ?? 0);
    if (gate.excusesAt(file, lines, line - 1, rule.id)) continue;

    findings.push({
      ruleId: rule.id,
      origin: "corpus",
      statement: rule.statement,
      severity: rule.severity,
      file,
      line,
      excerpt: rule.redact ? WITHHELD : (lines[line - 1] ?? "").trim().slice(0, 160),
      rationale: rule.rationale,
    });
  }
  return findings;
}

/** One finding per rule per file: repeating the same rule ten times is noise. */
function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.ruleId} ${f.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A tool that could not run, and the corpus promises that went unkept. */
export interface Unenforced {
  tool: string;
  reason: string;
  /** Corpus rules routed to the checked files that this tool was to enforce. */
  rules: string[];
}

export interface MechanicalResult {
  findings: Finding[];
  unenforced: Unenforced[];
  /** qa-ignore comments that matched a finding but did not count. */
  refused: RefusedException[];
}

export interface MechanicalOptions {
  adapters?: Adapter[];
  /**
   * Whether a missing tool fails the run. Locally it fails open, because a
   * scanner absent from one laptop should not stop work. In CI it fails closed,
   * because there a missing scanner is a problem with the repo.
   */
  ci?: boolean;
  /**
   * Which exceptions count. Every one by default, as at commit and in CI; the
   * automatic call sites pass a gate that honours only committed ones.
   */
  exceptions?: ExceptionGate;
  /**
   * Whether to report what no corpus rule claims. Off, an engine that claims no
   * rule routed to the files is not run at all, and unclaimed findings are
   * dropped: the call sites enforce the corpus. On, every engine runs broad and
   * reports everything, which is the gauntlet. On by default.
   */
  gauntlet?: boolean;
}

/** A claim on every rule of a tool that no other corpus rule claims by name. */
export const EVERY_RULE = "*";

function readLines(cwd: string, file: string, cache: Map<string, string[]>): string[] {
  let lines = cache.get(file);
  if (!lines) {
    try {
      lines = readFileSync(resolve(cwd, file), "utf8").split("\n");
    } catch {
      lines = [];
    }
    cache.set(file, lines);
  }
  return lines;
}

async function runAdapter(
  cwd: string,
  adapter: Adapter,
  files: string[],
  rules: Rule[],
  ci: boolean,
  lineCache: Map<string, string[]>,
  gate: ExceptionGate,
  gauntlet: boolean,
): Promise<{ findings: Finding[]; unenforced?: Unenforced }> {
  const handled = files.filter((file) => adapter.handles(file));
  if (!handled.length) return { findings: [] };

  const claims = new Map<string, Rule>();
  for (const rule of rules) {
    const e = rule.enforcement;
    if (e.kind === "external" && e.tool === adapter.tool) claims.set(e.rule, rule);
  }
  const everyRule = claims.get(EVERY_RULE);
  const claimFor = (toolRule: string) => claims.get(toolRule) ?? everyRule;

  // Enforcing the corpus only, an engine with nothing to enforce here is time
  // spent producing findings that would all be dropped.
  const enforcesSomething = handled.some((file) =>
    [...claims.values()].some((rule) => ruleAppliesTo(rule, file)),
  );
  if (!gauntlet && !enforcesSomething) return { findings: [] };

  const run = await adapter.run(cwd, handled);

  if (run.status === "unavailable") {
    const promised = new Set<string>();
    for (const file of handled) {
      for (const rule of claims.values()) {
        if (ruleAppliesTo(rule, file)) promised.add(rule.id);
      }
    }
    const unenforced = { tool: adapter.tool, reason: run.reason, rules: [...promised] };
    if (ci) {
      throw new Error(
        `${adapter.tool} is required in CI and could not run: ${run.reason}` +
          (promised.size ? ` (leaves unenforced: ${[...promised].join(", ")})` : ""),
      );
    }
    return { findings: [], unenforced };
  }

  // The coverage check. A corpus rule whose tool rule has been switched off
  // would otherwise produce no findings, which is indistinguishable from clean
  // code. Fails everywhere, CI or not: this is not a missing install, it is a
  // promise the configuration no longer keeps.
  const broken = new Map<string, string[]>();
  for (const file of handled) {
    for (const [toolRule, rule] of claims) {
      // A claim on every rule names none, so there is no one rule to look for.
      if (toolRule === EVERY_RULE || !ruleAppliesTo(rule, file)) continue;
      if ((await adapter.isLive(cwd, toolRule, file)) === false) {
        const key = `${rule.id} (${adapter.tool} ${toolRule}`;
        broken.set(key, [...(broken.get(key) ?? []), file]);
      }
    }
  }
  if (broken.size) {
    const list = [...broken].map(([key, on]) =>
      on.length === 1 ? `${key}, on ${on[0]})` : `${key}, on ${on[0]} and ${on.length - 1} more)`,
    );
    throw new Error(
      `the corpus promises rules that ${adapter.tool} is not running: ${list.join("; ")}`,
    );
  }

  const findings: Finding[] = [];
  for (const hit of run.findings) {
    const rule = claimFor(hit.rule);
    const promised = rule && ruleAppliesTo(rule, hit.file);
    if (!promised && !gauntlet) continue;
    const lines = readLines(cwd, hit.file, lineCache);

    const ruleId = promised ? rule.id : `${adapter.tool}:${hit.rule}`;
    if (gate.excusesAt(hit.file, lines, hit.line - 1, ruleId)) continue;

    const excerpt = hit.redact
      ? WITHHELD
      : (lines[hit.line - 1] ?? "").trim().slice(0, 160);

    findings.push(
      promised
        ? {
            ruleId,
            origin: "corpus",
            statement: rule.statement,
            severity: rule.severity,
            file: hit.file,
            line: hit.line,
            excerpt,
            rationale: rule.rationale,
          }
        : {
            ruleId,
            origin: "gauntlet",
            statement: hit.message,
            severity: "warn",
            file: hit.file,
            line: hit.line,
            excerpt,
            rationale: "",
          },
    );
  }
  return { findings };
}

export async function runMechanical(
  cwd: string,
  files: string[],
  rules: Rule[],
  options: MechanicalOptions = {},
): Promise<MechanicalResult> {
  const findings: Finding[] = [];
  const unenforced: Unenforced[] = [];
  const gate = options.exceptions ?? new ExceptionGate();

  for (const file of files) {
    const applicable = rulesForFile(file, rules).filter(
      (r) => r.tier === "mechanical" && r.enforcement.kind === "pattern",
    );
    if (!applicable.length) continue;

    let text: string;
    try {
      text = readFileSync(resolve(cwd, file), "utf8");
    } catch {
      continue; // deleted between globbing and reading
    }
    const lines = text.split("\n");

    for (const rule of applicable) {
      findings.push(
        ...patternFindings(
          rule,
          rule.enforcement as PatternEnforcement,
          file,
          text,
          lines,
          gate,
        ),
      );
    }
  }

  const ci = options.ci ?? Boolean(process.env.CI);
  const lineCache = new Map<string, string[]>();
  for (const adapter of options.adapters ?? defaultAdapters()) {
    const result = await runAdapter(cwd, adapter, files, rules, ci, lineCache, gate, options.gauntlet ?? true);
    findings.push(...result.findings);
    if (result.unenforced) unenforced.push(result.unenforced);
  }

  return { findings: dedupe(findings), unenforced, refused: gate.refused() };
}
