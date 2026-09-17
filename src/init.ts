import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

/**
 * Scaffolds the call sites into a repo, and only the ones that were asked for.
 *
 * Two rules, for the same reason. It installs nothing by default beyond its own
 * config file: a hook that edits someone's git configuration or their agent
 * settings as a side effect of a setup command is intrusive, however useful it
 * is. And it never overwrites, because an existing hook or settings file
 * belongs to whoever wrote it. Anything already present is reported and left
 * alone.
 */
export interface InitResult {
  written: string[];
  /** Files that existed and were replaced, which only --force does. */
  replaced: string[];
  /** Files that existed and gained something they did not have before. */
  updated: string[];
  skipped: { path: string; why: string }[];
}

/** Which call sites to install. Neither is on unless it was asked for. */
export interface InitOptions {
  gitHook: boolean;
  claudeHook: boolean;
  /**
   * Replace files this tool owns instead of leaving them alone. The escape
   * hatch for the case that motivated it: a repo set up by an older version,
   * where the call sites have since gained a hook it never wrote. It does not
   * extend to a `prepare` script, which belongs to whoever wrote it.
   */
  force: boolean;
}

/**
 * The hooks live in a committed directory, not in `.git/hooks`, which git does
 * not track. A hook under `.git/hooks` reaches whoever ran `init` and nobody
 * else, which makes the commit gate per-developer rather than per-repo.
 */
export const HOOKS_DIR = "hooks";

/** What a repo adds to its `prepare` script to get the hooks on `npm install`. */
export function prepareLine(runner: string): string {
  // `|| true` because `npm ci --omit=dev` runs prepare without the tool
  // installed. A missing dev dependency must not fail the install.
  return `${runner} install-hooks || true`;
}

function preCommit(runner: string): string {
  return `#!/bin/sh
# Installed by agentic-qa.
#
# Checks staged files. What runs is the commit row of agentic-qa's call-site
# table, adjusted under callSites in qa.config.yaml; never a model call. The
# judgment rules run in CI, where nobody can skip them with --no-verify.
exec ${runner} commit
`;
}

function claudeSettings(runner: string): string {
  return (
    JSON.stringify(
      {
        hooks: {
          // No matcher, so the guardrails arrive on startup, resume, clear and
          // after compaction alike: each is a context that has lost them.
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `${runner} session-start`,
                  timeout: 30,
                },
              ],
            },
          ],
          // No matcher: Stop fires once when the agent finishes a turn, and
          // sees every change the turn made, however it was made.
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: `${runner} stop`,
                  timeout: 300,
                  statusMessage: "agentic-qa: checking rules",
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ) + "\n"
  );
}

const QA_CONFIG = `# How agentic-qa checks this repo.
testGlobs:
  - "**/*.{test,spec}.{ts,tsx}"

ignore:
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/.qa/**"

judge:
  model: haiku
  concurrency: 4
  maxBudgetUsd: 0.5

# Turn on once every test description is falsifiable, and keep it on.
failOnUnverifiable: false
`;

