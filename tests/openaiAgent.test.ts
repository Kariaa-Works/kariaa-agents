import { describe, expect, it } from "vitest";
import type { Message } from "../workflows/openai-agent/agent.js";
import { fromChatReply, openAiModel, toChatMessages } from "../workflows/openai-agent/openai.js";

describe("the OpenAI adapter", () => {
  it("turns the loop's conversation into chat messages, tool calls and tool results", () => {
    const messages: Message[] = [
      { role: "user", content: "Find work" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching." },
          { type: "tool_use", id: "call_1", name: "search_jobs", input: { query: "design" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: '{"count":2}' },
          { type: "tool_result", tool_use_id: "call_2", content: "not allowed", is_error: true },
        ],
      },
    ];
    expect(toChatMessages("Be careful.", messages)).toEqual([
      { role: "system", content: "Be careful." },
      { role: "user", content: "Find work" },
      {
        role: "assistant",
        content: "Searching.",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "search_jobs", arguments: '{"query":"design"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"count":2}' },
      { role: "tool", tool_call_id: "call_2", content: "Error: not allowed" },
    ]);
  });

  it("reads a reply back as text, tool calls and a stop reason", () => {
    const calls = fromChatReply({
      choices: [
        {
          finish_reason: "tool_calls",
          message: { content: null, tool_calls: [{ id: "c1", function: { name: "get_job", arguments: '{"job_id":"kariaa:1"}' } }] },
        },
      ],
    });
    expect(calls.stop_reason).toBe("tool_use");
    expect(calls.content).toMatchObject([{ type: "tool_use", id: "c1", name: "get_job", input: { job_id: "kariaa:1" } }]);

    expect(fromChatReply({ choices: [{ finish_reason: "stop", message: { content: "Done." } }] })).toMatchObject({
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Done." }],
    });
    expect(fromChatReply({ choices: [{ finish_reason: "length", message: { content: "Half" } }] }).stop_reason).toBe("max_tokens");
    expect(fromChatReply({ choices: [{ finish_reason: "content_filter", message: { content: null } }] }).stop_reason).toBe("refusal");
    // Arguments that are not JSON become an empty input, so the tool says what is missing instead of the run crashing.
    const broken = fromChatReply({
      choices: [
        { finish_reason: "tool_calls", message: { tool_calls: [{ id: "c2", function: { name: "get_job", arguments: "{oops" } }] } },
      ],
    });
    expect(broken.content).toMatchObject([{ type: "tool_use", input: {} }]);
  });

  it("sends the tools as functions and says so plainly when the key is refused", async () => {
    let sent: { url: string; body: Record<string, unknown>; auth: string } | undefined;
    const fetchOk = (async (url: string, init?: RequestInit) => {
      sent = {
        url,
        body: JSON.parse(String(init!.body)) as Record<string, unknown>,
        auth: (init!.headers as Record<string, string>).authorization!,
      };
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
    }) as typeof fetch;
    const model = openAiModel({ apiKey: "sk-test", model: "gpt-test", fetch: fetchOk });
    const reply = await model({
      system: "s",
      tools: [{ name: "search_jobs", description: "Find work", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(reply.stop_reason).toBe("end_turn");
    expect(sent!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent!.auth).toBe("Bearer sk-test");
    expect(sent!.body).toMatchObject({
      model: "gpt-test",
      tools: [{ type: "function", function: { name: "search_jobs", description: "Find work", parameters: { type: "object" } } }],
    });

    const refused = openAiModel({
      apiKey: "bad",
      model: "gpt-test",
      fetch: (async () => Response.json({ error: { message: "Incorrect API key" } }, { status: 401 })) as typeof fetch,
    });
    await expect(refused({ system: "s", tools: [], messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(
      "OpenAI refused the key",
    );
  });
});
