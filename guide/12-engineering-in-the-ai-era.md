# Engineering in the AI Era

*When an agent types the code, the engineer's job is deciding what to build, saying it precisely, and proving the result is right.*

**Read when:** starting a piece of work, and again before calling it done.

## What actually changes

Producing code is no longer the expensive step. An agent can write a working endpoint, a migration, tests, and a UI component in minutes. What did not get cheaper: knowing what the endpoint should do, knowing whether it does that, and knowing whether it fits the system you already have.

The failure mode shifted. Human-written code fails in ways humans understand: a typo, a forgotten case, a misread spec. Agent-written code fails by being plausible. It compiles, the tests pass, the shape is right, and it quietly does the wrong thing, calls an API that does not exist, or duplicates something that already existed three directories over. The review skill that matters is spotting plausible-and-wrong.

- Volume of code is not progress. Ten thousand lines an agent wrote in an afternoon is a liability until someone has verified it.
- Speed of iteration went up, so the cost of a vague idea went down. You can afford to try three approaches. You cannot afford to not check which one is right.
- The bottleneck is now the engineer's attention: what to specify, what to review, what to run.

## The engineer's job now

Decide what to build. Decompose it into pieces an agent can do in one sitting. Specify each piece well enough that a competent stranger would build the right thing. Review what comes back. Verify it independently. Own the architecture across all of it, because the agent does not remember last week.

- Deciding what to build includes deciding what not to build. Agents will happily add the feature. The judgment about whether it belongs is yours.
- Decomposition is the design work. A task list that reads "add user model, add auth middleware, add login endpoint, add login form" is architecture expressed as sequence.
- Specification is where your experience shows up. Constraints you know from having been burned are exactly what the agent lacks.
- Review and verification are not the same. Review is reading. Verification is running.
- Ownership means you can explain every part of the system, even the parts you did not type.

## Writing specs and prompts for agents

A good spec for an agent looks like a good ticket for a strong contractor who has never seen your codebase. State the goal, the boundaries, the interfaces it must fit, how you will know it is done, and what it must not do.

- Goal: one or two sentences on what and why. The why lets the agent make reasonable calls you did not anticipate.
- Constraints: which layer this lives in, which existing modules to use, which patterns to follow, what is off limits (no new dependencies, do not touch the auth module, keep the migration reversible).
- Interfaces: the function signature, the API shape, the table schema, the event payload. Pin these down and the agent fills in the middle.
- Acceptance criteria: concrete, checkable. "Returns 404 for unknown IDs" and "existing tests pass" beat "handles errors properly".
- Examples: one input and its expected output does more than a paragraph of description. Edge cases as examples are the most efficient way to communicate them.
- What not to do: agents over-help. Say explicitly: do not refactor unrelated code, do not add a fallback that hides errors, do not write a mock that returns success.
- Point at existing code to imitate. "Follow the pattern in `orders/service.py`" transfers convention without describing it.

Specs drift toward the code once the code exists. Keep them short enough that updating them is not a chore, or accept that the spec was a one-time input and the tests are the durable record.

## Agent instruction files

CLAUDE.md, AGENTS.md, and their equivalents are the standing context an agent gets every session. They are the highest-leverage document in the repository now, and the one most likely to rot.

They should hold what the agent cannot infer from reading the code: how to run things, what the layers are, what the non-negotiable rules are, and why certain odd decisions were made.

- Commands: how to run tests, lint, type check, start the app, run a migration. Exact commands, not descriptions.
- Architecture map: the layers, what lives where, the direction dependencies are allowed to flow. A dozen lines.
- Invariants: rules that must hold everywhere. All money in integer cents. Every endpoint checks tenant ownership. No raw SQL outside the repository layer. Tests must not hit the network.
- Conventions the code does not make obvious: naming, error handling style, where feature flags go.
- Decisions and their reasons, when the reason is not visible from the code.
- Keep it short. Past a few hundred lines, instructions get skipped. Link to deeper docs rather than inlining them.
- Have one source of truth. If you have both CLAUDE.md and AGENTS.md, one should point at the other.
- Review it like code. When an agent repeatedly gets something wrong, the fix is usually a line in this file. When a rule stops being true, delete it.
- Agent-generated instruction files describing current behavior are low value. Human-written rules that change decisions are high value.

