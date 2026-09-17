# Performance and Reliability

*Measure first, put limits on everything, and assume every dependency will be slow or down at some point.*

**Read when:** doing work where latency, load, caching, limits, timeouts or resilience to a slow or failing dependency matter.

## Measure before optimizing

Most performance work fails because it starts with a guess. The guess is usually "the database" or "the framework" and it is usually wrong, or right for a reason nobody expected. Before touching code, get a number for the thing that is slow, and get it from production or something shaped like production.

Averages hide the problem. A p50 of 80ms with a p99 of 6 seconds means one in a hundred requests is a disaster, and for a page that makes ten API calls, that disaster hits most users. Tail latency compounds.

- p50 is the typical experience. p95 and p99 are what your busiest or unluckiest users get, and what pages with many calls get.
- A widening gap between p50 and p99 usually means contention: lock waits, pool exhaustion, GC pauses, a slow query that only runs for some inputs.
- Instrument the request end to end: trace IDs, per-span timing, structured logs. An APM tool or OpenTelemetry does most of this for free.
- Set a target before you start. "Checkout p95 under 500ms" is actionable. "Make it faster" is not.

**Gets you burned:**
- Optimizing a code path that accounts for 2% of request time.
- Benchmarking on a laptop against an empty database.
- Dashboards showing averages only.

## Where time actually goes in a request

For a typical web request, the application code is rarely the bottleneck. Time goes to waiting: on the database, on other services, on the network, on serialization of large payloads, and on rendering.

- Database: query execution, but also round trips. Ten fast queries in sequence cost more than one moderate query.
- External calls: payment providers, auth services, email APIs, anything over HTTP. Each one is a network round trip with its own tail.
- Serialization: turning 5,000 ORM objects into JSON is real CPU time and real memory. Over-fetching shows up here.
- Rendering: server-side templates or SSR with heavy component trees.
- Middleware and framework overhead: usually small, occasionally surprising (per-request session loads, logging that does synchronous I/O).

Look at a trace waterfall for a slow request. The answer is usually obvious once you see it.

## N+1 and chatty APIs

The classic: load a list of orders, then for each order load its customer. One query becomes 101. ORMs make this effortless and invisible in development where the list has three items.

The API-level version is the same problem: a frontend that fetches a list and then one detail call per item, or a service that calls another service inside a loop.

- Fix with eager loading, joins, batched lookups (`WHERE id IN (...)`), or a dataloader pattern that collects IDs and fetches once.
- Log query counts per request in development and fail tests when a request exceeds a threshold.
- For APIs, design endpoints around what a screen needs, or offer batch endpoints.

**When reviewing AI-written code:**
- Any loop containing a query, an ORM relationship access, or an HTTP call.
- Serializers that touch related objects without the query preloading them.

## Caching layers and invalidation

Caching is a hierarchy, and each layer answers a different question. Browser cache avoids the request entirely. CDN avoids your servers. Application cache (Redis, in-process memory) avoids the database or an expensive computation. The database's own caches avoid disk.

The hard part is never the cache. It is knowing when the cached thing is wrong.

- TTL: simplest, tolerates staleness up to the TTL. Good default for anything that can be slightly out of date.
- Cache-aside: app checks cache, on miss reads the source and writes the cache. Most common pattern. Watch for stampedes when a hot key expires and a thousand requests miss at once.
- Event-based invalidation: delete or update the cache entry when the underlying data changes. Precise but requires every write path to remember to do it.
- Versioned keys: include a version or updated-at in the key so stale entries are simply never read again.
- HTTP caching headers (`Cache-Control`, `ETag`) let browsers and CDNs do the work. Static assets should have long TTLs with content-hashed filenames.

**Gets you burned:**
- Caching per-user data under a key without the user ID. This is a data leak, not just a bug.
- Caching an error response.
- In-process caches on multiple instances that disagree with each other.
- Nobody knowing why the cache exists, so nobody dares remove it.

## Pagination and limits on everything

Every list endpoint, every query, every export will eventually run against a table with ten million rows. Unbounded queries work fine until the day they take down the database.

- Default and maximum page sizes on every list endpoint. Reject requests over the maximum rather than silently truncating.
- Offset pagination is fine for small sets and admin screens. It gets slow at deep offsets because the database still scans the skipped rows. Cursor (keyset) pagination scales.
- Put limits on request body size, upload size, query complexity, number of IDs in a batch, and length of any user-supplied string.
- Background jobs that "process all records" should work in chunks.

## Timeouts everywhere

Most HTTP clients, database drivers, and socket libraries default to no timeout or a very long one. A dependency that hangs will hang your request, then your worker, then your whole pool, and your service goes down because someone else's did.

- Set connect and read timeouts on every outbound HTTP call. Seconds, not minutes.
- Set statement timeouts on the database. A query that takes 30 seconds is almost always a bug.
- Set a server-side request timeout so a stuck handler releases its worker.
- Client-side (browser) timeouts so the UI can show an error instead of spinning forever.
- Timeouts should be shorter at the outer layers than the inner ones, or the inner call keeps running after the outer one gave up.

