# agentic-qa

Checks that AI-written code follows your rules, and that your tests actually
test what they say they do.

Agent code fails differently from human code. Human mistakes look like mistakes.
Agent mistakes look correct: it compiles, the shape is right, the tests pass, and
it quietly does the wrong thing. Reading all of it carefully does not scale.

What "right" means is written down in a guide to building software, which ships
in `guide/`. The agent is pointed at it before it writes, the parts a tool can
check are checked as it works, and your tests are checked against what they say.

## How it fits together

What agentic-qa is when finished. Most of it is built; the rest is marked.

1. **The guide** says how software should be built, one chapter per area. It
   ships in the package, so updating the dependency updates it.
2. **Setup** is `init`, which adds only the call sites you ask for and never
   overwrites your files.
3. **Session start:** the agent gets an index of the guide and reads the
   chapters its work touches, before it writes anything.
4. **End of every turn:** the free checks (scanners and pattern rules, the parts
   of the guide a tool can check) run on what changed. A broken rule blocks the
   agent once, with what to fix; if it still stands, you are told. No model
   calls.
5. **Commit:** the same free checks on staged files. Optionally, the gauntlet
   too.
6. **Ready for a PR:** the agent runs `agentic-qa review`. A fresh Opus session
   that did not write the code judges the whole change against the guide
   chapters it touches, and judges every changed test's contract (below). The
   findings go back to the agent, which fixes them or says where it disagrees.
   *Not built yet.*
7. **Test contracts:** every test's description is a claim about what it
   proves. Each is judged **upheld** (a broken implementation would fail it),
   **violated** (it would still pass) or **unverifiable** (too vague to prove
   wrong). Verdicts are committed in `.qa/contracts.json`, so reading the
   descriptions tells you what the suite really covers. Built as a per-test
   judge today (`agentic-qa contracts`); step 6 takes over the judging.
8. **Proof:** `agentic-qa mutate` tests a verdict for real by breaking the code
   the way the description says and running the test. When it disagrees with
   the judge, the judge was wrong.
9. **CI:** every pull request gets the free checks and the review, so nothing
   merges unreviewed even if nobody ran it locally. *The review part is not
   built yet; CI runs today's per-rule judgment and contracts instead.*
10. **Exceptions:** a `qa-ignore` comment with a reason, which counts only once
    a person commits it. An agent cannot excuse itself.
11. **The gauntlet:** thousands of community scanner rules, never shown
    automatically. You triage them with an agent on demand, and the good ones
    become free checks.
12. **The checker is checked:** each check is scored against examples with
    known answers, false positives weighed heaviest, and re-scored when a prompt
    or model changes. *Scoring for the review is not built yet.*

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
| `--claude-hook` | `SessionStart` and `Stop` hooks in `.claude/settings.json` |

Already set up by an older version? `init --force` replaces the hook wiring so
you pick up call sites added or removed since — including the per-edit hook,
which no longer exists. It never replaces `qa.config.yaml` or a
`prepare` script you wrote — those are yours. Without `--force`, anything that
already exists is left alone and reported, so you can see what you are missing.

Bare `init` leaves your git config and your agent settings alone and tells you
what it did not install. Either way it never overwrites a file that exists.

If you took the git hook, commit `hooks/pre-commit`. That is what makes the gate
reach everyone who clones the repo, instead of only the person who ran `init`.

## Commands

Run with `npx agentic-qa <command>`. Every check exits non-zero on a problem,
except `gauntlet`, which never blocks.

**Setup**

| command | what it does |
| --- | --- |
| `init` | Writes `qa.config.yaml`. Adds call sites only when asked: `--git-hook`, `--claude-hook`. `--force` replaces hook wiring it wrote before; `--runner <cmd>` changes how hooks invoke the tool. |
| `setup` | Downloads the pinned scanners and rules now instead of on first use. For CI and new machines. |
| `install-hooks` | Points git at the tracked `hooks/` directory. Run by the `prepare` script on `npm install`; you do not run it. |

**Call sites.** Hooks and CI run these for you; run one by hand to see what it would do.

| command | runs from | what it does |
| --- | --- | --- |
| `session-start` | Claude Code, session start | Prints the guide index the agent starts with. |
| `stop` | Claude Code, end of each turn | Free checks on what the turn changed. Blocks the agent once on a broken rule. |
| `commit` | git pre-commit hook | Free checks on staged files. Refuses the commit on an error. |
| `ci` | your CI | Free checks on the whole repo, plus judgment rules and test contracts when a key is available. |

**Checks you run**

| command | what it does | costs money |
| --- | --- | --- |
| `rules` | Checks code against the corpus rules. `--staged` for staged files only, `--json` for machine output. | no |
| `rules --llm` | Adds the rules that need a model's judgment. `--all` ignores cached verdicts. | yes |
| `gauntlet [paths]` | Every scanner rule the corpus does not claim, grouped by rule. Never blocks. `--json` lists all. | no |
| `contracts` | Judges whether each test asserts what its description claims. `--staged`, `--file <path>`, `--all`, `--json`. | yes |
| `mutate` | Breaks the implementation the way each description says and checks the test fails. `--staged`, `--all`. | yes |
| `eval` | Judges, then scores the contract judge against a known-answer file (`--expected`). For working on this tool. | yes |

