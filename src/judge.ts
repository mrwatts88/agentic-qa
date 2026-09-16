import { execFile } from "node:child_process";
import type { ExtractedTest, JudgeResult, JudgeInvocation } from "./types.js";
import type { QaConfig } from "./config.js";

/**
 * Bump when the system prompt or schema changes. Every cached verdict with a
 * lower version is re-judged, because a verdict is only meaningful relative to
 * the prompt that produced it.
 */
export const JUDGE_VERSION = 3;

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

const SYSTEM_PROMPT = `You are a test contract judge for a production TypeScript codebase.

You are given an English description of what a test claims to verify, and the body of that test.

Answer one question: if the described behavior broke in a realistic way, would these assertions fail?

- "upheld": the assertions would fail if the described behavior broke.
- "violated": the assertions would still pass if the described behavior broke. This covers assertions that only check definedness or shape, tautological assertions, assertions against a mock that was configured in the same test, and tests that only check that nothing threw.
- "unverifiable": the description is too vague to falsify, or the body is not really a test.

Decide in that order, and check "unverifiable" first. Ask whether the description is specific enough to be falsified at all: if a competent engineer could not say what observable outcome would prove it wrong, the verdict is "unverifiable" no matter how strong or weak the assertions are. A vague description is a defect in the description, and reporting it as "violated" sends the reader to fix the wrong thing. Only once the description is falsifiable do you judge whether the assertions would catch it breaking.

Read the description on its own. Do not work out what it must have meant from the test body, the file name, or the function it calls. The whole point of these descriptions is that a reader can learn what the suite covers without opening the tests, so a description that only makes sense once you have read the body has already failed, and the verdict is "unverifiable". "works correctly", "handles it properly" and "does the right thing" are unverifiable no matter what the body does.

Judge only the relationship between the description and the assertions. Do not comment on naming, style, formatting, or behaviors the description does not claim. Name the specific assertion that carries the weight, or the specific gap that lets a broken implementation pass.`;

const SCHEMA = {
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

function buildPrompt(test: ExtractedTest): string {
  const name = [...test.describePath, test.title].join(" > ");
  return [
    `Description: ${test.description}`,
    `File: ${test.file}`,
    `Test: ${name}`,
    "",
    "Test body:",
    "```ts",
    test.body,
    "```",
  ].join("\n");
}

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

export async function judgeContract(
  test: ExtractedTest,
  config: QaConfig,
): Promise<JudgeResult & JudgeInvocation> {
  const args = [
    "-p",
    buildPrompt(test),
    ...BASE_FLAGS,
    "--json-schema",
    JSON.stringify(SCHEMA),
    "--model",
    config.judge.model,
    "--system-prompt",
    SYSTEM_PROMPT,
    "--max-budget-usd",
    String(config.judge.maxBudgetUsd),
  ];

  const { stdout } = await run(args, config.judge.timeoutMs);

  let envelope: any;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(
      `judge returned unparseable output for ${test.id}: ${stdout.slice(0, 300)}`,
    );
  }

  if (envelope.is_error) {
    throw new Error(
      `judge errored for ${test.id}: ${envelope.result ?? envelope.api_error_status ?? "unknown"}`,
    );
  }

  const out = envelope.structured_output;
  if (!out?.verdict) {
    throw new Error(`judge returned no structured verdict for ${test.id}`);
  }

  return {
    verdict: out.verdict,
    reason: out.reason ?? "",
    weakestAssertion: out.weakest_assertion,
    suggestedMutation: out.suggested_mutation,
    costUsd: envelope.total_cost_usd ?? 0,
    durationMs: envelope.duration_ms ?? 0,
  };
}
