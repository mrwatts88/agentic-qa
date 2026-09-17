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

**It is a tool to use, not a product to ship.** It exists to check its owner's
own repos, on their own machines, installed from this public repository as a git
dependency. That is what makes some licensing choices open — the semgrep
community rules may be used for your own purposes, so they are downloaded per
machine rather than bundled — and it is why publishing, a plugin marketplace and
selling are not goals. Revisit the licensing decisions if that ever changes.

---

## Decisions already made

These are settled. Revisit only with a reason.

### The hooks enforce the corpus, and the gauntlet is on demand

Reached by dogfooding. Building the call-site table in this repo, with the hooks
live, the per-edit hook fired on nearly every file written, and almost all of it
was gauntlet noise the agent silently skipped. Nothing it said was wrong enough
to act on and nothing asked it to act, so it trained the agent to stop reading
hook output at all, which is the one habit that makes the corpus worthless too.
The owner's framing: **the corpus is the product** — the mechanical and judgment
rules written from `~/code/full-stack-swe`, which are about building software
well. The gauntlet is thousands of community rules nobody has vetted for this
stack. Mixing the two in one stream to the agent dilutes the one that matters.

What each place runs, once built:

| where | corpus, mechanical | corpus, judgment + contracts | gauntlet |
| --- | --- | --- | --- |
| per edit (`PostToolUse`) | removed | — | — |
| end of turn (`Stop`) | yes, blocks | yes, blocks | no |
| commit | yes, blocks | no | no |
| CI | yes, fails | yes, fails | no |
| `agentic-qa gauntlet`, npm script | — | — | on demand, never blocks |

- **The per-edit hook goes.** Its job was fast feedback, and nearly all its
  output was gauntlet. The corpus is enforced at Stop, which sees every change
  however it was made. Accepted cost: `PostToolUse` was the only feedback a
  subagent received while still running, so subagents now learn about the corpus
  only when the main agent's Stop catches their edits. This overrules "That is
  the argument that keeps the per-edit hook alive", below, deliberately.
- **Nothing automatic shows the gauntlet.** Stop, commit and CI report corpus
  findings only. The scanners still run where a corpus rule is claimed by them,
  but unclaimed findings are dropped there. That is not the filter "The corpus
  asserts coverage" warns against, because the gauntlet still exists, whole, in
  its own command. Likely consequence worth taking: a call site need only run an
  engine that enforces a corpus rule routed to the changed files, so opengrep,
  which claims none today, would leave Stop and cut about 5s from it.
- **The gauntlet is a working session.** `agentic-qa gauntlet` and an npm script
  run every engine broad and never block. A person runs it with an agent — "run
  the gauntlet, see what makes sense, fix it or ignore it" — which is where
  a rule earns promotion into the corpus or gets switched off. Whether it should
  also run on commit was raised and decided against by default: blocking commits
  on unvetted rules turns every false positive into a forced `qa-ignore`. It is
  an opt-in instead, for a repo that has worked through the gauntlet — fixed what
  is real, switched off or excused what is not — and wants to keep it that way.
- **Commit runs the corpus's mechanical rules only.** Judgment on commit was
  considered, since Stop already pays for it and commits are rarer, and rejected
  for a concrete reason: judging writes `.qa/rules.json`, a committed file, after
  the person has staged, so every commit would leave the ledger modified behind
  it. Most verdicts would be cache hits from Stop anyway. Revisit only if the
  trial shows commits landing judged-violating code that Stop never saw.
- **CI runs both corpus tiers and fails on either.** No gauntlet.
- **The person hears from Stop only when a block did not work.** On the first
  pass the agent is told and nothing goes to the person. If findings still stand
  on the second pass, the person gets them, and decides what to tell the agent.
  A clean turn says nothing. Today scanner notes reach the person on every turn.
- **A block must say what to fix.** Pattern and scanner findings carry the rule
  statement, which is the fix. Judgment findings today carry only the statement
  and a line: the judge's reason ("loads the order by id but never checks it
  belongs to the caller") is written to the ledger and dropped from the block, so
  the agent knows which principle it broke but not what the judge saw. The block
  must include the judge's reason and the rule's rationale. Contract findings
  already carry their reason.
- **No session-start steering yet.** A `SessionStart` hook could put a short form
  of the guardrails in front of the agent before it writes anything, shipped from
  the package so no consuming repo's files change. Not needed while the corpus
  blocks at Stop: the agent learns a rule the moment it breaks one, with what to
  fix. The signal to build it is the trial showing Stop blocking on the same
  rules again and again.
- **Instructions to agents in consuming repos travel in hook output, never in a
  steering file.** This repo's CLAUDE.md reaches only sessions working on this
  repo; nobody will edit every consuming repo's CLAUDE.md.

The evidence, from one session of building here. Every one of these reached the
agent, most of them repeatedly, and none was acted on:

