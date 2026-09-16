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
