import type { Tier } from "../types.js";

/**
 * A rule is only a rule if it can say how it is enforced. "Be careful about
 * auth" is a wish. `mechanical` rules name a pattern the CLI can run itself,
 * `llm` rules name a question worth paying a model to answer, `human` rules
 * are the ones no tool should pretend to settle.
 */
export interface RuleTrigger {
  /** Globs that make this rule apply to a file at all. */
  paths: string[];
  /**
   * Globs that exempt a file. This is how layering rules work: "no database
   * client outside the repository layer" is the same pattern everywhere, minus
   * the repository layer itself.
   */
  excludePaths?: string[];
}

export interface PatternEnforcement {
  kind: "pattern";
  /** Regex source. Written as a YAML block scalar so it needs no escaping. */
  pattern: string;
  flags?: string;
  /**
   * Suppress the finding when this second pattern appears anywhere in the same
   * file. Used for "X is only allowed when Y is also present", such as reading
   * a request body only when the file also runs a validator.
   */
  unlessFilePattern?: string;
}

export interface LlmEnforcement {
  kind: "llm";
  /** The question put to the judge about the changed code. */
  prompt: string;
}

export interface HumanEnforcement {
  kind: "human";
}

export type Enforcement =
  | PatternEnforcement
  | LlmEnforcement
  | HumanEnforcement;

export interface Rule {
  /** Dotted and stable: packs.area.specific. Used in qa-ignore comments. */
  id: string;
  /** One imperative line. What the rule requires, not why. */
  statement: string;
  tier: Tier;
  pack: string;
  severity: "error" | "warn";
  /** Short. A model judges better knowing why a rule exists. */
  rationale: string;
  triggers: RuleTrigger;
  enforcement: Enforcement;
  /** Where in the prose corpus this came from, for tracing it back. */
  source?: string;
}

export interface RulePack {
  pack: string;
  rules: Rule[];
}

export interface Finding {
  ruleId: string;
  statement: string;
  severity: "error" | "warn";
  file: string;
  line: number;
  /** The offending source line, trimmed. */
  excerpt: string;
  rationale: string;
}
