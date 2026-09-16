import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import pc from "picocolors";
import type { Verdict } from "../types.js";
import { loadLedger } from "./ledger.js";

/**
 * Who checks the checker.
 *
 * A judge with a meaningful false-positive rate gets switched off within a
 * fortnight, and after that a clean run means nothing. So the judge is scored
 * against a corpus of tests with known-correct verdicts, and the two error
 * directions are reported separately: crying wolf on a good test is far more
 * damaging than missing a bad one.
 */
interface ExpectedFile {
  expected: Record<string, Verdict>;
}

interface EvalRow {
  id: string;
  want: Verdict;
  got: Verdict | "MISSING";
  match: boolean;
}

export function runEval(cwd: string, expectedPath: string): boolean {
  const path = resolve(cwd, expectedPath);
  if (!existsSync(path)) {
    process.stderr.write(pc.red(`no expectations file at ${expectedPath}\n`));
    return false;
  }

  const expected = (JSON.parse(readFileSync(path, "utf8")) as ExpectedFile).expected ?? {};
  const ledger = loadLedger(cwd);

  const rows: EvalRow[] = Object.entries(expected).map(([id, want]) => {
    const got = ledger.records[id]?.verdict ?? "MISSING";
    return { id, want, got, match: got === want };
  });

  // Crying wolf: the corpus says this test is fine, the judge condemned it.
  const falsePositives = rows.filter((r) => r.want === "upheld" && r.got !== "upheld");
  // Blind spot: the corpus says this test is weak, the judge waved it through.
  const falseNegatives = rows.filter((r) => r.want !== "upheld" && r.got === "upheld");
  const passed = rows.filter((r) => r.match).length;

  for (const r of rows) {
    const mark = r.match ? pc.green("PASS") : pc.red("FAIL");
    const shown = r.id.includes("::") ? r.id.split("::")[1] : r.id;
    process.stdout.write(
      `${mark}  ${String(r.got).padEnd(13)} want ${r.want.padEnd(13)} ${pc.dim(shown)}\n`,
    );
  }

  process.stdout.write(
    `\n${passed}/${rows.length} match · ` +
      `${falsePositives.length} false positive(s) · ` +
      `${falseNegatives.length} false negative(s)\n`,
  );

  if (falsePositives.length) {
    process.stdout.write(
      pc.red(
        "\nFalse positives are the failure mode that gets this switched off. " +
          "Fix the judge prompt before shipping.\n",
      ),
    );
  }

  return rows.every((r) => r.match);
}
