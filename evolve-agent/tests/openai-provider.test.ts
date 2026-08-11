import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { OpenAIResponsesProvider } from "../src/providers/openai-responses.js";
import type { AgentPrompt } from "../src/providers/provider.js";

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

test("OpenAI adapter sends a Responses API function-tool request for gpt-5.6-sol", async () => {
  let captured: Record<string, unknown> | undefined;
  const server = createServer(async (request, response) => {
    captured = JSON.parse(await readBody(request)) as Record<string, unknown>;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "resp_test",
        output: [
          {
            type: "function_call",
            name: "commit_answer",
            call_id: "call_test",
            arguments: JSON.stringify({ answer: "done", evidence_ids: [], memory_proposals: [] }),
          },
        ],
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const provider = new OpenAIResponsesProvider({
      apiKey: "test-key",
      model: "gpt-5.6-sol",
      verifierModel: "gpt-5.6-sol",
      reasoningEffort: "high",
      endpoint: `http://127.0.0.1:${address.port}/v1/responses`,
      timeoutMs: 5_000,
    });
    const prompt: AgentPrompt = {
      task: {
        id: "task_aaaaaaaaaaaaaaaaaaaaaaaa",
        goal: "Acknowledge the task",
        constraints: [],
        successCriteria: ["Return an acknowledgement"],
        requestedTools: ["read_file"],
        budget: {
          maxTurns: 3,
          maxToolCalls: 1,
          maxInputTokens: 10_000,
          maxOutputTokens: 2_000,
          maxWallTimeMs: 10_000,
        },
        createdAt: new Date(0).toISOString(),
      },
      observations: [],
      memories: [],
      skills: [],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          risk: "read",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
      remainingBudget: { turns: 3, toolCalls: 1, inputTokens: 10_000, outputTokens: 2_000, wallTimeMs: 10_000 },
    };
    const result = await provider.decide(prompt);
    assert.equal(result.decision.kind, "final");
    assert.equal(result.usage.totalTokens, 14);
    assert.equal(captured?.model, "gpt-5.6-sol");
    assert.equal(captured?.store, false);
    assert.equal(captured?.tool_choice, "required");
    assert.equal(captured?.parallel_tool_calls, false);
    const tools = captured?.tools as Array<{ name: string; strict: boolean }>;
    assert.ok(tools.some((tool) => tool.name === "read_file" && tool.strict === false));
    assert.ok(tools.some((tool) => tool.name === "commit_answer" && tool.strict === true));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
