import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";
import type { Rule, RulePack } from "./types.js";
import { KNOWN_TOOLS } from "./adapters/index.js";

/**
 * Rules ship with the tool, not with the repo being checked. A repo that keeps
 * its own copy is a repo whose rules drift, which is the whole problem this is
 * meant to solve. Project-local packs are additive, for genuinely local
 * conventions.
 */
export function bundledRulesDir(): string {
  return fileURLToPath(new URL("../../rules", import.meta.url));
}

const TIERS = new Set(["mechanical", "llm", "human"]);
const SEVERITIES = new Set(["error", "warn"]);

function fail(file: string, index: number, message: string): never {
  throw new Error(`${file}: rule #${index + 1}: ${message}`);
}

/**
 * Strict on purpose. A rule that is silently dropped because of a typo is a
 * rule everyone believes is protecting them.
 */
function validate(raw: any, file: string, index: number, pack: string): Rule {
  if (!raw?.id) fail(file, index, "missing id");
  if (!raw.statement) fail(file, index, `${raw.id}: missing statement`);
  if (!TIERS.has(raw.tier)) {
    fail(file, index, `${raw.id}: tier must be mechanical, llm or human`);
  }
  if (!SEVERITIES.has(raw.severity)) {
    fail(file, index, `${raw.id}: severity must be error or warn`);
  }
  if (!raw.rationale) fail(file, index, `${raw.id}: missing rationale`);
  if (!raw.triggers?.paths?.length) {
    fail(file, index, `${raw.id}: needs at least one trigger path`);
  }

  const kind = raw.enforcement?.kind;
  if (kind === "pattern") {
    if (!raw.enforcement.pattern) {
      fail(file, index, `${raw.id}: pattern enforcement needs a pattern`);
    }
    // Every pattern, not just the main one. A companion pattern that only
    // throws when it first meets a matching file is a rule everyone believes
    // is protecting them, right up until it is not.
    for (const field of [
      "pattern",
      "unlessFilePattern",
      "requireFilePattern",
    ] as const) {
      const source = raw.enforcement[field];
      if (!source) continue;
      try {
        new RegExp(source, raw.enforcement.flags ?? "");
      } catch (err) {
        fail(
          file,
          index,
          `${raw.id}: invalid regex in ${field}: ${(err as Error).message}`,
        );
      }
    }
  } else if (kind === "external") {
    if (raw.tier !== "mechanical") {
      fail(file, index, `${raw.id}: external enforcement belongs to the mechanical tier`);
    }
    if (!KNOWN_TOOLS.includes(raw.enforcement.tool)) {
      fail(
        file,
        index,
        `${raw.id}: unknown tool '${raw.enforcement.tool}', expected one of ${KNOWN_TOOLS.join(", ")}`,
      );
    }
    if (!raw.enforcement.rule) {
      fail(file, index, `${raw.id}: external enforcement needs the tool's rule id`);
    }
  } else if (kind === "llm") {
    if (!raw.enforcement.prompt) {
      fail(file, index, `${raw.id}: llm enforcement needs a prompt`);
    }
  } else if (kind !== "human") {
    fail(file, index, `${raw.id}: enforcement.kind must be pattern, external, llm or human`);
  }

  return { ...raw, pack } as Rule;
}

function loadDir(dir: string): Rule[] {
  // Strict for the same reason a malformed rule is: a mistyped path in
  // rules.paths that quietly contributes nothing is a set of rules everyone
  // believes is protecting them, right up until someone checks.
  if (!existsSync(dir)) {
    throw new Error(`rules directory not found: ${dir}`);
  }

  const rules: Rule[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;

    const path = join(dir, entry);
    const doc = parse(readFileSync(path, "utf8")) as RulePack;
    if (!doc?.pack) throw new Error(`${path}: missing top-level 'pack'`);

    (doc.rules ?? []).forEach((raw, i) => {
      rules.push(validate(raw, entry, i, doc.pack));
    });
  }
  return rules;
}

export function loadRules(extraDirs: string[] = [], packs: string[] = []): Rule[] {
  const all = [bundledRulesDir(), ...extraDirs].flatMap(loadDir);

  const seen = new Set<string>();
  for (const rule of all) {
    if (seen.has(rule.id)) {
      throw new Error(`duplicate rule id: ${rule.id}`);
    }
    seen.add(rule.id);
  }

  // Two corpus rules claiming the same tool rule would make which one a
  // finding belongs to depend on load order.
  const claimed = new Map<string, string>();
  for (const rule of all) {
    if (rule.enforcement.kind !== "external") continue;
    const key = `${rule.enforcement.tool}:${rule.enforcement.rule}`;
    const other = claimed.get(key);
    if (other) {
      throw new Error(`${rule.id} and ${other} both claim ${key}`);
    }
    claimed.set(key, rule.id);
  }

  return packs.length ? all.filter((r) => packs.includes(r.pack)) : all;
}
