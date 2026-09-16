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
paths and content select which rule packs load: a change under `components/`
pulls the frontend and accessibility packs, not the migration pack. Routing is
what makes the check both affordable and actually attentive.

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
no work and costs nothing.**

Test ids are keyed on the title, so editing a description produces a new id and
forces a re-judge. That is intended behavior, not a cache miss.

### False positives outrank false negatives

A checker that condemns good code gets switched off within a fortnight, and
after that a clean run means nothing. The judge is scored against a corpus with
known-correct verdicts (`agentic-qa eval`) and the two error directions are
reported separately. A false positive is a release blocker.

### The judge runs through headless `claude -p`

Uses existing Claude Code OAuth, so no separate API key locally. `--safe-mode`
is load-bearing: it strips CLAUDE.md, skills, plugins, hooks and MCP servers,
taking a judgment from $0.083 to $0.012 (haiku $0.008). Do **not** use `--bare`,
which is cheaper still but forces API-key auth.

`--json-schema` gives structured output natively, so no parsing JSON out of
prose.

### Start small, then bulk-load the rules

Enumerating all rules first produces hundreds of unenforceable ones and leaves
the hard part (routing, caching, noise control, adoption) untouched. Build the
machine end to end with a small rule set spanning all three tiers, prove the
loop, then bulk-load. Converting the prose corpus in `~/code/full-stack-swe`
into structured rules is an afternoon of work once the machine exists.

---

## Status

**Done and verified.** The test-contract checker end to end: extraction
(including `@describes` docblocks and nested describe blocks), hash-based
invalidation, the judge, the committed ledger, the CLI, and judge scoring.
Scores 5/5 on the fixture corpus with no false positives or negatives, at about
a cent per judgment.

**In progress.** Mutation grounding.

---

## Next

### 1. Mutation grounding

The strongest available answer to "is this test real". The judge already
proposes a mutation that would violate the description and currently that
proposal is stored and ignored. Instead: apply it to the implementation, run
that single test, and require it to fail. The model proposes, the test run
disposes. That converts an opinion into a deterministic experiment.

Design notes:

- Mutate the implementation, never the test.
- Map test to implementation via the test file's imports.
- Run one test: `vitest run <file> -t "<name>"`.
- Safety: hold the original contents in memory, restore in a `finally`, and
  refuse to run when the target file has uncommitted changes so `git checkout`
  is always a valid recovery.
- Expensive, so it is opt-in per run and cached like everything else.

### 2. The rules corpus and mechanical checkers

The tier-0 majority. Source material is the twelve-topic prose corpus in
`~/code/full-stack-swe` (about 34,000 words), which is already organized by
area: web fundamentals, backend architecture, data, frontend, auth and security,
testing, repo hygiene, devops, observability, performance, infrastructure.

Rule schema, one structured object per rule:

```
id            be.authz.ownership-check
statement     one imperative line
tier          mechanical | llm | human
enforcement   the lint rule id / pattern, or the judge prompt
triggers      globs plus content patterns that make this rule apply
rationale     short, why it exists (models judge better knowing why)
exception     how to opt out with a recorded reason
```

Candidate mechanical rules for this stack: no tokens in `localStorage`; no
browser globals at module scope (breaks SSR); nothing secret behind a `VITE_`
prefix, since those ship to every user; no `useEffect` plus `fetch` plus a
loading boolean when a query library is present; no database client imported
outside the repository layer; no conditionals or loops in tests; no mocking the
project's own modules; migrations must be reversible; no open security groups;
no committed secrets.

Candidate llm rules: endpoint checks resource ownership and not merely that
someone is logged in; catch blocks that hide failures behind a plausible
default; a new helper duplicating an existing one.

Do this once there is a real repo to calibrate against. Writing rules with no
code to run them on is how you end up with hundreds of unenforceable ones.

### 3. Adoption on an existing repo: the baseline ratchet

Turning a full corpus on an existing codebase produces thousands of violations
and gets switched off the same afternoon. Snapshot the existing violations, fail
only on new ones, and require the count to trend down. Every successful linter
adoption works this way. It has to be designed in, not bolted on.

Also needed: a sanctioned escape hatch, `// qa-ignore: <rule-id> — reason`, that
is recorded and auditable. Without one, people disable the whole check instead
of the one rule.

### 4. Distribution

The thing that decides whether this is a system or a one-off. Rules live in a
versioned package consumed by both halves; a repo holds only `qa.config.yaml`
and `.qa/`. If rules live in the repo, there are N copies to maintain.

- A **Claude Code plugin** for the agent-facing half: hooks, the review
  subagent, slash commands. Installable across repos from a marketplace.
- An **installable CLI** for enforcement, used by git hooks and CI.
- Both depend on the same rules package, so updating rules centrally updates
  every repo.

### 5. Tests for this tool itself

There are currently none, which is not a defensible position for a QA tool. The
deterministic parts (extraction, hashing, invalidation, ledger pruning, eval
scoring) are all straightforwardly unit-testable. The judge is the only
non-deterministic piece and is covered by the fixture corpus instead.

---

## Open questions

- **Auth provider.** Cognito is the current guess. Affects the auth rule pack.
- **How much of the prose corpus survives conversion.** Some chapters are
  background knowledge rather than checkable rules, and background does not
  belong in a rules corpus.
- **Whether descriptions should be required on every test,** or only on tests
  above some complexity. Requiring them everywhere risks ceremony on trivial
  tests.
- **Escaped-defect log.** When a real bug ships, ask which rule should have
  caught it. That is the feedback loop that makes the corpus earn its keep
  instead of just accreting. Worth building once there is a real repo.
