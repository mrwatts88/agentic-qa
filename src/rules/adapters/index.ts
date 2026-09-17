import type { Adapter } from "./types.js";
import { eslint } from "./eslint.js";

/**
 * Kept separate from the adapters themselves so the rule loader can validate a
 * tool name without importing an engine.
 */
export const KNOWN_TOOLS = ["eslint"];

export function defaultAdapters(): Adapter[] {
  return [eslint()];
}
