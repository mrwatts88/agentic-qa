/**
 * Shared types for agentic-qa.
 *
 * The enforcement ladder: every rule declares the cheapest tier that can
 * actually enforce it. `mechanical` is free and runs on every line forever,
 * `llm` costs money and is reserved for genuine judgment, `human` is for
 * questions no tool can answer. A rule that cannot name its enforcement is
 * not a rule yet.
 */
export type Tier = "mechanical" | "llm" | "human";

export type Verdict = "upheld" | "violated" | "unverifiable";

/** A test's claim about itself, paired with the body that must back it up. */
export interface ExtractedTest {
  /** Stable across body edits, intentionally NOT stable across description edits. */
  id: string;
  file: string;
  describePath: string[];
  title: string;
  /** The English claim: a `@describes` docblock if present, else the test title. */
  description: string;
  descriptionSource: "title" | "docblock";
  body: string;
  line: number;
}

export interface JudgeResult {
  verdict: Verdict;
  reason: string;
  weakestAssertion?: string;
  suggestedMutation?: string;
}

/** One row of the durable ledger. Committed to the repo. */
export interface ContractRecord extends JudgeResult {
  id: string;
  file: string;
  description: string;
  /** Recorded so a silently-missed docblock is visible in the committed diff. */
  descriptionSource: "title" | "docblock";
  descriptionHash: string;
  bodyHash: string;
  model: string;
  judgeVersion: number;
  checkedAt: string;
  /** Present once the verdict has been tested by experiment. */
  mutation?: MutationOutcome;
  mutationVersion?: number;
}

/**
 * The result of breaking the implementation on purpose and watching the test.
 *
 * `confirmed` means reality agreed with the judge. `refuted` means it did not,
 * which is the interesting case: the judge was wrong about this test.
 */
export interface MutationOutcome {
  status: "confirmed" | "refuted" | "skipped";
  reason: string;
  file?: string;
  mutation?: string;
  checkedAt: string;
}

export interface Ledger {
  version: 1;
  records: Record<string, ContractRecord>;
}

export interface JudgeInvocation {
  costUsd: number;
  durationMs: number;
}