## Keeping architecture coherent when you did not type it

Each agent session starts fresh and optimizes locally. Left alone, a codebase built by many sessions converges on the average of every pattern ever used in it, plus a few new ones. Coherence has to be enforced from outside the agent.

- Name the layers and write them down. If the architecture only exists in your head, it does not exist for the agent.
- Enforce boundaries mechanically: import rules in the linter, architecture tests that fail when the wrong layer imports the wrong module, dependency-cruiser or equivalent. A rule the tooling enforces is a rule the agent follows.
- Review for drift, not just correctness. A new helper that duplicates an existing one, a second way of doing validation, a new pattern for errors. Each one is small. Together they are the reason the codebase becomes unmaintainable.
- Periodically ask an agent to audit for duplication and inconsistency. It is good at finding what it created.
- Consolidate on a cadence. Every few features, spend a session merging near-duplicates and removing dead paths.
- Keep the module structure shallow and obvious. Agents (and humans) place new code where the existing structure suggests. Deep, clever structures invite misplacement.

## Reviewing AI code

Agent output has a characteristic set of problems. Know them and you can review fast. The list below is where to look first.

- Error handling: catch blocks that swallow exceptions, log and continue, or return a default that looks like success. An empty catch is a bug until proven otherwise.
- Fake fallbacks: "if the API fails, return an empty list" turns an outage into silently missing data. Fallbacks should be a product decision, not an agent's guess.
- Auth and authorization: a new endpoint that does not check the session, or checks that a user is logged in but not that they own the resource. Agents reliably forget the second half.
- Input validation: trusting request bodies, query params, and headers. Look for anything user-supplied that reaches a query, a filesystem path, or a shell.
- N+1 and chatty patterns: queries or HTTP calls inside loops.
- Tests that assert nothing: tests that call the function and check it did not throw, tests that assert on the mock they just set up, tests that were adjusted to match the broken output. Read the assertions, not the test names.
- Hardcoded values: URLs, credentials, magic numbers, environment-specific paths, "TODO replace with real key".
- Invented APIs: methods that do not exist on the library, parameters the function does not accept, packages that are not on the registry. Type checkers catch some. Installing catches the rest.
- Dependency bloat: a new package for something the standard library or an existing dependency already does.
- Over-abstraction: a factory, a base class, a config system, and an interface for something with one implementation. Agents generalize because it looks thorough.
- Scope creep: files changed that the task did not mention. Every unrequested change needs a reason.
- Comments that describe the obvious, docstrings that restate the signature, and files of boilerplate that nobody asked for.

Read the diff in two passes. First for shape: what files changed, does the structure make sense, is it in the right layer. Then for risk: error paths, auth, data writes, anything touching money, deletion, or external systems.

## Verification over trust

The agent saying the tests pass is not the tests passing. The agent saying it checked the docs is not the API existing. Every claim an agent makes about its own work should be treated as a hypothesis until something outside the agent confirms it.

- Run it. Tests, type check, linter, build. On your machine or in CI, not in the agent's summary.
- Make the agent prove it. Ask for the command output, the failing test before the fix, the curl against the running server. Agents that must show evidence produce better work than agents that describe it.
- Type systems, linters, and architecture tests are cheap, automatic, and merciless. Invest in them. They review every line for free.
- Independence helps. A second agent with no shared context reviewing the first agent's work catches more than the first agent reviewing itself.
- For anything involving data migration, money, or deletion, verify by hand against a real copy of the data.
- Watch for the confident summary that does not match the diff. It happens.

## Test-first with agents

Writing the test before the implementation is more valuable with an agent than it was with a human, because the test is the spec in executable form and the agent cannot argue with it.

