import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The README's command reference is written by hand, and a command added to the
 * CLI without it is a command nobody setting this up can find. The help text in
 * src/cli.ts is the list of what exists.
 */
describe("the README's command reference", () => {
  const root = join(__dirname, "..");
  const cli = readFileSync(join(root, "src", "cli.ts"), "utf8");
  const usage = cli.slice(cli.indexOf("const USAGE = `"), cli.indexOf("`;", cli.indexOf("const USAGE = `")));
  const commands = [...usage.matchAll(/^ {2}agentic-qa ([a-z-]+)/gm)].map((m) => m[1]);
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const reference = readme.slice(readme.indexOf("## Commands"), readme.indexOf("\n## ", readme.indexOf("## Commands") + 1));

  it("finds the commands in the help text, so this test is not vacuous", () => {
    expect(commands.length).toBeGreaterThanOrEqual(12);
  });

  it("lists every command the CLI has", () => {
    const missing = commands.filter((c) => !new RegExp(`\\| \`${c}[\` ]`).test(reference));

    expect(missing).toEqual([]);
  });
});
