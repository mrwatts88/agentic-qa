import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import type { ExtractedTest } from "../types.js";

const TEST_FNS = new Set(["it", "test"]);
const SUITE_FNS = new Set(["describe", "suite"]);
const HOOK_FNS = new Set(["beforeEach", "afterEach", "beforeAll", "afterAll"]);

/** Keeps a pathological test file from producing an enormous prompt. */
const MAX_CONTEXT_CHARS = 4000;

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

/**
 * Everything in the file that is not itself a test: imports, builders, factory
 * helpers, and setup hooks. A test body means little without the helpers it
 * calls, and judging it alone manufactures false positives.
 */
function collectContext(source: ts.SourceFile): string {
  const parts: string[] = [];

  for (const statement of source.statements) {
    if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression)
    ) {
      const name = leftmostName(statement.expression.expression);
      // Suites and tests are handled separately; hooks are collected below at
      // whatever depth they appear, so skip them here to avoid duplicates.
      if (name && (SUITE_FNS.has(name) || TEST_FNS.has(name) || HOOK_FNS.has(name))) {
        continue;
      }
    }
    parts.push(statement.getText(source));
  }

  const visitForHooks = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = leftmostName(node.expression);
      if (name && HOOK_FNS.has(name)) {
        parts.push(node.getText(source));
        return;
      }
    }
    ts.forEachChild(node, visitForHooks);
  };
  ts.forEachChild(source, visitForHooks);

  const joined = parts.join("\n\n");
  return joined.length > MAX_CONTEXT_CHARS
    ? `${joined.slice(0, MAX_CONTEXT_CHARS)}\n// ... context truncated`
    : joined;
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
  const context = collectContext(source);

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
            context,
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

/**
 * Relative imports of a test file, resolved to files on disk. Used to find the
 * implementation a test exercises, so mutation grounding knows what to break.
 */
export function extractRelativeImports(absPath: string): string[] {
  const text = readFileSync(absPath, "utf8");
  const source = ts.createSourceFile(
    absPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(absPath),
  );

  const dir = dirname(absPath);
  const resolved: string[] = [];

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.startsWith(".")) continue;

    const base = resolve(dir, specifier.text);
    // TypeScript sources may be imported with no extension, with .js, or with
    // the real extension. Try the plausible spellings in order.
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      base.replace(/\.js$/, ".ts"),
      base.replace(/\.js$/, ".tsx"),
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ];

    for (const candidate of candidates) {
      if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
        if (existsSync(candidate) && !resolved.includes(candidate)) {
          resolved.push(candidate);
          break;
        }
      }
    }
  }

  return resolved;
}
