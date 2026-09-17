# Backend Architecture

*How a typical API server is layered, where each kind of logic belongs, and the ways it leaks when nobody is paying attention.*

**Read when:** adding or changing server code: handlers, services, repositories, validation, error handling, middleware, configuration or background jobs.

## Layered architecture

The standard shape is three layers with a strict downward dependency: **controller/handler** at the top, **service/use-case** in the middle, **repository/DAL** at the bottom. Each layer knows about the one below it and nothing about the one above. The point is not purity. The point is that each concern has exactly one home, so a change to HTTP shape, business rules, or storage touches one layer.

A handler takes an HTTP request, turns it into typed input, calls one service method, and turns the result into an HTTP response. A service takes typed input, enforces business rules, coordinates repositories and other services, and returns a domain result or a domain error. A repository takes domain-level questions ("orders for customer X since date Y") and turns them into queries, returning domain objects, not rows.

```
POST /orders          -> OrdersHandler.create(req)
                         -> OrderService.placeOrder(cmd)
                            -> InventoryRepo.reserve(...)
                            -> OrderRepo.insert(order)
                         <- Order | OutOfStockError
                      <- 201 + OrderResponse | 409 + problem body
```

- **Handler owns:** parsing and validating request shape, auth context extraction, calling the service, mapping results and errors to status codes and response DTOs. Nothing else.
- **Service owns:** business rules, invariants, orchestration, transaction boundaries, emitting events, deciding what is an error.
- **Repository owns:** queries, mapping between rows and domain objects, pagination mechanics, nothing about business meaning.

**Gets you burned:**
- Business logic in handlers: the rule exists once per endpoint, and the CLI job or the queue consumer that needs the same rule reimplements it.
- HTTP concepts in services: a service that returns status codes or throws `HttpException` can't be reused from a worker.
- ORM entities returned straight from the handler, so the API contract is now the database schema.
- "Fat repository" where the DAL enforces business rules, so there are now two places rules live.

**When reviewing AI-written code:**
- Generated code loves to put everything in the handler. Look for `db.` or query builder calls inside route files.
- Look for a service importing the web framework's request or response types.
- Check that one request maps to one service call, not a handler orchestrating five repository calls itself.

## DTOs, domain models, DB entities

Three shapes that are tempting to merge into one class. Keep them separate when they would diverge, and they always diverge eventually.

- **Request/response DTOs** are the API contract. Shaped for the client, versioned with the API, validated at the boundary. Contain no behaviour.
- **Domain models** are what the service layer reasons about. Carry invariants and behaviour. Know nothing about JSON or tables.
- **DB entities / rows** are the persistence shape. Column names, foreign keys, audit fields, soft-delete flags.

In a small app the domain model and the entity are often the same class and that is a reasonable trade. The DTO should still be separate: the moment you return an entity from an endpoint you have leaked `password_hash`, `internal_notes`, or the whole related graph.

- Map at the edges: handler maps DTO to command, repository maps row to model. Mapping code is boring and that is its job.
- Don't accept a DTO that is the entity with every field writable. Mass-assignment bugs come from exactly this.

## Where validation lives

Two different things get called validation. **Shape validation** (is this JSON, is `email` a string, is `qty` a positive integer) belongs at the boundary, in the handler or a schema layer in front of it. It fails fast with a 400 and never reaches the service. **Business validation** (does this customer have credit, is the slot still free, may this user cancel this order) belongs in the service, because it needs data and rules.

- Boundary validation is total: nothing untyped crosses into the service. The service can trust its inputs' shape.
- Business rules never live in the schema layer. A JSON schema can't know inventory.
- Database constraints are the last line, not the first. Catch the violation and translate it.
- Validate at every trust boundary. Queue messages and webhook bodies are inputs too.

## Error handling strategy

Services raise typed domain errors (`OrderNotFound`, `InsufficientStock`, `PaymentDeclined`). One place near the top of the stack maps those to HTTP: a middleware or error handler that knows `NotFound -> 404`, `Conflict -> 409`, `Validation -> 400`, unknown -> 500. Handlers do not catch and translate errors individually.

Every error response uses the same envelope. RFC 9457 Problem Details is a good ready-made shape: `type`, `title`, `status`, `detail`, `instance`, plus your own extension fields like `errors` for field-level validation and `request_id` for support.

- 5xx responses carry a generic message and a request id. Stack traces, SQL, file paths and internal hostnames stay in the logs.
- 4xx responses carry enough for the client to fix the request. A validation error lists fields and reasons.
- Log 5xx at error level with full context. Log 4xx at info or not at all, they are not your bug.

**When reviewing AI-written code:**
- `try/catch` around every call with a `console.log` and a `return 500`. Delete it and let the central handler work.
- Error messages that interpolate the raw exception into the response body.
- `catch` blocks that return a success shape with empty data.

