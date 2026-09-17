import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
const text = readFileSync("api/src/handlers/orders.ts","utf8");
const args = ["-p", `Rule: check ownership.\nQuestion: does each endpoint that loads a record by id check the caller may access it?\n\nFile:\n\`\`\`ts\n${text}\n\`\`\``,
 "--output-format","json","--tools","","--no-session-persistence","--permission-prompts","none","--safe-mode",
 "--json-schema", JSON.stringify({type:"object",properties:{verdict:{type:"string",enum:["ok","violated","not-applicable"]},reason:{type:"string"}},required:["verdict","reason"]}),
 "--model","haiku","--system-prompt","You judge code against a rule."];
const t=Date.now();
const c = execFile("claude", args, {maxBuffer: 1<<25}, (e, out, err) => {
  const j = JSON.parse(out);
  console.log("wall", Date.now()-t, "api", j.duration_api_ms, "turns", j.num_turns, "cost", j.total_cost_usd);
  console.log(JSON.stringify(j.usage), JSON.stringify(j.modelUsage));
});
c.stdin.end();
