import { describe, it, expect } from "vitest";
import { isIgnoredAtLine, isIgnoredInFile } from "../src/rules/ignore";

const RULE = "fe.storage.no-token-in-local-storage";

describe("isIgnoredAtLine", () => {
  it("accepts an exception on the offending line", () => {
    const lines = [`localStorage.setItem("t", t); // qa-ignore: ${RULE} - demo`];

    expect(isIgnoredAtLine(lines, 0, RULE)).toBe(true);
  });

  it("accepts an exception on the line above", () => {
    const lines = [`// qa-ignore: ${RULE} - demo`, 'localStorage.setItem("t", t);'];

    expect(isIgnoredAtLine(lines, 1, RULE)).toBe(true);
  });

  it("ignores an exception naming a different rule", () => {
    const lines = ["// qa-ignore: some.other.rule", 'localStorage.setItem("t", t);'];

    expect(isIgnoredAtLine(lines, 1, RULE)).toBe(false);
  });

  /**
   * A pattern finding points at a specific line, so the exception has to be
   * visible next to what it excuses rather than buried elsewhere in the file.
   */
  it("does not accept an exception several lines away", () => {
    const lines = [`// qa-ignore: ${RULE}`, "", "", 'localStorage.setItem("t", t);'];

    expect(isIgnoredAtLine(lines, 3, RULE)).toBe(false);
  });

  it("is not fooled by a line that merely mentions the rule id", () => {
    const lines = [`// see ${RULE} for why this matters`, "const t = 1;"];

    expect(isIgnoredAtLine(lines, 1, RULE)).toBe(false);
  });
});

/**
 * The judge reads a whole file and answers about the whole file, so the line it
 * cites is advisory. Requiring the comment to land on that exact line would
 * make the escape hatch work only by luck.
 */
describe("isIgnoredInFile", () => {
  it("accepts an exception anywhere in the file", () => {
    const text = [
      "import { Hono } from 'hono';",
      "",
      `// qa-ignore: ${RULE} - the service scopes this query`,
      "",
      "export const app = new Hono();",
    ].join("\n");

    expect(isIgnoredInFile(text, RULE)).toBe(true);
  });

  it("does not suppress a rule the exception does not name", () => {
    const text = `// qa-ignore: some.other.rule\nexport const app = 1;\n`;

    expect(isIgnoredInFile(text, RULE)).toBe(false);
  });

  it("reports nothing ignored in a file with no exception at all", () => {
    expect(isIgnoredInFile("export const app = 1;\n", RULE)).toBe(false);
  });
});
