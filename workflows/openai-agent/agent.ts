/**
 * The agent loop: the model asks for Work API tools, this code runs them and
 * sends the results back, until the model answers without asking for a tool.
 *
 * The model call and the tool server are passed in, so the loop and its guards
 * can be tested without a model key (tests/agentLoop.test.ts). openai.ts puts an
 * OpenAI model behind it; any other model needs the same small adapter.
 */
/** The conversation the loop keeps: plain blocks, the same whichever model is behind it. */
export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type ContentBlock = TextBlock | ToolUseBlock;
export type Message = { role: "user" | "assistant"; content: string | Array<TextBlock | ToolUseBlock | ToolResultBlock> };
export type Tool = { name: string; description: string; input_schema: Record<string, unknown> };
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn";

export const MAX_TURNS = 16;
export const MAX_WRITES = 3;
export const READ_TOOLS = [
  "list_connectors",
  "search_jobs",
  "get_job",
  "verify_work",
  "get_application",
  "my_applications",
  "whoami",
  "my_postings",
  "list_offers",
];
/** Tools that act as the key's owner. Paying is deliberately not here: a model does not confirm payments. */
export const WRITE_TOOLS = ["apply_to_job", "add_work", "remove_work", "submit_work"];

export const SYSTEM = `You find and do paid work for one person through the Work API tools.

How the loop goes: search_jobs to find work, get_job to read one in full, verify_work to check a draft against the job's own requirements, then (only if the write tools are available to you) apply_to_job, add_work and submit_work. Ids look like kariaa:3f2a or superteam-earn:abc; pass them back exactly as returned.

Rules that protect real people on the other side:
- Read a job with get_job before acting on it, and follow its rules. If a job says no AI tools or asks for the person's own photos, voice or video, it is not yours to do: say so and pick another.
- Run verify_work and get a pass before add_work or submit_work.
- Never invent facts about the person. Use only what the goal and whoami tell you.
- Apply to one job at a time. Do not apply to many jobs to see what sticks.

When you are done, answer with what you found or did, the ids involved, and what the person should do next.`;

/** The part of an MCP client the loop uses. */
export type ToolServer = {
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: unknown }> }>;
  /** An MCP tool result: `content`, and for the Work API also `structuredContent` and `isError`. */
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<Record<string, unknown>>;
};

export type ModelCall = (request: {
  system: string;
  tools: Tool[];
  messages: Message[];
}) => Promise<{ content: ContentBlock[]; stop_reason: StopReason; stop_details?: { category?: string | null } | null }>;

export type AgentResult = {
  /** Why the loop ended. */
  ended: "answered" | "refused" | "cut_off" | "turn_limit";
  turns: number;
  writes: number;
  /** Every tool call the model asked for, and whether it was run. */
  calls: Array<{ name: string; ran: boolean; reason?: string }>;
  answer: string;
};

export async function runAgent(options: {
  goal: string;
  /** May the model apply, add work and submit? */
  act: boolean;
  work: ToolServer;
  model: ModelCall;
  log?: (line: string) => void;
}): Promise<AgentResult> {
  const log = options.log ?? (() => {});
  const allowed = new Set(options.act ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS);
  const listed = await options.work.listTools();
  const tools: Tool[] = listed.tools
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.inputSchema as Record<string, unknown>,
    }));

  const messages: Message[] = [{ role: "user", content: options.goal }];
  const result: AgentResult = { ended: "turn_limit", turns: 0, writes: 0, calls: [], answer: "" };

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    result.turns = turn + 1;
    const response = await options.model({ system: SYSTEM, tools, messages });
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        log(block.text);
        result.answer = block.text;
      }
    }
    if (response.stop_reason === "refusal") {
      log(`The model declined (${response.stop_details?.category ?? "no category"}).`);
      result.ended = "refused";
      return result;
    }
    if (response.stop_reason === "max_tokens") {
      log("The reply was cut off at max_tokens.");
      result.ended = "cut_off";
      return result;
    }
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") {
      result.ended = "answered";
      return result;
    }

    // Run every tool call of this turn and send all results back in one message.
    const results: ToolResultBlock[] = [];
    const refuse = (id: string, name: string, reason: string) => {
      result.calls.push({ name, ran: false, reason });
      results.push({ type: "tool_result", tool_use_id: id, is_error: true, content: reason });
    };
    for (const call of response.content.filter((b): b is ToolUseBlock => b.type === "tool_use")) {
      const isWrite = WRITE_TOOLS.includes(call.name);
      if (!allowed.has(call.name)) {
        refuse(call.id, call.name, `${call.name} is not available in this run.`);
        continue;
      }
      if (isWrite && result.writes >= MAX_WRITES) {
        refuse(call.id, call.name, `This run may write at most ${MAX_WRITES} times.`);
        continue;
      }
      // A job description is text from a stranger. It must not be able to make the model send a file from this machine.
      const input = (call.input ?? {}) as { file?: { path?: unknown }; work?: Array<{ file?: { path?: unknown } }> };
      if (input.file?.path !== undefined || (Array.isArray(input.work) && input.work.some((piece) => piece?.file?.path !== undefined))) {
        refuse(call.id, call.name, "Local file paths are not accepted in this run. Send text, or a public https url.");
        continue;
      }
      if (isWrite) result.writes += 1;
      log(`→ ${call.name} ${JSON.stringify(call.input).slice(0, 160)}`);
      try {
        const answer = await options.work.callTool({ name: call.name, arguments: call.input as Record<string, unknown> });
        const text = (Array.isArray(answer.content) ? (answer.content as Array<{ type: string; text?: string }>) : [])
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("\n");
        result.calls.push({ name: call.name, ran: true });
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: answer.structuredContent !== undefined ? JSON.stringify(answer.structuredContent) : text,
          ...(answer.isError === true ? { is_error: true } : {}),
        });
      } catch (error) {
        refuse(call.id, call.name, error instanceof Error ? error.message : String(error));
      }
    }
    messages.push({ role: "user", content: results });
  }
  return result;
}
