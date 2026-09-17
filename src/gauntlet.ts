import { resolve } from "node:path";
import pc from "picocolors";
import { loadConfig } from "./config.js";
import { loadRules } from "./rules/load.js";
import { selectFiles } from "./rules/select.js";
import { runMechanical } from "./rules/mechanical.js";
import { printUnenforced } from "./gate.js";
import type { Adapter } from "./rules/adapters/types.js";
import type { Finding } from "./rules/types.js";

/**
 * The gauntlet: everything the scanners say that no corpus rule claims. No call
 * site shows it, because unvetted rules shown to an agent taught it to skip
 * hook output. It is a working session instead: a person runs this with an
 * agent, fixes what is real, and excuses or switches off what is not. That is
 * where a rule earns promotion into the corpus.
 *
 * Grouped by rule, largest first, so triage reads "this rule, these N places"
 * rather than a wall. Never blocks.
 */

const PER_RULE = 20;

export interface GauntletOptions {
  json?: boolean;
  /** The engine registry; every engine by default. Tests pass fakes. */
  adapters?: Adapter[];
}

/** Findings grouped by rule id, the most frequent rule first. */
export function groupByRule(findings: Finding[]): [string, Finding[]][] {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) groups.set(f.ruleId, [...(groups.get(f.ruleId) ?? []), f]);
  return [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

/** Narrows to files at or under any of the given paths; all of them when none are given. */
export function underPaths(files: string[], paths: string[]): string[] {
  const prefixes = paths.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""));
  if (!prefixes.length || prefixes.includes("") || prefixes.includes(".")) return files;
  return files.filter((file) => prefixes.some((p) => file === p || file.startsWith(`${p}/`)));
}

export async function runGauntlet(
  cwd: string,
  paths: string[],
  options: GauntletOptions = {},
): Promise<number> {
  const config = loadConfig(cwd);
  const rules = loadRules(
    config.rules.paths.map((p) => resolve(cwd, p)),
    config.rules.packs,
  );
  const files = underPaths(await selectFiles(cwd, config, rules), paths);

  const result = await runMechanical(cwd, files, rules, {
    gauntlet: true,
    ...(options.adapters ? { adapters: options.adapters } : {}),
  });
  const gauntlet = result.findings.filter((f) => f.origin === "gauntlet");
  printUnenforced(result.unenforced);

  if (options.json) {
    process.stdout.write(JSON.stringify(gauntlet, null, 2) + "\n");
    return 0;
  }

  const groups = groupByRule(gauntlet);
  for (const [ruleId, found] of groups) {
    process.stdout.write(`${pc.bold(ruleId)} ${pc.dim(`(${found.length})`)}\n`);
    for (const f of found.slice(0, PER_RULE)) {
      process.stdout.write(`  ${f.file}:${f.line} ${pc.dim(f.statement)}\n`);
    }
    const more = found.length - PER_RULE;
    if (more > 0) process.stdout.write(pc.dim(`  ...and ${more} more (--json lists all)\n`));
    process.stdout.write("\n");
  }

  process.stdout.write(
    pc.dim(
      `${gauntlet.length} finding(s) from ${groups.length} rule(s) in ${files.length} files. ` +
        "These never block.\n" +
        "Fix what is real. For what is not, a qa-ignore comment with a reason, committed.\n",
    ),
  );
  return 0;
}
