# Testing

*What tests are for, which kinds pay their way, and how to tell good tests from tests that only look like tests.*

**Read when:** writing or changing tests, or deciding what a change needs tested.

## Why we test

Tests exist so you can change code without fear. That is the whole job. A test suite that does not give you confidence to refactor, upgrade a dependency, or ship on a Friday is a cost with no return. Every other property (documentation, design pressure, regression catching) follows from that one.

This framing settles most arguments. A test is good if it fails when behavior breaks and passes when behavior is preserved, regardless of how the code is structured internally. A test that fails when you rename a private method is worse than no test, because it makes changing the code harder without making it safer.

## Unit, integration, end-to-end

Three levels, distinguished by how much real system is involved.

- **Unit.** One function or class in isolation, dependencies replaced with doubles. Fast, precise, cheap. Good for pure logic: pricing rules, parsers, validators, date math, state machines. Weak at catching the bugs that actually happen, which are mostly at the seams between pieces.
- **Integration.** Several real pieces together: an API endpoint through to a real database, a component rendered with its real children and a faked network. Slower than unit, still seconds. Catches wiring bugs, contract mismatches, and query errors. The best ratio of bugs found to maintenance cost for most application code.
- **End-to-end.** The deployed (or fully running) system driven through the UI like a user. Catches the things nothing else can: the button that no longer submits, the redirect loop, the CSP that blocked the script. Slow, flaky, expensive to maintain. Keep a small number of critical-path journeys.

### Pyramid vs trophy, settled

The pyramid (many unit, fewer integration, few e2e) came from an era when integration tests were slow and painful. The trophy (a base of static analysis, some unit, *most* integration, few e2e) reflects that they are now cheap: Docker gives you a real database in seconds, and component testing tools render real components fast.

For a typical full-stack web app, the trophy is right. Put most of your effort at the boundaries you actually own: HTTP endpoint to database on the backend, rendered component with user interactions on the frontend. Unit test the pure logic underneath when it is genuinely complex. Keep e2e to the handful of flows whose failure means the product is down (sign up, log in, core action, pay).

The pyramid still applies to a library or a domain-heavy core with little I/O. Choose per package, not per company.

## What to mock and what not to

Mock at the edge of your system, not inside it. The edge is the network, the clock, randomness, the filesystem, third-party APIs. Your own modules are not the edge.

When you mock your own service in a controller test and your own repository in a service test, you end up with a suite that passes while the real app is broken, because every test verified its neighbor's imagined behavior rather than its actual behavior. This is the single most common way suites become worthless.

- Mock: outbound HTTP to third parties, payment providers, email senders, time, random ids, anything slow or non-deterministic or with side effects you cannot undo.
- Do not mock: your database (use a real one), your own service and repository layers, your framework, the component under the one you are testing.
- If something is hard to test without mocking it, that is a design signal. Move the I/O to the edge and make the middle pure.

### Test doubles vocabulary

- **Stub.** Returns canned answers. No assertions on how it was called.
- **Mock.** Records calls and lets you assert on them ("was `sendEmail` called once with this address").
- **Fake.** A working, simplified implementation (in-memory repository, fake clock). Behaves like the real thing for test purposes.
- **Spy.** Wraps the real thing and records calls.
- **Dummy.** Passed to satisfy a signature, never used.

Fakes are underrated. An in-memory repository that honors the same interface gives you fast service tests with real behavior. Mocks with call-count assertions are the ones that couple tests to implementation.

**When reviewing AI-written code:**
- A test file where every import is mocked. Nothing real is under test.
- `expect(mockFn).toHaveBeenCalledWith(...)` as the only assertion. It verifies the code was written the way it was written.
- Mocking the module under test's own helpers.

## Structure and naming

Arrange, act, assert. Set up the state, do the one thing, check the result. One behavior per test. If you need "and" in the name, split it.

Name tests by behavior, not by method: `rejects an expired coupon` beats `test applyCoupon 3`. The failing test's name should tell you what broke without reading the body. Describe blocks group by scenario or by unit under test.

- Make the arrange step readable. Long setup hides what matters, so push it into builders (below).
- Assert on outcomes: return value, database state, rendered text, emitted event. Not on internal calls.
- Avoid logic in tests. No loops, no conditionals. A test with an `if` has two tests inside it and neither is guaranteed to run.