**When reviewing AI-written code:**
- Any HTTP client instantiated without a timeout. Agents copy the library's defaults, and the defaults are usually infinite.

## Retries, backoff, and idempotency

Retries turn transient failures into successes. They also turn a struggling dependency into a dead one if everyone retries at once, and they turn one payment into three if the operation is not idempotent.

- Only retry operations that are safe to repeat: reads, and writes that carry an idempotency key.
- Exponential backoff with jitter. Without jitter, every client retries at the same instant.
- Cap the number of attempts and the total time. Three attempts over a few seconds is typical.
- Retry on timeouts, connection errors, 429 and 5xx. Do not retry on 4xx that indicates a bad request.
- Idempotency keys: the client generates a unique key per logical operation, the server stores the result under that key and returns it on repeat. This is how payment APIs work and how your own write endpoints should work when a client might retry.

At-least-once delivery is the norm for queues and webhooks. Every consumer will eventually see a duplicate. Design consumers to tolerate it: check whether the work was already done, or make the work naturally idempotent (set a value rather than increment it).

## Bulkheads and circuit breakers at a glance

A bulkhead isolates resources so one slow dependency cannot consume everything. A separate connection pool or worker pool per dependency means the email provider being down does not starve checkout.

A circuit breaker watches failure rates for a dependency and, after a threshold, stops calling it for a while and fails fast instead. It gives the dependency room to recover and stops your request threads piling up on something that is down. Most apps get most of the value from timeouts plus bounded retries. Add a breaker when a dependency's outages have taken you down before.

## Connection pooling

Opening a database connection or a TLS session costs tens to hundreds of milliseconds. Pools keep connections open and hand them out. Nearly every production problem involving "too many connections" or "connection refused" is a pool sizing issue.

- Database pool size is bounded by what the database can handle, not what the app wants. Postgres degrades past a few hundred connections. With many app instances, a pooler like PgBouncer sits in between.
- Pool exhaustion looks like requests hanging, then timing out, with the database itself idle. Check for connections held across slow external calls or not returned on error paths.
- HTTP clients should reuse connections (keep-alive). Creating a new client per request defeats this and also leaks sockets.
- Serverless functions each hold their own connections, which multiplies the count. Use a pooler or an HTTP-based database proxy.

## Async and background work

Anything slow that the user does not need to wait for belongs in a job: sending email, generating PDFs, calling a slow third party, resizing images, anything over a few hundred milliseconds. The request enqueues, returns quickly, and the worker does the work.

- Jobs need: retries with backoff, a dead-letter queue for permanent failures, idempotency, visibility (what is queued, what failed), and a way to run one manually.
- The job payload should be an ID, not a serialized object. Load fresh state when the job runs.
- Users need feedback on long jobs: status field, polling endpoint, or a notification when done.
- Scheduled jobs (cron) need protection against overlapping runs and against running on every instance at once.

## Batch versus stream at a glance

Batch: collect work and process it on a schedule. Simple, easy to reason about, easy to rerun. Right for reports, reconciliation, nightly cleanups. Stream: process each event as it arrives. Lower latency, more moving parts, harder to replay. Most apps need batch for a long time before they need streaming. A queue with workers covers the middle ground.

## Memory leaks

A leak in a long-running process shows up as memory climbing steadily over hours or days until the process is killed or starts thrashing in GC. Restarting fixes it, which is why leaks survive for years.

- Common causes: unbounded in-process caches, event listeners added and never removed, global collections that grow per request, closures holding request state, connection or file handles not closed.
- Watch heap size over time per instance, not just at a moment. A sawtooth that resets on deploy is the signature.
- Bounded caches (LRU with a max size) rather than plain maps.
- Heap snapshots before and after a period of load show what is growing.

## Cold starts

Serverless functions and autoscaled containers pay a startup cost on the first request: loading the runtime, importing dependencies, opening connections, warming caches. This can be hundreds of milliseconds to several seconds and it lands on real users.

- Keep the dependency graph small for latency-sensitive functions. Import lazily where possible.
- Do expensive initialization once, outside the request handler, so warm instances reuse it.
- Provisioned concurrency or minimum instance counts trade money for latency.
- Cold starts are a p99 problem. They rarely show in p50.

## Frontend performance

The frontend is where most users perceive slowness, and the causes are mostly about bytes and blocking.

