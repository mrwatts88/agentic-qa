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
npm run smoke                 # real headless Claude sessions against the hooks, ~$0.13
npm run eval:rules            # score scanner and pattern rules on fixtures/rules; free, in CI
npm run eval:rules-llm        # score judgment rules on fixtures/rules-llm; costs money
npm run eval:contracts        # score the contract judge on fixtures/sample; costs money
node dist/cli.js contracts    # judge tests against their descriptions
node dist/cli.js mutate       # break the code and check the tests notice
node dist/cli.js rules        # run the rules tiers; --llm adds judgment
node dist/cli.js setup        # download the pinned scanners and rules now
```

Run the eval script for whatever changed: a rule or scanner config, a judge
prompt or schema, or the model. The paid two judge only what is stale in the
committed fixture ledger, then score, so an unchanged corpus costs nothing;
commit the ledger they rewrite. Scores from a ledger nobody refreshed mean
nothing: both fixture ledgers once predated the judge version field and still
read 5/5 and 19/19.

Fixture corpora:

```
fixtures/sample     # contract judging; its tests import a module that does not exist
fixtures/runnable   # a real green suite, for mutate
fixtures/rules      # scanner and pattern rules, each with clean controls
fixtures/rules-llm  # judgment rules, including files they must call not-applicable
fixtures/smoke      # inputs for npm run smoke
```

`fixtures/probes` is not a corpus: kept experiments, not scored.

`fixtures/sample` deliberately imports a module that does not exist, so its
tests can never run. `fixtures/runnable` is a real green suite, which mutation
grounding needs.

## Layers

- `src/cli.ts` — argument parsing and exit codes. Exit 1 means a gate failed.
- `src/sites.ts` — what runs where: the default policy per call site, a repo's
  `callSites` overrides, and the README table rendered from them.
- `src/gate.ts` — the `commit` and `ci` call sites, which gate by exit code.
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
- `src/rules/select.ts` — which files are worth checking: globbed from the rules'
  own triggers, minus the ignore list, intersected with any scope a caller
  supplies. Intersection, never substitution.
- `src/rules/mechanical.ts` — the mechanical conductor: runs patterns and every
  adapter, maps tool findings to corpus rules or the gauntlet, applies qa-ignore,
  and refuses to run when a claimed tool rule is switched off.
- `src/rules/adapters/*.ts` — one per engine. Runs the tool and returns what it
  said in the tool's own rule ids; knows nothing about the corpus.
- `src/tools/provision.ts` — downloads the scanners npm cannot install and the
  community rules into `~/.cache/agentic-qa/`, pinned and checksummed.
- `config/` — the engine configs the tool ships and runs with (eslint,
  dependency-cruiser, and gitleaks' upstream ruleset vendored at a pinned
  version: re-vendor it, never hand-edit it). Trimming a preset or narrowing a scope here can break a
  corpus claim; the coverage test says which.
- `src/rules/llm.ts` — runs the judgment tier, with its own cached ledger.
- `src/rules/ignore.ts` — the qa-ignore escape hatch, shared by both tiers.
- `src/rules/evaluate.ts` — scores both rule tiers against a known-answer file.
- `src/pool.ts` — shared bounded concurrency. Not for mutations, which must
  stay serial.
- `src/hook.ts` — what the Claude Code hooks share: payload reading, changed
  files, exception wording. The per-edit hook that lived here is removed.
- `src/stop.ts` — the Stop hook. Checks everything the turn changed and blocks
  the agent from finishing while findings stand, at most once per turn.
- `src/init.ts` — installs the call sites into a repo. Never overwrites.
- `test/` — unit tests for the deterministic parts. Anything that talks to a
  model is covered by the fixture corpora instead.

## Invariants

**Decided, partly built:** the per-edit hook is removed; the automatic call
sites will enforce only the corpus, and the gauntlet will run on demand. The
invariants about gauntlet warnings and Stop's notes change when that lands;
ROADMAP Next item 1 lists them. Until then they describe the code as it is.

- **The enforcement ladder.** Every rule declares the cheapest tier that can
  enforce it: `mechanical` (lint, tsc, dependency-cruiser, semgrep) before
  `llm` before `human`. Paying a model to do a linter's job is strictly worse.
  A rule that cannot name its enforcement is not a rule yet.
- **`mechanical` means delegated to a real engine.** eslint with
  eslint-plugin-sonarjs, semgrep OSS, dependency-cruiser, gitleaks, tflint. A
  hand-written pattern is what you write only when no engine covers the rule,
  never the default: 22 regexes do not compete with ~2,800 community rules, and
  whole-file regex is strictly weaker than AST matching with type information.
- **The corpus asserts coverage; the tools find the problems.** The corpus is not
  a filter on tool output — filtering to it would discard thousands of rules to
  keep ours. Run the tools broad. A corpus rule names a tool and rule id, and a
  test asserts that rule is still live in the tool's config, so dropping a plugin
  fails a test naming the promises it broke. Findings from corpus rules are
  errors and block; findings from the gauntlet are warnings and never block.
- **One CLI, three call sites.** The turn-boundary hook, the git hook, and CI
  all invoke this same binary. Never fork the logic per call site,
  or the rules the agent is told about drift from the rules the gate enforces.
- **What a call site runs is its row in `src/sites.ts`, never code of its own.**
  Defaults choose scanners by property (`slow`), never by name, so a slow engine
  added later stays out of the quick call sites unasked. A generated file names
  the call site (`agentic-qa commit`) rather than the checks, so a repo set up
  long ago still gets today's policy. A test holds the README's table to the
  defaults; change them together.
- **No model calls in pre-commit.** Git hooks run the mechanical tier only: a
  commit must not cost money or wait on a model. Commits no longer have to work
  offline — a current ruleset is worth more than that — but a rule that needs the
  network fails **open**, skipped with a warning, never blocking the commit.
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
- **There is no per-edit hook, on purpose.** Nearly everything it said was
  gauntlet noise, and the agent learned to skip hook output altogether, which
  makes the corpus worthless too. Stop sees every change however it was made.
  The cost, accepted: a subagent learns about the corpus only when the main
  agent's Stop catches its edits. `agentic-qa hook` still exits zero silently,
  so a repo whose settings predate the removal does not error on every edit.
- **Stop checks what the turn changed, not the whole repo.** Complaining about
  pre-existing violations in code the agent never touched is noise, and noise
  gets the hook uninstalled.
- **The Stop hook blocks at most once per turn.** `stop_hook_active` is true
  when a Stop hook has already held this turn; blocking again from there is how
  a session becomes unable to finish, which is far worse than a noisy report.
  The second pass repeats the findings and lets go, so the worst case is one
  wasted round trip.
- **Stop blocks through a top-level `decision`, never through the exit code,
  and always exits zero.** A non-zero exit would hold the turn without saying
  why, and a crash would hold it forever. `decision` nested in
  `hookSpecificOutput` is silently ignored — the hook shipped that way and never
  blocked. `hookSpecificOutput.additionalContext` keeps the agent going too, so
  it is never used for anything that must let the turn end: the second pass,
  notes and a failure to run all go to the person as `systemMessage`.
- **A hook contract is verified by running a real session.** Reading the docs
  produced the nested-`decision` bug, and tests that assert the emitted JSON
  only prove it was emitted. Run `npm run smoke` before committing any change
  to what `src/stop.ts` or the settings `init` writes emit, and
  add a scenario to `smoke/hooks.smoke.ts` for any new behaviour. Their inputs
  live in `fixtures/smoke/`, because they break rules on purpose.
- **Stop runs the ladder at runtime: mechanical first, and no judgment pass at
  all when a pattern already found an error.** Paying a model to judge code
  that fails a linter-tier rule is the same waste the enforcement ladder exists
  to prevent, one layer down.
- **Stop runs the paid tiers only when it can tell what changed.** Outside a git
  repo there is no working-tree scope, and judging the whole repo on every turn
  is a surprise on someone's bill. Mechanical still runs; judgment does not.
- **Nothing that writes a ledger may run from a hook that can fire
  concurrently.** Tool hooks such as PostToolUse fire inside subagents too, and
  parallel subagents have no documented ordering, so two copies can run at once.
  The judgment tiers write `.qa/rules.json` and `.qa/contracts.json`, and a lost
  write there is a verdict silently discarded from a committed file, so they
  belong only in `Stop` — which fires once, for the main agent, at the end of a
  turn. Relevant again the moment anyone adds a tool hook back.
- **Hooks anchor to `CLAUDE_PROJECT_DIR`, not the process cwd.** Claude Code
  runs hooks in the session's current directory, which moves whenever the agent
  `cd`s. This repo's own Stop hook once failed with "cannot find module
  fixtures/rules/dist/cli.js" because a shell was left in a fixture directory.
  Config, globs and git's root-relative paths all assume the repo root.
- **A finding never quotes a secret.** Every call site prints the excerpt — a
  terminal, a CI log, the agent's context — so an adapter marks secret findings
  `redact`, a pattern rule declares `redact: true`, and the conductor withholds
  the line.
- **An engine rule with the right name is not the same coverage.** Before
  delegating a pattern, read what the engine rule matches. The vitest rule named
  "no conditional in test" sees only a top-level `if`, and Sonar's cookie and
  CORS rules see Express but not Hono. A pattern that covers the target stack
  better stays a pattern.
- **Stdin parsing stays at the CLI boundary.** `runHook` and `runStop` are pure
  functions of cwd and options so their tests never wait on a pipe that may not
  close.
- **Narrow by intersection, never by substitution.** Any scope a caller supplies
  (staged paths, the edited file) goes through `selectFiles`, which intersects
  it with the globbed set so the ignore list and the rules' own triggers still
  apply. Handing a path straight to the checker is how staging a build artifact
  or a deliberately-broken fixture ends up failing your own pre-commit hook.
  Note that a unit test of `selectFiles` does not prove a call site uses it.
- **`init` never overwrites an existing file unless `--force` says so.** An
  existing pre-commit hook or settings file belongs to whoever wrote it, so the
  default reports it and leaves it alone — but silently, that leaves a repo set
  up by an older version missing call sites added since, while looking perfectly
  installed. So a skip names `--force`, and the summary says how many files were
  left alone.
- **`--force` replaces the wiring this tool generates, and nothing else.**
  `qa.config.yaml` is never replaced: it is seeded once and then belongs to the
  repo, with its own globs, ignore list and budget. Neither is a `prepare`
  script someone else wrote. Overwriting either to pick up a new hook is a trade
  nobody asked for.
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
- **Slow engines stay out of the commit hook by default.** An adapter marked
  `slow` (opengrep) runs at Stop and in CI, where its corpus rules still block.
  Every commit pays for whatever the commit hook runs, a person's as much as an
  agent's.
- **Never commit the semgrep community rules.** Their license forbids
  redistribution and this repository is public. They are downloaded into the
  per-machine cache, pinned by commit, like the scanner binaries, which are
  pinned by version and SHA-256 in `src/tools/provision.ts`.
- **Unit tests never download.** `vitest.config.ts` sets
  `AGENTIC_QA_NO_DOWNLOAD`; a test needing a real scanner uses the cache or an
  installed copy and skips otherwise, but never in CI, which runs `setup` first.
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
- **Only a person makes an exception.** Stop honours a
  `qa-ignore` only when its comment line is unchanged since `HEAD` (staged is
  not committed), and Stop shows every refused one to the person. A blocked
  agent was observed proposing one with a false reason; nothing can check a
  reason, only who committed it. `rules` — commit and CI — honours every
  exception it sees. Outside git every exception counts, since nothing can be
  committed there. The policy is `src/rules/exceptions.ts`; never let a call
  site's text invite the agent to write its own. The README recommends a
  Claude Code `ask` rule for `git commit`, but `init` does not write it: a
  person's permissions are theirs to set.
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

## Working on this repo itself

- **Working here is dogfooding: report what the hooks do to you.** A note that
  is wrong for this code, or that repeats without anyone acting on it, is a
  finding about the tool, not background. Say so to the owner when it happens,
  with the rule id and why it is or is not legitimate. Silently skimming past
  noise is exactly the failure this system exists to prevent in its users.
- **Never add a `qa-ignore` to get past a finding.** Not to release a Stop
  block, not to quiet a scanner, and not with a reason that sounds
  right. If a finding looks wrong, say so to the person and let them decide; an
  exception is theirs to make, and it counts once they commit it. The same goes
  for `--no-verify`, loosening a rule, or narrowing a scope to make a finding go
  away.

- **Report open problems first.** When work is done, the first thing the owner
  reads is what is still wrong, unfixed, unverified or assumed, with anything
  that needs their decision. How it works comes after, briefly. A problem found
  along the way is either fixed or named there, never left in the middle of a
  summary.
- **Restate a change of direction before acting on it.** When the owner reshapes
  what the tool is for, say back what they asked for, flag anything risky in it,
  and get agreement before editing.
- **Evaluate before building.** Before a large piece of work, update ROADMAP
  in priority order and agree *what* to work on next. *How* to build it is
  Claude's call: design it, make the decisions, and report them. Do not ask the
  owner to choose between implementation options. The
  system has to be trustworthy and usable before the rules corpus grows, so
  rule-writing comes last.
- **Keep the README understandable.** It is for someone setting this up, not a
  design record: plain tables for what runs where and what it costs. Reasoning
  belongs in ROADMAP.
- **Knowledge lives in repo files, not in agent memory.** Anything a future
  session needs goes in this file, ROADMAP or a committed fixture, where it is
  read every time. Throwaway experiments that a roadmap item starts from go in
  `fixtures/probes/`, never only a session scratchpad.

- **This repo's own `Stop` runs the free tier only, on purpose.** Consuming
  repos get the judgment tiers at the turn boundary by default. Here they are
  off because a model call on every turn of every session in this repo is real
  money for no benefit while working on the tool itself. It is set under
  `callSites.stop` in this repo's `qa.config.yaml`, not with a flag in
  `.claude/settings.json`, which matches what `init` writes. Do not turn it on,
  and do not change the default in `src/sites.ts` to match it.
- **`orders-admin` installs this as a git dependency, so it lags.** A new CLI
  command does not exist there until this repo is pushed and the dependency is
  reinstalled. The order is: commit and push here, then
  `npm install github:mrwatts88/agentic-qa` there, then commit its lockfile.
  Skipping it has twice produced a repo whose hooks call a command its installed
  copy does not have — once for `install-hooks`, once for `stop`. Both times the
  hook wiring looked perfect and simply did not work.

## Judge cost

`--safe-mode` is load-bearing: it strips CLAUDE.md, skills, plugins, hooks and
MCP servers while leaving OAuth intact, so no `ANTHROPIC_API_KEY` is needed.
Measured on one identical judgment with sonnet: $0.083 baseline, $0.020 with
`--strict-mcp-config`, $0.012 with `--safe-mode`, $0.008 on haiku. Do not use
`--bare`: it is cheaper still but forces API-key auth.
