# DevOps and Delivery

*Getting a commit from a laptop to production repeatedly, safely, and without heroics.*

**Read when:** changing CI/CD, containers, deploys, environments, feature flags, or how migrations run in the pipeline.

## CI/CD pipeline stages

A pipeline is a sequence of checks that a change must pass. The typical stages, in order of cheapness: install with a frozen lockfile, lint, typecheck, unit and integration tests, build the artifact, scan it, deploy it. Fast stages run first so a typo fails in thirty seconds instead of ten minutes. Stages that do not depend on each other run in parallel.

What runs on a PR: everything up to and including build and scan, so the reviewer knows the change is mergeable. What runs on merge to main: the same again (main can differ from the branch), then deploy to staging, and either deploy to production automatically or gate behind a manual approval. Tag pushes may trigger release-specific steps.

- CI calls the same task runner targets developers use. If CI has its own lint command, the two drift.
- Cache what is expensive and deterministic: dependency installs keyed on the lockfile hash, build caches, Docker layers. A cache keyed wrong (on branch name, on nothing) is worse than no cache because it produces stale results silently.
- Flaky tests get quarantined and fixed, not retried forever. A pipeline people rerun until green is a pipeline nobody trusts.
- Secrets in CI come from the CI system's secret store, scoped to the jobs that need them. Never printed, and PRs from forks should not get them.

**Gets you burned:**
- A pipeline that takes twenty minutes. People batch changes to avoid it, PRs get big, and the whole delivery loop slows.
- Build in CI differs from build in the deploy step, so what was tested is not what shipped.

## Containers and images

A Dockerfile turns the repo into an image. The practices that matter: multi-stage builds so the build toolchain (compilers, dev dependencies) stays out of the final image, a small base image (slim or distroless variants) so the attack surface and pull time shrink, and a non-root user so a compromised process is not root inside the container. Order the Dockerfile so rarely changing layers (base image, dependency install) come before frequently changing ones (source copy), because layer caching invalidates everything after the first changed layer.

`.dockerignore` keeps `node_modules`, `.git`, `.env`, and build output out of the build context. Without it, builds are slow and secrets end up in image layers.

- Copy the manifest and lockfile, install, then copy the rest of the source. That ordering is the whole layer-caching trick.
- One process per container. The app server in one, the worker in another, from the same image with different commands.
- The image should not need environment-specific values baked in. Config arrives at runtime.

**When reviewing AI-written code:**
- Generated Dockerfiles commonly run as root, use `latest` tags, and copy the whole repo before installing dependencies. Fix all three.
- Check that the final stage does not carry a package manager cache or the test suite.

## Registries and tagging