- Write or dictate the tests first, review them for meaning, then have the agent make them pass. This prevents the pattern where the agent writes tests that match whatever the code happens to do.
- Tell the agent explicitly not to modify the tests. When it wants to, that is a conversation about the spec, not a change to make silently.
- Test at the boundary that matters: the API response, the database state, the rendered output. Unit tests on internal helpers are cheap to generate and cheap to fake.
- Tests are the durable record of intent after the prompt is gone. Keep them readable.
- Failing tests should be shown failing first. "Red, then green" catches tests that pass for the wrong reason.

## Small scoped tasks versus big bang

An agent given "build the billing system" produces a large, plausible, subtly inconsistent pile. An agent given "add the invoice table and repository, following the customer repository pattern" produces something reviewable in ten minutes.

- Scope each task to something you can fully review in one sitting. If you cannot hold the diff in your head, it is too big.
- Sequence tasks so each builds on a verified base. Schema, then data access, then service logic, then API, then UI.
- Large tasks are fine for throwaway exploration. They are not fine for anything that ships.
- Commit after each verified step. Rolling back a small step is trivial. Untangling a big one is a day.

## Explore first or plan first

Some tasks benefit from letting the agent read the codebase, try things, and report back. Others need a plan agreed before any code is written.

- Explore when: you do not know the codebase well, the problem is a bug with an unclear cause, you are evaluating whether an approach is feasible, or the change is contained and cheap to discard.
- Plan first when: the change spans multiple modules, touches schema or public interfaces, involves a design choice with lasting consequences, or you have a specific pattern in mind.
- A good planning step ends with a written list of files to change and what changes in each. Review that list before code exists. It is the cheapest review you will do.
- Discard exploration freely. Code from an exploration session that "mostly works" is the most dangerous code to keep.

## Reading code fast

You will read far more code than you write. The skill is triage, not close reading of everything.

- Skim for structure first: file list, function names, imports, the shape of the data flow. Ten seconds per file.
- Then find the risk: where does data enter, where is it written, where does it leave. Read those paths line by line.
- Then the boring middle, quickly. Most bugs in agent code are in error paths and boundaries, not in the main logic.
- Diff tools that show moved code separately from changed code save a lot of time.
- If a diff is too large to read this way, it is too large. Split it.

## Knowing enough to know when it is wrong

You do not need to be able to write every line the agent writes. You need to be able to recognize when a line is wrong. That requires a working model of how the pieces fit: what a database transaction actually guarantees, what happens on a retry, where a cookie goes, why a query is slow.

- The fundamentals in this site are the recognition layer. They tell you what "wrong" looks like.
- When you cannot tell if something is right, that is the signal to go and understand it before merging, not after.
- Ask the agent to explain its reasoning for anything non-obvious. A wrong explanation is easier to spot than wrong code.
- The engineers who struggle with agents are the ones who accept output they cannot evaluate. The fix is not typing more. It is learning the thing well enough to judge.

## Domain knowledge and product sense

Agents know software in general. They do not know your customers, your regulatory constraints, the reason the billing cycle runs on the 3rd, or which feature the sales team promised last week. That knowledge is what turns a correct implementation into the right one.

- The most valuable specs encode domain rules: what an invoice can and cannot do, what states an order moves through, who is allowed to see what.
- Product sense is deciding that the feature should be simpler than asked for, or should not exist. Agents do not push back on scope.
- Knowing the users lets you judge whether an edge case matters. The agent will treat every edge case as equally important or ignore them all.

## Security implications

Agents change the security picture in a few specific ways.

- Secrets in prompts and context: an agent that reads your `.env` to "understand the config" has that content in its context and possibly in logs. Keep secrets out of files an agent will read, and out of chat.
- Broad permissions: an agent with shell access and your credentials can delete a database, push to main, or run a package install. Scope permissions per task. Prefer allowlists over "auto-approve everything" for anything touching production.
- Hallucinated packages: agents invent plausible package names. Attackers register those names with malware. Verify every new dependency exists, is the one you think it is, and has a history. Pin with a lockfile.
- Generated auth and crypto: agents produce code that looks like security. Have those paths reviewed by someone who knows the difference, and prefer well-known libraries over generated implementations.
- Prompt injection through data: an agent that reads issues, web pages, or user content can be steered by that content. Treat anything an agent reads from outside as untrusted input.
- Agents make it easy to add logging. Check that the logging does not include tokens, passwords, or personal data.

