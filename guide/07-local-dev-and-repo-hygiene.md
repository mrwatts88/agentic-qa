# Local Dev and Repo Hygiene

*How a project runs on a laptop, how its history stays readable, and which guardrails belong in the repo rather than in someone's head.*

**Read when:** changing local setup, env files, git hooks, lint or format config, scripts, dependencies, or the README and agent instruction files.

## Docker and Compose for the local stack

The local stack is the app plus its dependencies: a database, a cache, usually a mail catcher (Mailpit or similar) so outgoing email lands in a local inbox instead of a real one. Compose describes that set in one file, `compose.yaml` (the old `docker-compose.yml` name still works, and the top-level `version:` key is obsolete and should be gone). One command brings the whole thing up, and a new hire gets a working environment without a wiki page of install steps.

The pieces you actually configure: named volumes so database data survives restarts, healthchecks so a service reports when it is really ready and not just when its process started, and `depends_on` with `condition: service_healthy` so the app waits for the database rather than racing it. Profiles mark optional services (an admin UI, a worker, a test database) that only start when asked. An `.env` file next to the compose file feeds variable substitution, and a `compose.override.yaml` is loaded automatically on top of the base file, which is where local-only ports and bind mounts belong.

```yaml
services:
  app:
    build: .
    ports: ["3000:3000"]
    env_file: .env
    depends_on:
      db: { condition: service_healthy }
  db:
    image: postgres:17
    volumes: [dbdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 10
  mail:
    image: axllent/mailpit
    profiles: [tools]
volumes:
  dbdata:
```

- Run the dependencies in containers always. Run the app itself on the host when you want fast reloads, native debuggers, and editor integration. Run the app in a container when the production image is the thing you need to verify, or when native toolchains are painful to install.
- `depends_on` without a condition only orders container start, not readiness. That distinction causes most "works on second try" bugs.
- Bind mounts for source code are for the app service only. Never bind mount database data directories from the host.
- Pin dependency images to a major version at minimum. `postgres:latest` will silently jump majors and refuse to start on old data files.

**Gets you burned:**
- Volume left over from an old schema. `docker compose down -v` is the reset, and people forget it exists.
- Port collisions with a host-installed Postgres or Redis on the same default port.
- Secrets committed in `compose.yaml` because "it is only local". They get copied into staging configs.

**When reviewing AI-written code:**
- Check that healthchecks test the service, not the container. `curl localhost` inside a container without curl installed fails forever.
- Check the override file is not required for the base file to work. CI and other people use only the base.

## Devcontainers at a glance

A devcontainer is a `.devcontainer/devcontainer.json` that tells an editor (VS Code, JetBrains, Codespaces, and most agent sandboxes) to open the repo inside a container with the toolchain pre-installed. It usually references the same compose file. The payoff is that "install these twelve things first" disappears and everyone, including AI agents running in cloud sandboxes, gets the same toolchain. The cost is slower file I/O on macOS and one more artifact to keep current. Worth it for teams with onboarding churn or heavy native dependencies. Optional for a small team on one language.

## Env files and config precedence

Configuration comes from layers and the order matters. The usual precedence, highest first: explicit environment variables in the shell, then `.env.local` or similar untracked overrides, then `.env`, then defaults in code. The code should read config once at startup into a typed object and fail loudly if a required value is missing. Reading `process.env` or `os.environ` scattered through the codebase is how a missing variable becomes a runtime crash on a code path nobody hit in testing.

- `.env` is gitignored. `.env.example` is committed, lists every variable with a placeholder or safe default, and is the documentation of what the app needs.
- Compose reads `.env` for substitution in the file itself. `env_file:` on a service passes it to the container. These are different mechanisms and people conflate them.
- Local values should be obviously fake. A real API key in `.env.example` is a leak.

**Gets you burned:**
- A new variable added to code but not to `.env.example`. The next person spends an hour on a cryptic startup error.
- Booleans as strings. `"false"` is truthy in most languages.

## Git workflow

Trunk-based development is the default for teams that deploy continuously: one main branch, short-lived feature branches measured in hours or a couple of days, merged through PRs, with incomplete work hidden behind flags rather than parked on long branches. Gitflow, with its develop and release and hotfix branches, is now widely treated as legacy, including by its author, and fits only when you ship versioned releases to customers who install them. The DORA research links trunk-based practice to better delivery metrics, but the mechanism is simple: small diffs integrated often produce fewer merge conflicts and smaller blast radii.

