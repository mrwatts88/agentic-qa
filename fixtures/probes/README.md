# Probes

Throwaway experiments kept because a roadmap item starts from them. They are
not scored and not run by any test. `fixtures/` is in the ignore list, so the
tool never checks this code as if it were ours.

## gauntlet-hono-express

The same vulnerabilities written twice, once against Hono and once against
Express, plus a React component, a GitHub Actions workflow, a Dockerfile and
Terraform. Used to measure the semgrep community rules; starting point for
roadmap item 9 (the Hono gap).

    opengrep scan --json --config ~/.cache/agentic-qa/semgrep-rules/<commit>/javascript \
      --config .../typescript --config .../terraform --config .../dockerfile \
      --config .../yaml/github-actions .

Measured (rules at 40b8c63, opengrep 1.30.0): SQL injection, SSRF, path
traversal, open redirect and command injection found in `api/express-app.ts`,
all missed in `api/hono-app.ts`. Terraform, Dockerfile, the workflow's script
injection and the React open redirect and `dangerouslySetInnerHTML` all found.

## own-ast-rules

Three hand-written opengrep rules (`rules.yaml`) against the regex versions of
the same corpus rules. `tricky.ts` is built to trip regexes: a CORS wildcard
split across lines, a `sha256` checksum in a file that also hashes a password,
and `httpOnly: false` inside a string. Starting point for roadmap item 10.

    opengrep scan --json --config rules.yaml hono.ts express.ts tricky.ts

Measured: the AST rules got every case right in all three files, Hono and
Express alike; the regex rules produced two false positives in `tricky.ts`.

## stop-hook-shapes

The four Stop hook outputs tested against a real headless session, which found
that `agentic-qa stop` had never blocked. Starting point for roadmap item 1.
To reproduce one: in a scratch directory, write `.claude/settings.json` with a
Stop hook running `node <file>`, then

    claude -p "Say hello in one word." --model haiku --output-format json < /dev/null

| file | output | result |
| --- | --- | --- |
| `nested.js` | `hookSpecificOutput.decision: "block"` | ignored; turn ended |
| `toplevel.js` | top-level `decision: "block"` | held; agent continued |
| `context.js` | `hookSpecificOutput.additionalContext` | agent continued |
| `sysmsg.js` | `systemMessage` | shown to the person; turn ended |

Since then, `agentic-qa stop` itself has been run the same way with a
top-level `decision: "block"` and a `systemMessage` in one payload, which is how
it shows a refused `qa-ignore`: the turn was held and the message still reached
the person. No probe file for that one; the real hook is the probe.

Every block, from `toplevel.js` as much as the real hook, also produces a
notification reading "Stop hook error occurred · ctrl+o to see". That is Claude
Code's own label for a Stop block, not a failure, and nothing a hook emits
changes it (Claude Code 2.1.274).
