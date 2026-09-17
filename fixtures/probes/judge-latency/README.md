# Judge latency, 2026-09-17

Why the per-rule, per-file judge did not fit a turn. Run from `orders-admin` on
its `trial/orders-api-2` branch, after `npm run build` here.

- `raw-judge.mjs`: one headless haiku call with a short prompt and schema.
  15.7s, 967 thinking tokens, $0.011. Startup alone (a "reply ok" call) is 1.9s.
- `time-judge.mjs N`: N real rule judgments of `api/src/handlers/orders.ts` in
  parallel, through `dist/judge.js`. The ownership rule took about 50s and $0.03;
  the other three 10-18s and about $0.01 each, three of them `not-applicable`.

Adding `--effort low` or `medium` to the judge's flags changed neither time nor
cost on haiku. The time is the model thinking, not process overhead.
