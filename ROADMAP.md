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

The ladder named its engines from the first draft — "lint, tsc,
dependency-cruiser, semgrep" — and then the mechanical tier was implemented as
hand-written regexes anyway, because none of those were installed. That gap is
now closed: `mechanical` means delegated to a real engine, and a hand-written
pattern is what you write only when no engine covers the rule. See "Reversed: the
mechanical tier delegates to existing scanners".

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

### Four call sites, one CLI

Agent hooks, git hooks, and CI all invoke the same binary. Never fork the logic
per call site, or the rules the agent is told about drift from the rules the
gate enforces.

- **Agent harness hooks** (`PostToolUse`, `Stop`) — the fast loop. Feedback
  reaches the agent while it still holds the context that produced the code.
  This is where most of the leverage is: catching it at commit is far weaker,
  because the agent has moved on.
- **Git hooks** (lefthook) — the floor. Mechanical tier only. No model calls in
  pre-commit: latency and cost. The offline half of that rule was dropped once
  the mechanical tier started delegating to scanners that fetch rulesets, since
  a current ruleset is worth more than a commit on a plane. Network-dependent
  rules fail **open**: skipped with a warning, never blocking the commit.
- **CI** — the authority. Everything, including the llm tier over the PR diff.
  The only layer that cannot be bypassed with `--no-verify`.
- **Scheduled whole-repo audit** — a fourth cadence. Per-diff checks
  structurally cannot see "this is the fourth way we validate things".

### CI is documented, not generated

`init` does not write a CI workflow. It is provider-specific, it is committed,
and it spends money on every push, so generating one as a side effect of a setup
command is the sort of helpfulness this project exists to catch. It also cannot
finish the job: the judgment tiers need an API key as a repository secret, which
`init` cannot provision, so a manual step is unavoidable whatever we do.

The README documents the commands instead, because developers already know how
to run a command in their own CI, and `.github/workflows/qa.yml` here is a
working example. An opt-in `init --ci github` that writes the workflow and
prints which secret to add is a reasonable convenience later, not the default.

What belongs there: the mechanical tier again as cheap insurance against
`--no-verify`, plus `rules --llm` and `contracts`, the two that cannot gate a
commit because they cost money and need the network.

### `init` installs nothing you did not ask for

Each call site is a flag: `--git-hook`, `--claude-hook`. Bare `init` writes
`qa.config.yaml` and stops, then reports what it did not install so the rest is
still discoverable.

The tool's own thesis is that unrequested helpfulness is a defect, and a setup
command that rewrites your git configuration and your agent settings because you
typed six words is exactly that. It is also the practical choice: a tool that
surprises someone on first contact gets uninstalled before it can demonstrate
anything, which is the same failure mode as a false positive. Opting in costs
one flag, and the README documents the full line.

This sits alongside "never overwrite an existing file"; they are the same
principle applied to what `init` writes and to what is already there.

### The turn boundary is a call site of its own, and it blocks

CI was the only place any judgment ran, which is too late to steer anything: it
reports after the agent that wrote the code has stopped. The `Stop` hook fires
when the agent finishes a turn, and it is a far better fit than either of the
places judgment currently lives.

Per edit and per turn are different jobs, and the split follows from what each
can see:

- **PostToolUse** fires after *every* Edit or Write. It sees one file mid-draft,
  and its matcher means anything changed another way — `git mv`, a `sed` in
  Bash, a generator, a lockfile rewritten by an install — never reaches it at
  all. Mechanical only, advisory, and it cannot gate: it fires after the tool
  ran, so a non-zero exit stops the turn without undoing anything. It earns its
  place by interrupting compounding, not by coverage: agents copy their own
  patterns, so a violation caught at the first edit does not reach the next six
  files. It is the expendable tier.
- **Stop** fires once at the turn boundary. It sees the whole accumulated
  change via the working tree, which closes the matcher hole, and it judges
  final state rather than a draft — a violation introduced and then fixed mid-
  turn is never reported, which is correct. It can block, and it is the only
  agent-facing place that can.

