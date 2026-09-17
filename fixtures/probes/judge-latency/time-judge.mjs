import { readFileSync } from "node:fs";
import { judgeRule } from "/Users/mattwatts/code/agentic-qa/dist/judge.js";
import { loadRules } from "/Users/mattwatts/code/agentic-qa/dist/rules/load.js";
import { loadConfig } from "/Users/mattwatts/code/agentic-qa/dist/config.js";
const config = loadConfig(process.cwd());
const rules = loadRules([], []).filter(r => r.tier === "llm");
const file = "api/src/handlers/orders.ts";
const text = readFileSync(file, "utf8");
const n = Number(process.argv[2] ?? 1);
const t0 = Date.now();
const res = await Promise.all(Array.from({length:n}, (_, i) => {
  const s = Date.now();
  return judgeRule(rules[i % rules.length], file, text, config).then(r => ({rule: rules[i % rules.length].id, ms: Date.now()-s, api: r.durationMs, cost: r.costUsd, verdict: r.verdict}), e => ({err: e.message, ms: Date.now()-s}));
}));
console.log(JSON.stringify(res, null, 1), "total", Date.now()-t0);
