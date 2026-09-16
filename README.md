# agentic-qa

Checks that AI-written code follows your rules, and that your tests actually
test what they say they do.

Agent code fails differently from human code. Human mistakes look like mistakes.
Agent mistakes look correct: it compiles, the shape is right, the tests pass, and
it quietly does the wrong thing. Reading all of it carefully does not scale.

## Quick start

In the repo you want checked:

```
npm install --save-dev github:mrwatts88/agentic-qa
npx agentic-qa init --git-hook --claude-hook
```

`init` writes `qa.config.yaml`, and nothing else unless you ask for it. Each
call site is a flag:

| flag | installs |
| --- | --- |
| `--git-hook` | a tracked `hooks/pre-commit`, plus the `prepare` script that activates it |
| `--claude-hook` | `PostToolUse` and `Stop` hooks in `.claude/settings.json` |

Already set up by an older version? `init --force` replaces the hook wiring so
you pick up call sites added since. It never replaces `qa.config.yaml` or a
`prepare` script you wrote — those are yours. Without `--force`, anything that
already exists is left alone and reported, so you can see what you are missing.

Bare `init` leaves your git config and your agent settings alone and tells you
what it did not install. Either way it never overwrites a file that exists.

If you took the git hook, commit `hooks/pre-commit`. That is what makes the gate
reach everyone who clones the repo, instead of only the person who ran `init`.

Then:

```
agentic-qa rules        # check code against the rules      (free)
agentic-qa contracts    # check tests against their descriptions
agentic-qa mutate       # break the code, confirm tests notice
agentic-qa eval         # score the checker itself
```

`rules`, `contracts` and `mutate` take `--staged` to check only what git has
staged. `rules` takes `--llm` to add the rules that need a model's judgment.
`rules` and `contracts` take `--json`. Everything exits non-zero on a problem,
so it works as a gate.

## Two things it checks

### 1. Rules

Rules live in `rules/*.yaml` and ship inside the package, so a repo that
installs it gets the corpus and cannot drift from it. Updating the dependency
updates the rules.

Every rule must say how it is enforced:

| tier | enforced by | cost |
| --- | --- | --- |
| `mechanical` | a pattern the CLI runs itself | free, every line, always |
| `llm` | a model reads the file and judges | about a cent, opt-in |
| `human` | should this exist at all | no tool answers this |

Most rules are patterns, and a pattern beats a model at pattern-matching. The
`llm` tier is for what a pattern cannot express: does this handler check the
caller *owns* the record, does this catch block hide a failure.

> **Where this is heading.** The patterns above are hand-written, and they are
> being replaced by the free tools that do this better — eslint with
> eslint-plugin-sonarjs, semgrep OSS, dependency-cruiser, gitleaks. The corpus
> stays, but as the record of what this repo promises to enforce and a test that
> the promise is still wired up, rather than as the engine. The judgment tier is
> unaffected; it is the part no free tool covers. See
> [ROADMAP.md](ROADMAP.md) — "Reversed: the mechanical tier delegates to existing
> scanners". This section describes what ships today.

```
ERROR api/handlers.ts:4
  Import the database client only inside the repository layer. [be.layer.no-db-client-outside-repository]
  import { sql } from "drizzle-orm";
```

Turn one rule off, in one place, with a reason:

```ts
localStorage.setItem("authToken", token); // qa-ignore: fe.storage.no-token-in-local-storage - demo build only
```

That hatch matters: without it, the first false positive gets the whole checker
disabled instead of the one rule.

### 2. Test contracts

Every test carries a sentence saying what it checks — its title, or a longer
`@describes` docblock:

```ts
/**
 * @describes Stacking two coupons is refused: the second call leaves the cart
 * total exactly as the first coupon left it, and reports STACKING.
 */
it("refuses to stack", () => { /* ... */ });
```

For each test it asks one question: **if that behaviour broke, would these
assertions fail?**

- **upheld** — yes. The test is real.
- **violated** — no. A broken implementation would still pass.
- **unverifiable** — the description is too vague to prove wrong. Fix the
  description.

```
VIOLATED coupon.test.ts
  claims: applies a percentage discount to the cart total
  why:    The test only asserts the result is defined. An implementation that
          ignores the coupon and returns the cart unchanged would pass.
```

The payoff: you can read only the descriptions and know what the suite covers.

## Proving it, not just believing it

A model saying a test is weak is an opinion. `agentic-qa mutate` makes it an
experiment: ask for an edit to the implementation that breaks the description,
apply it, run that one test, put the file back.

If the checker said the test was real, it must now fail. If it said the test was
weak, it must still pass. When reality disagrees, the checker was wrong and says
so.

It only ever edits implementation, never tests; refuses files git cannot
restore; restores on throw; and confirms the test actually ran.

## What it costs

Nothing for code that has not changed. Verdicts are cached in `.qa/`, which is
committed, and re-checked only when the code, the description, or the checker
itself changes.

Model calls run through headless `claude -p`, so they use your existing Claude
Code login with no API key. Roughly **two cents** per judged file. Checking a
50-test suite from cold costs about a dollar; day to day, almost every run is
free because almost nothing changed.

## Where it runs

Four places, all calling the same binary, so what the agent is told cannot
drift from what the gate enforces.

- **While the agent works** — a `PostToolUse` hook. Checks the file just edited
  and reports straight back to Claude, in about a quarter of a second. Always
  exits zero: it reports, it never blocks.
- **When the agent finishes a turn** — a `Stop` hook. Checks everything the turn
  changed, however it was changed, and refuses to let the agent finish while
  problems remain. This is the one that steers: the agent is still holding the
  context that produced the code, unlike in CI. It blocks once, then reports and
  gets out of the way, so it can never trap a session.
- **On commit** — a git hook. Mechanical tier only, so commits stay fast, free
  and offline. It lives in a committed `hooks/` directory, and the `prepare`
  script points `core.hooksPath` at it on every `npm install`, so a fresh clone
  is gated without anyone typing a git command.
- **In CI** — everything, including the judgment tiers. The layer nobody can skip
  with `--no-verify`.

`init` does not write a CI config, because that file is committed, is different
for every provider, and costs money on every push. Add these steps to whatever
you already use:

```yaml
- run: npx agentic-qa rules         # free, no key needed
- run: npx agentic-qa rules --llm   # needs ANTHROPIC_API_KEY
- run: npx agentic-qa contracts     # needs ANTHROPIC_API_KEY
```

The judgment steps need `ANTHROPIC_API_KEY` as a secret, because `claude -p`
rides on your local Claude Code login and CI has none. `.github/workflows/qa.yml`
in this repo is a working example, including skipping those steps when the
secret is absent so a fork's pull request still gets the free tier.

## Checking the checker

A checker that cries wolf gets switched off, and then a clean run means nothing.
So the checker is scored against corpora whose correct answers are known, and
false positives are reported separately from misses.

```
agentic-qa eval      # the contract judge
agentic-qa rules --expected expected.json    # the rules
```

Current: 5/5 contracts, 14/14 rule violations with no false positives across
seven clean controls, 19/19 judgment verdicts with nothing in either direction.

Run it after any change to a prompt, a model, or a schema.

## More

- [ROADMAP.md](ROADMAP.md) — the design decisions, what they cost to learn, and
  what is left to build.
- [CLAUDE.md](CLAUDE.md) — the invariants, for anyone (human or agent) changing
  this code.

Target stack for the repos it checks: React/Vite/TypeScript/TanStack Query,
Hono/TypeScript, Postgres, AWS/Terraform.