Both tiers block there, mechanical and judgment alike. The counter-argument was
that a judge verdict is non-deterministic and persuadable, so blocking on one
risks trapping a session; `stop_hook_active` answers it. The hook blocks once,
and on the second firing reports without blocking, so the worst case is one
wasted round trip rather than a session that cannot end. Advisory-only was
rejected because an agent free to ignore a finding reproduces the CI problem
this call site exists to fix.

Run mechanical first and skip the judgment pass when it finds errors: the
enforcement ladder applied at runtime, not just when a rule is written. There is
no point paying a model to judge code that already fails a pattern.

Subagents do not get a gate of their own, and cannot. `SubagentStop` fires after
the subagent has already finished and has no decision control, so it could only
report to something that has stopped listening. `Stop` fires for the main agent
only. A subagent's edits are therefore caught at the end of the main turn, by
the same working-tree scope that catches a change made in Bash — deferred, but
not missed.

That is the argument that keeps the per-edit hook alive. PostToolUse *does* fire
inside subagents, carrying `agent_id` and `agent_type`, so it is the only
feedback a subagent can receive while it can still act on it. Removing it, which
looked reasonable once `Stop` could block, would leave every subagent working
blind to the corpus for its entire run.

It also fixes which tiers may run where. Parallel subagents have no documented
ordering, so a PostToolUse hook can run concurrently with itself. The mechanical
tier is stateless and read-only and does not care. The judgment tiers write
committed ledgers, where a lost write is a discarded verdict, so they stay in
`Stop`, which is single and serial by construction.

Two things the contract settles, both verified against the docs rather than
recalled. `Stop` supports no matchers, and its default timeout is 600s, so
**latency was never the constraint here — cost is.** The 30s figure that made
this look tight is the timeout `init` writes for the PostToolUse hook, not a
platform limit. And the payload carries `cwd` plus `stop_hook_active`; blocking
is either exit 2 or `hookSpecificOutput.decision: "block"` with a `reason`,
which is what the agent is shown.

### Hooks reach a repo the way husky's do

A hook in `.git/hooks` is untracked, so it reaches whoever ran `init` and nobody
else — a per-developer gate wearing the costume of a per-repo one. `init`
therefore writes a tracked `hooks/pre-commit` and adds a `prepare` script
pointing `core.hooksPath` at it. npm runs `prepare` on install, so the git
config change happens inside something every developer already does.

Two traps, both of which husky documents having hit:

- `npm ci --omit=dev` runs `prepare` with the tool absent, so the line ends in
  `|| true`, and `install-hooks` itself no-ops rather than failing: under `CI`,
  outside a git repository, and with no `hooks/` directory to point at.
- An existing `prepare` script belongs to whoever wrote it. `init` adds one only
  where there is none, and otherwise prints the exact line to add. That is the
  single place it touches a file that already exists, and it adds a key rather
  than changing one.

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

### Reversed: the mechanical tier delegates to existing scanners

This previously read "no external scanner binaries are assumed" — semgrep,
gitleaks, tflint, checkov and eslint were not installed, so the mechanical tier
was self-contained, and delegating was filed as a later enhancement. That was a
reasonable way to bootstrap and a bad thing to build on, and the plan that grew
out of it — hand-writing hundreds of regex rules — was the most expensive
mistake still ahead of us.

What the survey found, all free and local:

- **Semgrep OSS** (LGPL-2.1, no account, no usage limits): ~2,800 community
  rules covering the OWASP Top 10. Runs offline from a vendored rules directory.
  Single-file analysis only; cross-file is the paid tier, which does not matter
  for rules like "a handler imports the database client", visible in one file.
- **eslint-plugin-sonarjs**: SonarJS's own JS/TS rules as an ESLint plugin, with
  **no server**, and type-aware when paired with the typescript-eslint parser.
