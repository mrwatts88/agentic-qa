import ts from "typescript";
import { readFileSync } from "node:fs";
import type { ExtractedTest } from "../types.js";

const TEST_FNS = new Set(["it", "test"]);
const SUITE_FNS = new Set(["describe", "suite"]);

/** `it.each(...)` / `describe.only` etc: take the leftmost identifier. */
function leftmostName(expr: ts.Expression): string | undefined {
  let node: ts.Node = expr;
  while (ts.isPropertyAccessExpression(node) || ts.isCallExpression(node)) {
    node = ts.isCallExpression(node) ? node.expression : node.expression;
  }
  return ts.isIdentifier(node) ? node.text : undefined;
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  // A template with no substitutions is still a stable title.
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/**
 * Pull `@describes ...` out of a leading block comment. This is the richer
 * form; when absent the test title is the contract. Keeping the description
 * adjacent to the test is deliberate: a sidecar file rots immediately.
 */
function docblockDescription(
  source: ts.SourceFile,
  node: ts.Node,
  fullText: string,
): string | undefined {
  const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
  if (!ranges?.length) return undefined;

  // Scan every leading comment, nearest first. Taking only the closest one
  // misses the common case where an unrelated line comment sits between the
  // docblock and the test.
  for (let i = ranges.length - 1; i >= 0; i--) {
    const comment = fullText.slice(ranges[i].pos, ranges[i].end);
    const match = comment.match(/@describes\s+([\s\S]*?)(?:\n\s*\*\s*@|\*\/|$)/);
    if (!match) continue;

    const text = match[1]
      .split("\n")
      .map((l) => l.replace(/^\s*\*?\s?/, "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();

    if (text) return text;
  }

  return undefined;
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

export function extractTests(
  absPath: string,
  relPath: string,
): ExtractedTest[] {
  const text = readFileSync(absPath, "utf8");
  const source = ts.createSourceFile(
    absPath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKind(absPath),
  );

  const found: ExtractedTest[] = [];
  const suiteStack: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = leftmostName(node.expression);
      const title = literalText(node.arguments[0]);

      if (name && title !== undefined) {
        if (SUITE_FNS.has(name)) {
          suiteStack.push(title);
          ts.forEachChild(node, visit);
          suiteStack.pop();
          return;
        }

        if (TEST_FNS.has(name)) {
          const impl = node.arguments[1];
          const body =
            impl &&
            (ts.isArrowFunction(impl) || ts.isFunctionExpression(impl)) &&
            impl.body
              ? impl.body.getText(source)
              : "";

          const docblock = docblockDescription(source, node, text);
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));

          found.push({
            // Keyed on title, so a changed description yields a new id and is
            // re-judged. That is the correct behaviour, not a cache miss bug.
            id: `${relPath}::${[...suiteStack, title].join(" > ")}`,
            file: relPath,
            describePath: [...suiteStack],
            title,
            description: docblock ?? title,
            descriptionSource: docblock ? "docblock" : "title",
            body,
            line: line + 1,
          });
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
}
