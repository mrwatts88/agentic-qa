# Data

*Relational modelling, indexes, transactions, ORMs, migrations and the operational habits that stop a database from becoming the incident.*

**Read when:** changing the schema, migrations, queries, indexes, transactions or how the app talks to its database.

## Relational modelling and keys

Tables are sets of facts about one kind of thing. Each row has a **primary key** that never changes. Relationships are **foreign keys** pointing at primary keys. One-to-many is a foreign key on the many side. Many-to-many is a join table with two foreign keys and usually a composite unique constraint across them.

Model the nouns your domain actually talks about, not the screens. A screen is a query. A table is a fact.

- Every table gets an immutable surrogate primary key. Natural keys (email, SKU, ISBN) get a unique constraint instead, because natural keys change.
- Foreign keys are real constraints in the database, not just a convention in the ORM. Choose `ON DELETE` behaviour deliberately: `RESTRICT` by default, `CASCADE` only for true ownership (order lines belong to an order).
- `NOT NULL` everywhere it is true. Nullable columns are a design decision, not a default.
- Check constraints for cheap invariants (`qty > 0`, `status IN (...)`). The database is the only place every writer goes through.

## Normalization sanity

Normalization means each fact lives in one place. Third normal form in plain terms: every non-key column depends on the key, the whole key, and nothing but the key. Denormalization is deliberately copying a fact into a second place for read speed, and it buys you a synchronisation problem.

