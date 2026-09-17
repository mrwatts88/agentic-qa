# Observability and Ops

*Knowing what production is doing, finding out why it stopped, and keeping it running while you fix it.*

**Read when:** adding or changing logging, metrics, tracing, health checks, alerts, graceful shutdown, or timeouts and retries.

## The three pillars

Logs, metrics, and traces are three views of the same system, and each answers a different question. Logs are discrete events with context: what happened in this request, with which inputs, and what went wrong. Metrics are numbers over time, cheap to store and fast to query: how many, how fast, how often failing, right now and last week. Traces follow one request through every service and database call it touched: where did the time go, and which hop failed.

You need all three because each is bad at the others' job. Grepping logs for an error rate is slow and wrong. Metrics say errors went up but not which user or input. Traces show one request perfectly and nothing about the aggregate.

- Metrics for dashboards and alerts. Traces for "why is this slow." Logs for "what exactly happened."
- Everything carries the same attributes (service, environment, version, request id) or you cannot pivot between them.

## Structured logging

A log line is a JSON object, one per line, on stdout, and the platform ships it somewhere searchable. Fields, not prose: `level`, `timestamp`, `message`, `request_id`, `user_id`, `duration_ms`, and whatever the event is about. The message is a short constant string so you can search for it, and the variable parts are fields. Levels mean something: `error` is a thing that needs a human, `warn` is unexpected but handled, `info` is a business event, `debug` is off in production.

Never log secrets, tokens, passwords, card numbers, or personal data beyond an id. Logs are copied to more places than your database and retained longer than you think. Redaction at the logger is the safety net, not the plan.

- One event per line. Stack traces go in a field, not line breaks.
- Log at boundaries: request in and out, external call, job start and finish. Logging inside loops floods.
- Log the decision, not the state. "Retrying payment, attempt 2 of 3" beats dumping the payment object.

**When reviewing AI-written code:**
- Generated code loves `console.log` or `print` with string concatenation and the whole object. Convert to the logger with fields.
- Check that error handlers log the error once, at the point where it is handled, and not at every layer it passed through.

## Correlation and request ids

Every inbound request gets an id, generated at the edge or on arrival, attached to the request's logger, sent on every outbound call in a header, and returned to the client. With it you can find every log line across every service for one user's one click. Without it, distributed debugging is guesswork. Background jobs get their own ids and carry the id of whatever enqueued them.

## OpenTelemetry

OpenTelemetry (OTel) is the vendor-neutral standard for producing telemetry: one SDK per language, one wire protocol (OTLP), shared semantic conventions, stable traces, metrics, and logs. It graduated from the CNCF in 2026 and every major backend (Datadog, Grafana, Honeycomb, New Relic, the open-source stacks) ingests it natively. Instrument with OTel and switching vendors is a config change rather than a rewrite.

Auto-instrumentation covers frameworks, HTTP clients, and database drivers for free. You add manual spans around business logic that matters and attributes that make them searchable (tenant, plan, flag state). An OTel Collector between the app and the backend handles batching, sampling, redaction, and fan-out, and keeps vendor credentials out of the app.

- Trace context propagates through headers automatically once the HTTP client is instrumented. Queues and custom protocols need it done by hand.
- Sample traces in production. 100 percent of traces on a busy service is expensive and unnecessary. Keep all errors and slow requests, sample the rest.

## Dashboards: RED and USE

For every service, the RED dashboard: Rate (requests per second), Errors (failed requests per second, as a rate and as a percentage), Duration (latency at p50, p95, p99). Those three panels tell you whether users are having a bad time. For every resource (database, queue, host, pool), USE: Utilization (how busy), Saturation (how much is queued waiting), Errors. Those tell you why.

A good dashboard has under a dozen panels, answers "is it broken and where," and is the first thing opened during an incident. Everything else lives on other pages.

- Break RED down by route. One slow endpoint hides inside a healthy average.
- Show deploy markers on the graphs. Most incidents start at a vertical line.
- Averages lie. Percentiles for latency, always.

## Health, readiness, liveness

Liveness: the process is alive and not stuck, restart it if not. Readiness: it can take traffic now, pull it from the load balancer if not. A detailed health endpoint for humans and uptime monitors is a third thing. Keep them separate, keep readiness cheap, and never make liveness depend on a downstream service or one dependency outage restarts your whole fleet in a loop.

## Alerting

