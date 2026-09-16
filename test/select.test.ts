import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import type { Rule } from "../src/rules/types";
import { selectFiles } from "../src/rules/select";

let dir: string;

const tsRule = {
  id: "test.rule",
  statement: "Do not do the thing.",
  tier: "mechanical",
  pack: "test",
  severity: "error",
  rationale: "because it breaks",
  triggers: { paths: ["**/*.ts"] },
  enforcement: { kind: "pattern", pattern: "forbidden" },
} as Rule;

function write(relative: string, contents = "export const a = 1;\n"): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-select-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("selectFiles", () => {
  it("returns every file an active rule triggers on", async () => {
    write("src/a.ts");
    write("src/b.ts");

    const files = await selectFiles(dir, DEFAULT_CONFIG, [tsRule]);

    expect(files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("leaves out files no active rule triggers on", async () => {
    write("src/a.ts");
    write("notes.md", "# notes\n");

    const files = await selectFiles(dir, DEFAULT_CONFIG, [tsRule]);

    expect(files).toEqual(["src/a.ts"]);
  });

  it("narrows to the requested files", async () => {
    write("src/a.ts");
    write("src/b.ts");

    const files = await selectFiles(dir, DEFAULT_CONFIG, [tsRule], ["src/a.ts"]);

    expect(files).toEqual(["src/a.ts"]);
  });

  /**
   * The bug this function exists to prevent. Passing a staged path straight to
   * the checker skipped the ignore list, so staging a build artifact or a
   * deliberately-broken fixture would fail your own pre-commit hook.
   */
  it("still applies the ignore list to files the caller asked for", async () => {
    write("src/a.ts");
    write("dist/bundle.ts");

    const files = await selectFiles(dir, DEFAULT_CONFIG, [tsRule], [
      "src/a.ts",
      "dist/bundle.ts",
    ]);

    expect(files).toEqual(["src/a.ts"]);
  });

  it("drops a requested file that no longer exists, as a staged deletion does", async () => {
    write("src/a.ts");

    const files = await selectFiles(dir, DEFAULT_CONFIG, [tsRule], [
      "src/a.ts",
      "src/deleted.ts",
    ]);

    expect(files).toEqual(["src/a.ts"]);
  });

  it("returns nothing when the requested files are all irrelevant", async () => {
    write("src/a.ts");
    write("notes.md", "# notes\n");

    expect(
      await selectFiles(dir, DEFAULT_CONFIG, [tsRule], ["notes.md"]),
    ).toEqual([]);
  });
});
