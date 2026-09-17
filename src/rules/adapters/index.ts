import type { Adapter } from "./types.js";
import { eslint } from "./eslint.js";
import { dependencyCruiser } from "./dependency-cruiser.js";
import { gitleaks } from "./gitleaks.js";

/**
 * Kept separate from the adapters themselves so the rule loader can validate a
 * tool name without importing an engine.
 */
export const KNOWN_TOOLS = ["eslint", "dependency-cruiser", "gitleaks"];

export function defaultAdapters(): Adapter[] {
  return [eslint(), dependencyCruiser(), gitleaks()];
}
