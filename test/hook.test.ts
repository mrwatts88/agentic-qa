import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changedFiles } from "../src/hook";

let dir: string;

function write(relative: string, contents: string): void {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentic-qa-hook-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("changedFiles", () => {
  it("returns nothing outside a git repository, so Stop knows it has no scope", () => {
    expect(changedFiles(dir)).toBeUndefined();
  });

  it("lists a file the working tree has added", () => {
    git("init");
    write("a.ts", "export const a = 1;\n");

    expect(changedFiles(dir)).toContain("a.ts");
  });

  it("lists the files inside a new directory, not the directory", () => {
    git("init");
    write("web/auth/session.ts", "export const a = 1;\n");

    expect(changedFiles(dir)).toEqual(["web/auth/session.ts"]);
  });
});