- **dependency-cruiser**: purpose-built for the layering rule we hand-wrote.
- **gitleaks** for secrets, **knip** for unused code, **tflint/checkov/trivy**
  for Terraform, **StrykerJS** for mutation testing.

22 hand-written regexes were competing with roughly 2,800 community rules plus
Sonar's actual analyzer. A regex over whole-file text is also strictly weaker
than AST matching with type information.

The competitive read matters too, and cuts the other way from what we assumed.
Sonar ships a Claude Code plugin whose PostToolUse hooks analyse after every
edit — the same call site we built — so "our edge is the hooks" is no longer
true. But it needs a SonarQube Cloud account or a self-hosted server plus a
token; there is no standalone local mode. Community Build is free but analyses a
single branch with no PR decoration or taint analysis, which makes it useless
for diff gating. The free path for us is the OSS toolchain, not their platform.

### The corpus asserts coverage; the tools find problems

The obvious way to delegate is to make each rule name a tool rule, and report
only those. That is wrong: it throws away ~2,800 community rules to keep 22.

The opposite — run the gauntlet and take whatever it says — loses the other
half: you can no longer answer "are we still enforcing the things we decided to
care about?" when a preset changes or someone drops a plugin.

So both, because they answer different questions. **The tools answer "what is
wrong with this code?"** Run them broad, on recommended presets. **The corpus
answers "what do we promise to enforce, and is that promise still kept?"** A rule
keeps its statement, rationale and tier, and its enforcement names a tool and a
rule id. A test then asserts that rule is actually live in the tool's config, so
dropping a plugin fails a test that names the promises it broke. The fixture
corpora keep working and gain that second job.

Noise is handled by severity rather than by filtering:

- A finding from a rule **in the corpus** is an error and blocks.
- A finding from the gauntlet **not in the corpus** is a warning: visible, never
  blocking.

Full coverage immediately, curated gating from day one, and a promotion path — a
tool rule that proves itself gets a corpus entry and starts blocking. That is the
baseline ratchet, arriving as a side effect.

### The 22 rules are a test set, not a spec

They were derived from the prose in `~/code/full-stack-swe` to have something
concrete to build the machine against, and they were never audited as a corpus
anybody would want. Treating them as the product is a mistake in both
directions: it overstates what is covered, and it makes retiring them feel like
a loss.

What they are genuinely good for is test data. Each has a violating fixture and
a clean control, which is precisely what verifying an adapter needs. Keep them
in that role and delete them from the corpus freely.

The durable thing they produced was the discipline — a rule must name its
enforcement, and must have a clean control — not the rules themselves.

This also corrects how engines get chosen. Deriving the required engine set from
these 22 would be deriving it from a sample of convenience. Engines are chosen
by the failure surface of the target stack — TypeScript and React, Hono,
Postgres, Terraform, secrets, dependencies — and the 22 agreeing with that list
was a sanity check, not the derivation.

### Two derivations, because only one of them can find an absence

Engines-first tells you what is already covered: enable them broadly, run them
against real code, write entries for what is left. Cheap, empirical, and it stops
you transcribing someone else's ruleset by hand.

But it has a blind spot worth more than its economy. **You cannot detect an
absence by watching output.** If no engine holds any opinion about a concept —
expand-contract migrations, every endpoint being account-scoped, where cache
invalidation is allowed to live — then running every engine produces silence
about it, and silence is indistinguishable from "covered and fine". A corpus
derived only from engine output ends up shaped by what existing tools happen to
care about, which is mostly syntax, known vulnerability patterns and code smells.
The architectural and semantic rules, which are the reason this project exists,
are exactly the ones that would never appear. The failure mode is seductive:
thousands of findings firing, looking comprehensive, while missing the things
that motivated the system.

So the prose corpus is not a nice-to-have and not a checklist for later. It is
the statement of intent; the engines are an implementation of part of it. The
audit therefore runs in the direction that can find something missing: walk the
prose, and for each concept ask what enforces it. Walking engine output and
asking what is missing cannot answer that question.

