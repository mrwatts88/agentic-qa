import { execFile } from "node:child_process";
import type { ExtractedTest, JudgeResult, JudgeInvocation } from "./types.js";
import type { QaConfig } from "./config.js";

/**
 * Bump when the contract system prompt or schema changes. Every cached verdict
 * with a lower version is re-judged, because a verdict is only meaningful
 * relative to the prompt that produced it.
 */
export const JUDGE_VERSION = 3;

/** Same idea, for mutation proposals. */
export const MUTATION_VERSION = 1;

/**
 * Measured on this machine, same judgment, same model (sonnet):
 *   baseline                  $0.083   19,351 cache-creation tokens
 *   --strict-mcp-config       $0.020    3,113
 *   --safe-mode               $0.012    1,454
 *   --safe-mode + haiku       $0.008        0
 *
 * `--safe-mode` disables CLAUDE.md, skills, plugins, hooks and MCP servers
 * while leaving OAuth intact, so the judge still needs no ANTHROPIC_API_KEY.
 * `--bare` would be cheaper still but forces API-key auth, so it is not used.
 */
const BASE_FLAGS = [
  "--output-format",
  "json",
  "--tools",
  "",
  "--no-session-persistence",
  "--permission-prompts",
  "none",
  "--safe-mode",
];

const CONTRACT_SYSTEM_PROMPT = `You are a test contract judge for a production TypeScript codebase.

You are given an English description of what a test claims to verify, and the body of that test.

Answer one question: if the described behavior broke in a realistic way, would these assertions fail?

- "upheld": the assertions would fail if the described behavior broke.
- "violated": the assertions would still pass if the described behavior broke. This covers assertions that only check definedness or shape, tautological assertions, assertions against a mock that was configured in the same test, and tests that only check that nothing threw.
- "unverifiable": the description is too vague to falsify, or the body is not really a test.

Decide in that order, and check "unverifiable" first. Ask whether the description is specific enough to be falsified at all: if a competent engineer could not say what observable outcome would prove it wrong, the verdict is "unverifiable" no matter how strong or weak the assertions are. A vague description is a defect in the description, and reporting it as "violated" sends the reader to fix the wrong thing. Only once the description is falsifiable do you judge whether the assertions would catch it breaking.

Read the description on its own. Do not work out what it must have meant from the test body, the file name, or the function it calls. The whole point of these descriptions is that a reader can learn what the suite covers without opening the tests, so a description that only makes sense once you have read the body has already failed, and the verdict is "unverifiable". "works correctly", "handles it properly" and "does the right thing" are unverifiable no matter what the body does.

Judge only the relationship between the description and the assertions. Do not comment on naming, style, formatting, or behaviors the description does not claim. Name the specific assertion that carries the weight, or the specific gap that lets a broken implementation pass.`;

const CONTRACT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["upheld", "violated", "unverifiable"] },
    reason: { type: "string" },
    weakest_assertion: { type: "string" },
    suggested_mutation: {
      type: "string",
      description:
        "A change to the implementation under test that would violate the description. Used to verify the verdict by experiment.",
    },
  },
  required: ["verdict", "reason"],
} as const;

const MUTATION_SYSTEM_PROMPT = `You break production code on purpose, so that a test suite can be measured.

You are given an English description of a behavior, the test that claims to verify it, and the source of the implementation files that test exercises.

Produce one edit to the IMPLEMENTATION that breaks exactly the described behavior. Never edit the test.

Requirements, all of them mandatory:
- The result must still parse and type-check. Do not delete a closing brace, leave a dangling expression, or remove something another line still references.
- Break only the described behavior. Do not reformat, rename, or change anything the description does not cover.
- "old_str" must be copied verbatim from the file you name, including indentation, and must appear EXACTLY ONCE in that file. Prefer a distinctive multi-line span over a short one that repeats.
- The break must be real. Returning the same code, or a cosmetic change, makes the measurement meaningless.

A good mutation is the bug a tired engineer would actually write: a dropped guard clause, an inverted condition, an off-by-one, a branch that returns the success value without doing the work.`;

const MUTATION_SCHEMA = {
  type: "object",
  properties: {
    file: {
      type: "string",
      description: "Path of the file to edit, exactly as given in the prompt.",
    },
    old_str: {
      type: "string",
      description: "Verbatim snippet from that file, appearing exactly once.",
    },
    new_str: { type: "string", description: "Replacement text." },
    explanation: {
      type: "string",
      description: "One sentence on which described behavior this breaks.",
    },
  },
  required: ["file", "old_str", "new_str", "explanation"],
} as const;

function run(
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "claude",
      args,
      { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // A non-zero exit still often carries a parseable JSON envelope, so
        // hand stdout back and let the caller decide.
        if (err && !stdout) reject(err);
        else resolve({ stdout, stderr });
      },
    );
  });
}

/**
 * The single place this codebase talks to a model. Both call types share it so
 * the cost flags cannot drift apart.
 */