- Bundle size: every kilobyte of JavaScript must be downloaded, parsed, and executed. Code-split by route, lazy-load below-the-fold components, audit what the bundler includes. One imported utility library can add hundreds of kilobytes.
- Images: usually the largest bytes on a page. Serve correctly sized, modern formats (WebP, AVIF), with lazy loading and explicit dimensions so the layout does not jump.
- Render blocking: scripts and stylesheets in the head that block first paint. Defer non-critical scripts.
- Core Web Vitals: LCP (largest contentful paint, is the main content visible fast), INP (interaction to next paint, does the page respond when clicked), CLS (cumulative layout shift, does content jump around). These are what Google measures and what users feel.
- Too many requests: a waterfall of dependent fetches on page load. Fetch in parallel, or fetch on the server.
- Measure with Lighthouse for a lab number and real-user monitoring for the truth.

## Database performance

The database is the most common real bottleneck, and the fixes are mostly indexes and query shape.

- An index makes a lookup fast for the columns it covers. Every `WHERE`, `JOIN`, and `ORDER BY` on a large table should be backed by one. Composite indexes matter in column order.
- Indexes cost write speed and space. Do not index everything.
- `EXPLAIN` (or `EXPLAIN ANALYZE`) shows what the planner does. Sequential scan on a large table, nested loops over big sets, and sorts spilling to disk are the things to look for.
- Turn on the slow query log with a threshold like 200ms and review it weekly. It finds the problems for you.
- Select only the columns you need. `SELECT *` on wide tables with large text or JSON columns is a silent cost.
- Long transactions hold locks. Keep them short and never hold one across an external call.
- Missing foreign key indexes are a classic: the constraint exists but the lookup from the child side does a full scan.

**When reviewing AI-written code:**
- New query patterns on large tables with no matching migration adding an index.
- Migrations that add an index on a big table without `CONCURRENTLY` or equivalent, locking the table in production.

## Graceful degradation

When a dependency fails, the question is what the user sees. The goal is a worse experience rather than no experience.

- Recommendations service down: show the page without recommendations.
- Search index down: fall back to a database query with a note that results may be limited.
- Payment provider slow: queue the order and confirm by email.
- Feature flags let you turn off expensive or fragile features under load without a deploy.
- Return partial data with an indication of what is missing rather than failing the whole response.

The opposite of graceful degradation is a hard dependency chain where any failure is total. Map which dependencies are truly required per endpoint.

## Capacity basics

Know roughly how many requests per second you handle, how big the database is, how fast it grows, and how much headroom you have. These four numbers answer most capacity questions.

- Most web apps run at tens to low hundreds of requests per second. A single well-configured database instance handles this comfortably.
- Vertical scaling (a bigger box) is the right first move almost every time. It has no architectural cost.
- Horizontal scaling of stateless app servers is easy. The database is the thing that is hard to scale, so protect it: caching, read replicas for read-heavy loads, and query discipline.
- Know your growth rate. A table adding a million rows a month needs different thinking than one adding a thousand.

## Load testing at a glance

A load test answers "what breaks first, and at what load". Run one before a launch or a known traffic event, and after major changes to the data layer.

- Use a tool (k6, Locust, Artillery, whatever is convenient) to replay realistic traffic against a staging environment with production-sized data.
- Ramp up gradually and watch latency percentiles, error rates, CPU, memory, database connections, and queue depth.
- The first thing to break is usually the connection pool or a specific query, not CPU.
- A load test against a tiny database proves nothing about queries.

## Common "it got slow" checklist

When something that used to be fast is slow, work through these before anything clever.

- A table crossed a size threshold and a query lost its index or the planner changed strategy.
- A new N+1 was introduced, often via a serializer or template accessing a relationship.
- An external dependency got slower and there is no timeout.
- Connection pool exhausted, or pool size reduced by adding instances that share the same database limit.
- A cache stopped working: expired key, Redis restart, changed key format, cache disabled by a config change.
- Memory pressure causing GC thrashing or swap.
- A background job or cron competing for the database at the same time.
- Bundle size grew after a dependency upgrade.
- Logging or metrics doing synchronous I/O in the hot path.
- Someone is paginating with offset and the offsets are now large.
- A missing index on a foreign key that only mattered once the table grew.
- A deploy changed a default: timeout, pool size, cache TTL, log level to debug.

## Key takeaways

- Measure in production-shaped conditions before optimizing, and set a concrete target.
- Averages hide the problem. Optimize p95 and p99, not p50.
- Time goes to waiting: database round trips, external calls, serialization, rendering.
- Any loop containing a query or HTTP call is an N+1.
- Caching per-user data without the user id in the key is a data leak.
- Default and maximum page sizes on every list endpoint, cursor pagination at scale.
- Timeouts on every outbound call, statement, and request, shorter at outer layers.
- Retry only idempotent operations, with jittered exponential backoff and capped attempts.
- Queues deliver at least once, so consumers must tolerate duplicates.
- Pool sizing is bounded by the database, not the app. Serverless multiplies connections.
- Job payloads are ids, not serialized objects.
- Index every WHERE, JOIN, ORDER BY, and foreign key on large tables, concurrently.
- Degrade gracefully: a worse experience beats no experience.
- Vertical scaling first. Protect the database, it is the hard thing to scale.