Rebase your branch onto main to keep it current, merge to main via squash. Squash merging gives main a clean one-commit-per-PR history and makes the commit message on the PR the thing that matters. Interactive rebase before opening a PR is fine for tidying a branch. Rewriting history that other people have pulled is not.

- Conventional commits (`feat:`, `fix:`, `chore:`, with an optional scope) are worth adopting only if a tool consumes them for changelogs or version bumps. Otherwise the rule is just: imperative subject under 72 characters, body explains why, not what.
- `git bisect` finds the commit that broke something by binary search. It only works when every commit builds, which is another argument for squash merges.
- `git stash` holds work in progress while you switch context. Worktrees are better when the switch lasts more than a few minutes: a second checkout of the same repo in a sibling directory, no stashing, and each AI agent can work in its own worktree without stepping on the others.
- Feature branch naming matters less than people argue about. Pick one pattern and move on.

**Gets you burned:**
- Long-lived branches. Every day a branch is open the merge gets worse.
- Force-pushing to a shared branch.
- Merge commits from main into a feature branch repeatedly, producing a history that bisect cannot use.

## PR hygiene

A PR is a unit of review, and review quality falls off fast past a few hundred lines. Split by concern, not by file count: a refactor PR followed by a behavior PR is easier to review than one that does both. The description says what changed and why, how to verify it, and what is deliberately out of scope. Draft PRs signal "not ready for review, but CI should run and you may look."

Self-review before requesting review. Read your own diff in the PR UI, not the editor. You will catch the debug statement, the stray file, the rename you half finished. With AI writing most of the code this step matters more, not less: you are the first human to read it.

- Branch protection on main: require PR, require CI green, require at least one review, no direct pushes, no force push. Include admins.
- Stacked PRs are the answer to "this feature is legitimately 2000 lines." Tools exist, but plain branches off branches work.
- Review comments distinguish blocking from nit. Say which.

**When reviewing AI-written code:**
- The diff often includes drive-by changes the prompt did not ask for. Push those to their own PR or drop them.
- Generated descriptions summarize what the code does. Rewrite to say why and what you checked.

## Git hooks and pre-commit tooling

Hooks run scripts at commit or push time. The tooling manages hook installation across the team since `.git/hooks` is not committed. In the JS world that is Husky plus lint-staged (run tools only on staged files) or Lefthook (one YAML, parallel, language-agnostic, Go binary). In Python and polyglot repos the `pre-commit` framework is the standard. Lefthook has been gaining across ecosystems because it is faster and does not depend on a package manager.

The rule for what belongs in a hook: fast, deterministic, and fixable in seconds. Formatting, a lint pass on staged files, secret scanning, maybe a commit message check. Anything over a few seconds moves to pre-push or CI. Type checking and the full test suite belong in CI. A slow pre-commit hook teaches everyone to use `--no-verify`, and then the hook protects nothing.

- Hooks are a convenience, CI is the enforcement. Never rely on a hook for anything that matters, because it can be skipped.
- Auto-fixing formatters in hooks are fine. Auto-fixing lint rules in hooks can surprise people with diffs they did not write.

## Linting vs formatting

These are separate concerns and should be separate tools, or at least separately configured. A formatter decides whitespace, line breaks, and quote style, and it is not negotiable: pick one, run it on save and in the hook, never discuss it in review again. A linter enforces codified taste and catches real bugs: unused variables, unreachable code, unsafe patterns, import ordering. Lint rules are decisions the team made once so nobody has to relitigate them per PR.

- Type checking is another lint. It runs in CI, it blocks merge, and its config (strictness level) is a team decision.
- `.editorconfig` covers the basics (indent, line endings, trailing newline) for every editor, including the ones that do not run your formatter. Keep it, it is ten lines.
- Every rule that gets disabled inline more than a few times is either wrong for this codebase or needs a better fix. Look at the count.

**When reviewing AI-written code:**
- Watch for blanket `eslint-disable` or `# type: ignore` comments added to make the build pass. Those hide the exact bugs the tools exist to catch.

## Task runners as the command surface

Every project needs a single place where the commands live: `make dev`, `just test`, `npm run lint`. The runner does not matter much. A Makefile is universal but has tab and phony-target foot-guns. `justfile` is a Makefile without the baggage. Package manager scripts are fine for single-language repos. What matters is that the README says "run `just dev`" and that CI calls the same targets developers do, so there is exactly one definition of "run the tests."

