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
  /**
   * Only report when this pattern also appears somewhere in the file. The
   * positive counterpart of `unlessFilePattern`, for rules where the construct
   * is fine on its own and wrong only in company: a wildcard CORS origin is
   * ordinary until credentials are enabled, and SHA-256 is a perfectly good
   * hash until it is hashing a password.
   */
  requireFilePattern?: string;
}

/**
 * Delegated to a real engine. The rule names a tool and that tool's own rule
 * id; the tool finds the problem, and the corpus entry is what makes a finding
 * from that rule block instead of warn. It is also a promise: the conductor
 * refuses to run if the named rule is not live in the config the tool runs
 * with, so dropping a plugin fails loudly rather than quietly unenforcing it.
 */
export interface ExternalEnforcement {
  kind: "external";
  tool: string;
  /** The tool's own rule id, exactly as the tool reports it. */
  rule: string;
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
  | ExternalEnforcement
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
  /**
   * The matched line holds a secret, so findings must not quote it. Every call
   * site prints the excerpt: a terminal, a CI log, the agent's context.
   */
  redact?: boolean;
  /** Where in the prose corpus this came from, for tracing it back. */
  source?: string;
}

export interface RulePack {
  pack: string;
  rules: Rule[];
}

export interface Finding {
  /**
   * A corpus rule id, or `<tool>:<rule>` for a gauntlet finding: something an
   * engine reported that no corpus rule promises to enforce.
   */
  ruleId: string;
  /**
   * `corpus` findings are the ones the corpus promised to enforce, and carry
   * that rule's severity. `gauntlet` findings are everything else a tool
   * reported: always a warning, never a gate, and never a false positive
   * against a clean control, because nothing promised they would stay quiet.
   */
  origin: "corpus" | "gauntlet";
  statement: string;
  severity: "error" | "warn";
  file: string;
  line: number;
  /** The offending source line, trimmed. */
  excerpt: string;
  rationale: string;
}
