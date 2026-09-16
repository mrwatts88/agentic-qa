import picomatch from "picomatch";
import type { Rule } from "./types.js";

/**
 * Routing is what keeps this affordable and attentive. Handing a model, or a
 * reviewer, every rule for every file produces a shallow pass over all of them.
 * A change under components/ should pull the frontend rules and nothing else.
 */
const matcherCache = new Map<string, (path: string) => boolean>();

function matcher(globs: string[]): (path: string) => boolean {
  const key = globs.join("\u0000");
  let fn = matcherCache.get(key);
  if (!fn) {
    fn = picomatch(globs, { dot: true });
    matcherCache.set(key, fn);
  }
  return fn;
}

/** Normalise to forward slashes so globs behave the same on every platform. */
export function normalise(file: string): string {
  return file.split("\\").join("/");
}

export function ruleAppliesTo(rule: Rule, file: string): boolean {
  const path = normalise(file);
  if (!matcher(rule.triggers.paths)(path)) return false;

  const excludes = rule.triggers.excludePaths;
  if (excludes?.length && matcher(excludes)(path)) return false;

  return true;
}

export function rulesForFile(file: string, rules: Rule[]): Rule[] {
  return rules.filter((rule) => ruleAppliesTo(rule, file));
}

/**
 * The set of globs worth walking the filesystem for, given the active rules.
 * Avoids globbing the entire repo to then discard most of it.
 */
export function triggerGlobs(rules: Rule[]): string[] {
  const globs = new Set<string>();
  for (const rule of rules) {
    for (const glob of rule.triggers.paths) globs.add(glob);
  }
  return [...globs];
}
