import { describe, it, expect } from "vitest";
import { groupByRule, underPaths } from "../src/gauntlet";
import type { Finding } from "../src/rules/types";

function finding(ruleId: string, file: string): Finding {
  return { ruleId, origin: "gauntlet", statement: "x", severity: "warn", file, line: 1, excerpt: "", rationale: "" };
}

describe("groupByRule", () => {
  /** Triage reads "this rule, these N places", the noisiest rule first. */
  it("groups by rule, most frequent first", () => {
    const groups = groupByRule([
      finding("eslint:a", "one.ts"),
      finding("eslint:b", "one.ts"),
      finding("eslint:b", "two.ts"),
    ]);

    expect(groups.map(([rule, found]) => [rule, found.length])).toEqual([
      ["eslint:b", 2],
      ["eslint:a", 1],
    ]);
  });
});

describe("underPaths", () => {
  const files = ["src/a.ts", "src/lib/b.ts", "srcs/c.ts", "d.ts"];

  it("keeps everything when no path is given", () => {
    expect(underPaths(files, [])).toEqual(files);
  });

  it("keeps files at or under a directory, not ones sharing its prefix", () => {
    expect(underPaths(files, ["src/"])).toEqual(["src/a.ts", "src/lib/b.ts"]);
  });

  it("accepts a single file", () => {
    expect(underPaths(files, ["./d.ts"])).toEqual(["d.ts"]);
  });
});
