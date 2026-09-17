// The eslint configuration agentic-qa runs, shipped with the tool rather than
// read from the repo being checked, for the same reason the rules corpus is:
// a repo that keeps its own copy is a repo whose enforcement drifts.
//
// Run broad, on recommended presets. Only the rules the corpus names block;
// everything else here is the gauntlet, reported as warnings. The corpus says
// which of these it depends on, and a coverage check fails if one is switched
// off, so trimming a preset is visible rather than silent.
//
// Not type-aware yet. Type information needs a tsconfig the checked repo may not
// have, and costs a full program build per run; the rules that need it skip
// themselves quietly without parser services.
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import vitest from "@vitest/eslint-plugin";

const TESTS = ["**/*.{test,spec}.{ts,tsx,js,jsx}"];

export default [
  {
    // Severity here is irrelevant: the corpus decides what blocks. Stale
    // disable directives are a lint-hygiene opinion, not a finding.
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
  ...tseslint.configs.recommended,
  sonarjs.configs.recommended,
  {
    files: TESTS,
    plugins: { vitest },
    rules: vitest.configs.recommended.rules,
  },
];
