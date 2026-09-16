import { execFileSync } from "node:child_process";
import { relative, resolve, isAbsolute } from "node:path";
import { glob } from "tinyglobby";
import { loadConfig } from "./config.js";
import { loadRules } from "./rules/load.js";
import { triggerGlobs } from "./rules/route.js";
import { runMechanical } from "./rules/mechanical.js";

/**
 * The agent-facing call site: a PostToolUse hook that runs after every edit.
 *
 * Two rules govern everything here.
 *
 * It never exits non-zero. PostToolUse fires after the tool has already run, so
 * exit 2 cannot undo anything; it only stops the turn. Findings reach the model
 * through `additionalContext` instead, which is what Claude actually reads.
 *
 * It reports on the file that was just edited, and failing that on whatever the
 * working tree has changed. A hook that complains about pre-existing violations
 * in code the agent never touched is noise, and gets switched off within a day.
 * Running it repo-wide is fast enough, but speed was the wrong thing to
 * optimise: a batch of seven edits produced seven identical warnings.
 */
function emit(additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext,
      },
    }) + "\n",
  );
}

/** Paths git reports as modified, added or untracked. */
export function changedFiles(cwd: string): string[] | undefined {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
    });

    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const path = line.slice(3).trim();
        // Renames appear as "old -> new"; the new path is the one to check.
        const arrow = path.indexOf(" -> ");
        return arrow === -1 ? path : path.slice(arrow + 4);
      })
      .filter(Boolean);
  } catch {
    return undefined;
  }
}

/**
 * Reads the PostToolUse payload from stdin and pulls out the edited path.
 *
 * Kept at the CLI boundary rather than inside `runHook`, so the checker stays a
 * pure function of (cwd, path) and its tests never touch stdin. A test that
 * waits on a pipe that may never close is a test that hangs.
 */
export async function readHookPayload(): Promise<{ filePath?: string }> {
  if (process.stdin.isTTY) return {};

  const raw = await new Promise<string>((done) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => done(""), 250);

    process.stdin.on("data", (chunk) => chunks.push(chunk as Buffer));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      done(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      done("");
    });
  });

  if (!raw.trim()) return {};

  try {
    const path = JSON.parse(raw)?.tool_input?.file_path;
    return typeof path === "string" ? { filePath: path } : {};
  } catch {
    return {};
  }
}

export async function runHook(cwd: string, filePath?: string): Promise<number> {
  try {
    const config = loadConfig(cwd);
    const rules = loadRules(
      config.rules.paths.map((p) => resolve(cwd, p)),
      config.rules.packs,
    );

    const all = await glob(triggerGlobs(rules), {
      cwd,
      ignore: config.ignore,
      absolute: false,
    });

    // Narrowest scope that is still honest: the file just edited, else the
    // working tree's changes, else everything.
    const edited = filePath
      ? (isAbsolute(filePath) ? relative(cwd, filePath) : filePath)
          .split("\\")
          .join("/")
      : undefined;

    let files: string[];
    if (edited && !edited.startsWith("..")) {
      files = all.filter((f) => f === edited);
    } else {
      const changed = changedFiles(cwd);
      files = changed ? all.filter((f) => changed.includes(f)) : all;
    }

    const findings = runMechanical(cwd, files, rules);
    if (!findings.length) return 0;

    const lines = findings.map(
      (f) => `- ${f.file}:${f.line} ${f.statement} [${f.ruleId}]`,
    );

    emit(
      [
        `agentic-qa found ${findings.length} rule violation(s) in code you just changed:`,
        "",
        ...lines,
        "",
        "Fix these before moving on. If one is genuinely intended, record it with",
        "a comment naming the rule, for example:",
        "  // qa-ignore: <rule-id> - why this case is different",
      ].join("\n"),
    );
  } catch (err) {
    // Surfaced rather than swallowed: a checker that fails silently is worse
    // than no checker, because its silence reads as approval.
    emit(`agentic-qa could not run: ${(err as Error).message}`);
  }

  return 0;
}
