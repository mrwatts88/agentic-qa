let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const p = JSON.parse(s);
  if (p.stop_hook_active) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: "Before finishing, reply with exactly the word MANGO." } }));
});
