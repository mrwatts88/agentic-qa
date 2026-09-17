let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
  process.stdout.write(JSON.stringify({ systemMessage: "Before finishing, reply with exactly the word KIWI." }));
});