Images push to a registry (GHCR, ECR, Docker Hub, or the PaaS's own). Tag every image with something immutable: the git SHA, or a build number. Mutable tags like `latest` or `main` are fine as pointers but never as the thing a deploy references, because "what is running in production" must be answerable exactly. A rollback is a deploy of a previous immutable tag, which only works if you kept it.

- Retention policies on the registry, or it fills with years of images.
- Sign or at least scan images if anything you run is exposed to compliance questions.

## Environments

Development is the laptop. Staging is a production-shaped environment for verifying a build before real users see it. Production is production. Preview environments are per-PR ephemeral deploys, which many PaaS platforms and frontend hosts do automatically, and they are the best tool for "let the designer click through it" and for testing against a real URL.

Staging is only useful if it resembles production: same image, same config shape, same infrastructure type, smaller scale. A staging that is hand-configured and drifted is a false sense of safety. Data is the hard part. Staging usually runs on synthetic or scrubbed data, never a live copy of production.

- Config differs per environment, code does not. The same image runs everywhere.
- Secrets differ per environment and live in the platform's secret store, injected as environment variables or mounted files. Config that is not secret (feature settings, URLs, limits) can live in plain env vars or a committed per-env file.
- Every environment gets its own database, cache, and third-party credentials (Stripe test mode, sandbox APIs). Sharing any of these between staging and production is a recurring source of incidents.

## Twelve-factor at a glance

The twelve-factor app is a 2011 checklist that still describes what a PaaS expects: one codebase, explicit dependencies, config in the environment, backing services as attached resources, strict build/release/run separation, stateless processes, port binding, scale by adding processes, fast startup and graceful shutdown, dev/prod parity, logs as event streams to stdout, admin tasks as one-off processes. If your app follows it, it runs on any platform. If it writes to local disk, keeps session state in memory, or reads config from a file it edits, deployment will be painful everywhere.

## Deploy strategies

Rolling: replace instances a few at a time, old and new versions run together briefly. Default on most platforms. Blue/green: stand up the new version alongside the old, switch traffic all at once, keep the old ready for instant rollback. Costs double capacity for a while. Canary: send a small slice of traffic to the new version, watch error rates, widen or abort. Needs traffic splitting and good metrics to be worth doing.

For most teams on a PaaS the answer is rolling, with the platform managing it. What you owe the platform is a health check that means something and a version that can coexist with the previous one for a few minutes.

- All three strategies imply two versions running at once. Code and schema must tolerate that.
- Deploy is not release. Deploying puts code on servers. Releasing makes a behavior visible to users. Feature flags separate them.

## Rollbacks

The fastest fix for a bad deploy is deploying the previous image. That should be one command or one click, tested occasionally, and known to everyone on call. The complication is the database: if the deploy ran a migration that dropped a column or changed a type, the old code may not run against the new schema. That is why migrations are written to be backward-compatible with the previous code version, so rolling back code never requires rolling back the schema.

- Rollback first, diagnose second. A rolled-back production with a confused engineer is better than a broken production with an enlightened one.
- Data written by the new version during its brief life must be readable by the old version, or at least not crash it.

## Feature flags

A flag is a runtime switch that decides whether a code path is active, evaluated per request and often per user or percentage. It lets you merge incomplete work to main, deploy it dark, and turn it on later for a subset, and turn it off in seconds without a deploy when it misbehaves. Kill switches for risky integrations (a new payment provider, a new search backend) are the highest-value flags.

Flag debt is the cost. Every flag is a branch in the code and a combination to test. Flags get removed once fully rolled out, and the cleanup ticket is created when the flag is.

- Flag evaluation must be fast and must fail to a safe default when the flag service is unreachable.
- Do not put flags in the database schema path. Schema changes are not toggleable.
- A homegrown table of booleans is fine for a small team. A flag service is worth it when you need percentages, targeting, and an audit trail.

## Database migrations in the pipeline

Migrations are versioned, ordered, committed scripts that change the schema. They run as a pipeline step before the new code starts serving, or as a release phase command on the platform. They must be safe to run while the old code is still serving traffic, because it is, during any rolling deploy.

The expand/contract pattern: add the new column (nullable, or with a default), deploy code that writes both old and new, backfill, deploy code that reads new, then in a later release drop the old column. Each step is backward-compatible with its neighbors. Destructive changes always land in a separate, later migration.

- Long-running migrations on large tables lock things. Know what your database locks on `ALTER TABLE` and add indexes concurrently where supported.
- Migrations run exactly once, in order, and are never edited after merge. Write a new one.
- Test migrations against a production-sized dataset at least once before assuming they are fast.

**When reviewing AI-written code:**
- Generated migrations tend to rename or drop in one step. Split them.
- Check for a down migration that actually works, or an explicit decision that there is none.

## Infrastructure as code

IaC means your cloud resources (databases, buckets, DNS, queues, permissions) are declared in files, applied by a tool, and changed through PRs. Terraform and OpenTofu use a declarative HCL language, Pulumi and CDK let you write it in a general-purpose language. All of them keep state: a record of what the tool believes exists, stored remotely and locked during applies. Drift is when reality diverges from the declaration because someone clicked in a console. Tools detect it on the next plan.

For a small team on a PaaS, most of this is handled by the platform, and a per-service config file in the repo is the IaC. Reach for Terraform-class tooling when you have more than a handful of cloud resources outside the PaaS, or when reproducing the environment from scratch needs to be possible.

- Plan before apply, and read the plan. A destroy-and-recreate on a database shows up there.
- State files contain secrets. Store them somewhere locked down.

## PaaS vs managed Kubernetes vs serverless

PaaS (Railway, Render, Fly, Heroku-class): give it a repo or image, it builds, runs, scales, and handles TLS and logs. The right default for most teams, and the ceiling is higher than people assume. Managed Kubernetes: maximum control and portability, and a permanent tax in YAML, upgrades, and someone who understands it. Justified when you have many services, unusual networking needs, or a platform team. Serverless functions: pay per invocation, scale to zero, cold starts and execution limits. Good for event handlers, scheduled jobs, and glue. Awkward as the primary home for a stateful web app with connection pools.

Choose the simplest thing that works and move only when a concrete limit is hit. Migrating a twelve-factor app between these is a project, not a rewrite. The [Infrastructure](11-infrastructure.html) page covers what you take on when the platform is a raw cloud account.

## Health checks, readiness, zero-downtime

The platform asks your app "are you alive" and "are you ready" and routes traffic based on the answers. Liveness: the process is running and not deadlocked, restart it if this fails. Readiness: the app can serve requests now (database reachable, caches warmed), stop routing to it if this fails. A readiness check that only returns 200 unconditionally defeats rolling deploys, because traffic arrives before the app can handle it.

Zero-downtime deploys are the combination: new instances come up, pass readiness, receive traffic, then old instances get a shutdown signal, stop accepting connections, finish in-flight requests, and exit. Your app must handle SIGTERM by draining, not by dying instantly, and the platform's grace period must exceed your longest request.

- Readiness checks should be cheap. They run every few seconds.
- Do not make readiness depend on third-party APIs. One vendor outage would take your whole fleet out of rotation.

## DNS and TLS

On a PaaS: add a custom domain, point a CNAME at the platform, certificates are issued and renewed automatically via ACME (Let's Encrypt). On your own infrastructure: a reverse proxy or ingress with an ACME client does the same. Manual certificate renewal is a thing of the past and a thing that pages you at 3am when forgotten. DNS changes take time to propagate and TTLs matter when you plan to move traffic.

## Reproducible builds and versioning

The same commit should produce the same artifact. That requires a frozen lockfile, pinned base images, and no network fetches at build time that can change. Stamp the build with its git SHA and expose it (a `/version` endpoint, a log line at startup) so "what is running" is a question with an answer.

Semantic versioning (major.minor.patch, breaking.feature.fix) matters for libraries and for anything customers install. For a continuously deployed web app the SHA is the version and release notes are a changelog generated from merged PRs or conventional commits, if anyone reads them. A tagged release per notable change is enough.

## On-call for a small team

On-call means someone is reachable when production breaks. For a small team: one person at a time, a rotation that is visible in the calendar, a paging tool (PagerDuty, Opsgenie, or the platform's alerting) that escalates if unacknowledged, and a hard rule that only real user-facing symptoms page. Being paged for a disk at 80 percent at 2am is how people quit. Everything else is a ticket for business hours.

- Every page should have a runbook or a link to one.
- On-call includes the authority to roll back without asking.
- Pages that recur get a fix ticket with priority, not a longer runbook.

## Cost awareness

Cloud bills come from a few places: compute running when idle, storage that grows forever (logs, images, backups, buckets), egress, and managed services priced per unit that scale with traffic you did not expect. Know what your monthly bill is and what the top three lines are. Set a budget alert. Retention policies on logs, registries, and backups are the most common missed saving. Scale to zero or downsize non-production environments overnight. None of this is FinOps, it is looking at the bill once a month.

## Key takeaways

- Cheap pipeline stages first, independent stages in parallel, same targets as developers.
- Quarantine and fix flaky tests, never rerun until green.
- A cache keyed wrong is worse than no cache.
- Dockerfiles: multi-stage, small base, non-root, install deps before copying source.
- Deploy only immutable tags like the git SHA, never `latest`.
- Staging is only useful if it resembles production, with its own credentials.
- Config differs per environment, code and image do not.
- Every deploy strategy runs two versions at once, so code and schema must tolerate it.
- Rollback first, diagnose second. Migrations stay backward-compatible with previous code.
- Use expand/contract, and land destructive migration steps separately and later.
- Readiness must mean something, and must never depend on third-party APIs.
- Handle SIGTERM by draining, with grace period longer than your longest request.
- Only user-facing symptoms page. On-call can roll back without asking.
