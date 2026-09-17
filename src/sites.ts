import type { Adapter } from "./rules/adapters/types.js";
import { defaultAdapters, KNOWN_TOOLS } from "./rules/adapters/index.js";

/**
 * What runs where: the one table.
 *
 * Before this, the answer was spread across `hook.ts`, `stop.ts`, a CLI flag in
 * someone's settings and the command `init` wrote into a pre-commit hook, and
 * the README described what that code happened to do. It drifted once already:
 * opengrep reached the commit hook, adding seconds to every commit, without
 * anyone deciding it should.
 *
 * Three layers, each owned by whoever knows the answer:
 *
 * - engine facts, on each adapter: opengrep is `slow`.
 * - the default policy, here.
 * - a repo's overrides, under `callSites` in its `qa.config.yaml`.
 *
 * Defaults select scanners by property, never by name, so a slow engine added
 * later stays out of the fast call sites without anyone remembering to exclude
 * it. Naming an engine is for a repo's overrides, where it is choosing its own
 * trade-off.
 */
export const CALL_SITES = ["stop", "commit", "ci"] as const;
export type CallSite = (typeof CALL_SITES)[number];
const RETIRED_SITE = "edit";

export interface SitePolicy {
  /** `fast` leaves out every engine marked slow; `all` runs every one. */
  scanners: "fast" | "all";
  /** Engines to leave out by name, after the group is chosen. */
  skip: string[];
  /** The rules that need a model's judgment. */
  llm: boolean;
  /** Test contracts: whether tests assert what their descriptions claim. */
  contracts: boolean;
}

export const DEFAULT_POLICY: Record<CallSite, SitePolicy> = {
  // The one agent-facing place that can hold the turn; cost, not latency, is
  // what limits it.
  stop: { scanners: "all", skip: [], llm: true, contracts: true },
  // Every commit pays this, a person's as much as an agent's. The slow engines'
  // corpus rules still block at Stop and in CI, and CI is the gate nobody can
  // skip with --no-verify.
  commit: { scanners: "fast", skip: [], llm: false, contracts: false },
  // The authority: everything.
  ci: { scanners: "all", skip: [], llm: true, contracts: true },
};

/**
 * Cells a repo may not change, and why. An invariant rather than a preference:
 * a commit must never cost money or wait on a model.
 */
const FIXED: Partial<Record<CallSite, { cells: (keyof SitePolicy)[]; why: string }>> = {
  commit: {
    cells: ["llm", "contracts"],
    why: "a commit must not cost money or wait on a model",
  },
};

export type SiteOverrides = Partial<Record<CallSite, Partial<SitePolicy>>>;

const KEYS: (keyof SitePolicy)[] = ["scanners", "skip", "llm", "contracts"];

function fail(message: string): never {
  throw new Error(`qa.config.yaml callSites: ${message}`);
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCell(site: CallSite, key: string, cell: unknown, policy: Partial<SitePolicy>): void {
  if (!(KEYS as string[]).includes(key)) {
    fail(`${site}.${key} is not a setting; expected one of ${KEYS.join(", ")}`);
  }
  const fixed = FIXED[site];
  if (fixed?.cells.includes(key as keyof SitePolicy)) {
    fail(`${site}.${key} cannot be changed: ${fixed.why}`);
  }

  if (key === "scanners") {
    if (cell !== "fast" && cell !== "all") fail(`${site}.scanners must be "fast" or "all"`);
    policy.scanners = cell;
    return;
  }

  if (key === "skip") {
    if (!Array.isArray(cell) || cell.some((t) => typeof t !== "string")) {
      fail(`${site}.skip must be a list of scanner names`);
    }
    const unknown = (cell as string[]).find((tool) => !KNOWN_TOOLS.includes(tool));
    if (unknown) {
      fail(`${site}.skip names unknown scanner "${unknown}"; expected one of ${KNOWN_TOOLS.join(", ")}`);
    }
    policy.skip = cell as string[];
    return;
  }

  if (typeof cell !== "boolean") fail(`${site}.${key} must be true or false`);
  policy[key as "llm" | "contracts"] = cell;
}

/**
 * Strict, like the rules loader. A misspelled call site or engine in a config
 * that is silently ignored is a check someone believes they changed.
 */
export function parseSiteOverrides(raw: unknown): SiteOverrides {
  if (raw === undefined || raw === null) return {};
  if (!isMap(raw)) fail("must be a map of call site to settings");

  const overrides: SiteOverrides = {};
  for (const [name, value] of Object.entries(raw)) {
    // The retired per-edit hook. Its settings configure nothing now, but a repo
    // that set them did nothing wrong, and failing to load would stop every
    // call site over a line that used to be valid.
    if (name === RETIRED_SITE) continue;
    if (!(CALL_SITES as readonly string[]).includes(name)) {
      fail(`unknown call site "${name}"; expected one of ${CALL_SITES.join(", ")}`);
    }
    const site = name as CallSite;
    if (!isMap(value)) fail(`${site} must be a map of settings`);

    const policy: Partial<SitePolicy> = {};
    for (const [key, cell] of Object.entries(value)) parseCell(site, key, cell, policy);
    overrides[site] = policy;
  }
  return overrides;
}

export function policyFor(site: CallSite, overrides: SiteOverrides = {}): SitePolicy {
  return { ...DEFAULT_POLICY[site], ...overrides[site] };
}

/** The engines a policy runs, chosen from a registry by property, then by name. */
export function adaptersFor(policy: SitePolicy, registry: Adapter[] = defaultAdapters()): Adapter[] {
  return registry
    .filter((a) => policy.scanners === "all" || !a.slow)
    .filter((a) => !policy.skip.includes(a.tool));
}

const LABELS: Record<CallSite, { where: string; command: string }> = {
  stop: { where: "end of each turn", command: "agentic-qa stop" },
  commit: { where: "on commit", command: "agentic-qa commit" },
  ci: { where: "CI", command: "agentic-qa ci" },
};

/**
 * The README's table, rendered from the defaults. A test requires the README to
 * contain exactly this, so the documentation cannot describe a policy the code
 * does not have.
 */
export function renderSiteTable(registry: Adapter[] = defaultAdapters()): string {
  const yes = (on: boolean) => (on ? "yes" : "no");
  return [
    "| call site | command | scanners | judgment rules | test contracts |",
    "| --- | --- | --- | --- | --- |",
    ...CALL_SITES.map((site) => {
      const policy = DEFAULT_POLICY[site];
      const tools = adaptersFor(policy, registry).map((a) => a.tool).join(", ");
      const { where, command } = LABELS[site];
      return `| ${where} | \`${command}\` | ${tools} | ${yes(policy.llm)} | ${yes(policy.contracts)} |`;
    }),
  ].join("\n");
}
