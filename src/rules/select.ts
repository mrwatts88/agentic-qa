import { glob } from "tinyglobby";
import type { QaConfig } from "../config.js";
import type { Rule } from "./types.js";
import { triggerGlobs } from "./route.js";

/**
 * The files worth checking: everything some active rule triggers on, minus the
 * ignore list, optionally narrowed to a caller-supplied set.
 *
 * Narrowing by intersection rather than substitution is the whole point. Handing
 * a staged or edited path straight to the checker skips the ignore list, so
 * staging a build artifact or a deliberately-broken fixture would fail your own
 * pre-commit hook. It also quietly drops deleted paths, which are staged but no
 * longer on disk.
 */
export async function selectFiles(
  cwd: string,
  config: QaConfig,
  rules: Rule[],
  only?: string[],
): Promise<string[]> {
  const globbed = await glob(triggerGlobs(rules), {
    cwd,
    // .git is never source, and is excluded here rather than in the default
    // ignore list because a repo's own list replaces the defaults.
    ignore: [...config.ignore, "**/.git/**"],
    absolute: false,
    // Routing matches dotfiles, so globbing must find them. Without this a
    // `**/*` trigger never saw .env, .npmrc or .github/, which is where a
    // committed secret is most likely to be.
    dot: true,
  });

  if (!only) return globbed;

  const wanted = new Set(only);
  return globbed.filter((file) => wanted.has(file));
}