Commands that call a model take `--model` and `--concurrency`. Nothing re-judges
code, descriptions or prompts that have not changed since the last run.

## Before the agent writes anything

With `--claude-hook`, every Claude Code session starts with an index of the
guide: one line per chapter saying what kind of work it applies to, and where to
read it. The agent reads a chapter when its work enters that area — asked to
prepare for a login endpoint, it reads the auth, web, backend and testing
chapters — so it pays only for what its work touches, however large the guide
grows. The index is built from the chapters at the start of each session, so an
edited guide needs no other step. See it with `npx agentic-qa session-start`.

The guide is twelve chapters, about 34,000 words: web fundamentals, backend
architecture, data, frontend, auth and security, testing, repo hygiene,
delivery, observability, performance, infrastructure, and working with agents.

## Two things it checks

### 1. Rules

Rules are the parts of the guide a tool can check. They live in `rules/*.yaml`
and ship inside the package, so updating the dependency updates them. Today they
are a small set that proves the machinery; most of the guide is not yet a rule.

Every rule must say how it is enforced:

| tier | enforced by | cost |
| --- | --- | --- |
| `mechanical` | a real scanner, or a hand-written pattern where no scanner does it well | free |
| `llm` | a model reads the file and judges | about a cent, opt-in |
| `human` | should this exist at all | no tool answers this |

A scanner beats a model at what a scanner can see. The `llm` tier is for what one
cannot: does this handler check the caller *owns* the record, does this catch
block hide a failure.

**The scanners.** All run from configs that ship with this package, so every repo
gets the same checks.

| scanner | looks for |
| --- | --- |
| eslint (typescript-eslint, sonarjs, vitest plugin) | bugs, code smells, test mistakes |
| dependency-cruiser | imports that break layering, circular dependencies |
| gitleaks | secrets and credentials |
| opengrep, running the semgrep community rules | security holes (injection, SSRF, redirects, XSS) and risky Terraform, Dockerfiles and GitHub Actions |

**Two kinds of result.**

- **The corpus** is the rules in this package's `rules/*.yaml`. A corpus rule
  either runs its own pattern or names the scanner rule that enforces it. Its
  errors block, and it is all that the end of a turn, a commit and CI report.
- **The gauntlet** is everything else the scanners report — thousands of
  community rules nobody has vetted for your code — labelled `<scanner>:<rule>`.
  Nothing automatic shows it. You run it.

If a corpus rule names a scanner rule that has been switched off, the check
refuses to run rather than report clean code it never checked. Findings about
secrets never repeat the secret.

```
ERROR api/handlers.ts:4
  Import the database client only inside the repository layer. [be.layer.no-db-client-outside-repository]
  import { sql } from "drizzle-orm";
```

### The gauntlet

```
agentic-qa gauntlet            # the whole repo
agentic-qa gauntlet src/api    # or some paths
```

Every scanner, every rule, grouped by rule with the noisiest first. It never
blocks. Work through it with an agent — "run the gauntlet, fix what is real,
say which rules are wrong for this code" — and add a `qa-ignore` with a reason
for anything that should stay.

Once a repo is clean against it, consider keeping it that way by having commits
enforce it too. Any gauntlet finding then blocks the commit:

```yaml
callSites:
  commit:
    gauntlet: true
```

The end of a turn never shows the gauntlet: shown to an agent, unvetted rules
taught it to skip the checker's output altogether.

### Exceptions

Turn one rule off, in one place, with a reason. The same comment works for a
corpus rule or a gauntlet rule, using the id in brackets:

```ts
localStorage.setItem("authToken", token); // qa-ignore: fe.storage.no-token-in-local-storage - demo build only
```

That hatch matters: without it, the first false positive gets the whole checker
disabled instead of the one rule.

An exception takes effect once it is **committed**. The Stop hook ignores a
`qa-ignore` added or changed since the last commit, so the finding still stands,
and if the agent has not fixed it by the time the turn ends, Stop shows you the
exceptions it refused. That stops a blocked agent from writing its own way out. Commit and CI honour every exception
they see. Because an agent with an unrestricted shell can commit too, set Claude
Code to ask before `git commit`. `init` does not add this for you; put it in your
own settings, for one repo or for all of them:

```json
{ "permissions": { "ask": ["Bash(git commit:*)"] } }
```

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
Code login with no API key. The scanners, the end-of-turn check and the commit
hook never call a model. Judgment rules cost one to three cents per rule per
file and take ten to fifty seconds each; a test contract is about a cent. Day to
day, almost every run is free because almost nothing changed. These are
per-call judgments being replaced by one review of a whole change; see the
[roadmap](ROADMAP.md).

## What it downloads