| rule | fired on | legitimate here? |
| --- | --- | --- |
| `eslint:sonarjs/no-os-command-from-path` | every `execFileSync("git")`, about a dozen times | no: whoever controls PATH already controls the machine |
| `opengrep:...detect-non-literal-regexp` | `mechanical.ts`, `load.ts`, `opengrep.ts` | no: the patterns come from our own corpus, not user input; real in a request handler |
| `eslint:sonarjs/no-invariant-returns` | `hook.ts` always returning 0 | no: that is an invariant |
| `opengrep:...missing-template-string-indicator` | `init.ts`, a `{test,spec}` glob | no: false positive |
| `eslint:sonarjs/cognitive-complexity` | `cli.ts` (88), `mechanical.ts` (40), `stop.ts` (28) | yes, but pre-existing and repeated on every edit of the file |
| `eslint:@typescript-eslint/no-explicit-any` | test stdout mocks, smoke transcript types | mildly |
| `eslint:sonarjs/no-nested-template-literals`, `no-nested-conditional` | several | style, arguable |
| `eslint:sonarjs/super-linear-regex` | `llm.ts` whitespace normalisation | technically, on local files only |
| `opengrep:...github-actions-mutable-action-tag` | `actions/checkout@v4` | yes: pin actions by SHA |

Two corpus findings fired in the same session, and both were right: a token in
`localStorage` inside smoke-test data, which moved to `fixtures/`, and an
assertion inside a loop, which became a table. The corpus earned its place; the
gauntlet, as shown to an agent, did not.

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

