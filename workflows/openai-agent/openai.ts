/**
 * An OpenAI chat model behind the agent loop (agent.ts). It translates the loop's messages and tools to
 * OpenAI's Chat Completions shape and the reply back. No SDK: one HTTPS call.
 */
import type { ContentBlock, Message, ModelCall, StopReason, TextBlock, ToolUseBlock } from "./agent.js";

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

type ChatReply = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  error?: { message?: string };
};

/** The loop's conversation in OpenAI's shape. */
export function toChatMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push(message.role === "assistant" ? { role: "assistant", content: message.content } : { role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const text = message.content
        .filter((b): b is TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const calls = message.content
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // A user turn made of tool results: one "tool" message per result.
    for (const block of message.content) {
      if (block.type === "tool_result") {
        const content = block.content;
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content: block.is_error ? `Error: ${content}` : content });
      } else if (block.type === "text") out.push({ role: "user", content: block.text });
    }
  }
  return out;
}

/** An OpenAI reply as the content blocks and stop reason the loop reads. */
export function fromChatReply(reply: ChatReply): Awaited<ReturnType<ModelCall>> {
  const choice = reply.choices?.[0];
  const content: ContentBlock[] = [];
  const text = choice?.message?.content?.trim();
  if (text) content.push({ type: "text", text });
  for (const call of choice?.message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      input = {}; // arguments that are not JSON: the tool answers with what is missing
    }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  const reason = choice?.finish_reason;
  const stop_reason: StopReason =
    choice?.message?.refusal || reason === "content_filter"
      ? "refusal"
      : content.some((b) => b.type === "tool_use")
        ? "tool_use"
        : reason === "length"
          ? "max_tokens"
          : "end_turn";
  return { content, stop_reason };
}

export function openAiModel(options: { apiKey: string; model: string; baseUrl?: string; fetch?: typeof fetch }): ModelCall {
  const send = options.fetch ?? fetch;
  const url = `${(options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/u, "")}/chat/completions`;
  return async ({ system, tools, messages }) => {
    const response = await send(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        model: options.model,
        messages: toChatMessages(system, messages),
        tools: tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
        })),
      }),
    });
    const reply = (await response.json().catch(() => ({}))) as ChatReply;
    if (!response.ok) {
      const why = reply.error?.message ?? `HTTP ${response.status}`;
      throw new Error(
        response.status === 401
          ? "OpenAI refused the key. Set a working OPENAI_API_KEY in .env."
          : `OpenAI answered ${response.status}: ${why}`,
      );
    }
    return fromChatReply(reply);
  };
}