Alert on symptoms users feel, not causes you suspect. "Error rate above 2 percent for five minutes" and "p95 above 2 seconds" are symptoms. "CPU above 80 percent" is a cause that may not matter. Symptom alerts catch problems you did not predict. Cause alerts fire constantly and teach people to ignore them.

Two severities. Page: a human must act now, at any hour. Ticket: a human should look during business hours. Nearly everything is a ticket. A page that needs no action is a bug in the alert, and fixing it is part of on-call.

- Every alert has a threshold, a duration, and a runbook link. No duration means it fires on every blip.
- Review alert volume monthly. Delete or tune anything that fired repeatedly without action.
- Alert on absence too: no orders in an hour on a weekday, a scheduled job that did not run.

## SLOs at a light touch

An SLI is a measurement of something users care about: fraction of requests that succeed, fraction served under 500ms. An SLO is a target for it over a window: 99.9 percent of requests succeed over 30 days. The error budget is the gap, about 43 minutes of failure a month at 99.9. Burning it fast means page. Mostly spent means slow down risky changes. Untouched means ship faster. For a small team, one or two SLOs on the main user flows give "how reliable should this be" a number instead of an argument.

## Error tracking

Sentry-class tools capture exceptions with stack trace, request context, breadcrumbs, user, and release, then group identical errors and count them. That grouping is the value: 40,000 events become 12 issues, sorted by users hit and whether they are new since the last deploy. Wire it into frontend and backend, tag releases with the git SHA, and treat a new issue after a deploy as a deploy problem.

- Resolve issues and let regressions reopen them. An unresolved backlog of 500 issues is noise.
- Source maps for frontend errors, or the stack traces are useless.
- Scrub PII at the SDK. These tools store request bodies by default in some configurations.

## Triage and reading a stack trace

An incident starts with a page or a customer report. The first questions in order: what changed (deploy, config, flag, dependency, traffic, upstream vendor), how many users are affected (blast radius), and can we make it stop (rollback, flag off, scale up) before we understand it. Stabilize first, root cause second.

Reading a stack trace: the top frame is where it threw, not necessarily where it went wrong. Walk down to the first frame in your own code, that is where to look. The exception type and message carry the most information. Framework frames between your frames are usually noise.

- Timeline the incident as it happens, in a channel, with timestamps. It becomes the postmortem.
- One person communicates, others investigate. Do not have five people restarting things.
- Follow the request id from the error tracker to the trace to the logs. That is the point of the pillars.

## Runbooks and postmortems

A runbook is a page per alert or known failure mode: what the symptom looks like, what to check, what to do, who to call. Written for someone half awake who knows the system less well than the author. Short, imperative, with the actual commands.

A postmortem follows every incident with real user impact. Blameless means it describes what the system and process allowed, not who made a mistake. Timeline, impact, root cause, contributing factors, action items with owners and dates. The action items are the output. A postmortem that produces no change is a story, not a fix.

## Graceful shutdown and signals

The platform stops your process with SIGTERM, waits a grace period, then SIGKILL. Handle SIGTERM: stop accepting connections, fail readiness, finish in-flight requests, finish or requeue in-progress jobs, close database connections, exit 0. An app that ignores it gets killed mid-request and users see errors on every deploy. A worker that ignores it loses or duplicates jobs.

- The grace period must exceed your longest legitimate request or job step. Configure both sides.
- Test it locally: start the app, send a slow request, send SIGTERM, confirm the request finishes.

## Timeouts, retries, backoff, jitter

Every outbound call has a timeout. No exceptions. A call without one can hang a thread forever and a handful of them exhausts the server. Timeouts nest: each shorter than the caller's own deadline.

Retries are for transient failures (network blip, 503, lock timeout), never for 4xx or for anything not idempotent unless you have an idempotency key. Use exponential backoff (1s, 2s, 4s) with jitter (randomize the wait) so a thousand clients failing at once do not retry in the same instant and knock the recovering service back over. Cap the attempts.

- Retries multiply load on a struggling dependency. Three layers each retrying three times is 27 requests.
- A retried request that was actually processed the first time is a duplicate charge or a duplicate email. Idempotency keys fix this.

**When reviewing AI-written code:**
- Generated HTTP calls almost never set a timeout. Add one.
- Generated retry loops often retry everything, including 400 and 401. Restrict to transient statuses.

## Circuit breaker at a glance

A circuit breaker watches calls to a dependency. When failures exceed a threshold it opens: calls fail immediately for a cooldown period, then a trial request checks whether the dependency recovered. The point is to stop hammering something that is down, keep your own threads free, and give the dependency room to recover. Use one when a non-critical dependency (recommendations, analytics, an enrichment API) can take your core path down with it.

