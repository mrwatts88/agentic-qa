/**
 * What every engine is reduced to. An adapter runs its tool and returns what
 * the tool said, in the tool's own rule ids. It does not know about the corpus,
 * severity or qa-ignore: the conductor in mechanical.ts applies all three, the
 * same way for every tool, so they cannot drift between engines.
 */
export interface ToolFinding {
  /** The tool's own rule id. */
  rule: string;
  /** Relative to the repo root, forward slashes. */
  file: string;
  line: number;
  message: string;
  /**
   * The line holds something that must not be echoed, such as a secret. The
   * conductor then reports without quoting the source, because every call
   * site prints the excerpt: the terminal, CI logs and the agent's context.
   */
  redact?: boolean;
}

export type ToolRun =
  | { status: "ran"; findings: ToolFinding[] }
  /**
   * The tool is not installed or could not start. Reported, never mistaken for
   * a clean run: silence from a scanner that never ran reads as approval.
   */
  | { status: "unavailable"; reason: string };

export interface Adapter {
  tool: string;
  /** Whether this tool has anything to say about a file at all. */
  handles(file: string): boolean;
  run(cwd: string, files: string[]): Promise<ToolRun>;
  /**
   * Whether a rule is switched on for this file in the configuration the tool
   * actually runs with. This is what holds the corpus to its promises.
   * Undefined when the tool is unavailable and cannot be asked.
   */
  isLive(cwd: string, rule: string, file: string): Promise<boolean | undefined>;
}
