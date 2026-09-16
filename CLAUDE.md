# agentic-qa

A rule-enforcement and test-contract system for AI-written production code.
Target stack of the repos it checks: React/Vite/TypeScript/TanStack Query,
Hono/TypeScript, Postgres, AWS/Terraform.

## Commands

```
npm run build                 # tsc -> dist/
npm test                      # vitest (fixtures/ excluded)
node dist/cli.js contracts    # judge tests against their descriptions
node dist/cli.js mutate       # break the code and check the tests notice
node dist/cli.js eval         # score the judge against known-correct verdicts
```

Two fixture corpora, used for different things:

```
cd fixtures/sample   && node ../../dist/cli.js contracts   # judging only
cd fixtures/runnable && node ../../dist/cli.js mutate      # judging + experiment
```

`fixtures/sample` deliberately imports a module that does not exist, so its
tests can never run. `fixtures/runnable` is a real green suite, which mutation
grounding needs.

## Layers

- `src/cli.ts` — argument parsing and exit codes. Exit 1 means a gate failed.
- `src/config.ts` — `qa.config.yaml` loading and defaults.
- `src/judge.ts` — the only place that talks to a model.
- `src/contracts/extract.ts` — TypeScript AST parsing of test files.
- `src/contracts/ledger.ts` — hashing and the committed verdict ledger.
- `src/contracts/check.ts` — orchestration and reporting.
- `src/contracts/mutate.ts` — mutation grounding.
- `src/contracts/evaluate.ts` — scores the judge against known answers.
- `rules/*.yaml` — the rules corpus, one file per area.
- `src/rules/load.ts` — reads and validates the corpus, strictly.
- `src/rules/route.ts` — which rules apply to which files.
- `src/rules/mechanical.ts` — runs the pattern tier.
- `src/rules/llm.ts` — runs the judgment tier, with its own cached ledger.
- `src/pool.ts` — shared bounded concurrency. Not for mutations, which must
  stay serial.
- `src/hook.ts` — the PostToolUse hook. Reports to the model, never gates.
- `src/init.ts` — installs the call sites into a repo. Never overwrites.
- `test/` — unit tests for the deterministic parts. Anything that talks to a
  model is covered by the fixture corpora instead.

## Invariants

- **The enforcement ladder.** Every rule declares the cheapest tier that can
  enforce it: `mechanical` (lint, tsc, dependency-cruiser, semgrep) before
  `llm` before `human`. Paying a model to do a linter's job is strictly worse.
  A rule that cannot name its enforcement is not a rule yet.
- **One CLI, three call sites.** Agent harness hooks, git hooks, and CI all
  invoke this same binary. Never fork the logic per call site, or the rules the
  agent is told about drift from the rules the gate enforces.
- **No model calls in pre-commit.** Git hooks run the mechanical tier only.
  Commits must work offline and must not cost money.
- **All model calls go through `invoke()` in `src/judge.ts`.** Everything else
  is deterministic and unit-testable. Keep it that way, and keep the cost flags
  in one place so they cannot drift.
- **Bump `JUDGE_VERSION` or `MUTATION_VERSION` whenever a system prompt or
  schema changes.** A cached result is only meaningful relative to the prompt
  that produced it; the bump invalidates every stale one.
- **`.qa/contracts.json` is committed.** It is the durable record of what the
  suite claims and whether those claims hold. `.qa/cache/` is not.
- **Test ids are keyed on the title.** Editing a description yields a new id
  and forces a re-judge. That is intended, not a cache miss.
- **Never trust a test runner's exit code to mean "the test failed".** vitest
  exits 0 when `-t` matches nothing. Treating that as a failure would read as
  "the test passed despite the mutation" and condemn a good test. Always read
  the per-assertion `status` from the JSON reporter and match it structurally
  on `ancestorTitles` plus `title`. The reporter writes to
  `<root>/.vitest/json/output.json`, not stdout, and its `fullName` joins the
  describe path with a space.
- **Mutations run strictly serially and only on tracked, clean files.** They
  write to real source files: concurrent runs would corrupt each other, and an
  untracked file has no recovery path if the process dies. Restore the original
  in a `finally`, always.
- **Mutation grounding edits the implementation, never a test.** A test edited
  to pass proves nothing.
- **The PostToolUse hook always exits zero.** It fires after the tool has
  already run, so a non-zero exit cannot undo anything and only stops the turn.
  Findings reach the model through `hookSpecificOutput.additionalContext`, which
  is what Claude actually reads. `continueOnBlock`, `decision` and `reason` do
  not apply to this event.
- **The hook reports only on the file just edited**, falling back to the working
  tree's changes when no path is given. Complaining about pre-existing
  violations in code the agent never touched is noise, and noise gets the hook
  uninstalled. Repo-wide is fast enough, but speed was never the constraint.
- **Stdin parsing stays at the CLI boundary.** `runHook` is a pure function of
  cwd and path so its tests never wait on a pipe that may not close.
- **`init` never overwrites an existing file.** An existing pre-commit hook or
  settings file belongs to whoever wrote it. Report it and leave it alone.
- **The llm tier is opt-in (`--llm`) and never runs in a git hook.** It costs
  money and needs the network. The mechanical tier is what gates a commit.
- **An llm rule must be able to answer `not-applicable`.** Routing hands a rule
  every file its globs match, and most are irrelevant to it. Forcing a binary
  answer manufactures false positives. Any new llm rule needs fixture cases
  asserting it stays quiet about files it has nothing to say about.
- **Every rule keeps a working `qa-ignore` escape hatch.** Without a sanctioned
  way to switch off one rule with a recorded reason, the first false positive
  gets the whole check disabled instead.
- **A new mechanical rule needs a clean control file, not just a violating
  one.** `fixtures/rules` exists to prove a rule stays silent on correct code
  that contains the same construct. A rule with no clean control has not been
  shown to be safe.
- **False positives are the thing that kills this system.** A judge that cries
  wolf on good tests gets switched off within a fortnight, and then the clean
  runs mean nothing. Weigh a false positive far more heavily than a miss, and
  re-run `eval` against both fixture corpora after any judge change.

## Judge cost

`--safe-mode` is load-bearing: it strips CLAUDE.md, skills, plugins, hooks and
MCP servers while leaving OAuth intact, so no `ANTHROPIC_API_KEY` is needed.
Measured on one identical judgment with sonnet: $0.083 baseline, $0.020 with
`--strict-mcp-config`, $0.012 with `--safe-mode`, $0.008 on haiku. Do not use
`--bare`: it is cheaper still but forces API-key auth.
