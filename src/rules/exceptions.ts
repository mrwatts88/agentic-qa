import { execFileSync } from "node:child_process";
import { ignoreLinesAt, ignoreLinesInFile } from "./ignore.js";

/**
 * Whether a written `qa-ignore` counts.
 *
 * An agent that is blocked has a one-line way out: write an exception with a
 * plausible reason. That was observed, not imagined — the first headless run of
 * a blocking Stop hook had an agent propose `qa-ignore ... - this is test code`
 * on production code. Nothing can check a reason, because the reason is the
 * very text written to persuade. What can be checked is who made the exception
 * take effect: an exception exists because a person chose it, and committing is
 * that act.
 *
 * So there are two policies. Commit and CI honour every exception they see,
 * since what they see is staged or committed. The automatic call sites — the
 * per-edit hook and Stop — honour only an exception whose comment line is
 * unchanged since `HEAD`.
 */
export interface ExceptionPolicy {
  /** Whether the exception comment on this 0-based line of this file counts. */
  honours(file: string, lineIndex: number): boolean;
}

/** An exception that was written but not honoured. */
export interface RefusedException {
  file: string;
  /** 1-based, as findings are. */
  line: number;
  ruleId: string;
}

export const HONOUR_ALL: ExceptionPolicy = { honours: () => true };

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/**
 * The 0-based working-tree lines of a file that differ from `HEAD`, or "all"
 * when the file is not in `HEAD` at all: untracked, newly added, renamed, or in
 * a repo with no commits yet.
 */
export function uncommittedLines(cwd: string, file: string): Set<number> | "all" {
  if (git(cwd, ["cat-file", "-e", `HEAD:./${file}`]) === undefined) return "all";

  // Staged changes count as uncommitted too: staging is not approval, the
  // commit is. -U0 makes every hunk exactly the changed lines.
  const diff = git(cwd, [
    "diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "-U0", "--", file,
  ]);
  if (diff === undefined) return "all";

  const changed = new Set<number>();
  for (const match of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let i = 0; i < count; i++) changed.add(start - 1 + i);
  }
  return changed;
}

/**
 * Honours an exception only when its comment line is unchanged since `HEAD`.
 *
 * Judged by line rather than by whether the same text exists somewhere in the
 * committed file: moving an approved comment onto different code is a new
 * exception, and a diff sees a moved line as an added one.
 *
 * Outside a git repository nothing can be committed, so there is no approval to
 * wait for, and refusing every exception would remove the hatch entirely.
 * There, every exception counts, as it does at commit and in CI.
 *
 * git is consulted only when a comment actually matches a finding, and once per
 * file, so a run with no exceptions in play costs nothing.
 */
export function committedOnly(cwd: string): ExceptionPolicy {
  if (git(cwd, ["rev-parse", "--is-inside-work-tree"])?.trim() !== "true") return HONOUR_ALL;

  const cache = new Map<string, Set<number> | "all">();
  return {
    honours(file, lineIndex) {
      let lines = cache.get(file);
      if (!lines) {
        lines = uncommittedLines(cwd, file);
        cache.set(file, lines);
      }
      return lines !== "all" && !lines.has(lineIndex);
    },
  };
}

/**
 * Collects refusals across a run, one per comment, so a finding reported by
 * two engines does not list its exception twice.
 */
export class ExceptionGate {
  private readonly seen = new Map<string, RefusedException>();

  constructor(private readonly policy: ExceptionPolicy = HONOUR_ALL) {}

  /** True when an honoured exception excuses this finding. */
  private excuses(file: string, ruleId: string, candidates: number[]): boolean {
    if (candidates.some((i) => this.policy.honours(file, i))) return true;
    for (const i of candidates) {
      const refused = { file, line: i + 1, ruleId };
      this.seen.set(`${file}:${refused.line} ${ruleId}`, refused);
    }
    return false;
  }

  /** Pattern and scanner findings: the offending line or the one above. */
  excusesAt(file: string, lines: string[], lineIndex: number, ruleId: string): boolean {
    return this.excuses(file, ruleId, ignoreLinesAt(lines, lineIndex, ruleId));
  }

  /** Judgment findings: anywhere in the file. */
  excusesInFile(file: string, text: string, ruleId: string): boolean {
    return this.excuses(file, ruleId, ignoreLinesInFile(text, ruleId));
  }

  refused(): RefusedException[] {
    return [...this.seen.values()];
  }
}
