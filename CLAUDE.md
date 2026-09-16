# agentic-qa

A rule-enforcement and test-contract system for AI-written production code.
Target stack of the repos it checks: React/Vite/TypeScript/TanStack Query,
Hono/TypeScript, Postgres, AWS/Terraform.

**Where things stand and what is next: [ROADMAP.md](ROADMAP.md).** It carries
the status, the remaining work, and the reasoning behind decisions already made,
including several that were reached by getting them wrong first.

**The calibration target is `~/code/orders-admin`**, a separate repo: a small
CRUD app on the target stack that installs this tool as a git dependency. A rule
change is not finished until it has been run against both the fixtures here and
that app. Fixtures prove the machinery works; only real code shows how the rules
behave on code that was not written to be a test case.

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
- `src/rules/ignore.ts` — the qa-ignore escape hatch, shared by both tiers.
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
- **Bump `JUDGE_VERSION`, `RULE_JUDGE_VERSION` or `MUTATION_VERSION` whenever
  its system prompt or schema changes.** A cached result is only meaningful
  relative to the prompt that produced it; the bump invalidates every stale one.
  There are three because the three prompts change independently, and one shared
  constant would re-judge every contract because a rule prompt moved. Every
  ledger record must carry its version, and the freshness check must compare it:
  the rules ledger shipped without one, so for a while a bump silently
  invalidated nothing. A per-rule `promptHash` does not cover this — it sees the
  rule's own question, never the shared system prompt around it.
- **`.qa/contracts.json` and `.qa/rules.json` are committed.** They are the
  durable record of what the suite claims, and of every judgment verdict, and
  whether those claims hold. `.qa/cache/` and `.qa/tmp/` are not. Because they
  are shared, a stale record is not a local annoyance: it propagates.
- **A scoped run never prunes.** Both ledgers drop dead records, but a run
  narrowed to staged or edited files has no view of anything else, so deleting
  what it did not look at would make a committed file depend on how it was last
  invoked. Contracts prunes tests that no longer exist only on an unscoped run;
  the rules ledger prunes verdicts whose file is gone, on the same condition.
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
- **Narrow by intersection, never by substitution.** Any scope a caller supplies
  (staged paths, the edited file) goes through `selectFiles`, which intersects
  it with the globbed set so the ignore list and the rules' own triggers still
  apply. Handing a path straight to the checker is how staging a build artifact
  or a deliberately-broken fixture ends up failing your own pre-commit hook.
  Note that a unit test of `selectFiles` does not prove a call site uses it.
- **`init` never overwrites an existing file.** An existing pre-commit hook or
  settings file belongs to whoever wrote it. Report it and leave it alone.
- **`init` installs nothing that was not asked for.** Each call site is a flag
  (`--git-hook`, `--claude-hook`); bare `init` writes only `qa.config.yaml` and
  reports what it left out. A setup command that rewrites someone's git config
  or agent settings as a side effect is the same defect this tool exists to
  catch, and it gets the tool uninstalled as fast as a false positive does.
- **The commit hook is tracked, not written into `.git/hooks`.** Git does not
  track that directory, so a hook there reaches whoever ran `init` and nobody
  else. `init --git-hook` writes `hooks/pre-commit` and wires a `prepare` script
  that points `core.hooksPath` at it, so a clone is gated by `npm install`
  alone. `install-hooks` must no-op quietly — under `CI`, outside a git repo,
  with no `hooks/` directory — because it runs during every install, and a
  setup step that fails an install gets deleted.
- **The llm tier is opt-in (`--llm`) and never runs in a git hook.** It costs
  money and needs the network. The mechanical tier is what gates a commit.
- **The judge reads comments as evidence.** It is given whole files, so prose
  is part of its input. A comment explaining that a check lives one layer down
  can flip a verdict from violated to ok on its own, without the code changing.
  That is usually right and occasionally dangerous: a confident but false
  comment can talk the judge out of a real finding, which makes explanatory
  prose an injection surface. Never treat a verdict as independent confirmation
  of a claim the file itself makes. Mutation grounding is the answer where it
  matters, because an experiment cannot be talked round.
- **Fixture prose must not name the verdict it expects.** A header reading
  "VIOLATES be.authz.ownership-check" is evidence handed to the thing under
  test, because the judge reads whole files. Describe the scenario and let the
  judge work out the answer, or the corpus scores its own hints.
- **An llm rule must be able to answer `not-applicable`.** Routing hands a rule
  every file its globs match, and most are irrelevant to it. Forcing a binary
  answer manufactures false positives. Any new llm rule needs fixture cases
  asserting it stays quiet about files it has nothing to say about.
- **Every rule keeps a working `qa-ignore` escape hatch, in both tiers.**
  Without a sanctioned way to switch off one rule with a recorded reason, the
  first false positive gets the whole check disabled instead. The two tiers
  read it differently, on purpose: a pattern finding points at a line, so the
  comment must sit on that line or the one above, where it is visible next to
  what it excuses. A judgment finding is about the whole file and the line it
  cites is advisory, so the comment counts anywhere in the file. Requiring an
  exact line there would make the hatch work only by luck.
  Both tiers share `src/rules/ignore.ts` so they cannot drift on what an
  exception looks like.
- **A new mechanical rule needs a clean control file, not just a violating
  one.** `fixtures/rules` exists to prove a rule stays silent on correct code
  that contains the same construct. A rule with no clean control has not been
  shown to be safe.
- **A clean control must be clean against every rule, not only the one it
  demonstrates.** The first data-pack control sat outside `repositories/`, so
  importing the database client correctly tripped the layering rule and read as
  a false positive. Place controls where they satisfy the whole corpus.
- **A file-level companion pattern matches prose as readily as code.** A clean
  control that names the word `requireFilePattern` looks for, even in a comment
  explaining itself, will trip the rule it documents.
- **Validate every regex a rule carries at load time**, not just the main
  pattern. A companion pattern that only compiles when it first meets a
  matching file is a rule everyone believes is protecting them until it throws.
  JavaScript has no inline `(?i)` group; case-insensitivity comes from `flags`.
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
