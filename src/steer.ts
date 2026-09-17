import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { loadRules } from "./rules/load.js";
import { ruleAppliesTo } from "./rules/route.js";
import { selectFiles } from "./rules/select.js";
import type { Rule } from "./rules/types.js";

/**
 * Session-start steering: the guardrails, put in front of the main model before
 * it writes anything.
 *
 * Detection alone arrives late. Stop catches the mechanical rules after the
 * code exists, and the judgment rules are reviewed later still. A strong model
 * told the rules up front avoids most of what either would catch, for the price
 * of reading about thirty lines once per session.
 *
 * The text is generated at the start of every session from the rules the repo
 * loads, so a corpus change reaches the agent with no step anyone must remember,
 * and it cannot promise a check that does not run. It travels in hook output
 * rather than a steering file, so no consuming repo's CLAUDE.md changes.
 *
 * Only rules that apply to some file in the repo are listed. The corpus will
 * grow far past what an agent reads carefully, and a backend repo told the
 * frontend rules is paying attention for nothing.
 */

const AREAS: Record<string, string> = {
  backend: "Backend",
  data: "Data",
  frontend: "Frontend",
  security: "Security",
  testing: "Tests",
};

function grouped(rules: Rule[]): string[] {
  const byPack = new Map<string, Rule[]>();
  for (const rule of rules) byPack.set(rule.pack, [...(byPack.get(rule.pack) ?? []), rule]);

  return [...byPack].flatMap(([pack, packRules]) => [
    `${AREAS[pack] ?? pack}:`,
    ...packRules.map((r) => {
      const statement = r.statement.replace(/\s+/g, " ").trim();
      return `- ${statement}${r.severity === "warn" ? " (warning)" : ""} [${r.id}]`;
    }),
  ]);
}

/** A rule that routes by kind of file, rather than to every file there is. */
function isSpecific(rule: Rule): boolean {
  return !rule.triggers.paths.includes("**/*");
}

/**
 * Rules whose triggers match at least one file the repo has. A repo with no code
 * yet gets every rule: all of its code is about to be written, and nothing in it
 * says which rules will matter. Config files do not count as code, and a rule
 * that matches any file at all says nothing about what kind of repo this is.
 */
export function rulesForRepo(rules: Rule[], files: string[]): Rule[] {
  const hasCode = files.some((file) => rules.some((rule) => isSpecific(rule) && ruleAppliesTo(rule, file)));
  if (!hasCode) return rules;
  return rules.filter((rule) => files.some((file) => ruleAppliesTo(rule, file)));
}

/** The guidance for a set of rules. Pure, so it can be tested and measured. */
export function guardrailText(rules: Rule[]): string {
  const checked = rules.filter((r) => r.tier === "mechanical");
  const reviewed = rules.filter((r) => r.tier === "llm" || r.tier === "human");

  return [
    "This repository is checked by agentic-qa. Write code that keeps these rules from the start.",
    ...(checked.length
      ? [
          "",
          "Checked automatically when you finish a turn and on commit. A broken rule stops you until it is fixed:",
          ...grouped(checked),
        ]
      : []),
    ...(reviewed.length
      ? [
          "",
          "Not checked automatically, but reviewed before the work is merged:",
          ...grouped(reviewed),
        ]
      : []),
    "",
    "Tests are reviewed too: each test's description must state something a broken implementation would",
    "make false, and its assertions must fail if that behaviour broke.",
    "",
    "If a rule looks wrong for a particular case, say so to the person rather than working around it.",
    "An exception is a `// qa-ignore: <rule-id> - reason` comment, and it counts only once a person commits it.",
  ].join("\n");
}

function emit(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

/**
 * The SessionStart hook. Always exits zero: a session that cannot start because
 * its guidance failed to load is far worse than a session without guidance. A
 * failure is told to the person, because silence would read as "no rules".
 */
export async function runSessionStart(cwd: string): Promise<number> {
  try {
    const config = loadConfig(cwd);
    const rules = loadRules(
      config.rules.paths.map((p) => resolve(cwd, p)),
      config.rules.packs,
    );
    const files = await selectFiles(cwd, config, rules);
    emit({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: guardrailText(rulesForRepo(rules, files)),
      },
    });
  } catch (err) {
    emit({ systemMessage: `agentic-qa could not load its rules for this session: ${(err as Error).message}` });
  }
  return 0;
}
