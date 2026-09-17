import type { Adapter } from "./types.js";
import { eslint } from "./eslint.js";
import { dependencyCruiser } from "./dependency-cruiser.js";
import { gitleaks } from "./gitleaks.js";
import { opengrep } from "./opengrep.js";

/**
 * Kept separate from the adapters themselves so the rule loader can validate a
 * tool name without importing an engine.
 */
export const KNOWN_TOOLS = ["eslint", "dependency-cruiser", "gitleaks", "opengrep"];

/**
 * `fast` leaves out the slow engines, for the commit hook by default.
 */
export function defaultAdapters(options: { fast?: boolean } = {}): Adapter[] {
  const all = [eslint(), dependencyCruiser(), gitleaks(), opengrep()];
  return options.fast ? all.filter((a) => !a.slow) : all;
}