async function invoke(
  prompt: string,
  schema: unknown,
  systemPrompt: string,
  config: QaConfig,
  label: string,
): Promise<{ output: any; costUsd: number; durationMs: number }> {
  const args = [
    "-p",
    prompt,
    ...BASE_FLAGS,
    "--json-schema",
    JSON.stringify(schema),
    "--model",
    config.judge.model,
    "--system-prompt",
    systemPrompt,
    "--max-budget-usd",
    String(config.judge.maxBudgetUsd),
  ];

  const { stdout } = await run(args, config.judge.timeoutMs);

  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(
      `${label}: unparseable output: ${stdout.slice(0, 300)}`,
    );
  }

  if (envelope.is_error) {
    throw new Error(
      `${label}: ${envelope.result ?? envelope.api_error_status ?? "unknown error"}`,
    );
  }

  if (!envelope.structured_output) {
    throw new Error(`${label}: no structured output returned`);
  }

  return {
    output: envelope.structured_output,
    costUsd: envelope.total_cost_usd ?? 0,
    durationMs: envelope.duration_ms ?? 0,
  };
}

function testHeading(test: ExtractedTest): string {
  return [...test.describePath, test.title].join(" > ");
}

export async function judgeContract(
  test: ExtractedTest,
  config: QaConfig,
): Promise<JudgeResult & JudgeInvocation> {
  const prompt = [
    `Description: ${test.description}`,
    `File: ${test.file}`,
    `Test: ${testHeading(test)}`,
    "",
    "Test body:",
    "```ts",
    test.body,
    "```",
  ].join("\n");

  const { output, costUsd, durationMs } = await invoke(
    prompt,
    CONTRACT_SCHEMA,
    CONTRACT_SYSTEM_PROMPT,
    config,
    `contract judge (${test.id})`,
  );

  if (!output.verdict) {
    throw new Error(`contract judge (${test.id}): no verdict in output`);
  }

  return {
    verdict: output.verdict,
    reason: output.reason ?? "",
    weakestAssertion: output.weakest_assertion,
    suggestedMutation: output.suggested_mutation,
    costUsd,
    durationMs,
  };
}

const RULE_SYSTEM_PROMPT = `You audit one source file against one rule, for a production TypeScript codebase.

You are given the rule, the reason it exists, and the whole file. Decide:

- "not-applicable": the file contains nothing the rule is about. This is the common answer and it is not a failure. A rule about endpoints says nothing about a file with no endpoints.
- "ok": the rule applies to something in this file, and the file satisfies it.
- "violated": the rule applies, and the file breaks it. Name the line and say what a reader would have to change.

Prefer "not-applicable" or "ok" whenever you are genuinely unsure. A rule that fires on correct code gets the entire checking system switched off, after which nothing it reports matters. A missed violation is a smaller loss than a false alarm, so do not reach for "violated" to look thorough.

Judge only the rule you were given. Other problems in the file are not your business, however tempting.`;

const RULE_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["ok", "violated", "not-applicable"],
    },
    reason: {
      type: "string",
      description: "One or two sentences. For a violation, what must change.",
    },
    line: {
      type: "integer",
      description: "1-based line of the violation. Omit unless verdict is violated.",
    },
  },
  required: ["verdict", "reason"],
} as const;

export interface RuleJudgement {
  verdict: "ok" | "violated" | "not-applicable";
  reason: string;
  line?: number;
  costUsd: number;
}

export async function judgeRule(
  rule: { id: string; statement: string; rationale: string; enforcement: unknown },
  file: string,
  text: string,
  config: QaConfig,
): Promise<RuleJudgement> {
  const prompt = (rule.enforcement as { prompt: string }).prompt;

  const numbered = text
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
    .join("\n");

  const body = [
    `Rule: ${rule.statement}`,
    `Why it exists: ${rule.rationale}`,
    "",
    `Question: ${prompt}`,
    "",
    `File: ${file}`,
    "```ts",
    numbered,
    "```",
  ].join("\n");

  const { output, costUsd } = await invoke(
    body,
    RULE_SCHEMA,
    RULE_SYSTEM_PROMPT,
    config,
    `rule judge (${rule.id} on ${file})`,
  );

  if (!output.verdict) {
    throw new Error(`rule judge (${rule.id} on ${file}): no verdict in output`);
  }

  return {
    verdict: output.verdict,
    reason: output.reason ?? "",
    line: typeof output.line === "number" ? output.line : undefined,
    costUsd,
  };
}

export interface ProposedMutation {
  file: string;
  oldStr: string;
  newStr: string;
  explanation: string;
  costUsd: number;
}

export async function proposeMutation(
  test: ExtractedTest,
  sources: { path: string; text: string }[],
  config: QaConfig,
): Promise<ProposedMutation> {
  const rendered = sources
    .map((s) => [`--- ${s.path} ---`, "```ts", s.text, "```"].join("\n"))
    .join("\n\n");

  const prompt = [
    `Described behavior: ${test.description}`,
    `Test: ${testHeading(test)}`,
    "",
    "The test that claims to verify it:",
    "```ts",
    test.body,
    "```",
    "",
    "Implementation files it exercises:",
    "",
    rendered,
  ].join("\n");

  const { output, costUsd } = await invoke(
    prompt,
    MUTATION_SCHEMA,
    MUTATION_SYSTEM_PROMPT,
    config,
    `mutation proposal (${test.id})`,
  );

  return {
    file: output.file,
    oldStr: output.old_str,
    newStr: output.new_str,
    explanation: output.explanation ?? "",
    costUsd,
  };
}
