# agentic-qa

Tools that help an AI build production-quality software, and prove that it did.

## The problem

Most code is now typed by an agent. Agent code fails differently from human
code. Human mistakes look like mistakes: a typo, a forgotten case. Agent
mistakes look correct. The code compiles, the shape is right, the tests pass,
and it quietly does the wrong thing, or duplicates something that already
existed three directories over.

Reading all of it carefully does not scale. And an agent reporting that the
tests pass is not the same as the tests passing.

## What we are trying to build

Two connected ideas.

### 1. Write the rules down, then check code against them automatically

The things an experienced engineer checks for: every endpoint confirms the
caller actually owns the thing they asked for, no secrets end up in the browser
bundle, no database queries inside loops, migrations can be undone. Right now
those live in people's heads and get applied when someone remembers.

We write them down once, and check changed code against them on every commit.

The important part is *how* each rule gets checked. Most rules are not judgment
calls, they are patterns, and a linter checks a pattern better than a model
does: instantly, on every line, for free, forever. So every rule has to say how
it is enforced:

- **mechanical** — a linter, the type checker, an import boundary, a pattern
  search. Free and exact. Most rules belong here.
- **llm** — a model reads the change and judges it. This costs money and is not
  perfectly repeatable, so it is reserved for things a pattern cannot express:
  does this error handler quietly hide a failure, does this new helper duplicate
  one that already exists.
- **human** — should this feature exist at all. No tool answers that.

Paying a model to do a linter's job is slower, less reliable and less complete.
So the design work is pushing every rule as far down that list as it will go.

### 2. Every test says in plain English what it checks, and we verify that it does

A test carries a sentence describing what it verifies. Something else then
confirms the test actually verifies that sentence.

The payoff: **you can read only the descriptions and know what the suite
covers.** You never have to read the assertions to find out whether a test is
real. That only holds if something keeps the two honest, which is what this
does.

This is the part that works today.

## What works today

The test-contract checker, end to end.

Each test's description is its title, or a longer `@describes` docblock when the
title is too short to be useful:

```ts
/**
 * @describes Stacking two coupons is refused: the second call leaves the cart
 * total exactly as the first coupon left it, and reports STACKING.
 */
it("refuses to stack", () => { /* ... */ });
```

For each test it answers one question: **if the described behavior broke in a
realistic way, would these assertions fail?**

- **upheld** — yes. The test is real.
- **violated** — no. A broken implementation would still pass. Assertions that
  only check something is defined, assertions that can never fail, assertions
  against a mock that the same test set up, tests that only check nothing threw.
- **unverifiable** — the description is too vague to prove wrong, so there is
  nothing to check it against. The description is the thing to fix.

Real output from the test fixtures:

```
VIOLATED coupon.test.ts
  claims: applies a percentage discount to the cart total
  why:    The test only asserts that the result is defined, but does not verify
          that a discount was actually applied. An implementation that ignores
          the coupon and returns the original cart unchanged would pass.
  proof:  Change applyCoupon to return the cart unchanged: `return cart;`

VAGUE coupon.test.ts
  claims: works correctly
  why:    Too vague to be falsified. A competent engineer cannot determine from
          this description what observable outcome would prove it wrong.
```

## Checking code against the rules

The rules live in `rules/*.yaml`, one file per area, and ship with the tool
rather than with the repo being checked. A repo that keeps its own copy is a
repo whose rules quietly drift.

Each rule says what it requires, why, and how it is enforced:

```yaml
- id: be.layer.no-db-client-outside-repository
  statement: Import the database client only inside the repository layer.
  tier: mechanical
  severity: error
  rationale: >
    Layer boundaries only exist if something enforces them. Once a handler
    queries the database directly, business rules and SQL interleave.
  triggers:
    paths: ["**/*.ts"]
    excludePaths: ["**/repositories/**", "**/migrations/**"]
  enforcement:
    kind: pattern
    pattern: |-
      from\s+['"](pg|postgres|drizzle-orm|kysely|knex)['"]
```

`excludePaths` is what makes a layering rule possible: importing the database
client is a violation in a handler and exactly right in a repository.

Output looks like this:

```
ERROR api/handlers.ts:4
  Import the database client only inside the repository layer. [be.layer.no-db-client-outside-repository]
  import { sql } from "drizzle-orm";
```

### Turning one rule off

Every rule can be opted out of, in one place, with a reason:

```ts
localStorage.setItem("authToken", token); // qa-ignore: fe.storage.no-token-in-local-storage - demo build only
```

This exists because without a sanctioned escape hatch, the first false positive
gets the whole check disabled instead of the single rule.

### Scoring the rules

Same idea as scoring the judge. `fixtures/rules` holds files with known
violations *and* clean files that contain the exact constructs the rules match
on, in contexts where they are correct:

```
8/8 violations found · 0 false positive(s) on clean files
```

The clean files are the important half. Missing a problem is disappointing;
firing on correct code is what gets the checker switched off.

## Proving it, instead of just believing it

A model saying a test is weak is still an opinion. `agentic-qa mutate` turns it
into an experiment:

1. ask the model for an edit to the **implementation** that breaks the described
   behavior
