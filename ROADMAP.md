# Roadmap and design record

The durable home for the plan. [README.md](README.md) says what the tool does
today; this says where it is going and why, including the reasoning behind
decisions already made so they do not get relitigated.

---

## Goal

A system that helps an AI build production-quality full-stack software: a
written body of rules, and automatic checks that the changed code follows them.
Target stack: React/Vite/TypeScript/TanStack Query, Hono/TypeScript, Postgres,
AWS/Terraform, auth provider undecided (possibly Cognito).

It has to work across repos, not be rebuilt per project.

---

## Decisions already made

These are settled. Revisit only with a reason.

### The enforcement ladder

Every rule declares the cheapest tier that can actually enforce it:
`mechanical` → `llm` → `human`. A rule that cannot name its enforcement is not a
rule yet, it is a wish.

Most of a rules corpus is mechanical. Paying a model to check something a linter
can check is slower, non-deterministic, and less complete. The `llm` tier is the
fallback of last resort, not the default.

### Rule routing, not one big checklist

Handing a model 200 rules gets a shallow pass on a dozen of them. Changed file
paths select which rules apply: a change under `components/` pulls the frontend
rules, not the migration rules. Routing is what makes the check both affordable
and actually attentive.

`excludePaths` is what makes a layering rule expressible at all: importing the
database client is a violation in a handler and correct in a repository.

### A rule that matches dangerous strings must exempt test files

Tests write the exact constructs these rules look for, on purpose, to prove
production code must not. The first version of the corpus exempted test files
from some rules and not others, and spelled the exemption `**/*.test.ts`, which
silently missed `.test.tsx` and `.spec.ts`. Every exclusion now uses
`**/*.{test,spec}.{ts,tsx,js,jsx}`.

The hook found this by firing on the tool's own test suite within minutes of
being installed, which is a fair argument for installing it early.

### Every rule needs a clean control, not just a violating one

A new mechanical rule is not proven by catching its violation. It is proven by
staying silent on correct code containing the same construct. `fixtures/rules`
pairs each violation with a clean file for exactly this reason.

### Rules ship with the tool, not with the repo

A repo that keeps its own copy of the corpus is a repo whose rules drift, which
is the problem this exists to solve. Project-local packs are additive, for
genuinely local conventions.

### Three call sites, one CLI

Agent hooks, git hooks, and CI all invoke the same binary. Never fork the logic
per call site, or the rules the agent is told about drift from the rules the
gate enforces.

- **Agent harness hooks** (`PostToolUse`, `Stop`) — the fast loop. Feedback
  reaches the agent while it still holds the context that produced the code.
  This is where most of the leverage is: catching it at commit is far weaker,
  because the agent has moved on.
- **Git hooks** (lefthook) — the floor. Mechanical tier only. No model calls in
  pre-commit: latency, cost, and it must work offline.
- **CI** — the authority. Everything, including the llm tier over the PR diff.
  The only layer that cannot be bypassed with `--no-verify`.
- **Scheduled whole-repo audit** — a fourth cadence. Per-diff checks
  structurally cannot see "this is the fourth way we validate things".

### Verdicts are cached and committed

`.qa/contracts.json` is committed. Re-judge only when the claim changed, the
body changed, or the judge changed (`JUDGE_VERSION` or model). Hashes ignore
whitespace so reformatting is free. **Verified: a run where nothing changed does
no work and costs nothing.** Mutation results cache the same way, keyed on
`MUTATION_VERSION`.

Test ids are keyed on the title, so editing a description produces a new id and
forces a re-judge. That is intended behavior, not a cache miss.

### False positives outrank false negatives

A checker that condemns good code gets switched off within a fortnight, and
after that a clean run means nothing. Both halves are scored against corpora
with known-correct answers, and the two error directions are reported
separately. A false positive is a release blocker.

Every rule also keeps a working `qa-ignore` escape hatch. Without a sanctioned
way to switch off one rule with a recorded reason, the first false positive gets
the whole check disabled instead.

### An llm rule must be allowed to say "not applicable"

Routing sends a rule every file matching its globs, and most of them have
nothing to do with it. A model forced to answer only ok or violated about
irrelevant code will eventually answer violated. The third verdict is what keeps
the tier quiet enough to be worth reading, and the fixture corpus asserts it
explicitly rather than leaving it to chance.

### A test body means nothing without its helpers

Judging a test body alone produces false positives on any real suite. The judge
sees `needsJudging(t, ledgerFor(t), "sonnet")` and cannot tell what `ledgerFor`
established, so it reports a good test as weak. Module-scope helpers and setup
hooks are therefore sent with every test, and they feed the body hash, so
editing a shared builder re-judges the tests that depend on it.

Fixtures could never have caught this: their bodies were written self-contained.
It took running against real code, where **ten of thirteen findings turned out
to be this one defect**. The lesson generalises: a corpus written to have known
answers proves the machinery works and says nothing about behaviour on code that
was not built to be a test case.

