/**
 * The sanctioned escape hatch, shared by both tiers so they cannot disagree
 * about what an exception looks like.
 *
 *   // qa-ignore: fe.storage.no-token-in-local-storage - short-lived demo key
 *
 * Without a way to switch off one rule with a recorded reason, the first false
 * positive gets the whole check disabled instead of the single rule.
 *
 * This file only says where an exception is written. Whether a written one
 * counts is `exceptions.ts`: automatic runs honour only committed ones.
 */
/**
 * Also matches gauntlet ids such as `eslint:@typescript-eslint/no-explicit-any`,
 * so a tool's warning is silenced the same way as a corpus rule. Every engine
 * has its own suppression dialect; this is the one the repo has to learn.
 */
const IGNORE = /qa-ignore:\s*([A-Za-z0-9._:@/-]*[A-Za-z0-9_@/])/;

function namesRule(line: string | undefined, ruleId: string): boolean {
  const match = line?.match(IGNORE);
  return match?.[1] === ruleId;
}

/**
 * Pattern tier: the comment must sit on the offending line or the one above it,
 * because a pattern finding points at a specific line and an exception should
 * be visible next to what it excuses. Returns the indices of the lines that
 * carry one.
 */
export function ignoreLinesAt(
  lines: string[],
  lineIndex: number,
  ruleId: string,
): number[] {
  return [lineIndex, lineIndex - 1].filter((i) => i >= 0 && namesRule(lines[i], ruleId));
}

export function isIgnoredAtLine(
  lines: string[],
  lineIndex: number,
  ruleId: string,
): boolean {
  return ignoreLinesAt(lines, lineIndex, ruleId).length > 0;
}

/**
 * Judgment tier: anywhere in the file counts.
 *
 * The judge is given a whole file and answers about the whole file, so the line
 * it cites is advisory rather than exact. Requiring the comment to land on that
 * line would make the escape hatch work only by luck.
 */
export function ignoreLinesInFile(text: string, ruleId: string): number[] {
  const found: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (namesRule(line, ruleId)) found.push(i);
  });
  return found;
}

export function isIgnoredInFile(text: string, ruleId: string): boolean {
  return ignoreLinesInFile(text, ruleId).length > 0;
}