2. apply it
3. run that one test
4. put the file back

If the checker said the test was real, it must now fail. If the checker said the
test was weak, it must still pass. When reality disagrees with the checker, the
checker was wrong, and it says so rather than quietly keeping its verdict.

This is the part that makes the whole approach defensible. Both tests in
`fixtures/runnable` pass against correct code, so running the suite tells you
nothing about which one is real. Breaking the code does:

```
CONFIRMED rejects a coupon that expired before the current time
  the test failed when the described behavior was broken, so it is real
  broke: Inverting the expiration check allows expired coupons to pass through.

CONFIRMED applies a percentage discount to the cart total
  the test still passed when the described behavior was broken, confirming it
  does not verify its description
  broke: Removes the line that modifies cart.total to apply the discount.
```

Safety rules, all enforced in code:

- it only edits the implementation, never a test
- it refuses to touch a file that is untracked or has uncommitted changes, so
  git can always recover it
- it restores the original file even if the run throws
- it runs one mutation at a time, because concurrent edits to real source files
  would corrupt each other
- it confirms the test actually *ran*. vitest exits 0 when it matches no tests,
  so a bad test selector would otherwise look like "the test passed despite the
  mutation" and wrongly condemn a good test

## Quick start

```
npm install
npm run build
```

Then from any repo with tests:

```
agentic-qa rules                 # check code against the rules corpus
agentic-qa rules --staged        # only files staged in git

agentic-qa contracts             # check whatever changed
agentic-qa contracts --staged    # only tests in files staged in git
agentic-qa contracts --all       # re-check everything
agentic-qa contracts --json      # machine-readable output

agentic-qa mutate                # prove the verdicts by breaking the code
agentic-qa eval                  # score the checker itself (see below)
```

It exits non-zero when a test does not back up its description, so it works as
a commit gate or a CI step.

To see it work immediately, against deliberately broken example tests:

```
cd fixtures/sample && node ../../dist/cli.js contracts
```

## Why it is cheap to run

Two reasons.

**It only re-checks what changed.** Verdicts are saved in `.qa/contracts.json`,
which is committed to the repo. A test is re-checked only when its description
changes, its body changes, or the checker itself changes. Reformatting costs
nothing, because the comparison ignores whitespace. A run where nothing changed
does no work and costs nothing.

**The model call is stripped down.** It runs through headless `claude -p`, so it
uses your existing Claude Code login and needs no separate API key. Running it
with `--safe-mode` stops it rebuilding your whole Claude Code environment (MCP
servers, CLAUDE.md, skills, plugins) on every single call:

| how it is called | cost per check |
| --- | --- |
| naively | $0.083 |
| `--safe-mode` | $0.012 |
| `--safe-mode` on haiku | $0.008 |

About a cent per test, and only for tests that actually changed.

## Checking the checker

A checker that cries wolf gets switched off within a fortnight, and after that a
clean run tells you nothing. So the checker is itself scored against a set of
tests whose correct verdicts are known ahead of time, in
`fixtures/sample/expected.json`.

```
agentic-qa eval
```

It reports two kinds of error separately, because they are not equally bad:

- **false positive** — condemned a good test. Treat as a release blocker.
- **false negative** — waved through a bad test. Worth fixing, less urgent.

Current score: **5/5, no false positives, no false negatives.**

Run this after any change to the model, the prompt, or the schema.

## Where this runs

Three places, all calling this same tool, so the rules an agent is told about
cannot drift from the rules the gate enforces.

- **While the agent works** (Claude Code hooks) — the fast loop. The agent finds
  out it broke a rule while it still remembers why it wrote the code.
- **On commit** (git hooks) — the floor. Mechanical checks only. Never a model
  call here: commits must be fast, free, and work offline.
- **In CI** — the authority. Everything, including the model checks. The only
  layer nobody can skip.

## What is not built yet

See [ROADMAP.md](ROADMAP.md) for the full plan and the reasoning behind it.
Short version:

- **The llm tier has no runner yet.** Rules like "an endpoint must check the
  caller owns the record, not just that they are logged in" are written down and
  routed, but nothing executes them. Only the mechanical tier runs today.
- A way to adopt this on a repo that already has thousands of violations,
  without everyone switching it off on day one.
- Packaging, so it installs into any repo instead of living in this one.

## Repo layout

```
rules/*.yaml              the rules corpus, one file per area
src/cli.ts                argument parsing and exit codes
src/config.ts             qa.config.yaml loading
src/judge.ts              the only thing that talks to a model
src/rules/load.ts         reads and validates the corpus
src/rules/route.ts        decides which rules apply to which files
src/rules/mechanical.ts   runs the pattern rules
src/contracts/extract.ts  reads tests out of source files
src/contracts/ledger.ts   hashing and the saved verdicts
src/contracts/mutate.ts   mutation grounding
test/                     unit tests for the deterministic parts
fixtures/sample/          broken tests with known-correct verdicts
fixtures/runnable/        a green suite, for mutation grounding
fixtures/rules/           known violations plus clean control files
```

Target stack for the repos this checks: React/Vite/TypeScript/TanStack Query,
Hono/TypeScript, Postgres, AWS/Terraform.
