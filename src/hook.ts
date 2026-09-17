import { execFileSync } from "node:child_process";
import { relative, resolve, isAbsolute } from "node:path";
import { loadConfig } from "./config.js";
import { loadRules } from "./rules/load.js";
import { selectFiles } from "./rules/select.js";
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

const GAUNTLET_LIMIT = 10;

/** Paths git reports as modified, added or untracked. */
export function changedFiles(cwd: string): string[] | undefined {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      // Swallow git's stderr. Outside a repo it prints a fatal line, which is
      // a normal fallback here, not a problem: letting it through trains
      // people to ignore output that is sometimes real.
      stdio: ["ignore", "pipe", "ignore"],
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
export async function readHookPayload(): Promise<{
  filePath?: string;
  stopHookActive?: boolean;
}> {
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
    const payload = JSON.parse(raw);
    const path = payload?.tool_input?.file_path;
    return {
      ...(typeof path === "string" ? { filePath: path } : {}),
      // Stop only. True when a Stop hook has already blocked this turn, which
      // is the flag that keeps a blocking hook from trapping the session.
      stopHookActive: payload?.stop_hook_active === true,
    };
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

    const edited = filePath
      ? (isAbsolute(filePath) ? relative(cwd, filePath) : filePath)
          .split("\\")
          .join("/")
      : undefined;

    // Narrowest scope that is still honest: the file just edited, else the
    // working tree's changes, else everything. selectFiles intersects rather
    // than substitutes, so the ignore list and the rules' own triggers still
    // apply whatever scope is asked for.
    const scope =
      edited && !edited.startsWith("..") ? [edited] : changedFiles(cwd);

    const files = await selectFiles(cwd, config, rules, scope);

    const { findings, unenforced } = await runMechanical(cwd, files, rules);
    const corpus = findings.filter((f) => f.origin === "corpus");
    const gauntlet = findings.filter((f) => f.origin === "gauntlet");
    if (!findings.length && !unenforced.length) return 0;

    const sections: string[] = [];

    if (corpus.length) {
      sections.push(
        [
          `agentic-qa found ${corpus.length} rule violation(s) in code you just changed:`,
          "",
          ...corpus.map((f) => `- ${f.file}:${f.line} ${f.statement} [${f.ruleId}]`),
          "",
          "Fix these before moving on. If one is genuinely intended, record it with",
          "a comment naming the rule, for example:",
          "  // qa-ignore: <rule-id> - why this case is different",
        ].join("\n"),
      );
    }

    if (gauntlet.length) {
      // Capped: this is advice about one file, and a wall of it gets skimmed.
      const shown = gauntlet.slice(0, GAUNTLET_LIMIT);
      const more = gauntlet.length - shown.length;
      sections.push(
        [
          `Linters also noted ${gauntlet.length} thing(s) in the same code. These do not block;`,
          "fix the ones that are real, and silence one deliberately with qa-ignore and its id:",
          "",
          ...shown.map((f) => `- ${f.file}:${f.line} ${f.statement} [${f.ruleId}]`),
          ...(more > 0 ? [`- ...and ${more} more`] : []),
        ].join("\n"),
      );
    }

    for (const u of unenforced) {
      sections.push(
        `${u.tool} could not run (${u.reason})` +
          (u.rules.length ? `, so these rules were not checked: ${u.rules.join(", ")}` : ""),
      );
    }

    emit(sections.join("\n\n"));
  } catch (err) {
    // Surfaced rather than swallowed: a checker that fails silently is worse
    // than no checker, because its silence reads as approval.
    emit(`agentic-qa could not run: ${(err as Error).message}`);
  }

  return 0;
}