That is the enforcement ladder applied one level up. Every concept gets
classified:

1. **Covered** by an engine — record the tool and rule id; the coverage test
   holds it.
2. **Judgment tier** — objective, but not expressible as a pattern. Expect most
   of the real content here. It is also where there is no incumbent.
3. **Human** — a review question, not a check.
4. **Not a rule** — background knowledge. A real category, not a failure.

Classification is checkable work rather than opinion: engine registries are
enumerable and searchable, so "nothing covers this" is a conclusion you can
demonstrate rather than assume.

What survives from "start small" is the warning not to write rules before the
machine works. Classifying is not authoring, and the classifying pass is cheap.

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

### Start small: build the machine before enumerating anything

Enumerating all rules first produces hundreds of unenforceable ones and leaves
the hard part (routing, caching, noise control, adoption) untouched. Build the
machine end to end with a small rule set, prove the loop, then bulk-load from
the prose corpus in `~/code/full-stack-swe` (about 34,000 words across twelve
topics).

Still true, and the second half has since been overtaken twice. Most of that
prose describes rules a free tool already enforces, so converting it into
hand-written patterns would be transcription rather than leverage. And the 22
rules it produced turned out to be a test set rather than a corpus, which
removed the last reason to start from a list.

The bulk-load is therefore not the plan any more — but the prose is not demoted
either. It is the statement of intent, and it gets classified concept by concept
rather than transcribed wholesale. See "The 22 rules are a test set, not a spec"
and "Two derivations, because only one of them can find an absence". What
survives here is the first half, which was always the real point: build the
machine end to end before enumerating anything.

---

## Status

**Read this first if you are new here.** The decisions above record what has been
*settled*, which is not the same as what has been *built*. The delegation turn is
partly implemented: the adapter seam, the corpus/gauntlet split and the coverage
check exist, with three adapters: **eslint** (`sec.jwt.no-none-algorithm`,
`test.no-conditional-assertion`), **dependency-cruiser**
(`be.layer.no-db-client-outside-repository`) and **gitleaks**
(`sec.no-aws-access-key-id`). Every other mechanical rule is still a regex, some
of them on purpose (see Phase 2). semgrep is not wired in, and `mutate` is still
the hand-rolled version rather than Stryker. Everything in this section runs.

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
  each with a violating fixture and a clean control. A **test set**, derived to
  have something to build against — not an audited corpus and not a spec. See
  "The 22 rules are a test set, not a spec".
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
- The call sites themselves (`agentic-qa init`), each behind its own flag: a
  tracked `hooks/pre-commit` running the free tier on staged files, activated on
  every clone by a `prepare` script that sets `core.hooksPath`, and a Claude Code
  `PostToolUse` hook that reports violations in changed files back to the model
  after every edit. It installs neither unless asked, and never overwrites an
  existing file. Verified end to end: in a scratch repo, `init --git-hook`
  followed by `git commit` of a file storing a token in `localStorage` is
  refused by the hook.
- The first engine adapter (Phase 0, eslint half). A rule can declare
  `enforcement: { kind: external, tool, rule }`; `runMechanical` is a conductor
  over `src/rules/adapters/`, with eslint running typescript-eslint,
  eslint-plugin-sonarjs and @vitest/eslint-plugin on recommended presets from a
  config shipped in `config/`. Claimed findings take the corpus rule's id and
  severity; everything else is a gauntlet warning named `eslint:<rule>` that
  never blocks, never counts against a clean control, and never reaches Stop.
  `qa-ignore` filters both through `src/rules/ignore.ts`. A tool that cannot run
  fails open locally with the rules it left unenforced, and closed under `CI`.
  The coverage check runs at runtime on the files being checked and as a unit
  test over the fixtures, and both were shown to fail by switching the claimed
  rule off. `fixtures/rules` scores 17/17 with no false positives. Whole
  repo in about 1.4s here; `orders-admin` is clean, with no notes.