## Tech debt velocity

Agents produce mediocre code faster than teams can absorb it. Every session leaves a little extra: a helper nobody uses, a second config format, an abstraction for one case. The debt does not announce itself. It accumulates until a simple change takes a week.

- Delete aggressively. Unused code, redundant tests, speculative abstractions. Agents can find them for you. You have to decide to remove them.
- Prefer fewer, better-understood modules over many generated ones.
- Treat "it works" as the beginning of review, not the end.
- Budget consolidation time. It will not happen on its own and the agent will not suggest it.
- Watch dependency count and total lines of code as metrics. Both should grow slower than features.

## Documentation and ADRs matter more

When nobody typed the code, the reasoning behind it lives nowhere unless you write it down. Architecture decision records, a short one for each significant choice, are how future sessions (agent or human) avoid relitigating settled questions.

- An ADR is a page: context, decision, consequences. Fifteen minutes to write.
- Link ADRs from the instruction file so agents read them.
- README-level docs for each major module: what it is for, what it must not do, how to run its tests.
- Docs that describe what the code does are low value and go stale. Docs that describe why, and what the constraints are, hold their value.
- Prompts and specs are disposable. Tests and ADRs are the record.

## Cost and tokens at a glance

Agent work has a running cost, and the cost scales with context size and iteration count. Awareness prevents both waste and false economy.

- Large contexts (whole-repo dumps, huge files, long conversations) cost more and degrade output quality. Point the agent at what matters.
- A long back-and-forth fixing a bad first attempt costs more than a good spec would have.
- Cheaper models for mechanical tasks (renames, formatting, boilerplate), stronger models for design and review.
- The expensive resource is still your review time. Spending tokens to get a cleaner diff is usually a good trade.

## Skills that still compound

- The fundamentals in this site: HTTP, databases, auth, data modeling, what happens on a retry. These are what let you evaluate output.
- Debugging: forming hypotheses, isolating variables, reading logs and traces. Agents help, but the judgment about where to look is yours.
- Systems thinking: how a change here affects behavior there, what the failure modes are, what breaks under load.
- Decomposition: turning a fuzzy goal into an ordered list of concrete, verifiable pieces. This is the skill most directly rewarded by agent workflows.
- Communication: writing clearly is now literally how the code gets written. Precision in specs, tickets, ADRs, and reviews.
- Naming: agents copy the names they see. Good names propagate. So do bad ones.
- Reading code: fast, structural, risk-first.
- Taste: knowing when something is too clever, too general, or too big.

## What to stop spending time on

- Syntax trivia and language-specific idioms. Look them up, or let the agent handle them.
- Memorizing framework APIs and boilerplate. It changes yearly and the agent knows the current version.
- Framework churn: tracking every new library. Learn the underlying pattern once and recognize it in whatever wrapper is current.
- Hand-writing scaffolding, config, and test fixtures.
- Perfecting code you are about to throw away.
- Debating tooling. Pick something reasonable, write it in the instruction file, and move on.

## Key takeaways

- Producing code is cheap. Deciding, specifying, and verifying are the job.
- Agent code fails by being plausible. Review for plausible-and-wrong.
- Decomposition is the design work. Scope tasks to one reviewable sitting.
- Specs pin goal, constraints, interfaces, acceptance criteria, examples, and what not to do.
- Instruction files hold commands, layers, invariants, and reasons. Keep them short.
- Enforce architecture mechanically and review for drift, not just correctness.
- Watch for swallowed errors, fake fallbacks, missing ownership checks, invented APIs.
- Tests that assert nothing are common. Read the assertions, not the names.
- Treat every agent claim as a hypothesis. Run it yourself.
- Write tests first, show them failing, and forbid the agent from editing them.
- Plan first for cross-module or schema changes. Discard exploration code freely.
- Verify every new dependency exists. Hallucinated package names get squatted with malware.
- Delete aggressively and budget consolidation time. Debt accumulates silently.
- Prompts are disposable. Tests and ADRs are the durable record.
