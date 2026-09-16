import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULT_CONFIG } from "../src/config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("falls back to the defaults when the repo has no config file", () => {
    expect(loadConfig(dir)).toEqual(DEFAULT_CONFIG);
  });

  it("reads settings from qa.config.yaml when one is present", () => {
    writeFileSync(
      join(dir, "qa.config.yaml"),
      "failOnUnverifiable: true\ntestGlobs:\n  - \"*.spec.ts\"\n",
    );

    const config = loadConfig(dir);

    expect(config.failOnUnverifiable).toBe(true);
    expect(config.testGlobs).toEqual(["*.spec.ts"]);
  });

  /**
   * Judge settings are nested, so a shallow merge would wipe out the defaults
   * for every key the file does not mention.
   */
  it("keeps default judge settings that the config file does not override", () => {
    writeFileSync(join(dir, "qa.config.yaml"), "judge:\n  model: sonnet\n");

    const config = loadConfig(dir);

    expect(config.judge.model).toBe("sonnet");
    expect(config.judge.concurrency).toBe(DEFAULT_CONFIG.judge.concurrency);
    expect(config.judge.maxBudgetUsd).toBe(DEFAULT_CONFIG.judge.maxBudgetUsd);
    expect(config.judge.timeoutMs).toBe(DEFAULT_CONFIG.judge.timeoutMs);
  });

  it("keeps default mutation settings that the config file does not override", () => {
    writeFileSync(join(dir, "qa.config.yaml"), "failOnUnverifiable: true\n");

    expect(loadConfig(dir).mutation.root).toBe(DEFAULT_CONFIG.mutation.root);
  });

  it("accepts the .yml spelling of the config file", () => {
    writeFileSync(join(dir, "qa.config.yml"), "failOnUnverifiable: true\n");

    expect(loadConfig(dir).failOnUnverifiable).toBe(true);
  });
});
