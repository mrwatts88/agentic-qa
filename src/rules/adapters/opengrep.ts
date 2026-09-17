import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, ToolFinding, ToolRun } from "./types.js";
import { ensureBinary, ensureSemgrepRules, OPENGREP, SEMGREP_RULES } from "../../tools/provision.js";

/**
 * Opengrep running the semgrep community rules: the security and configuration
 * gauntlet. It follows untrusted input to dangerous sinks, and it reads the
 * files eslint cannot: Terraform, Dockerfiles, GitHub Actions workflows.
 *
 * Opengrep rather than semgrep because it is a single downloadable binary that
 * runs the same rules (it matched semgrep's findings, plus one, on a probe
 * app), so it can be provisioned automatically where semgrep's Python install
 * cannot.
 *
 * Slow: most of a run is loading rules, about 4s for the TypeScript and
 * JavaScript sets. So it is kept out of the per-edit hook, and it loads only
 * the rule sets for the kinds of file actually being checked.
 */

/** Which rule directories apply to a file. Empty means opengrep has nothing to say. */
export function ruleDirsFor(file: string): string[] {
  if (/\.(ts|tsx|mts|cts)$/.test(file)) return ["javascript", "typescript"];
  if (/\.(js|jsx|mjs|cjs)$/.test(file)) return ["javascript"];
  if (/\.tf$/.test(file)) return ["terraform"];
  if (/(^|\/)Dockerfile[^/]*$|\.dockerfile$/.test(file)) return ["dockerfile"];
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) return ["yaml/github-actions"];
  return [];
}

interface Result {
  check_id: string;
  path: string;
  start: { line: number };
  extra: { message: string };
}

/**
 * Opengrep prefixes a rule id with the dotted path of the directory it was
 * loaded from, which differs on every machine. The stable id is what follows
 * the rules root: `javascript.express.security.express-open-redirect`.
 */
export function stableRuleId(checkId: string, rulesRoot: string): string {
  const dotted = rulesRoot.replace(/^[/\\]+/, "").split(/[/\\]/).join(".");
  return checkId.startsWith(`${dotted}.`) ? checkId.slice(dotted.length + 1) : checkId;
}

function firstSentence(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return (end === -1 ? flat : flat.slice(0, end + 1)).slice(0, 200);
}

export interface OpengrepOptions {
  /** A binary to use instead of provisioning one. */
  binary?: string;
  /** A rules root to use instead of downloading the pinned rules. */
  rulesRoot?: string;
}

export function opengrep(options: OpengrepOptions = {}): Adapter {
  const resolveBinary = () => (options.binary ? Promise.resolve(options.binary) : ensureBinary(OPENGREP));
  const resolveRules = () => (options.rulesRoot ? Promise.resolve(options.rulesRoot) : ensureSemgrepRules());

  return {
    tool: "opengrep",
    slow: true,

    handles: (file) => ruleDirsFor(file).length > 0,

    async run(cwd, files): Promise<ToolRun> {
      let binary: string;
      let root: string;
      try {
        [binary, root] = await Promise.all([resolveBinary(), resolveRules()]);
      } catch (err) {
        return { status: "unavailable", reason: `could not provision opengrep: ${(err as Error).message}` };
      }

      const dirs = [...new Set(files.flatMap(ruleDirsFor))].filter((d) => SEMGREP_RULES.dirs.includes(d));
      const args = ["scan", "--quiet", "--json", ...dirs.flatMap((d) => ["--config", join(root, d)]), ...files];

      const output = await new Promise<{ stdout: string } | { error: Error }>((done) => {
        execFile(binary, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
          // Exit code 1 means findings, which is a successful run. Anything
          // that did not produce JSON is the failure.
          if (stdout?.trim().startsWith("{")) return done({ stdout });
          done({ error: error ?? new Error("opengrep produced no output") });
        });
      });

      if ("error" in output) {
        return { status: "unavailable", reason: `opengrep failed: ${output.error.message}` };
      }

      // Partial parse errors are reported alongside results, and a file that
      // parsed partially was still scanned. Nothing here is treated as fatal.
      const parsed = JSON.parse(output.stdout) as { results: Result[] };
      const findings: ToolFinding[] = parsed.results.map((r) => ({
        rule: stableRuleId(r.check_id, root),
        file: r.path.split("\\").join("/"),
        line: r.start.line,
        message: firstSentence(r.extra.message),
      }));
      return { status: "ran", findings };
    },

    /**
     * Live means the pinned rules contain that rule, and this file is of a kind
     * whose rule set includes it. Undefined when the rules are not downloaded,
     * because then there is nothing to ask.
     */
    async isLive(_cwd, rule, file) {
      let root: string;
      try {
        root = await resolveRules();
      } catch {
        return undefined;
      }
      const segments = rule.split(".");
      const id = segments.pop()!;
      const dir = segments.join("/");
      if (!ruleDirsFor(file).some((d) => dir === d || dir.startsWith(`${d}/`))) return false;

      // The id names the rule's directory, not its file: any rule file in
      // javascript/express/security/ may declare express-open-redirect.
      const abs = join(root, dir);
      if (!existsSync(abs)) return false;
      const declares = new RegExp(`^\\s*-\\s*id:\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m");
      return readdirSync(abs).some(
        (entry) => /\.ya?ml$/.test(entry) && declares.test(readFileSync(join(abs, entry), "utf8")),
      );
    },
  };
}
