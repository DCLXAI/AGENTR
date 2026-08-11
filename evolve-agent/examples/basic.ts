import { createRuntime, loadConfig } from "@dclxai/evolve-agent";

const { runtime } = createRuntime(loadConfig({ workspace: process.cwd() }));
const result = await runtime.run({
  goal: "Read package.json and summarize the package scripts.",
  requestedTools: ["read_file"],
  successCriteria: ["Every factual claim cites current-episode evidence"],
});
console.log(result);
