import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { parseSiteOverrides, type SiteOverrides } from "./sites.js";

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
  /**
   * This repo's changes to what runs at each call site. The defaults and the
   * reasoning behind them are in `src/sites.ts`.
   */
  callSites: SiteOverrides;
  /** Treat `unverifiable` (description too vague to falsify) as a failure. */
  failOnUnverifiable: boolean;
  mutation: {
    /** Directory vitest runs against, relative to the repo root. */
    root: string;
  };
  rules: {
    /** Pack names to enable. Empty means every bundled pack. */
    packs: string[];
    /** Extra rule directories, relative to the repo, for local conventions. */
    paths: string[];
    llm: {
      /**
       * Files above this size are skipped rather than judged: they cost a lot
       * and get judged badly. Reported, never silently dropped.
       */
      maxFileBytes: number;
    };
  };
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
  callSites: {},
  failOnUnverifiable: false,
  mutation: {
    root: ".",
  },
  rules: {
    packs: [],
    paths: [],
    llm: {
      maxFileBytes: 60_000,
    },
  },
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
      callSites: parseSiteOverrides(raw.callSites),
      judge: { ...DEFAULT_CONFIG.judge, ...(raw.judge ?? {}) },
      mutation: { ...DEFAULT_CONFIG.mutation, ...(raw.mutation ?? {}) },
      rules: {
        ...DEFAULT_CONFIG.rules,
        ...(raw.rules ?? {}),
        llm: { ...DEFAULT_CONFIG.rules.llm, ...(raw.rules?.llm ?? {}) },
      },
    };
  }
  return DEFAULT_CONFIG;
}