## Middleware and the request pipeline

Cross-cutting concerns run in a chain before and after the handler. Order matters and should be explicit.

A typical order: request id (generate or accept from a trusted proxy), structured logging start, body size limit, CORS, rate limit, authentication (who), then routing, then authorization (may they), then the handler, then error translation and logging end on the way out.

- Authentication establishes identity and attaches a principal to the request. Authorization is a per-endpoint or per-resource decision and mostly belongs in the service, where the resource is known.
- Request id goes into every log line and into the response header. This is the single most useful debugging feature you will build.
- Rate limiting and body size limits run before anything expensive, including auth.

## Dependency injection as a concept

DI means a component receives its collaborators (repository, clock, HTTP client, mailer) rather than constructing them. It does not require a framework or a container. Constructor parameters are enough.

- Composition happens in one place at startup: build the DB pool, build repositories with the pool, build services with repositories, build handlers with services.
- Tests pass fakes for the edges (clock, external APIs, mailer) and usually a real database for repositories.
- Inject the clock. Code that calls `now()` directly is untestable around date boundaries.
- Global singletons and service locators are DI's evil twin. They hide dependencies and make tests order-dependent.

## Configuration and environment

Configuration is everything that differs between deployments: database URLs, secrets, feature flags, external endpoints, limits. Code is everything that doesn't. Read config once at startup into a typed, validated object and fail loudly on anything missing.

- Environment variables are the lowest common denominator and fine. Secrets come from a secret manager and land in env or files at deploy time, never in the repo.
- One config object passed down, not environment reads scattered through the codebase.
- Frontend "env vars" are baked in at build time and therefore public.

## Background jobs and queues

Move work off the request when it is slow, unreliable, or not needed for the response: sending email, calling third-party APIs, generating files, resizing images, syncing to another system. The request enqueues a job and returns. A worker picks it up.

Every mainstream queue delivers **at least once**. Your consumer will see duplicates. Design every job to be idempotent: check whether the work is already done, key side effects on a stable id, make the database write an upsert.

- Retry with exponential backoff and a maximum attempt count. After that the job goes to a **dead letter queue** that a human looks at. Silent infinite retry is how you find out about a bug three weeks late.
- Small payloads: pass ids, not full objects. The worker reloads current state.
- Enqueue after the transaction commits, or use an outbox table. Enqueuing inside the transaction and then rolling back produces a worker that can't find the row.
- Make job execution visible: attempts, last error, queue depth. Queue depth growing is the first alarm.

**Gets you burned:**
- Non-idempotent consumer plus at-least-once delivery equals duplicate emails and double charges.
- Retry on every error, including permanent ones like validation failure. Distinguish retryable from terminal.
- One giant job that does 10,000 things. Fan out into small jobs so failures are isolated and progress is visible.

## Idempotency keys

For operations where a retry must not create a second effect (payments, order placement, anything POST that clients might retry), the client sends an `Idempotency-Key` header with a unique value per logical operation. The server stores the key with the response the first time and returns the same response for repeats. There is an IETF draft standardising the header name, and Stripe's implementation is the reference behaviour.

- Store key, request fingerprint, status, and response. Same key with a different body is a 422, not a replay.
- The store needs a TTL (24 hours is common) and should be checked inside the same transaction as the write, or with a unique constraint on the key, to close the concurrent-duplicate window.
- Scope keys to the authenticated user or tenant.

## Transactions across the service boundary

A transaction is a service-level decision: the service knows which writes must succeed or fail together. The repository executes queries within whatever transaction it is handed. The handler knows nothing about it.

- One request, usually one transaction, opened and committed in the service method that represents the use case.
- Keep transactions short. No external HTTP calls, no email sending, no sleeping inside one. Locks held while waiting on a third party are how you get a thundering herd on a table.
- Cross-service or cross-database consistency is not a transaction. Use the outbox pattern, idempotent jobs, and compensating actions. If you find yourself wanting two-phase commit, revisit the boundaries.

## Pagination in the service layer

The handler parses `limit` and `cursor`. The service passes them through. The repository implements keyset pagination and returns a page plus the next cursor. Authorization filters (only orders the caller may see) are applied in the query, not by fetching everything and filtering in memory.

- Clamp `limit` server-side. Total counts are expensive on large tables, offer them only where the UI needs them.

## Rate limiting basics

Rate limiting protects your capacity and your third-party quotas. Token bucket or sliding window keyed by user id, API key, or IP (in that order of preference). Put the counters in a shared store if you run more than one instance.

- Return 429 with `Retry-After` and the standard `RateLimit-*` headers if you can.
- Separate limits for expensive endpoints (search, export, login attempts).
- IP-based limits alone punish everyone behind a corporate NAT and miss a distributed attacker. They are a floor, not a strategy.