- Targets: `dev`, `test`, `lint`, `fmt`, `typecheck`, `build`, `db-reset`, `seed`. Nearly every repo wants that set.
- Agent instruction files should point at these targets rather than re-describing the commands.

## README, CONTRIBUTING, ADRs

The README answers: what is this, how do I run it, how do I run the tests. If it takes more than that, the setup is the problem. CONTRIBUTING covers branch and PR conventions and where to ask. Architecture Decision Records are short dated documents, one per significant decision, that say what was decided, what the alternatives were, and why. They live in the repo, are append-only, and stop the same debate from recurring every time someone new joins. Superseded ADRs get a note pointing at the replacement, they do not get deleted.

## Agent instruction files

`AGENTS.md` has become the cross-tool convention for telling coding agents how a repo works. `CLAUDE.md` is Claude Code's own file, and the common pattern is to keep one real file and have the other import or symlink it. Treat these as a real repo artifact reviewed like code. Contents that earn their place: the commands to run, the conventions that are not obvious from the code, the directories not to touch, and the checks to run before declaring done. Contents that do not: restating what the code shows, long style guides, anything a linter already enforces.

- Keep them short. A long file is skimmed, not followed.
- These files are an injection surface. An instruction file from an untrusted fork or a dependency should be read before an agent acts on it.

## Monorepo vs polyrepo

A monorepo puts multiple deployable things in one repo, sharing tooling and allowing atomic cross-cutting changes. It needs a build tool that understands the graph (Turborepo, Nx, Bazel-class, or workspaces plus discipline) or CI gets slow. Polyrepo gives each service its own repo, which is simpler until shared code needs versioning and publishing. For a small team with one web app, one API, and a shared types package, a monorepo with workspaces is the default. Split when teams or deploy cadences genuinely diverge.

## Dependency management

Lockfiles are committed, always, for applications. They make installs reproducible and are the thing that lets CI and production match your laptop. Install in CI with the frozen or ci mode so a drifted lockfile fails instead of silently updating. Pin major versions in the manifest and let the lockfile pin exact versions.

Upgrade on a cadence rather than never and rather than instantly. A bot (Dependabot, Renovate) that opens grouped weekly PRs is the practical middle: patches merge on green CI, majors get a human. Letting dependencies go stale for a year turns the upgrade into a project.

**Gets you burned:**
- Lockfile conflicts resolved by deleting and regenerating, which quietly upgrades everything.
- A transitive dependency with a security advisory that nobody sees because scanning is not in CI.

## Seeding local data

A fresh database with no rows tests nothing. A seed script creates a realistic minimal dataset: a couple of users with known credentials, a few records in every important state, edge cases you keep hitting. It runs idempotently, is fast, and is part of `db-reset`. Production data copies are tempting and are a compliance problem unless scrubbed. Prefer generated data shaped like production.

## Local HTTPS and tunnels

Webhooks from Stripe, GitHub, or an auth provider need a public URL. Tunnels (ngrok, Cloudflare Tunnel, or the provider's CLI forwarding) expose your local port for the session. Some browser features and cookie settings behave differently on plain HTTP, so a local certificate via `mkcert` or the framework's built-in HTTPS mode avoids surprises that only show in production. Neither should be in the critical path of running the app.

## Dotfiles and tooling reproducibility

Toolchain versions live in the repo: `.node-version`, `.tool-versions` (asdf or mise), `.python-version`, or the version field in the manifest. A version manager reads them and switches automatically. This is what keeps "works on my machine" from being a version mismatch. Personal dotfiles (shell, editor) are yours and belong in your own repo, not the project's.

## Key takeaways

- Run dependencies in containers always, the app on the host for fast reloads.
- `depends_on` without `condition: service_healthy` orders start, not readiness.
- Pin dependency images to a major version, never `latest`.
- Never commit secrets to `compose.yaml`, even for local.
- Read config once at startup into a typed object, fail loudly if missing.
- Keep `.env.example` current with every variable, using obviously fake values.
- Trunk-based development, short branches, rebase onto main, squash merge.
- Never force-push a shared branch or rewrite pulled history.
- Split PRs by concern, self-review your own diff in the PR UI.
- Hooks are convenience, CI is enforcement. Slow hooks teach `--no-verify`.
- Reject blanket `eslint-disable` or `type: ignore` added to pass builds.
- Commit lockfiles, install frozen in CI, never regenerate to resolve conflicts.