The remaining limit is that context stops at the file boundary. A test whose
discriminating power depends on an imported value the judge cannot see may still
be reported as weak. That is usually a fair complaint about the test.

### Comments are evidence to the judge, for better and worse

Discovered by getting it wrong. A handler that delegates authorization to an
account-scoped service was reported as missing an ownership check, because the
judge reads one file and cannot follow the call. A `qa-ignore` comment was added
expecting the escape hatch to withhold the finding. The finding did clear, but
not for that reason: the judge read the comment, accepted the explanation, and
returned `ok`. Its recorded reason cites the comment directly.

Two consequences. The escape hatch was never exercised on that case, so it went
unverified in integration for a while, and testing it with a justified comment
has a structural confound: any comment changes the file the judge reads, so a
cleared finding cannot be attributed to suppression rather than persuasion.

That is now settled by a paired control in `fixtures/rules-llm`. Two files carry
the same violation; one has an exception naming only the rule and making no
argument. The judge records both as violated, and only the unexcused one is
reported. Suppression and persuasion are distinguishable because the verdict
moved in one case and not the other.

And prose is an injection surface. A false comment can talk the judge out of a
real finding as easily as a true one can correct it. This is the sharpest
argument for mutation grounding: an experiment cannot be persuaded.

### The corpus was scoring its own hints, and the scores were inflated

Every judgment score reported before the fixtures were de-labelled was too high.
The headers said things like "VIOLATES be.errors.no-silent-fallback", the judge
reads whole files, and a header naming one rule steers it away from the others.
Stripping the labels dropped a corpus that had scored 19/19 to 18/19, and the
file that changed was the one whose old header had announced which rule it was
supposed to be about.

This is worth remembering as a general hazard rather than a one-off: a fixture
corpus that describes itself is grading the judge on an exam it has already
annotated. Ground truth belongs in `expected.json`, which the judge never reads.
Pairs now carry identical neutral headers so the prose cannot discriminate even
by accident.

### One finding per rule per file, which is not the same as one problem

`be.authz.ownership-check` once reported an unscoped read in a service and said
nothing about an unscoped delete in the same file. The obvious reading was that
its prompt, which speaks of loading a record by an identifier, was blind to
mutations. That turned out to be wrong: given a file whose only problem is an
unscoped delete by id, the rule reports it, and names the exact call.

The likelier explanation is reporting granularity. Findings are deduplicated to
one per rule per file, so a file with two instances of the same problem shows
the more prominent one. Worth knowing when reading a clean-looking report after
fixing what it pointed at: fixing the named instance does not mean the rule has
nothing further to say about that file. Re-run rather than assume.

### A judgment is not evidence until an experiment says so

`agentic-qa mutate` breaks the implementation on purpose and checks the test
notices. The model proposes the break, the test run decides. When the experiment
disagrees with the verdict, the verdict is reported as refuted rather than
quietly kept.

### The judge runs through headless `claude -p`

Uses existing Claude Code OAuth, so no separate API key locally. `--safe-mode`
is load-bearing: it strips CLAUDE.md, skills, plugins, hooks and MCP servers,
taking a judgment from $0.083 to $0.012 (haiku $0.008). Do **not** use `--bare`,
which is cheaper still but forces API-key auth.

`--json-schema` gives structured output natively, so no parsing JSON out of
prose. All model calls go through one helper in `src/judge.ts` so the cost flags
cannot drift apart.

### Never trust a test runner's exit code to mean "the test failed"

**vitest exits 0 when `-t` matches nothing.** A typo in a test selector would
otherwise look identical to "the test passed despite the mutation", which would
condemn a perfectly good test. Mutation grounding therefore reads the
per-assertion `status` out of the JSON reporter and matches it structurally on
`ancestorTitles` plus `title`. The reporter writes to
`<root>/.vitest/json/output.json`, not stdout, and `fullName` joins the describe
path with a space.

### Patterns match whole files, not single lines

Some rules legitimately span a line break, such as an assertion followed by the
closing brace of its test. Line numbers are recovered from the match offset. A
related trap: `\s` matches newlines, so a pattern anchored with `^\s{4,}` starts
matching on the blank line above and reports the wrong line. Use `[ \t]`.

### No external scanner binaries are assumed

semgrep, gitleaks, tflint, checkov and eslint are not installed here, so the
mechanical tier is self-contained in the CLI. Delegating to those tools when
they happen to be present is a later enhancement, never a requirement.

### The calibration target lives in a separate repo

`~/code/orders-admin` is a small CRUD application on the target stack, built
normally and deliberately without consulting the rule list, and it installs this
tool as a git dependency. It exists because fixtures prove the machinery works
and say nothing about behaviour on code that was not written to be a test case.

It earned its keep immediately. Pointed at its first vertical slice, the
judgment tier found a real IDOR that had been written without anyone planting
it: a service loaded a customer by id with no account check, and the delete path
had the same hole. The contract checker rejected two of its endpoint tests, both
correctly. The layering rule produced a false positive on a connection-pool
module, which is how that rule gained its exemption.