## Connection pool exhaustion

The classic production failure. The app holds a fixed pool of database connections. Under load or during a slow query every connection is checked out, new requests block waiting for one, timeouts fire, and the error is "could not acquire connection" everywhere while the database itself looks idle. Causes: a slow query holding connections, a leak where an error path never returns the connection, too many instances each with a pool larger than the database allows, long transactions wrapping external calls.

- Pool size times instance count stays under the database's connection limit, with headroom. A pooler (PgBouncer-class) in front of Postgres is standard once instances multiply.
- Monitor pool utilization and wait time. It predicts outages minutes ahead.
- Never hold a connection across an external HTTP call.

## Queue depth as a signal

For any background queue, depth (jobs waiting) and oldest job age are the metrics. Depth growing steadily means consumers cannot keep up. Age growing means something is stuck. Both lead the user-visible problem by minutes. Alert on age rather than depth, because depth spikes during normal bursts.

## Log retention and cost

Logs are the line item that surprises people. Volume grows with traffic and with every developer who adds a line. Retention policy: hot and searchable for a couple of weeks, cold in cheap storage for whatever compliance needs, gone after that. Drop `debug` in production and sample high-volume low-value logs (health checks, static asset hits) at the collector. Metrics are cheap by comparison and traces sit in between with sampling.

## Debugging in production safely

You cannot attach a debugger to production. What you can do: raise the log level for one service or one request id through a runtime setting, turn on a feature flag for your own user only, increase trace sampling for one route, and read the result. Add the instrumentation you wish you had, deploy it, reproduce, remove it later. Never edit production directly, and never run ad hoc queries against production without a read replica or a transaction you will roll back.

## Performance profiling basics

Measure before optimizing. The question is not "is this code fast" but "where does the p95 go." Look at the trace for a slow request and the time is almost always in one of four places: database queries (slow query, missing index, or N+1 where a loop issues one query per item), serialization of a large response, calls to external services, or waiting on a lock or a pool. CPU-bound code in your own logic is the last place to look.

p50 is the typical user. p95 and p99 are the users about to leave, and they usually suffer from a different cause than the median. Optimize the tail.

- The slow query log and the ORM's per-request query count find most of it.
- N+1 hides behind lazy loading. Fix with eager loading or a batched query, and assert query count in a test.
- Profile the real thing. Local data is too small to show the problem.

## Caching layers and invalidation

From the outside in: the browser cache (`Cache-Control` headers, free, invisible), the CDN (whole responses at the edge for static assets and cacheable pages), the application cache (Redis-class, computed results and hot rows with a TTL), and the database's own caches (buffer pool, plan cache, automatic). Each layer moves work closer to the user and each introduces staleness.

Invalidation is the hard part. TTLs are the reliable strategy: accept staleness bounded by time. Explicit invalidation on write is precise and fragile, because every write path must remember to do it. Versioned keys (a version or updated-at in the key) make old entries unreachable instead. For static assets, content-hashed filenames with long lifetimes are the solved version of this problem.

- Cache the expensive and the read-heavy. Caching cheap things adds complexity for nothing.
- Every cache is empty after a deploy or restart, and a cold cache stampede takes down the database. Have a story for that.
- Watch the hit rate. A cache that is never hit costs money quietly.

**Gets you burned:**
- Caching a response that includes user-specific data at a shared layer. One user sees another's page.
- `Cache-Control` left at defaults on an API, so a proxy caches a response the app expected to be fresh.

## Key takeaways

- Metrics for alerts, traces for slowness, logs for what exactly happened.
- Structured JSON logs with fields, one event per line, never secrets or PII.
- Every request carries an id propagated to logs, outbound calls, and jobs.
- Instrument with OpenTelemetry and sample traces, keeping errors and slow requests.
- RED per service, USE per resource, broken down by route, with deploy markers.
- Alert on user symptoms with a duration and runbook, not suspected causes.
- Nearly everything is a ticket. A page needing no action is a bug.
- Stabilize first, root cause second. One person communicates during incidents.
- Postmortems are blameless and their action items are the output.
- Every outbound call has a timeout. Retry only transient failures, with jittered backoff.
- Retries multiply load and can duplicate charges without idempotency keys.
- Keep pool size times instances under the database limit, never hold connections across HTTP.
- Alert on oldest job age, not queue depth.
- Cold caches stampede the database, and shared caches leak user-specific data.
