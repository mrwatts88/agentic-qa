import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Adapter, ToolFinding, ToolRun } from "./types.js";

export function bundledCruiserConfig(): string {
  return fileURLToPath(new URL("../../../config/dependency-cruiser.mjs", import.meta.url));
}

const CRUISABLE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

interface CruiserRule {
  name: string;
  severity?: string;
  from?: { path?: string | string[]; pathNot?: string | string[] };
}

const list = (v?: string | string[]): string[] => (v === undefined ? [] : [v].flat());

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * dependency-cruiser reports edges, not lines. A qa-ignore comment has to sit
 * next to what it excuses, so find the line that names the module.
 */
function lineOf(cwd: string, file: string, specifier: string | undefined): number {
  if (!specifier) return 1;
  try {
    const quoted = new RegExp(`['"\`]${escape(specifier)}['"\`]`);
    const index = readFileSync(resolve(cwd, file), "utf8")
      .split("\n")
      .findIndex((line) => quoted.test(line));
    return index === -1 ? 1 : index + 1;
  } catch {
    return 1;
  }
}

export function dependencyCruiser(configFile = bundledCruiserConfig()): Adapter {
  let ruleSet: Promise<{ forbidden: CruiserRule[] }> | undefined;
  const load = (): Promise<{ forbidden: CruiserRule[] }> =>
    (ruleSet ??= import(pathToFileURL(configFile).href).then((m) => m.default));

  return {
    tool: "dependency-cruiser",

    handles: (file) => CRUISABLE.test(file),

    async run(cwd, files): Promise<ToolRun> {
      const { cruise } = await import("dependency-cruiser");
      const result = await cruise(
        files,
        {
          baseDir: cwd,
          validate: true,
          ruleSet: (await load()) as never,
          // Follow the repo's own modules, so a cycle through a changed file is
          // visible, but never into packages.
          doNotFollow: { path: "node_modules" },
          tsPreCompilationDeps: true,
        },
      );

      const output = result.output as {
        modules: { source: string; dependencies: { resolved: string; module: string }[] }[];
        summary: { violations: { from: string; to: string; rule: { name: string } }[] };
      };

      // Following imports reaches files nobody changed. Report only on the
      // files asked about, like every other call site.
      const asked = new Set(files);
      const bySource = new Map(output.modules.map((m) => [m.source, m]));

      const findings: ToolFinding[] = [];
      for (const v of output.summary.violations) {
        if (!asked.has(v.from)) continue;
        const specifier = bySource
          .get(v.from)
          ?.dependencies.find((d) => d.resolved === v.to)?.module;
        findings.push({
          rule: v.rule.name,
          file: v.from,
          line: lineOf(cwd, v.from, specifier),
          message:
            v.rule.name === "no-circular"
              ? `Circular dependency through ${v.to}`
              : `${v.rule.name}: imports ${v.to}`,
        });
      }
      return { status: "ran", findings };
    },

    /**
     * Live means the rule exists, is not switched to ignore, and its `from`
     * scope still covers this file. A pathNot that drifted to exempt handlers
     * would otherwise unenforce the rule while it still looked configured.
     */
    async isLive(_cwd, rule, file) {
      const found = (await load()).forbidden.find((r) => r.name === rule);
      if (!found || found.severity === "ignore") return false;
      const path = list(found.from?.path);
      if (path.length && !path.some((p) => new RegExp(p).test(file))) return false;
      return !list(found.from?.pathNot).some((p) => new RegExp(p).test(file));
    },
  };
}
