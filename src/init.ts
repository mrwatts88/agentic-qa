import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Scaffolds the three call sites into a repo.
 *
 * Never overwrites. An existing pre-commit hook or settings file belongs to
 * whoever wrote it, and silently replacing it would be exactly the kind of
 * destructive helpfulness this tool exists to catch. Anything already present
 * is reported and left alone.
 */
export interface InitResult {
  written: string[];
  skipped: { path: string; why: string }[];
}

function preCommit(runner: string): string {
  return `#!/bin/sh
# Installed by agentic-qa.
#
# Mechanical tier only. No model calls here: a commit has to be fast, free and
# work with no network. The judgment rules run in CI, where nobody can skip
# them with --no-verify.
exec ${runner} rules --staged
`;
}

function claudeSettings(runner: string): string {
  return (
    JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit|Write",
              hooks: [
                {
                  type: "command",
                  command: `${runner} hook`,
                  timeout: 30,
                  statusMessage: "agentic-qa: checking rules",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n"
  );
}

const QA_CONFIG = `# How agentic-qa checks this repo.
testGlobs:
  - "**/*.{test,spec}.{ts,tsx}"

ignore:
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/.qa/**"

judge:
  model: haiku
  concurrency: 4
  maxBudgetUsd: 0.5

# Turn on once every test description is falsifiable, and keep it on.
failOnUnverifiable: false
`;

function put(
  cwd: string,
  relative: string,
  contents: string,
  result: InitResult,
  executable = false,
): void {
  const path = resolve(cwd, relative);
  if (existsSync(path)) {
    result.skipped.push({ path: relative, why: "already exists, left alone" });
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (executable) chmodSync(path, 0o755);
  result.written.push(relative);
}

export function runInit(cwd: string, runner: string): InitResult {
  const result: InitResult = { written: [], skipped: [] };

  put(cwd, "qa.config.yaml", QA_CONFIG, result);
  put(cwd, join(".claude", "settings.json"), claudeSettings(runner), result);

  // Only install a git hook where there is a git repo to install it into.
  if (existsSync(resolve(cwd, ".git"))) {
    put(cwd, join(".git", "hooks", "pre-commit"), preCommit(runner), result, true);
  } else {
    result.skipped.push({
      path: ".git/hooks/pre-commit",
      why: "not a git repository",
    });
  }

  return result;
}
