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
    ignore: config.ignore,
    absolute: false,
  });

  if (!only) return globbed;

  const wanted = new Set(only);
  return globbed.filter((file) => wanted.has(file));
}
