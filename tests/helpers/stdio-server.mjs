// A tiny MCP server over stdio, for the stdio transport test.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "stdio-fake", version: "0" });
server.registerTool("list_bounties", { inputSchema: { limit: z.number().optional() } }, async ({ limit }) => {
  const bounties = [
    { id: "b1", title: "Translate a page", reward_usd: 25, status: "open", url: "https://stdio.example/b1" },
    { id: "b2", title: "Label 50 images", reward_usd: 10, status: "open", url: "https://stdio.example/b2" },
  ].slice(0, limit ?? 10);
  return { content: [{ type: "text", text: JSON.stringify({ bounties }) }], structuredContent: { bounties } };
});
server.registerTool("whoami_env", { inputSchema: {} }, async () => ({
  content: [{ type: "text", text: process.env.STDIO_FAKE_TOKEN ?? "" }],
  structuredContent: { token: process.env.STDIO_FAKE_TOKEN ?? "" },
}));
process.stderr.write("stdio-fake ready\n");
await server.connect(new StdioServerTransport());