Two scanners are standalone programs that npm cannot install, and the semgrep
community rules cannot be bundled in this package (their license forbids
redistributing them). So the first time a check needs them, it downloads them:

- opengrep and gitleaks, each a single program at a pinned version, checked
  against a pinned SHA-256 before it is ever run
- the semgrep community rules, pinned to one commit

They go in `~/.cache/agentic-qa/` and are reused after that, offline. A new
machine or CI runner sets itself up the first time it runs a check; nothing needs
installing by hand. To download ahead of time instead:

```
npx agentic-qa setup
```

Updating any of them means changing its pin in `src/tools/provision.ts`, so an
update is a reviewed change, never a surprise.

If a download is impossible (offline on a first run), that scanner is skipped
with a warning naming the rules it left unchecked. In CI it fails the run
instead.

## Where it runs

Three call sites, each its own command, all in the same binary, so what the agent
is told cannot drift from what the gate enforces. What each one runs by default:

| call site | command | scanners | judgment rules | test contracts | gauntlet |
| --- | --- | --- | --- | --- | --- |
| end of each turn | `agentic-qa stop` | eslint, dependency-cruiser, gitleaks, opengrep | no | no | no |
| on commit | `agentic-qa commit` | eslint, dependency-cruiser, gitleaks | no | no | no |
| CI | `agentic-qa ci` | eslint, dependency-cruiser, gitleaks, opengrep | yes | yes | no |

- **End of each turn** checks everything the turn changed, and is the one that
  steers. If a rule is broken, the agent is not allowed to finish and is told
  why while it still has the context that produced the code. It blocks once,
  then tells you and lets the turn end, so it can never trap a session. You
  hear from it only then, or if a check could not run; a clean turn is silent.
  It runs only the free rules, and only the scanners that enforce one on the
  changed files. The rules that need a model's judgment, and test contracts,
  take minutes on a feature's worth of changes, so they run when you ask and in
  CI: `agentic-qa rules --llm` and `agentic-qa contracts`.
- **On commit** checks staged files and refuses the commit on an error. It
  lives in a committed `hooks/` directory, and the `prepare` script points git
  at it on every `npm install`, so a fresh clone is gated without anyone typing
  a git command. It skips opengrep so every commit stays quick; opengrep's rules
  still block at the end of a turn and in CI.
- **CI** checks the whole repo and is the layer nobody can skip with
  `--no-verify`.

### Changing what runs

Override any cell under `callSites` in `qa.config.yaml`:

```yaml
callSites:
  commit:
    scanners: all          # fast (the default here) or all
  stop:
    skip: [opengrep]       # leave a scanner out by name
  ci:
    contracts: false       # judgment rules and test contracts switch separately
```

`scanners: fast` means every scanner not marked slow, so a slow scanner added in
a later version stays out of the quick call sites without any config change.
Skipping a scanner leaves the rules it enforces to the other call sites.

Some cells cannot be changed. The commit hook never runs the judgment rules or
test contracts, because a commit must never cost money or wait on a model. The
end of a turn never runs them either, because they do not fit in one, and never
shows the gauntlet. A misspelled call site, setting or scanner name is an error, not ignored.

### CI

`init` does not write a CI config, because that file is committed, is different
for every provider, and costs money on every push. Add these steps to whatever
you already use:

```yaml
- run: npx agentic-qa setup    # download the pinned scanners and rules
- run: npx agentic-qa ci       # everything; exits non-zero on a problem
```

Cache `~/.cache/agentic-qa` between runs so the download happens once. The
judgment rules and test contracts need `ANTHROPIC_API_KEY` as a secret, because
`claude -p` rides on your local Claude Code login and CI has none. Without the
key, `ci` skips them with a warning and still runs the scanners, so a fork's pull
request gets the free tier.

This repository's own `.github/workflows/qa.yml` shows the caching, but it is not
a template for yours: it builds agentic-qa from source and runs `node
dist/cli.js`, where your repo runs `npx agentic-qa`. A tested GitHub Actions
example for a consuming repo is on the [roadmap](ROADMAP.md).

## Checking the checker

A checker that cries wolf gets switched off, and then a clean run means nothing.
So the checker is scored against corpora whose correct answers are known, and
false positives are reported separately from misses.

In this repository:

```
npm run eval:rules        # scanner and pattern rules (free, runs in CI)
npm run eval:rules-llm    # rules judged by a model
npm run eval:contracts    # the contract judge
```

Current: 20/20 rule violations with no false positives across eight clean
controls. The paid evals last scored 5/5 contracts and 19/19 judgment verdicts.

Run it after any change to a prompt, a model, or a schema.

## More

- [ROADMAP.md](ROADMAP.md) — the design decisions, what they cost to learn, and
  what is left to build.
- [CLAUDE.md](CLAUDE.md) — the invariants, for anyone (human or agent) changing
  this code.

Target stack for the repos it checks: React/Vite/TypeScript/TanStack Query,
Hono/TypeScript, Postgres, AWS/Terraform.