## API contracts and OpenAPI

An OpenAPI document (3.1 or 3.2) is the contract: paths, methods, parameters, request and response schemas, auth schemes, error shapes. Generate it from code or generate code from it, but keep one source of truth and check it in CI.

- Generate clients and server stubs from the spec so frontend types match backend reality.
- Breaking-change detection on the spec diff in CI catches accidental contract changes.
- Document the error envelope and pagination shape once as reusable components.

## Modular monolith vs microservices

Default to one deployable with clear internal module boundaries. Modules own their tables and expose a small internal interface. Cross-module calls are in-process function calls. This gives you most of the organisational benefits of services without the distributed-systems tax: no network failures between modules, one transaction, one deploy, one log stream, refactorable with an IDE.

Split a module into its own service when there is a concrete reason: a genuinely different scaling profile, a different runtime or language requirement, a team boundary that needs independent deploys, or an isolation requirement. "It might need to scale" is not a reason.

- Enforce module boundaries with tooling (import rules, separate packages) or they erode in a quarter.
- Shared database across services is the worst of both worlds. If two services must share tables they are one service.
- The first extraction is always harder than expected because of hidden coupling. A well-bounded module in a monolith is the best preparation for it.

## File uploads

Files don't belong in your application server's memory or on its disk, and they don't belong in the database. The standard pattern: client asks the API for a pre-signed upload URL, uploads directly to object storage, then tells the API the upload is done. The API records metadata (key, size, content type, owner) and kicks off any processing as a background job.

- Validate content type by sniffing bytes, not by trusting the extension or the client-supplied header.
- Enforce size limits at the storage layer (pre-signed URL conditions) and at the API.
- Never let user-supplied filenames become storage keys or file paths. Generate the key, store the original name as metadata.

## Time and timezones

Store instants in UTC. Convert to a timezone only at the display edge, using the user's or the resource's timezone, never the server's. The server's timezone should be UTC and you should still not rely on it.

- Distinguish an **instant** (a point on the timeline, "2026-03-01T14:00:00Z") from a **wall-clock time** ("9am local"). A recurring meeting at 9am Sydney is a wall-clock time plus a zone, not an instant. Storing it as UTC breaks at daylight saving transitions.
- Dates without times (birthdays, due dates) are their own type. Don't store them as midnight UTC.
- Use the IANA zone names (`Australia/Sydney`), never fixed offsets, for anything user-facing.

## Scheduled tasks

Cron-style work (nightly reports, cleanups, sync jobs) should enqueue a job rather than do the work inside the scheduler process. The scheduler's only job is to fire on time.

- With multiple instances, only one may fire each tick. Use a distributed lock or a scheduler that guarantees single execution, or make the job idempotent enough that double-firing is harmless.
- Missed ticks (deploy in progress, instance down) need a decision: run late, or skip. Make it explicit.
- Log each run with a start, end, and outcome. A scheduled job that silently stopped running in March is a classic.

## Webhooks

**Receiving:** treat a webhook as an untrusted POST. Verify the signature first (HMAC-SHA256 over timestamp plus body with a shared secret is the common scheme, and the Standard Webhooks spec formalises it), reject stale timestamps to block replays, then persist the raw event and return 200 immediately. Process the event from a job. The sender will retry on non-2xx and on timeout, so you will receive duplicates: dedupe on the event id.

**Sending:** sign every delivery, include an event id and timestamp, retry with backoff on failure, stop after a bounded number of attempts and surface the failure to the subscriber. Deliver from a job, never from the request that caused the event.

- Verify using the raw request body bytes. Parsing and re-serialising JSON changes the bytes and breaks the signature.
- Use a constant-time comparison for the signature.
- Rotate secrets by supporting two valid secrets during the overlap window.

**When reviewing AI-written code:**
- Signature check skipped "for now" or done on the parsed JSON.
- Handler does database writes, sends email, and calls another API before returning, with no dedupe on event id.
- Outbound webhook sender with no timeout on the HTTP call.

## Key takeaways

- Handlers parse and map, services own rules, repositories own queries.
- Business logic in handlers cannot be reused by jobs or CLIs.
- Never return ORM entities from endpoints, that leaks the schema.
- Shape validation at the boundary, business validation in the service.
- Services throw typed domain errors, one central handler maps them to HTTP.
- 5xx responses carry a generic message and request id, never internals.
- Rate limits and body size limits run before auth.
- Every queue consumer must be idempotent, delivery is at least once.
- Enqueue after commit or use an outbox table.
- No external HTTP calls inside a database transaction.
- Default to a modular monolith, split only for a concrete reason.
- Verify webhook signatures on raw bytes, then persist and process from a job.