function put(
  cwd: string,
  relative: string,
  contents: string,
  result: InitResult,
  options: { force: boolean; executable?: boolean; skipReason?: string },
): void {
  const path = resolve(cwd, relative);
  const exists = existsSync(path);

  if (exists && !options.force) {
    result.skipped.push({
      path: relative,
      // Only files --force can actually replace may advertise it. Telling
      // someone to re-run with a flag that will not touch this file — worse,
      // telling them so in the output of the run where they just passed it —
      // is noise that trains people to ignore the report.
      why: options.skipReason ?? "already exists, left alone — pass --force to replace it",
    });
    return;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (options.executable) chmodSync(path, 0o755);
  (exists ? result.replaced : result.written).push(relative);
}

export interface InstallHooksResult {
  installed: boolean;
  why: string;
}

/**
 * Points `core.hooksPath` at the committed hooks directory.
 *
 * Runs from the repo's `prepare` script, which npm runs on every install, so
 * a developer cloning the repo needs no git command of their own. That means
 * it runs in places where installing a hook is wrong or impossible, and every
 * one of them has to be a quiet no-op rather than a failed install.
 */
export function installHooks(cwd: string): InstallHooksResult {
  if (process.env.CI) return { installed: false, why: "CI, hooks are pointless here" };
  if (!existsSync(resolve(cwd, ".git")))
    return { installed: false, why: "not a git repository" };
  if (!existsSync(resolve(cwd, HOOKS_DIR)))
    return { installed: false, why: `no ${HOOKS_DIR}/ directory` };

  execFileSync("git", ["config", "core.hooksPath", HOOKS_DIR], { cwd });
  return { installed: true, why: `core.hooksPath -> ${HOOKS_DIR}` };
}

/**
 * Adds the prepare script, if and only if there is no prepare script.
 *
 * This is the one place `init` touches a file that already exists, it happens
 * only behind the git-hook flag, and it adds a key rather than changing one: an
 * existing `prepare` belongs to whoever wrote it, so that case is reported with
 * the exact line to add and left alone.
 */
function wirePrepare(cwd: string, runner: string, result: InitResult): void {
  const path = resolve(cwd, "package.json");
  if (!existsSync(path)) {
    result.skipped.push({ path: "package.json", why: "no package.json here" });
    return;
  }

  const pkg = JSON.parse(readFileSync(path, "utf8"));
  const existing: string | undefined = pkg.scripts?.prepare;

  if (existing?.includes("install-hooks")) {
    result.skipped.push({ path: "package.json", why: "prepare already installs the hooks" });
    return;
  }

  if (existing) {
    result.skipped.push({
      path: "package.json",
      why: `has its own prepare script; add: ${prepareLine(runner)}`,
    });
    return;
  }

  pkg.scripts = { ...pkg.scripts, prepare: prepareLine(runner) };
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  result.updated.push("package.json");
}

/**
 * Installs the commit gate: the tracked hook, the prepare script that activates
 * it on install, and the git config for whoever ran this.
 */
function installGitHook(
  cwd: string,
  runner: string,
  result: InitResult,
  force: boolean,
): void {
  put(cwd, join(HOOKS_DIR, "pre-commit"), preCommit(runner), result, {
    force,
    executable: true,
  });
  wirePrepare(cwd, runner, result);

  // The person running init should not have to install to get their own hook.
  const hooks = installHooks(cwd);
  if (!hooks.installed) {
    result.skipped.push({ path: "core.hooksPath", why: hooks.why });
    return;
  }
  result.updated.push(`core.hooksPath -> ${HOOKS_DIR}`);

  // An earlier version of init wrote here. Once core.hooksPath is set, git
  // stops reading this directory, so a stale copy silently does nothing.
  const legacy = resolve(cwd, ".git", "hooks", "pre-commit");
  if (existsSync(legacy) && readFileSync(legacy, "utf8").includes("Installed by agentic-qa")) {
    result.skipped.push({
      path: ".git/hooks/pre-commit",
      why: "superseded by hooks/pre-commit and now inert; safe to delete",
    });
  }
}

/**
 * Which call sites a repo already has, whoever installed them and whenever. A
 * run that did not pass a flag says nothing about whether that call site exists,
 * so offering it on that basis tells someone with a working hook to install it.
 */
export function installedCallSites(cwd: string): { gitHook: boolean; claudeHook: boolean } {
  const read = (relative: string) => {
    try {
      return readFileSync(resolve(cwd, relative), "utf8");
    } catch {
      return "";
    }
  };

  let claudeHook = false;
  try {
    const settings = JSON.parse(read(join(".claude", "settings.json")) || "{}");
    const stops: { hooks?: { command?: unknown }[] }[] = settings?.hooks?.Stop ?? [];
    claudeHook = stops.some((entry) =>
      (entry.hooks ?? []).some((h) => typeof h.command === "string" && /\bstop\b/.test(h.command)),
    );
  } catch {
    // An unreadable settings file has no hook in it that Claude Code will run.
  }

  return { gitHook: /\bcommit\b/.test(read(join("hooks", "pre-commit"))), claudeHook };
}

export function runInit(cwd: string, runner: string, options: InitOptions): InitResult {
  const result: InitResult = { written: [], replaced: [], updated: [], skipped: [] };

  // The config is the tool's own file, and the command line is what every repo
  // gets. The call sites that touch anything else are opt-in.
  //
  // Never force-replaced, deliberately. This file is seeded once and then
  // belongs to the repo: its globs, its ignore list, its budget. The hook
  // wiring below is generated boilerplate that the tool owns and that an older
  // version may have written incompletely, which is the whole reason --force
  // exists. Replacing someone's tuned config to pick up a new hook would be a
  // trade nobody asked for.
  put(cwd, "qa.config.yaml", QA_CONFIG, result, {
    force: false,
    skipReason: "already exists — yours to edit, never replaced",
  });

  if (options.claudeHook) {
    put(cwd, join(".claude", "settings.json"), claudeSettings(runner), result, {
      force: options.force,
    });
  }

  if (options.gitHook) {
    installGitHook(cwd, runner, result, options.force);
  }

  return result;
}