It also caught what fixtures structurally could not. When the authz prompt was
tightened, only real code could show that services and repositories now come
back `not-applicable` while an actual route handler is still judged.

Work on the two together: a rule change is not finished until it has been run
against both the fixtures and the app.

### Start small, then bulk-load the rules

Enumerating all rules first produces hundreds of unenforceable ones and leaves
the hard part (routing, caching, noise control, adoption) untouched. Build the
machine end to end with a small rule set, prove the loop, then bulk-load from
the prose corpus in `~/code/full-stack-swe` (about 34,000 words across twelve
topics).

---

## Status

**Done and verified.**

- The test-contract checker end to end: extraction (including `@describes`
  docblocks and nested describe blocks), hash-based invalidation, the judge, the
  committed ledger, and the CLI. Scores 5/5 on `fixtures/sample` with no false
  positives or negatives. Roughly two cents per judgment on real test files, and
  nothing at all for tests that have not changed.
- Judge scoring (`agentic-qa eval`), reporting the two error directions
  separately.
- Mutation grounding (`agentic-qa mutate`), verified on `fixtures/runnable`,
  where two tests that both pass are correctly separated into one real and one
  worthless by breaking the implementation.
- The rules engine (`agentic-qa rules`): schema, strict loader, path routing
  with excludes, the pattern tier, `qa-ignore`, and scoring against
  `fixtures/rules`. 14/14 known violations found, 0 false positives across
  seven clean control files.
- A corpus of 22 rules across frontend, backend, data, testing and security,
  each with a violating fixture and a clean control.
- The llm tier (`agentic-qa rules --llm`): the rule judge, per-file and
  per-prompt caching, and scoring against `fixtures/rules-llm`. 19/19 with
  nothing in either error direction, including telling apart violating and
  clean files that differ only by an ownership check, by rethrowing instead of
  returning an empty list, or by whether the query inside a loop is a query at
  all. That figure counts only because the fixtures no longer name their own
  verdicts: the same corpus scored 19/19 while it was labelled, and 18/19 once
  the labels came off.
- Unit tests for this tool's own deterministic parts, in `test/`.
- Published at `github.com/mrwatts88/agentic-qa`, installable as a git
  dependency, verified by installing it into a clean directory and running the
  binary there. CI runs on every push.
- A calibration target: see below.
- The call sites themselves (`agentic-qa init`): a git pre-commit hook running
  the free tier on staged files, and a Claude Code `PostToolUse` hook that
  reports violations in changed files back to the model after every edit. It
  never overwrites an existing file.

---

## Next

### 1. Adoption on an existing repo: the baseline ratchet

Turning a full corpus on an existing codebase produces thousands of violations
and gets switched off the same afternoon. Snapshot the existing violations, fail
only on new ones, and require the count to trend down. Every successful linter
adoption works this way. It has to be designed in, not bolted on.

### 2. Packaging

Mostly done. The package builds on install via `prepare`, ships `dist/` and the
rules corpus, and has been verified by packing it, installing the tarball into a
clean directory, and running the installed binary there: it loads all 22 rules
from inside the package and reports correctly. A consuming repo therefore holds
only its own `qa.config.yaml` and `.qa/` ledgers.

A CI workflow template now exists in `.github/workflows/qa.yml`. Note the
judgment tiers need `ANTHROPIC_API_KEY` there, because `claude -p` rides on
Claude Code's OAuth locally and CI has none.

What is left:

- **Publishing.** A deliberate decision, not a technical gap. The package is
  marked `private` so it cannot go out by accident. Until then, install it as a
  git or tarball dependency.
- **A Claude Code plugin** for the agent-facing half: the hook, a review
  subagent, slash commands, installable across repos from a marketplace.
- **Versioning the rules corpus separately** from the tool, so rules can be
  updated without shipping a new binary, and a repo can pin them.

### 3. Bulk-load the rules corpus

Once the ratchet exists, convert the rest of
`~/code/full-stack-swe` into structured rules. Each one needs a violating
fixture and a clean control. Expect a meaningful fraction of the prose to be
background knowledge rather than checkable rules; that part does not belong in
the corpus.

### 4. Mutation grounding, second pass

Working, but narrow. Assumes vitest and finds the implementation by following
the test file's relative imports. Worth extending to other runners and to tests
whose subject is reached less directly. Also worth occasionally running the
whole suite rather than one test, to catch a mutation that breaks something
other than its target.

---

## Open questions

- **Auth provider.** Cognito is the current guess. Affects the auth rule pack.
- **Whether descriptions should be required on every test,** or only on tests
  above some complexity. Requiring them everywhere risks ceremony on trivial
  tests.
- **Escaped-defect log.** When a real bug ships, ask which rule should have
  caught it. That is the feedback loop that makes the corpus earn its keep
  instead of just accreting. Worth building once there is a real repo.
- **How `qa-ignore` gets audited.** The escape hatch is necessary, but a repo
  where it spreads unchecked has quietly turned the rules off. Counting them and
  watching the trend is probably enough.
