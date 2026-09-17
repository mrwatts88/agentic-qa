import { execFileSync } from "node:child_process";
import type { RefusedException } from "./rules/exceptions.js";

/**
 * What the Claude Code hooks share: reading a hook's payload, what the working
 * tree has changed, and how an exception is described to the agent.
 *
 * This file was once the per-edit PostToolUse hook. It was removed because
 * nearly everything it said was gauntlet noise the agent learned to skip, and
 * Stop enforces the corpus on every change however it was made. `agentic-qa
 * hook` still exits zero silently, so a repo whose settings predate the removal
 * does not error on every edit; see src/cli.ts.
 */

/**
 * Addressed to the agent, which is the likeliest author of an exception it has
 * no business approving. It is told what an exception is so that it can
 * propose one, and told plainly that writing one does not release anything.
 */
export const EXCEPTIONS_ARE_APPROVED = [
  "If you believe one is wrong, say so to the person rather than working around it.",
  "An exception is a comment naming the rule, and it counts only once a person has",
  "committed it:",
  "  // qa-ignore: <rule-id> - why this case is different",
].join("\n");

export function refusedLines(refused: RefusedException[]): string[] {
  return refused.map((r) => `- ${r.file}:${r.line} qa-ignore for ${r.ruleId}`);
}

/** Paths git reports as modified, added or untracked. */
export function changedFiles(cwd: string): string[] | undefined {
  try {
    // Every untracked file, not the default's collapsed "dir/": a file created
    // in a new directory would otherwise never be checked.
    const out = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
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
 * Reads a hook's payload from stdin.
 *
 * Kept at the CLI boundary rather than inside `runStop`, so the checker stays a
 * pure function of cwd and options and its tests never touch stdin. A test that
 * waits on a pipe that may never close is a test that hangs.
 */
export async function readHookPayload(): Promise<{ stopHookActive?: boolean }> {
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
    return {
      // True when a Stop hook has already blocked this turn, which is the flag
      // that keeps a blocking hook from trapping the session.
      stopHookActive: payload?.stop_hook_active === true,
    };
  } catch {
    return {};
  }
}