- The dependency-cruiser adapter. The layering rule moved to it because the
  pattern could not see how real code reaches a database: in a probe shaped
  like `orders-admin`, the import-name regex found two of six violations and
  missed a handler importing the repo's own `db/client` module, `require`,
  dynamic `import()` and a re-export. The cruiser found all six, on the right
  line, in about 55ms, and `fixtures/rules` gained that case: the regex scores
  17/18 on it, the cruiser 18/18. It follows imports through the repo, so
  violations are reported only on the files asked about. `isLive` checks the
  rule's `from` scope too, so a `pathNot` that drifted to exempt handlers fails
  the coverage check rather than silently unenforcing. Shipped with a
  `no-circular` gauntlet rule. A one-file PostToolUse run with both engines
  takes about 0.7s. Path aliases from a tsconfig are not resolved yet.
- The gitleaks adapter, completing Phase 0. `sec.no-aws-access-key-id` moved to
  `aws-access-token`, which catches `ASIA` temporary credentials the AKIA-only
  pattern missed and, through entropy and an allowlist, stays quiet on AWS's
  documentation example key, which the pattern flagged; `fixtures/rules` gained
  both cases and scores 19/19. The ruleset is vendored at v8.30.1 in
  `config/gitleaks.toml` and CI installs that binary version. It is the first
  adapter that can genuinely be missing: locally that is a warning naming the
  rules left unchecked, and in CI a failure, and a test runs the adapter
  against a binary that does not exist. Secret findings are redacted at the
  source (`--redact`) and never quote the line, because every call site prints
  the excerpt into a terminal, a CI log or the agent's context.
  Building it found two older gaps. **File selection skipped dotfiles**, so a
  `**/*` trigger never saw `.env`, `.npmrc` or `.github/` — the likeliest places
  for a committed secret — while routing matched them; `selectFiles` now globs
  with `dot: true` and always excludes `.git/`. And **the coverage check caught
  the corpus over-promising**: the rule triggered on `**/*`, but gitleaks never
  scans lockfiles, images or its own config, so the rule's `excludePaths` now
  state that. Test files are exempt too, per "A rule that matches dangerous
  strings must exempt test files", which the old pattern had never followed.
- The turn-boundary call site (`agentic-qa stop`): a `Stop` hook that checks
  everything the turn changed, blocks the agent from finishing while findings
  stand, and blocks at most once per turn. Mechanical first, with the judgment
  tiers skipped entirely when a pattern already found an error, and skipped
  outside a git repo where there is no way to tell what changed. It gates
  through the `decision` field and always exits zero, so a crash reports rather
  than trapping the turn.

---

## Next

### 1. Phase 0 is done; measure the per-edit cost before Phase 1

All three Phase 0 adapters are built (see Status). Before semgrep adds a fourth
engine to every PostToolUse call, time the hook on a realistic edit in
`orders-admin` and decide whether some engines belong only at Stop, commit and
CI. semgrep in particular starts slowly.

Decided while building the eslint half, and worth not relitigating:

- **The eslint config ships with the tool** (`config/eslint.config.js`), for the
  same reason the corpus does, and plugins resolve from this package's own
  dependencies. A repo's own eslint config is not read. Whether a repo may
  extend the shipped one is open, and belongs with the baseline ratchet.
- **A claimed rule in a path the corpus rule excludes is a gauntlet warning**,
  not dropped: the exclusion means the promise does not apply there, not that
  the tool is wrong.
- **Stop sees corpus findings only.** The per-edit hook shows gauntlet notes,
  capped at ten, for the file just edited.
- **Not type-aware yet.** typescript-eslint's type-checked presets need a
  tsconfig the checked repo may not have, and a program build per run.
- **Gauntlet noise is already measurable.** On this repo: 31 notes, including a
  real unused import, and `sonarjs/no-os-command-from-path` on every
  `execFileSync("git")`, which is noise here. The answer is the ratchet (item 5)
  and trimming the preset deliberately, not filtering output to the corpus.

### 2. Phase 1: semgrep OSS