## Testing the layered API

Controller, service, repository. Where to test each.

- **Repository.** Against a real database in Docker (Testcontainers or a compose file). SQL is the thing to test and only the database can tell you whether the query is right. Migrations run first, so the schema is also tested.
- **Service.** Two good options. Fast path: real service with a fake (in-memory) repository, testing business rules without I/O. Thorough path: real service with the real repository against the real database. Most teams do the second for the majority and reserve the fake for combinatorial logic that needs hundreds of cases.
- **Controller / endpoint.** Spin up the app in-process, hit it over HTTP (or the framework's test client), assert on status, body, and database state. Real service, real repository, real database, faked outbound network. This is the highest-value test in the suite. One per endpoint per meaningful case (success, validation failure, unauthorized, not found).

Do not test controllers by mocking the service. You would be testing that the framework parses JSON.

### Contract tests

When frontend and backend, or two services, are built separately, each side tests against a recorded contract (schema, example requests and responses) rather than the live other side. Consumer-driven contract tools (Pact and similar) or a shared OpenAPI schema validated on both ends. The point is catching "you renamed the field" before deploy, without a full environment.

## Snapshot tests

A snapshot stores an output (rendered markup, serialized object) and fails on any change. Cheap to write, and mostly cheap in the wrong way: the failure tells you something changed, not whether it should have, and the fix everyone applies is "update snapshots." Large snapshots are noise nobody reads.

Use them for small, stable outputs where any change is meaningful: a generated config file, an error message format, a serialized event. Not for whole component trees.

## Test data: builders, factories, fixtures

Tests need realistic data and should say only what matters. A builder or factory produces a valid default object with overrides for the fields the test cares about: `buildOrder({ status: 'shipped' })`. The reader sees that status matters and nothing else does.

- Defaults should be valid and boring. Tests override the interesting part.
- Unique values (emails, slugs) from a sequence, so tests do not collide.
- Keep factories next to the domain code they build, not in a giant shared fixtures file that every test imports.

### Database reset strategies

Tests that hit a real database need isolation. Options, from fastest to slowest:

- **Transaction rollback.** Each test runs inside a transaction that is rolled back at the end. Fast and clean. Breaks when the code under test commits, or uses multiple connections.
- **Truncate between tests.** Wipe tables after each test. Simple, a bit slower, works with everything.
- **Fresh database per test file or per worker.** Template database cloned per worker for parallel runs. Best isolation, more setup.
- **Shared database, unique data per test.** Every test creates its own tenant or user and only touches its own rows. Works with parallelism, requires discipline.

Pick one and enforce it in a shared test harness. Tests that leak state into each other are the root of most "passes alone, fails in the suite" bugs.

## Flaky tests

A flaky test passes and fails without a code change. Each one erodes trust in the whole suite, because people start re-running instead of reading. Quarantine and fix or delete within days. The causes are a short list.

- **Time.** Real clock in tests: midnight rollovers, daylight saving, "expires in 1 second" races. Fix: inject a fake clock.
- **Order and shared state.** Test B depends on what test A left behind. Fix: reset strategy above, and run in random order to surface it.
- **Async races.** Asserting before the thing finished. Fix: await the actual condition (element appears, promise resolves), never `sleep(500)`.
- **Network.** Real calls to third parties. Fix: fake at the edge.
- **Concurrency and resource limits.** Port collisions, shared temp files, parallel workers on one database. Fix: per-worker resources.
- **Nondeterminism in the code.** Random ids, unordered maps, `Date.now()` in output. Fix: inject, or assert on shape not value.

## Coverage

Coverage measures which lines executed during tests. It tells you what is definitely untested. It does not tell you what is tested well: a test with no assertions gets 100% coverage of what it touches.

Use it as a signal for gaps (a whole module at 0% is worth a look). Do not set it as a target. Targets produce tests written to hit lines, which are the tests that assert nothing. A modest ratchet in CI ("do not decrease") is fine.

## TDD

Write the failing test, make it pass, refactor. It helps most when you know what the behavior should be but not what the code should look like: a parser, a pricing rule, a bug reproduction. It helps less when you are exploring an unfamiliar API or building UI, where you do not yet know what to assert. Use it when it helps and do not moralize about it.

For bugs, TDD is nearly always right: reproduce with a failing test first, or you cannot prove the fix.

## Property-based testing at a glance

Instead of hand-picked examples, you state a property ("decoding what you encoded gives the original," "sorting is idempotent," "total never negative") and the tool generates hundreds of random inputs, shrinking any failure to a minimal case. Excellent for parsers, serializers, numeric logic, and anything with invariants. Not a replacement for example tests, a supplement where the input space is large.

## End-to-end tooling

Browser automation (Playwright, Cypress, and their kind) drives a real browser against a running app. Modern tools auto-wait for elements, record traces and video on failure, and run in CI containers.

- Select by role and accessible name, not by CSS class or test id where you can. It doubles as an accessibility check and survives restyling.
- Seed state through an API or database, not by clicking through the UI. Log in via a stored session, not the login form, in every test except the one that tests login.
- Keep them few. Each one costs seconds to minutes and has more moving parts than anything else in the suite.

## Load and performance tests at a glance

Load tools (k6, Locust, Gatling, and similar) hit an endpoint with concurrency and report latency percentiles and error rates. Run against a production-like environment before a launch or after a change to a hot path, not in every CI run. Care about p95 and p99, not the mean. Set a budget and fail the run if it is exceeded. Frontend performance budgets (bundle size, Lighthouse score) can run in CI cheaply.

## Testing in CI

Every push runs the suite. The suite must be green on main at all times, and the fix for a red main is revert first, investigate second.

- Fast feedback first: lint, typecheck, unit, then integration, then e2e. Fail fast.
- Run integration tests against real services in containers, the same versions as production.
- Parallelize by test file across workers. Keep total wall time under ten minutes or people stop waiting for it.
- Retries hide flakiness. If you allow one retry, track which tests needed it and fix them.
- Keep the test environment reproducible: pinned images, seeded data, no network access to real third parties.

## Mutation testing at a glance

A mutation tool changes your code (flips a `<` to `<=`, deletes a line, returns a constant) and reruns the tests. If the suite still passes, the mutant survived and that code is not really tested. It is slow and best run occasionally on the modules that matter most. It is the honest answer to "is our coverage real."

## Reviewing AI-written tests

AI generates tests quickly and they look plausible. The failure modes are consistent and easy to check once you know them.

- **Tests that assert nothing.** The test runs the code and checks that it "did not throw," or asserts `toBeDefined()` on a result. Ask: what behavior would have to break for this test to fail? If the answer is "none," delete it.
- **Tests that mirror the implementation.** The test reads the code, mocks every collaborator, and asserts the collaborators were called in the order the code calls them. Passes today, fails on any refactor, catches no bugs. Replace with an outcome assertion.
- **Over-mocking.** Every import mocked, including the module's own dependencies from the same codebase. Nothing real is exercised. Unmock and use a real database or a fake at the edge.
- **Tautological assertions.** Computing the expected value with the same logic as the code, or asserting `result` equals `mock.return`. The test cannot fail.
- **Testing the framework.** Asserting that the ORM saves a record or the router routes. Someone else tested that.
- **Happy path only.** Ask for the validation failure, the unauthorized case, the empty list, the not-found. Those are where the bugs live.
- **Snapshot everything.** A generated snapshot of a whole page is not a test, it is a diff.
- **Wrong reset or shared state.** Tests that pass only in the order generated. Run the file in random order once.

The single question to ask of every test, AI-written or not: if I introduced a realistic bug here, would this fail? If you cannot name the bug it would catch, it is not earning its place.

## Key takeaways

- A test earns its place only if a realistic bug would fail it.
- Trophy over pyramid for web apps, most effort at integration.
- Mock the edge: network, clock, randomness. Never your own layers or database.
- Mocking your own services yields suites that pass while the app is broken.
- Endpoint tests with real service, repository and database are the highest value.
- Assert on outcomes, not on which internal calls happened.
- No loops or conditionals in tests.
- Snapshots only for small stable outputs, never whole component trees.
- Pick one database reset strategy and enforce it in the harness.
- Quarantine flaky tests and fix or delete within days.
- Coverage is a gap signal, never a target.
- Reproduce every bug with a failing test before fixing it.
