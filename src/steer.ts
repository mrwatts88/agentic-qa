import { bundledGuideDir, loadGuide, type Chapter } from "./guide.js";

/**
 * Session-start steering: before the main model writes anything, it learns that
 * the repo is held to a guide, which chapter covers which kind of work, and
 * where to read it.
 *
 * An index, not the guide and not a list of rules. The guide is tens of
 * thousands of words; a list of its rules would be hundreds of lines nobody
 * reads. An index stays a few hundred words however large the guide grows, and
 * the agent pays only for the chapters its work touches. The first version
 * listed every rule, which worked for a 25-rule test set and nothing larger.
 *
 * Generated at the start of every session from the chapters' own headers, so an
 * edited guide reaches the agent with no step anyone must remember. It travels
 * in hook output, so no consuming repo's CLAUDE.md changes.
 */

/** The index for a set of chapters. Pure, so it can be tested and measured. */
export function guideIndex(chapters: Chapter[], dir: string): string {
  return [
    "This repository is built to an engineering guide, and agentic-qa holds work to it.",
    "",
    `Before you work in an area, read that chapter of the guide in full. The chapters are in ${dir}:`,
    ...chapters.map((c) => `- ${c.file} (${c.title}). Read when ${c.readWhen}`),
    "",
    "When you finish a turn, the parts of the guide that can be checked mechanically are checked, and a",
    "broken rule stops you until it is fixed. Before the work is merged it is reviewed against these",
    "chapters, including whether each test's description states something its assertions would catch breaking.",
    "",
    "If the guide looks wrong for a particular case, say so to the person rather than working around it.",
    "An exception to a checked rule is a `// qa-ignore: <rule-id> - reason` comment, and it counts only",
    "once a person commits it.",
  ].join("\n");
}

function emit(payload: unknown): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

/**
 * The SessionStart hook. Always exits zero: a session that cannot start because
 * its guidance failed to load is far worse than a session without guidance. A
 * failure is told to the person, because silence would read as "no guide".
 */
export function runSessionStart(): number {
  try {
    const dir = bundledGuideDir();
    emit({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: guideIndex(loadGuide(dir), dir),
      },
    });
  } catch (err) {
    emit({ systemMessage: `agentic-qa could not load its guide for this session: ${(err as Error).message}` });
  }
  return 0;
}