Replaces the security patterns, which are nine of the 22 rules and the ones a
regex is worst at. Vendor the rulesets so they are pinned and reviewable, and
let network-dependent rules fail open.

### 3. Phase 2: retire the superseded rules and prove parity

Delete the YAML rules an engine now covers, then re-run both fixture corpora and
`orders-admin`. This is exactly what `fixtures/rules` was built for: each rule
already has a violating case and a clean control, so parity is measurable rather
than asserted.

Retire freely rather than ceremonially. These 22 are a test set, not a spec, so
a rule whose fixture an engine does not happen to catch is not necessarily worth
keeping — the question is whether anyone would have written that rule on
purpose. The fixtures stay either way, as the harness that proves an adapter
reports correctly.

Parity findings already in hand from the eslint half. The lesson in both: an
engine rule with the right name is not evidence of the same coverage. Read what
it actually matches before retiring a pattern.

- **Sonar's security rules do not know Hono.** `cookie-no-httponly`, `cors` and
  `hashing` follow data into known sinks (`express`, `cors()`,
  `cookie-session`). On an Express app they fire, as "make sure this is safe"
  hotspots; on the same code written against `hono/cors` and `hono/cookie` —
  the target stack — they fire on nothing. They also treat `sha256` on a
  password as fine, and missed `res.cookie(..., { httpOnly: false })`. Our
  patterns caught every case in both. They stay; semgrep is the next candidate.
- **`vitest/no-conditional-in-test` covers far less than its name.** It reports
  only an `if` that is a direct child of the test callback: no nested `if`, no
  `switch`, no ternary. The first attempt delegated `test.no-conditional-logic`
  to it and quietly lost all three. The rule was split by hazard instead:
  - `test.no-conditional-assertion` (error) — delegated to
    `vitest/no-conditional-expect`, which follows an assertion into an `if`,
    ternary, `switch` or `catch` at any depth. An assertion that may not run is
    a test that can pass vacuously.
  - `test.no-conditional-logic` (warn) — kept as a pattern, extended to `switch`
    and ternaries. Branching in a test is a smell even when every assertion
    runs; a ternary computing the expected value re-implements the code.
  - `test.no-assertion-in-loop` (warn) — a new pattern. A loop is fine; a loop
    *around an assertion* passes when it iterates zero times. The old regex
    flagged every loop, setup loops included.
- **Indentation is a weak proxy for "inside a test".** `test.no-conditional-logic`
  flagged a type-narrowing guard in a helper defined inside a `describe`, which
  is a common shape. It is a warning, and the helper moved to module scope, but
  this is the pattern's ceiling: an AST rule scoped to test callbacks would not
  make that mistake, and none exists that covers ternaries and nested ifs.
- **Patterns match code inside strings.** The unit-test table for those two
  patterns tripped them, so the cases live in `test/test-shape-cases.json`. The
  loop rule then correctly caught the test iterating over its own tables.

Terraform follows the same path: tflint and checkov, never hand-written regex.

### 4. Mutation grounding: adopt Stryker, then give it a trigger

Two problems, and the survey solved one of them. **StrykerJS** is mature mutation
testing for JS/TS with deterministic operators, `--incremental` backed by its own
cache and git-like mutant matching, `--mutate` scoping down to line ranges, and a
vitest runner with full support since v7. Our hand-rolled version is LLM-proposed
mutations, strictly serial, vitest-only, with the subject found by following
relative imports. For "do my tests catch bugs", Stryker wins outright.

Keep the idea — a judgment is not evidence until an experiment says so — and let
Stryker run the experiment. That also absorbs the old "second pass" item, which
wanted other runners and occasional whole-suite runs; Stryker has both.

The trigger question survives unchanged, because no tool answers it: `mutate`
still runs nowhere but by hand. It is slow and rewrites real source files, so it
cannot sit in a commit hook or fire after every agent edit, and running it on
every push would be wasteful enough that someone would delete the job. The likely
shape is a selection rather than a schedule: ground only the contracts whose
verdict changed since the last run, which the committed ledger already knows.
Needs a `--changed` selection over the ledger, and a decision about where it is
invoked from.

