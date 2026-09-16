import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ContractRecord, ExtractedTest, Ledger } from "../types.js";
import { JUDGE_VERSION } from "../judge.js";

export const LEDGER_PATH = ".qa/contracts.json";

/**
 * Whitespace-insensitive so reformatting does not burn tokens re-judging
 * tests whose meaning did not change.
 */
function hash(input: string): string {
  return createHash("sha256")
    .update(input.replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16);
}

export function descriptionHash(t: ExtractedTest): string {
  return hash(t.description);
}

export function bodyHash(t: ExtractedTest): string {
  return hash(t.body);
}

export function loadLedger(cwd: string): Ledger {
  const path = resolve(cwd, LEDGER_PATH);
  if (!existsSync(path)) return { version: 1, records: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version === 1 && parsed.records) return parsed as Ledger;
  } catch {
    // A corrupt ledger is a cache, not a source of truth. Rebuild it.
  }
  return { version: 1, records: {} };
}

export function saveLedger(cwd: string, ledger: Ledger): void {
  const path = resolve(cwd, LEDGER_PATH);
  mkdirSync(dirname(path), { recursive: true });
  // Sorted keys so the committed diff is readable and review-friendly.
  const sorted: Record<string, ContractRecord> = {};
  for (const key of Object.keys(ledger.records).sort()) {
    sorted[key] = ledger.records[key];
  }
  writeFileSync(path, JSON.stringify({ version: 1, records: sorted }, null, 2) + "\n");
}

/**
 * The invalidation rule the whole design rests on: re-judge only when the
 * claim changed, the body changed, or the judge itself changed.
 */
export function needsJudging(
  test: ExtractedTest,
  ledger: Ledger,
  model: string,
): boolean {
  const prior = ledger.records[test.id];
  if (!prior) return true;
  if (prior.judgeVersion !== JUDGE_VERSION) return true;
  if (prior.model !== model) return true;
  if (prior.descriptionHash !== descriptionHash(test)) return true;
  if (prior.bodyHash !== bodyHash(test)) return true;
  return false;
}

/** Drop records for tests that no longer exist. */
export function prune(ledger: Ledger, liveIds: Set<string>): number {
  let removed = 0;
  for (const id of Object.keys(ledger.records)) {
    if (!liveIds.has(id)) {
      delete ledger.records[id];
      removed++;
    }
  }
  return removed;
}
