# agentic-qa

A rule-enforcement and test-contract system for AI-written production code.
Target stack of the repos it checks: React/Vite/TypeScript/TanStack Query,
Hono/TypeScript, Postgres, AWS/Terraform.

## Commands

```
npm run build                 # tsc -> dist/
npm test                      # vitest (fixtures/ excluded)
node dist/cli.js contracts    # run the contract checker in the cwd
```

To exercise the checker end to end:

```
cd fixtures/sample && node ../../dist/cli.js contracts
```

## Layers

- `src/cli.ts` — argument parsing and exit codes. Exit 1 means a gate failed.
- `src/config.ts` — `qa.config.yaml` loading and defaults.
- `src/judge.ts` — the only place that talks to a model.
- `src/contracts/extract.ts` — TypeScript AST parsing of test files.
- `src/contracts/ledger.ts` — hashing and the committed verdict ledger.
- `src/contracts/check.ts` — orchestration and reporting.
- `fixtures/sample/` — deliberately broken suites with known-correct verdicts
  in `expected.json`. Parsed by the extractor, never executed.

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
- **The judge is the only model caller.** Everything else is deterministic and
  unit-testable. Keep it that way.
- **Bump `JUDGE_VERSION` whenever the system prompt or schema changes.** A
  cached verdict is only meaningful relative to the prompt that produced it;
  the bump invalidates every stale verdict.
- **`.qa/contracts.json` is committed.** It is the durable record of what the
  suite claims and whether those claims hold. `.qa/cache/` is not.
- **Test ids are keyed on the title.** Editing a description yields a new id
  and forces a re-judge. That is intended, not a cache miss.
- **False positives are the thing that kills this system.** A judge that cries
  wolf on good tests gets switched off within a fortnight, and then the clean
  runs mean nothing. Weigh a false positive far more heavily than a miss, and
  validate every judge change against `fixtures/sample/expected.json`.

## Judge cost

`--safe-mode` is load-bearing: it strips CLAUDE.md, skills, plugins, hooks and
MCP servers while leaving OAuth intact, so no `ANTHROPIC_API_KEY` is needed.
Measured on one identical judgment with sonnet: $0.083 baseline, $0.020 with
`--strict-mcp-config`, $0.012 with `--safe-mode`, $0.008 on haiku. Do not use
`--bare`: it is cheaper still but forces API-key auth.
