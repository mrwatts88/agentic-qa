import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";
import type { Rule, RulePack } from "./types.js";

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
    try {
      new RegExp(raw.enforcement.pattern, raw.enforcement.flags ?? "");
    } catch (err) {
      fail(file, index, `${raw.id}: invalid regex: ${(err as Error).message}`);
    }
  } else if (kind === "llm") {
    if (!raw.enforcement.prompt) {
      fail(file, index, `${raw.id}: llm enforcement needs a prompt`);
    }
  } else if (kind !== "human") {
    fail(file, index, `${raw.id}: enforcement.kind must be pattern, llm or human`);
  }

  return { ...raw, pack } as Rule;
}

function loadDir(dir: string): Rule[] {
  if (!existsSync(dir)) return [];

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

  return packs.length ? all.filter((r) => packs.includes(r.pack)) : all;
}