### 5. Adoption on an existing repo: the baseline ratchet

Half-solved by the severity split, and made more urgent by it. Pointing the
gauntlet at an existing repo produces far more findings than 22 hand-written
rules ever did, so the ratchet stops being a nicety. The corpus-blocks /
gauntlet-warns rule is the first half of it; the second half is a committed
snapshot and a count that must trend down.

Turning a full corpus on an existing codebase produces thousands of violations
and gets switched off the same afternoon. Snapshot the existing violations, fail
only on new ones, and require the count to trend down. Every successful linter
adoption works this way. It has to be designed in, not bolted on.

### 6. Packaging

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

### 7. Classify the prose, then build the corpus from what is uncovered

Rescoped twice, and the second rescope overshot. It began as "bulk-load the rules
corpus"; delegation made much of that somebody else's job; then gap-first briefly
demoted the prose to an afterthought, which would have left us structurally
unable to notice the concepts no engine has an opinion about.

The deliverable is a coverage pass over `~/code/full-stack-swe`: every concept
classified as covered by an engine (with tool and rule id), judgment tier, human,
or not a rule. Expect most of the real content to land in the judgment tier, and
expect a meaningful fraction to be background knowledge rather than a checkable
rule — that is a legitimate outcome, not a failure of the pass.

Run it after Phase 0, so "covered" can be verified rather than asserted and the
coverage test can hold every claim it makes. See "Two derivations, because only
one of them can find an absence".

The other two sources of rules stay live alongside it: house-specific convention
that no public ruleset can know, and escaped defects — when a real bug ships, ask
which rule should have caught it. That last one is the only source grounded in
something that actually went wrong.

The measured holes below still describe where the corpus is thin. The answer to
some is now "enable a ruleset"; the answer to the rest is a judgment-tier rule
that nothing off the shelf provides.

Where the holes are, measured rather than guessed. Of 22 rules: nine come from
the auth and security chapter, three each from frontend, data and testing, two
from infrastructure, one from backend architecture, one from the AI-era chapter.
Five chapters have produced nothing at all: web fundamentals, repo hygiene,
devops and delivery, observability and ops, performance and reliability.

Infrastructure is the sharpest gap relative to its weight. It is the longest
chapter in the source and it has yielded two rules, both filed under security,
with exactly one rule in the whole corpus matching a `.tf` file. An infra pack
covering state, IAM scope, tagging, and the expand-contract discipline around
managed databases is probably the most valuable single addition, given the
target stack runs on Terraform.

Once the ratchet exists, convert the rest of
`~/code/full-stack-swe` into structured rules. Each one needs a violating
fixture and a clean control. Expect a meaningful fraction of the prose to be
background knowledge rather than checkable rules; that part does not belong in
the corpus.

### 8. The judgment tier is the part with no free incumbent

Not a task so much as a reminder of where the remaining original work is, now
that the mechanical tier is delegated.

Semgrep Assistant and Sonar's AI CodeFix both point a model at **triage and
repair of findings a deterministic engine already produced**. Neither uses one as
a primary finder. The rules that need judgment are broad and intent-level, and
engines cannot reach them for structural reasons rather than for want of effort:
whether a handler checks the caller *owns* the record (no pattern knows which
field is the tenant key, or that the check lives one layer down), whether a catch
block hides a failure (a swallowed error and a deliberate fallback are
syntactically identical), whether this is the fourth way the codebase validates
something.

That is not a guess: the judgment tier found a real IDOR in `orders-admin` that
nobody planted. Test contracts are in the same position — the adjacent art is
test-smell detection, which finds missing or unexecuted assertions structurally,
and none of it judges whether assertions would fail if the described behaviour
broke.

Delegation makes this tier better, not smaller. Routing stops spending model
budget on work a linter does, which is the enforcement ladder finally working as
designed.

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
