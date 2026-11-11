import type { McpProfileInput } from "../../core/mcp/profile.js";

/** See README.md. Edit this object to change how the server's tools map onto the protocol. */
export const profile = {
  id: "dice",
  name: "Dice",
  description: "Tech jobs in the US from Dice.",
  homepage: "https://www.dice.com",
  kinds: ["listing"],
  category: "job",
  payoutRails: ["employer"],
  transport: {
    type: "http",
    url: "https://mcp.dice.com/mcp",
  },
  tools: {
    search: {
      name: "search_jobs",
      args: {
        keyword: {
          from: "$.query",
          required: true,
        },
      },
      items: "$.data",
      filter: ["location"],
      map: {
        id: "$.guid",
        title: "$.title",
        org: "$.companyName",
        "location.text": "$.jobLocation.displayName",
        "location.remote": "$.isRemote",
        url: "$.detailsPageUrl",
        summary: "$.summary",
        posted_at: "$.postedDate",
        "pay.text": "$.salary",
        tags: {
          template: "${employmentType},${employerType}",
        },
      },
    },
  },
  sample: {
    query: "electrician",
  },
  notes: "get_job_details returns only the description and skills, without the title, so the full job is served from the search cache.",
} satisfies McpProfileInput;