- **Agent harness hooks** (`Stop`; `PostToolUse` was removed, see "The hooks
  enforce the corpus, and the gauntlet is on demand") — the fast loop. Feedback
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

### One table decides what runs where

What each call site runs used to be decided in four places: `src/hook.ts` chose
the fast engines, `src/stop.ts` ran everything unless a `--mechanical` flag in
someone's settings said otherwise, the pre-commit hook ran whatever command
`init` had written into it, and CI ran whatever a workflow listed. The README
described what that code happened to do. It drifted: opengrep reached the commit
hook, adding about 5s to every commit, without anyone deciding it should.

Now it is one table, `src/sites.ts`, in three layers owned by whoever knows the
answer:

| layer | lives in | example |
| --- | --- | --- |
| engine facts | this repo, on each adapter | opengrep is `slow` |
| default policy | this repo, `src/sites.ts` | `edit` and `commit` run the `fast` scanners; `stop` and `ci` run `all` |
| repo overrides | a consuming repo's `qa.config.yaml`, under `callSites` | skip opengrep at Stop; put slow scanners back on commit |

- **Each call site is a command.** `hook`, `stop`, `commit`, `ci`. A generated
  file names the call site, never the checks: the pre-commit hook `init` writes
  is `agentic-qa commit`, so a repo set up long ago still gets today's policy
  rather than whatever command its hook was written with. `rules` and
  `contracts` stay as commands a person runs by hand, with every engine.
- **Defaults select by property, never by name.** `fast` is every engine not
  marked slow, so a slow engine added later stays out of the quick call sites
  without anyone remembering an exception. Naming an engine is for a repo's
  overrides, where it is choosing its own trade-off.
- **Commit runs the fast scanners by default.** Previously undecided; opengrep
  had reached the commit hook unexamined. Every commit pays the commit row, a
  person's as much as an agent's, and a slow commit hook is how `--no-verify`
  becomes a habit. The slow engines' corpus rules still block at Stop and in CI,
  and CI is the gate that cannot be skipped. A repo that wants them on commit
  sets `callSites.commit.scanners: all`.
- **Two cells are fixed.** `edit` and `commit` can never run the judgment rules
  or test contracts: the per-edit hook can run concurrently and those tiers
  write committed ledgers, and a commit must never cost money or wait on a
  model. Both were invariants already; the table refuses to load an override
  that breaks one, rather than letting config quietly do what the code forbids.
- **Overrides are validated strictly.** An unknown call site, setting or scanner
  name fails the load. A misspelled override that is silently ignored is a check
  someone believes they changed.
- **Flags are overrides of the same table.** `stop --mechanical` switches off
  that row's judgment cells and nothing else. This repo's own free-tier Stop,
  once a flag in its settings that differed from what `init` writes, is now
  `callSites.stop` in its `qa.config.yaml`, the layer meant for it.
- **`ci` skips the judgment tiers in CI without an API key**, loudly, rather than
  failing, so a fork's pull request still gets the scanners. Locally the same
  command uses Claude Code's login.
- **The README's table is rendered from the defaults**, and a test requires the
  README to contain it exactly, including which scanners each group resolves to.

Accepted: skipping a scanner by name leaves its corpus rules to the other call
sites without a warning. That is the trade-off a repo is choosing when it names
one, and the defaults never do it.

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

What belongs there is `agentic-qa ci`: the ci row of the call-site table, which
is every scanner again as insurance against `--no-verify`, plus the judgment
rules and test contracts, the two that cannot gate a commit because they cost
money and need the network.

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

**Overruled:** the per-edit hook was removed anyway, with this cost accepted;
see "The hooks enforce the corpus, and the gauntlet is on demand". The
argument as it stood: PostToolUse *does* fire
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
platform limit. And the payload carries `cwd` plus `stop_hook_active`.

**Corrected: how Stop blocks.** This section used to say blocking was
`hookSpecificOutput.decision: "block"` with a `reason`, "verified against the
docs". It was wrong, and the hook shipped that way: Claude Code ignores a nested
`decision`, so `agentic-qa stop` looked wired in every repo and never blocked
anything. Its tests asserted the JSON it emitted, which proved only that it
emitted it. Found while adding opengrep, and settled by headless `claude -p` runs
against probe hooks rather than by reading again:

| output | effect on the turn |
| --- | --- |
| top-level `decision: "block"` + `reason` | held; the agent continues with the reason |
| `hookSpecificOutput.decision` | ignored |
| `hookSpecificOutput.additionalContext` | **also continues the agent** |
| `systemMessage` | shown to the person; the turn ends |
| top-level `decision: "block"` + `systemMessage` | held, and the message is shown to the person as well |

The second row is the bug. The third mattered as much: the "report once and let
go" pass used `additionalContext`, which would have kept the agent going, a
second block by another name. So Stop blocks with top-level `decision`, and
everything that must not hold the turn — the second pass, notes, a crash — goes
to the person through `systemMessage`. After the fix, a real headless session
asked only to say hello was held on an uncommitted violation, dealt with it, and
was released. **A hook contract is verified by running a real session, not by
reading the docs.**

### Only a person makes an exception, and committing is how

**Observed, not hypothetical.** Once Stop really blocked, the first headless
test showed an agent without edit permission proposing to silence a real
violation in production code with `// qa-ignore: ... - this is test code`. The
reason was false. A blocked agent's cheapest way out is a one-line comment, and
nothing can check the reason, because the reason is the very text written to
persuade — asking a model whether it is honest just moves the persuasion. The
gate that exists to hold agents contained a bypass that agents are the likeliest
to use.

What can be checked is who made an exception take effect:

- **The automatic call sites honour only committed exceptions.** The per-edit
  hook and Stop treat a `qa-ignore` whose comment line was added or changed since
  `HEAD` as absent, so the finding stands and Stop still blocks. Staged counts as
  uncommitted: an agent can `git add` as easily as it can edit. Judged by line,
  from `git diff HEAD -U0`, not by whether the same text appears somewhere in the
  committed file, so moving an approved comment onto different code is a new
  exception. A file not in `HEAD` — untracked, renamed, or in a repo with no
  commits — has no committed exceptions at all.
- **Every refused one is shown to the person**, through `systemMessage` at Stop,
  on the blocking pass and the one that lets go, so an attempt is visible rather
  than found later in a diff. The agent is told too, and told that exceptions are
  the person's decision.
- **Commit and CI honour every exception they see.** What they see is staged or
  committed, and committing is the act of approval.
- **Outside a git repository every exception counts.** Nothing can be committed
  there, so refusing would remove the hatch rather than guard it.

git is consulted only when a comment actually matches a finding, so a run with no
exceptions in play costs nothing extra. The policy lives in
`src/rules/exceptions.ts`; `src/rules/ignore.ts` still only says where a comment
must sit.

Not done, on purpose: tightening where the comment may sit. Pattern and scanner
findings already require the same line or the one above; only judgment findings
accept it anywhere in the file, because a judge's cited line is advisory. An
agent can put a comment on the right line as easily as the wrong one, so
placement was never the protection.

**The honest limit.** An agent with an unrestricted shell can run `git commit`
itself, so "committed" is only as strong as the agent's permission to commit.
The recommended setup is a Claude Code permission rule that asks before
`git commit`. `init` does not install it, deliberately: permissions are the
person's own configuration, and a setup command that edits them is the
unrequested change this tool objects to. It is also a speed bump rather than a
lock, since it matches how a command starts. Whether stronger approval is worth
building is an open question.

Two known edges, accepted for now and worth watching in real use (item 2). A
renamed file has no committed exceptions until the rename is committed. And an
exception a person asked the agent to add is listed as refused on every turn
until it is committed, which could read as nagging.

Verified in a headless haiku session with Edit, Write and Bash denied, against a
file carrying an uncommitted `qa-ignore` with a false reason: the turn was held,
the person was shown the refused exception on both passes, and the agent told
the person the comment would not count until committed and asked what to do,
rather than writing another.

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

**Revised:** a warning shown to an agent on every edit turned out not to be
"visible" but ignorable, and ignorable output trains the reader to ignore all of
it. Gauntlet findings left the automatic call sites entirely and live in
`agentic-qa gauntlet`; see "The hooks enforce the corpus, and the gauntlet is on
demand". The coverage half of this section stands unchanged.

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
*settled*, which is not the same as what has been *built*.

Built: four scanner adapters — **eslint**, **dependency-cruiser**, **gitleaks**
and **opengrep** running the semgrep community rules — behind one conductor with
the corpus/gauntlet split and the coverage check, and the scanners npm cannot
install provisioned automatically. Four corpus rules are delegated to them
(`sec.jwt.no-none-algorithm`, `test.no-conditional-assertion`,
`be.layer.no-db-client-outside-repository`, `sec.no-aws-access-key-id`); every
other mechanical rule is still a pattern, some on purpose. opengrep claims no
corpus rule yet. `mutate` is still the hand-rolled version rather than Stryker.

Everything listed below runs. First in Next is reshaping the call sites so the
hooks enforce the corpus and the gauntlet runs on demand, which is decided but
not built.

Known gaps in what is built: this repo's CI has no `ANTHROPIC_API_KEY` secret,
so its `ci` step has never run the judgment rules or contracts; they are scored
by hand with `npm run eval:rules-llm` and `eval:contracts`. And a judgment finding
at Stop does not tell the agent what the judge saw (Next, item 1).

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
  through a top-level `decision` field and always exits zero, so a crash
  reports rather than trapping the turn. Until Phase 1 that field was nested
  where Claude Code ignores it, so the hook never actually blocked; see
  "Corrected: how Stop blocks".
- Phase 1: opengrep running the semgrep community rules, the security and
  configuration gauntlet (see "Phase 1: opengrep and the downloaded tools"). Scanners npm
  cannot install — opengrep, gitleaks — and the community rules are downloaded
  on first use into `~/.cache/agentic-qa/`, each pinned (binaries by version and
  SHA-256, rules by commit), with `agentic-qa setup` to do it ahead of time and
  CI caching the result. opengrep runs at Stop, on commit and in CI but not per
  edit, and loads only the rule sets for the kinds of file changed. Its notes
  reach the person at Stop. A Stop after a one-file change in `orders-admin`
  takes about 4.6s; the per-edit hook stays under a second.
- The escape hatch closed at the automatic call sites: the per-edit hook and
  Stop honour only a `qa-ignore` committed in `HEAD`, and show every refused one.
  See "Only a person makes an exception, and committing is how".
- Real-session smoke tests for the agent-facing call sites (`npm run smoke`,
  `smoke/hooks.smoke.ts`). Five headless haiku sessions run in parallel against
  throwaway repos whose hooks `init` wrote, pointed at this checkout's build, and
  assert on the transcript rather than the payload: Stop holds the turn on a
  corpus error and the agent receives the reason; the second pass lets go and
  the person is told; notes and a failure to run never hold the turn; an
  uncommitted `qa-ignore` releases nothing and the person sees it; the per-edit
  hook's report reaches the agent, proven by the agent repeating a rule id it
  could not otherwise know. About 30s and $0.13 a run. Shown to fail: with
  `decision` nested back inside `hookSpecificOutput`, the three tests that need
  Stop to hold the turn fail. Local only, deliberately: CI would need an API key
  and bill every push, which is worth it only if a hook change ever ships
  without a run. Stop runs `--mechanical` there, so the hook makes no model
  calls of its own; the judgment tiers leave through the same output code.

- One table for what runs where (`src/sites.ts`): each call site is a command
  (`hook`, `stop`, `commit`, `ci`) that reads its row, a repo overrides cells
  under `callSites` in `qa.config.yaml`, and the README's table is rendered from
  the defaults and held to them by a test. Commit now runs the fast scanners
  only. See "One table decides what runs where".
---

## Next

In priority order. The ordering principle: **the system has to be trustworthy
and usable before the corpus grows.** Every item above rule-writing is about
whether a gate can be believed, whether it can be configured, and whether it
survives real use. Writing rules into a machine that cannot yet be trusted only
produces more output nobody can rely on.

### 1. The hooks enforce the corpus; the gauntlet runs on demand

Built. See "The hooks enforce the corpus, and the gauntlet is on demand" for the
reasoning. What landed, beyond the decision as written:

- **gitleaks is claimed whole.** Dropping unclaimed findings would have left an
  AWS key the only secret a commit could be stopped for, since the corpus
  claimed one gitleaks rule of about 200. `sec.no-committed-secret` claims every
  gitleaks rule not claimed by name (`rule: "*"`).
- **Commit and CI can both opt in to the gauntlet** (`callSites.<site>.gauntlet`),
  blocking when on. Stop cannot.
- **`agentic-qa rules` reports the corpus only**, like the call sites.

### 2. Use it for real on `orders-admin`

**Trial 1, 2026-09-17** (prompt in `fixtures/probes/trial-orders-api/`): a
headless Sonnet session built an orders API — repository, service, handlers, 18
passing tests — in 9 minutes for $0.65. Stop checked none of it. Cold, it made
about 30 judge calls (every llm rule on every changed file, plus every new
test) at concurrency 4, overran its 300s timeout and was cancelled, which
reports nothing to anyone. Run by hand with some verdicts cached it took 3m44s.
Every judge call also waited 3s on an open stdin. Fixed: stdin closed, a
judging window that always leaves Stop inside its timeout (now 600s), and
unjudged or failed judgments reported to the person. Also seen:

- The by-hand run blocked on two contract verdicts, both handler tests that mock
  the service and assert the handler's response. The judge calls that an
  assertion against a mock configured in the same test, which its prompt tells
  it to. Whether a handler test that mocks its service is a weak test is the
  owner's call; see Open questions.
- The agent, denied `DATABASE_URL=... npm test`, retried with
  `dangerouslyDisableSandbox`, and tried `git stash`. Both denied.
- Still unmeasured: what the agent does when Stop does hold it. Trial 2.

`orders-admin` is on the current version, with the working Stop hook. Build an
actual feature there with the hooks live, and record what nothing else can show:

- **The judgment tier at Stop, now that it can block.** It runs the llm rules and
  contract checks on every turn that changes code. Until the Stop fix its
  verdicts could not hold a turn, so two things have never been measured: the
  cost per turn, and how often a wrong verdict now holds the agent.
- Which blocks were right and which were wrong, per rule.
- Stop latency during real work, not probes, and cost per turn.
- **Whether Stop blocks on the same rules again and again.** That is the signal
  for session-start steering: an agent repeating a mistake it could have been
  told about up front.
- **A first gauntlet triage session** on real code: which community rules are
  worth promoting into the corpus under one of the guardrails, and which should
  be switched off in the shipped config for this stack.
- Whether agents still reach for `qa-ignore` when they can edit, now that an
  uncommitted one releases nothing, and whether any try `git commit`.
- Whether the refused-exception list is useful or nagging when the person asked
  for the exception and just has not committed yet.

This is the calibration the fixtures cannot provide, and its findings will
re-rank the items below it.

### 3. CI documentation a consuming repo can follow

`init` deliberately does not write CI (see "CI is documented, not generated").
`agentic-qa ci` collapsed the checks into one step, but a working workflow still
needs install, `setup`, caching the tool cache and the key as a secret, and
nobody has run that outside this repo. This repo's workflow is not a
fair example — it builds agentic-qa from source and runs `node dist/cli.js`,
where a consumer runs `npx agentic-qa`. Write a GitHub Actions example for a
consuming repo into the README, and prove it by running it in a real consuming
repo before documenting it; `orders-admin` has no remote, so that needs one.
Other providers get the command list, not examples.

### 4. Adoption on an existing repo: the baseline ratchet

Half-solved by the severity split, and made more urgent by it. Pointing the
gauntlet at an existing repo produces far more findings than 22 hand-written
rules ever did, so the ratchet stops being a nicety. The corpus-blocks /
gauntlet-warns rule is the first half of it; the second half is a committed
snapshot and a count that must trend down.

Turning a full corpus on an existing codebase produces thousands of violations
and gets switched off the same afternoon. Snapshot the existing violations, fail
only on new ones, and require the count to trend down. Every successful linter
adoption works this way. It has to be designed in, not bolted on.

### 5. Mutation grounding: adopt Stryker, then give it a trigger

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

### 6. Packaging and configuration

Mostly done. The package builds on install via `prepare`, ships `dist/` and the
rules corpus, and has been verified by packing it, installing the tarball into a
clean directory, and running the installed binary there: it loads the whole
corpus and the shipped engine configs from inside the package and reports
correctly. A consuming repo therefore holds
only its own `qa.config.yaml` and `.qa/` ledgers.

What is left:

- **Publishing.** A deliberate decision, not a technical gap. The package is
  marked `private` so it cannot go out by accident. Until then, install it as a
  git or tarball dependency.
- **A Claude Code plugin** for the agent-facing half: the hook, a review
  subagent, slash commands, installable across repos from a marketplace.
- **Versioning the rules corpus separately** from the tool, so rules can be
  updated without shipping a new binary, and a repo can pin them.
- **Stack profiles, framework gauntlets and a personal mode.** Designed in
  outline under "Raised, not yet designed"; all three build on the call-site table.

### 7. Speed: a long-lived process

Not needed yet. A fresh process per hook call spends almost all its time
loading: eslint takes about 500ms to load and 20ms to lint, opengrep seconds to
load and milliseconds to scan. A long-lived process would let Stop run opengrep
without its load cost. Less pressing once item 1 removes the per-edit hook and
keeps engines that claim no corpus rule out of Stop. Worth it only once
item 2 shows latency is actually hurting.

### 8. Make the gauntlet robust where no engine covers the stack

Separate from the corpus. The gauntlet is meant to be broad coverage for free,
and it has holes wherever the engines and their plugins do not know the target
stack:

- **Hono.** The community rules' taint tracking knows Express request objects
  and not Hono's `c.req`: on a probe app, SQL injection, SSRF, path traversal,
  open redirect and command injection were all found in Express and all missed
  in identical Hono code. Teaching opengrep Hono's sources — roughly half a dozen
  rules mirroring the Express ones — recovers the whole class. Sonar's eslint
  security rules have the same blind spot, and Hono has no eslint plugin.
- **Framework plugins not enabled.** React hooks, `jsx-a11y`, Next.js: see
  "Framework-specific gauntlets" under "Raised, not yet designed".
- **Terraform** has only opengrep today; tflint and checkov remain candidates.

The probe app behind these measurements is `fixtures/probes/gauntlet-hono-express`.

The rules written here are gauntlet rules, not corpus promises: they widen what
is noticed, and only a corpus claim (item 9) makes one block.

### 9. The corpus, last

Everything that writes, moves or retires a rule. Last because a rule is only
worth as much as the machine that enforces it.

#### Our own AST rules in place of the regex security rules

Shipped in `config/` under this repository's license. On a file built to trip
regexes, three opengrep rules got every case right where the patterns produced
two false positives (a `sha256` checksum in a file that also hashes a password,
and `httpOnly: false` inside a string), and matched Hono and Express alike. The
prototype rules and the files they were measured on are in
`fixtures/probes/own-ast-rules`.

#### Corpus claims on community rules

Where a community rule covers a corpus rule better, claim it so its findings
block. The public-ingress security group rule is the first candidate, since the
pattern also flags an ordinary `0.0.0.0/0` egress. Claims need the coverage test
to run against the cached rules.

#### Retire superseded rules and prove parity

Delete the YAML rules an engine now covers, then re-run both fixture corpora and
`orders-admin`. Each rule already has a violating case and a clean control, so
parity is measured rather than asserted. Retire freely: these 22 were a test
set, not a spec, and the fixtures stay as the harness that proves an adapter
reports correctly.

Parity findings already in hand. The lesson in all of them: **an engine rule
with the right name is not evidence of the same coverage.** Read what it
actually matches before retiring a pattern.

- **Sonar's security rules do not know Hono.** `cookie-no-httponly`, `cors` and
  `hashing` follow data into known sinks (`express`, `cors()`,
  `cookie-session`). On an Express app they fire, as "make sure this is safe"
  hotspots; on the same code written against `hono/cors` and `hono/cookie` they
  fire on nothing. They also treat `sha256` on a password as fine, and missed
  `res.cookie(..., { httpOnly: false })`. Our patterns caught every case in
  both, and the community opengrep rules caught only one of them, so these stay
  until our own AST rules replace them.
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
  make that mistake, and no existing one covers ternaries and nested ifs.
- **Patterns match code inside strings.** The unit-test table for those two
  patterns tripped them, so the cases live in `test/test-shape-cases.json`. The
  loop rule then correctly caught the test iterating over its own tables.

#### The corpus is the guardrails; scanner rules sit under them

The owner's guardrails in `~/code/full-stack-swe` are principles — authorise
per record, validate at the boundary, keep the database behind the repository
layer — not syntax. A corpus rule should be one principle, enforced by whatever
tier can: a pattern, a judgment prompt, or several scanner rules claimed at once.
SQL injection, SSRF and path traversal from the community rules would each be a
claim under one "never trust request input" guardrail, rather than three corpus
rules or three unowned notes. The gauntlet triage sessions (item 1's command) are
how candidates are found; this item is where they are adopted.

#### Classify the prose, then build the corpus from what is uncovered

Rescoped twice, and the second rescope overshot. It began as "bulk-load the rules
corpus"; delegation made much of that somebody else's job; then gap-first briefly
demoted the prose to an afterthought, which would have left us structurally
unable to notice the concepts no engine has an opinion about.

The deliverable is a coverage pass over `~/code/full-stack-swe`: every concept
classified as covered by an engine (with tool and rule id), judgment tier, human,
or not a rule. Expect most of the real content to land in the judgment tier, and
a meaningful fraction to be background knowledge rather than a checkable rule —
a legitimate outcome, not a failure of the pass. The engines now exist, so
"covered" can be verified rather than asserted and the coverage test can hold
every claim. See "Two derivations, because only one of them can find an
absence". The pack list — including the missing `infra` pack — is more likely to
fall out of this pass than to precede it.

The other two sources of rules stay live alongside it: house-specific convention
that no public ruleset can know, and escaped defects — when a real bug ships, ask
which rule should have caught it. That last one is the only source grounded in
something that actually went wrong.

Where the corpus is thin, measured rather than guessed. Of the original 22 rules:
nine come from the auth and security chapter, three each from frontend, data and
testing, two from infrastructure, one from backend architecture, one from the
AI-era chapter. Five chapters have produced nothing at all: web fundamentals,
repo hygiene, devops and delivery, observability and ops, performance and
reliability. Infrastructure is the sharpest gap relative to its weight: the
longest chapter in the source, with exactly one rule in the corpus matching a
`.tf` file. An infra pack covering state, IAM scope, tagging, and the
expand-contract discipline around managed databases is probably the most
valuable single addition. Each new rule needs a violating fixture and a clean
control.

---

## Decisions made while building the scanner tier

Recorded from the build, so they are not relitigated.

### Phase 1: opengrep and the downloaded tools


- **Opengrep, not semgrep, as the engine.** Both are LGPL and run the same rules;
  on the probe app opengrep matched semgrep's findings and added one, in less
  time. Opengrep is a single downloadable binary, so it can be provisioned
  automatically; semgrep is a 230MB Python install that cannot.
- **The community rules are downloaded, never vendored.** Their license permits
  use for your own purposes and forbids redistribution, and this repository is
  public, so committing them would be distributing them. Making the repository
  private was considered and rejected: every install would need GitHub
  credentials, and it would not have removed the need to get the rules onto each
  machine. The Opengrep fork of the rules (a December 2024 snapshot, LGPL plus
  Commons Clause) could be vendored, but it is frozen and forbids selling.
- **Pinned and checksummed.** A binary is checked against a pinned SHA-256
  before it is ever run; the rules are pinned to a commit. Updating either is a
  one-line reviewed change in `src/tools/provision.ts`. A failed download fails
  open locally and closed in CI, like any missing scanner. Unit tests never
  download (`AGENTIC_QA_NO_DOWNLOAD`); they use what is cached or skip, and CI
  runs `setup` first so nothing is skipped there.
- **Kept out of the per-edit hook.** Loading rules dominates: about 3.4s for the
  JavaScript set, 1.3s for TypeScript, 5.4s for Terraform, against 20ms per
  scan once loaded. Rule sets are chosen by file type, so a TypeScript-only turn
  pays about 4s. The per-edit hook is a fresh process each time; in it, eslint
  spends ~500ms of its time loading and ~20ms linting, so a long-lived process
  is the lever if the per-edit hook ever needs to get faster.
- **Notes surface at Stop without holding the turn.** The per-edit hook already
  shows the fast engines' notes; Stop shows the slow ones' to the person via
  `systemMessage`, and to the agent only when it is being held anyway.

### Phase 0: eslint, dependency-cruiser, gitleaks

- **The eslint config ships with the tool** (`config/eslint.config.js`), for the
  same reason the corpus does, and plugins resolve from this package's own
  dependencies. A repo's own eslint config is not read. Whether a repo may
  extend the shipped one is open, and belongs with the baseline ratchet.
- **A claimed rule in a path the corpus rule excludes is a gauntlet warning**,
  not dropped: the exclusion means the promise does not apply there, not that
  the tool is wrong.
- **Stop blocks on corpus findings only.** The per-edit hook shows the fast
  engines' notes, capped at ten, for the file just edited; Stop shows the slow
  engines' notes without blocking on them.
- **Not type-aware yet.** typescript-eslint's type-checked presets need a
  tsconfig the checked repo may not have, and a program build per run.
- **Gauntlet noise is already measurable.** On this repo: 31 notes, including a
  real unused import, and `sonarjs/no-os-command-from-path` on every
  `execFileSync("git")`, which is noise here. The answer is the ratchet (item 4)
  and trimming the preset deliberately, not filtering output to the corpus.

### The judgment tier is the part with no free incumbent

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

- **Is a handler test that mocks its service weak?** Trial 1's judge said yes
  twice: "responds 409 when the order is not a draft" passes even if the
  service stopped detecting non-drafts, because the service is mocked. True, and
  it is also the ordinary way to test one layer. Either the judge reads a
  description as a claim about the layer the test targets, or descriptions must
  name the layer ("maps an invalid transition to 409"). The first quiets it; the
  second keeps it strict and puts the burden on test authors.
- **Auth provider.** Cognito is the current guess. Affects the auth rule pack.
- **Whether descriptions should be required on every test,** or only on tests
  above some complexity. Requiring them everywhere risks ceremony on trivial
  tests.
- **Escaped-defect log.** When a real bug ships, ask which rule should have
  caught it. That is the feedback loop that makes the corpus earn its keep
  instead of just accreting. Worth building once there is a real repo.
- **How `qa-ignore` gets audited, and who approves one.** "Only a person makes
  an exception" settles what automatic runs honour: only committed exceptions. Two things stay open. A repo
  where exceptions accumulate has quietly switched its rules off, so counting
  them and watching the trend is probably still needed, in CI and earlier. And
  approval is only as strong as the agent's permission to commit; whether a
  stronger channel is worth building — a person-only approval the agent cannot
  perform through its shell — is undecided.

### Raised, not yet designed

Recorded so they are thought about deliberately rather than discovered late.
Each notes where it is likely to be decided — `init` flags, `qa.config.yaml`, or
both — but none of them is settled.

- **Monorepos.** Routing is by file path, and every corpus trigger today is an
  extension glob (`**/*.ts`, `**/*.tsx`), so one repo holding a frontend and a
  backend gets every rule routed to both halves. Mechanical rules cope, because
  an engine rule only fires on code that matches it. Judgment rules cope in
  verdict — they answer `not-applicable` — but each routed pair is a judge call,
  paid once per file version. Separate frontend and backend repos have the same
  cost today, for the same reason. Undecided: whether triggers should route by
  package or directory, whether a package gets its own `qa.config.yaml`, where
  `init` puts hooks when the git root and the package differ, and whether the
  shipped eslint and dependency-cruiser configs must learn per-package roots.

- **Session-start steering.** A `SessionStart` hook, installed by
  `init --claude-hook`, putting a short form of the guardrails and how to treat
  findings into the agent's context before it writes anything, from text shipped
  in the package. Waiting on the trial showing repeated blocks on the same rules.
  Verify with a smoke test before relying on it.
- **Switching a gauntlet rule off for a whole repo.** Today the only ways are a
  `qa-ignore` per line or editing the shipped config, which changes every repo.
  A triage session that decides "this rule is wrong for us" needs somewhere to
  record that, with a reason, probably in `qa.config.yaml`.
- **`eval` is named for more than it does.** It scores the contract judge only;
  the rules are scored by `rules --expected`. The npm scripts name them
  properly; the command could follow.

- **A check that a consuming repo's wiring works (`agentic-qa doctor`).** The
  smoke tests prove the tool's hooks behave; nothing proves a given repo is
  wired to a copy that has the commands its hooks call. `orders-admin` twice had
  hooks calling a command its installed version lacked — `install-hooks`, then
  `stop` — while everything looked installed. A `doctor` would run each
  configured call site's command against the installed binary and say which do
  not exist or fail. Distinct from the smoke tests: repo setup, not tool
  behaviour.

- **Other stacks.** Everything assumes TypeScript, Hono, React, Postgres and
  Terraform: the shipped engine configs, the file extensions adapters handle,
  the patterns. Supporting another language or framework cleanly probably means
  a *stack profile* as the unit of configuration — which adapters run, which
  engine presets they load, which packs apply — declared in `qa.config.yaml`
  and proposed by `init` from what it detects (`package.json` dependencies,
  `go.mod`, `pyproject.toml`, `*.tf`). The seam already fits: adapters say which
  files they handle, and a corpus rule names its tool. What must not happen is
  forking the logic per stack; a profile selects, it does not branch.
- **Framework-specific gauntlets.** The corpus is framework-agnostic on purpose,
  and so is the shipped eslint config, so a Next.js repo gets nothing from
  `@next/eslint-plugin-next`, and a React repo nothing from
  `eslint-plugin-react-hooks` or `jsx-a11y` (the last would cover
  `fe.a11y.no-click-handler-on-div`). The likely answer is the same profile
  mechanism: frameworks contribute engine plugins to the gauntlet, detected from
  dependencies, and a framework pack can claim rules from them. Hono has no
  eslint plugin, which is part of why Sonar's rules missed it.
- **Non-cooperative mode.** One developer wants the checks; the team does not
  want anything added to the repo. The least invasive install touches no
  tracked file: no `prepare` script, no `hooks/` directory, no committed
  `.claude/settings.json`. Candidates for each piece: the tool itself installed
  globally or run through `npx` rather than added to `package.json`; the commit
  hook in `.git/hooks` or a local-only `core.hooksPath`, which git does not
  share; Claude Code hooks in `.claude/settings.local.json`, which is
  per-developer by design; `qa.config.yaml` and the `.qa/` ledgers either
  excluded through `.git/info/exclude` or kept outside the repo altogether. The
  ledgers are the awkward part — "committed and shared" is a design invariant —
  so this mode likely means local-only verdicts, and that trade should be
  stated rather than hidden. Probably `init --personal`.
- **Whether the packs are complete.** Five exist: backend, data, frontend,
  security, testing. The prose corpus has twelve chapters, and five have
  produced no rules at all (web fundamentals, repo hygiene, devops and delivery,
  observability and ops, performance and reliability). Infrastructure has no
  pack: its one Terraform rule, `sec.no-world-open-security-group`, is filed
  under security. Creating empty packs now would fix a taxonomy before the
  classification pass (item 9) has shown what the concepts actually are; the
  pack list is more likely to fall out of that pass than to precede it. An
  `infra` pack is the one that is clearly missing already.