- Normalize by default. Update anomalies (changing a customer's name in 40,000 order rows) are a worse class of bug than a slow join.
- Denormalize when a specific hot read path is measurably slow and the copied data is either immutable or maintained by one code path. Snapshotting a price onto an order line is correct denormalization: the price at the time of purchase is a different fact from the current price.
- Counter columns (`comment_count`) and materialized views are denormalization too. Have a way to recompute them.

## Indexes

An index is a separate sorted structure (almost always a B-tree) that maps column values to row locations, so the database can find matching rows without scanning the table. Every index speeds up reads that can use it and slows down every write to that table, because each insert, update and delete must maintain it. The primary key and every unique constraint are indexes already.

Add an index when a query is slow and `EXPLAIN` shows a sequential scan on a large table filtered by a column you can index. Foreign key columns almost always want an index, because you join on them and because deleting a parent row must check them.

- **Composite index** on `(a, b, c)` serves queries filtering on `a`, on `a and b`, on `a and b and c`, in that order, and can serve sorting by `b` within a fixed `a`. It does not serve a query filtering only on `b`. Put the equality columns first, the range or sort column last.
- **Covering index** includes every column the query needs, so the database never touches the table. Databases support `INCLUDE` columns for this.
- **Partial index** with a `WHERE` clause indexes only the rows that matter (`WHERE deleted_at IS NULL`, `WHERE status = 'pending'`). Smaller, faster, cheaper to maintain.
- Functions in the `WHERE` clause (`LOWER(email)`, `DATE(created_at)`) defeat a plain index. Index the expression or store the normalised value.

### Reading an EXPLAIN at a glance

Run `EXPLAIN ANALYZE` on the real query with real parameters. Read from the innermost node outward.

- **Seq Scan** on a big table in a filtered query: missing index.
- **Index Scan** or **Index Only Scan**: good. **Bitmap Heap Scan**: fine, index used then rows fetched in bulk.
- **Nested Loop** with a large outer set: usually the slow part. **Hash Join** and **Merge Join** are normally what you want for big sets.
- Compare estimated rows with actual rows. A large mismatch means stale statistics. Run `ANALYZE`.

**When reviewing AI-written code:**
- Generated migrations add a table with foreign keys and no indexes on them.
- Indexes added on every column "to be safe".
- A query with `ORDER BY created_at DESC LIMIT 20` on a large table and no index on `created_at`.

## Transactions and isolation, practically

A transaction makes a group of statements atomic: all commit or none do. Isolation is about what concurrent transactions see of each other. The default in most databases (Postgres, Oracle, SQL Server default) is **read committed**: each statement sees data committed before that statement started. MySQL InnoDB defaults to repeatable read. Neither default prevents the race conditions you actually hit.

The one that bites everyone is **read-then-write**: two requests both read "seats available: 1", both decide to book, both write. Under read committed, both succeed. A transaction alone does not save you, because neither transaction sees the other's uncommitted write.

- **Pessimistic locking:** `SELECT ... FOR UPDATE` on the row you are about to change. The second transaction blocks until the first commits, then re-reads and sees zero seats. Simple, correct, fine for low contention on specific rows. Lock in a consistent order to avoid deadlocks.
- **Optimistic locking:** a `version` column. Read the row and its version, write with `WHERE id = ? AND version = ?`, and if zero rows were updated, someone else won, so retry or fail. Better for high read, low conflict workloads, and the only option across a user's "edit form" gap.
- **Database constraints:** a unique index on `(room_id, slot)` makes double-booking impossible regardless of application logic. Constraints are the cheapest concurrency control there is.
- **Atomic updates:** `UPDATE stock SET qty = qty - 1 WHERE id = ? AND qty > 0` and check the affected row count. No read, no race.
- **Serializable** isolation makes the database detect these conflicts for you, at the cost of every caller handling serialization-failure retries.

**Gets you burned:**
- Wrapping read-check-write in a transaction and believing it is now safe.
- Long transactions holding locks while calling a payment API.

## N+1 and how ORMs cause it

Load 50 orders, then for each order access `order.customer`. The ORM lazily fires 50 more queries. That is N+1. It is invisible in development with 5 rows and it is the most common performance bug in ORM-backed apps.

- Eager load the relations the code path needs (`include`, `joins`, `preload`, `select_related`, `with`), or use a batching loader that collects ids and issues one `WHERE id IN (...)`.
- Log query counts per request in development and fail tests that exceed a threshold. This is the only reliable way to keep N+1 out.

**When reviewing AI-written code:**
- Loop over a result set with a relation access or a repository call inside the loop.
- A `map` over ids that awaits a query per id.

## ORM vs query builder vs raw SQL

- **ORM** (full object mapping, lazy relations, change tracking): fastest for CRUD-shaped code, good migrations tooling, type-safe models. Costs: N+1, opaque queries, fighting it for anything set-based, and a tendency to leak entities into the API.
- **Query builder** (typed SQL construction, no object graph): keeps you close to SQL with composable filters and type checking. The pragmatic middle for most teams.
- **Raw SQL** (with parameter binding, never string interpolation): for reports, bulk operations, anything the builder makes ugly. Put it in the repository, name it, test it.

Most codebases use two of these. The rule that matters is that all three go through the repository layer and all three use parameters, never concatenated values.

## Migrations

Schema changes are versioned, ordered scripts committed with the code that needs them and applied automatically on deploy. Never change the schema by hand in an environment that matters.

- **Forward-only.** Write the down migration if your tool wants one, but plan on never running it in production. Rolling back is a new forward migration.
- **Never edit an applied migration.** It has already run somewhere. Editing it makes environments diverge silently. Add a new one.
- **Expand/contract for zero downtime.** During a rolling deploy, old and new code run against the same database at the same time. Every change must be safe for both. Add the new column nullable (expand), deploy code that writes both, backfill in batches, deploy code that reads the new column, then drop the old column in a later release (contract). Renames are an add plus a drop weeks apart.
- Big backfills run in batches from a job, not inside the migration. A migration that updates 50 million rows holds a lock and blocks the deploy.
- Set a short `lock_timeout` on migrations so an `ALTER TABLE` fails fast instead of queueing behind a long query and freezing the table.
- Create indexes concurrently on large tables. Adding a foreign key or changing a column type each has a locking gotcha on big tables. Check the docs before running one against millions of rows.

## Connection pooling

Database connections are expensive to open and each one costs memory on the server. Applications hold a pool of open connections and hand them to requests. The pool size is bounded, and when it is exhausted, requests wait.

- Pool size per instance times number of instances must stay under the database's connection limit, with headroom for migrations and admin.
- Serverless and heavily horizontal deployments blow through connection limits. Put a pooler (PgBouncer style) between the app and the database.
- A leaked connection (acquired, never released on an exception path) shrinks the pool until everything hangs. Pool exhaustion presents as "the database is slow". Check pool wait time first.

## Soft deletes

A `deleted_at` timestamp instead of a real `DELETE`. Recoverable, auditable, and every query in the system must now remember to filter it out.

- Use it when users expect undo, when regulators expect a trail, or when foreign keys make hard deletes impractical.
- Enforce the filter in one place (a default scope, a view, a partial index) not in every query.
- Unique constraints break: a soft-deleted user still holds their email. Use a partial unique index on `WHERE deleted_at IS NULL`.
- Soft delete is not a privacy deletion. Personal data that must be erased needs a real delete or a scrubbing job.

## Audit columns

`created_at` and `updated_at` on every table, set by the database or a single well-tested hook. Add `created_by` and `updated_by` where the actor matters. For anything with a compliance or support angle, a separate append-only audit log table (who, what, when, before, after) is worth the effort.

- `updated_at` must actually update. ORMs handle it for their own writes and skip it for bulk updates and raw SQL.

## UUID vs sequential ids

- **Sequential integers** are compact, index-friendly, and human-readable. They leak record counts and enable enumeration (`/invoices/1042`, try `1043`).
- **UUIDv4** is random. Globally unique, safe to generate client-side, but random inserts fragment B-tree indexes and bloat storage on large tables.
- **UUIDv7** is time-ordered with a random tail. Index-friendly like an integer, globally unique like a UUID. Now built into Postgres 18 and available as a library everywhere. The default choice for new tables in 2026.

Whatever the primary key, any id that appears in a URL should be non-guessable. UUIDv7 leaks creation time, which is fine for almost everything and a consideration for a few things.

## JSON columns

A JSON column is for data that is genuinely schemaless: third-party payloads you store as received, user-defined attributes, settings blobs. It is not a way to avoid designing tables.

- Anything you filter on, join on, or need a constraint for belongs in a real column. Extract it.
- Validate the shape in application code. The database will happily store `{"amount": "twelve"}`.

## Full text search at a glance

`LIKE '%term%'` cannot use an index and does not rank. Built-in full text search (Postgres `tsvector`, MySQL FULLTEXT) covers a large share of real needs: tokenisation, stemming, ranking, decent performance with a GIN index. Reach for a dedicated search engine when you need typo tolerance, faceting, relevance tuning, or search across a very large corpus, and accept that you now have a second datastore to keep in sync.

## When Redis or a cache helps

A cache turns an expensive read into a cheap one at the cost of possibly stale data. It helps when the same expensive read happens far more often than the underlying data changes: rendered pages, aggregated dashboards, permission lookups, external API responses, session data. It does not help a read that is unique per request, and it hides a slow query rather than fixing it.

- Every cache entry needs a TTL. Even if you invalidate explicitly, TTL is the safety net.
- **Invalidation** is the hard part. Invalidate on write in the same code path that writes, or accept staleness and pick a TTL to match. Avoid patterns where five different writers each need to remember to invalidate.
- Cache-aside (read cache, on miss read DB and populate) is the common pattern. Watch for stampedes: many requests missing at once and all hitting the database. Lock or single-flight the refill.
- Redis is also the standard home for rate limit counters, distributed locks, job queues and pub/sub. That is fine, but treat it as ephemeral. If losing it would lose data, it was the wrong store.

## When a document store is actually justified

Document databases fit data that is naturally a self-contained document read and written as a whole, with little need for joins or cross-document transactions: content pages, product catalog entries with wildly varying attributes, event logs. Most web apps have relational data with a few document-shaped corners, and a relational database with JSON columns covers the corners.

- Pick a document store when the schema genuinely varies per record and the access pattern is by document id or a couple of indexed fields.
- Do not pick it to avoid migrations. The schema still exists, it is just in your code now, unversioned.
- The moment you need "all orders for customers in region X with more than three returns", you are doing joins in application code.

## Backups and restores

A backup you have not restored is a hope, not a backup. Automated daily snapshots plus continuous write-ahead log archiving gives point-in-time recovery to any moment in the retention window. That is the standard and every managed database offers it.

- Restore to a scratch instance on a schedule and run a smoke test. Time it. That number is your actual recovery time.
- Backups live in a different account or region from the database. A credential leak that deletes the database should not be able to delete the backups.
- Know what is not in the backup: object storage, Redis, third-party state.

## Seeds and fixtures for local development

Seed data is a versioned script that populates a fresh database with enough realistic data to run the app: a few users with known logins, a mix of records in every state, some edge cases. Fixtures are the equivalent for tests: small, explicit, created per test rather than shared.

- Never seed with production data. Generate synthetic data or anonymise properly, which is harder than it sounds.
- Tests that depend on a shared fixture set become order-dependent. Build what each test needs with factories.

## Data privacy basics

Personal data is anything that identifies a person: name, email, IP address, device id, location, and combinations that identify together. Privacy law (GDPR, CCPA and relatives) gives people rights over that data and gives you obligations: collect only what you need, keep it only as long as needed, protect it, delete it on request, and be able to say where it is.

- Inventory it. Know which tables and columns hold personal data, which logs contain it, which third parties receive it.
- **Retention:** define a retention period per category and enforce it with a job. Data you no longer hold cannot leak.
- **Deletion:** a real deletion or anonymisation path that covers the database, backups within their retention window, search indexes, caches, logs and downstream systems.
- **Minimise in logs.** Emails, tokens and request bodies do not belong in log lines. Log ids.
- Access to production data is a logged, limited privilege, not a default for every engineer.

## Key takeaways

- Immutable surrogate primary keys, unique constraints for natural keys.
- Foreign keys are real constraints, and they almost always need an index.
- Normalize by default, denormalize only for a measured hot read path.
- Composite indexes serve leftmost columns only, equality first, range last.
- Functions in WHERE defeat plain indexes.
- A transaction alone does not fix read-then-write races.
- Unique constraints and atomic updates are the cheapest concurrency control.
- N+1 is invisible in development, fail tests on query count.
- Migrations are forward-only, never edit one already applied.
- Expand/contract every schema change so old and new code both work.
- Pool exhaustion looks like a slow database, check pool wait first.
- A backup you have not restored is a hope.
