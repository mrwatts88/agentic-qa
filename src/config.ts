import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export interface QaConfig {
  /** Globs for test files whose contracts are verified. */
  testGlobs: string[];
  ignore: string[];
  judge: {
    /**
     * Model alias passed to `claude --model`. haiku judged the validation
     * corpus correctly at ~$0.007/test; sonnet is ~$0.012 and the safer
     * default until the eval corpus says otherwise.
     */
    model: string;
    /** Parallel judge processes. Each is a separate `claude -p` invocation. */
    concurrency: number;
    /** Hard per-invocation spend ceiling, passed through to the CLI. */
    maxBudgetUsd: number;
    /** Abort a single judgment that hangs. */
    timeoutMs: number;
  };
  /** Treat `unverifiable` (description too vague to falsify) as a failure. */
  failOnUnverifiable: boolean;
}

export const DEFAULT_CONFIG: QaConfig = {
  testGlobs: ["**/*.{test,spec}.{ts,tsx}"],
  ignore: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.qa/**"],
  judge: {
    model: "sonnet",
    concurrency: 4,
    maxBudgetUsd: 0.5,
    timeoutMs: 120_000,
  },
  failOnUnverifiable: false,
};

const CONFIG_NAMES = ["qa.config.yaml", "qa.config.yml"];

export function loadConfig(cwd: string): QaConfig {
  for (const name of CONFIG_NAMES) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    const raw = parse(readFileSync(path, "utf8")) ?? {};
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      judge: { ...DEFAULT_CONFIG.judge, ...(raw.judge ?? {}) },
    };
  }
  return DEFAULT_CONFIG;
}
