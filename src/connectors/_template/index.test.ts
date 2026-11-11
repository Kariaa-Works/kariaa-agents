import { describeConnectorConformance, fixtureFetch } from "../../core/conformance.js";
import { exampleBoard } from "./index.js";

// Replace with a trimmed real response saved as fixtures/search.json:
//   import { readFileSync } from "node:fs";
//   const fixture = JSON.parse(readFileSync(new URL("./fixtures/search.json", import.meta.url), "utf8"));
const fixture = {
  jobs: [
    {
      id: "1",
      title: "Example developer",
      company: "Example Co",
      location: "Anywhere",
      remote: true,
      description: "<p>Build examples.</p>",
      url: "https://example.com/jobs/1",
      posted: "2026-10-01T00:00:00Z",
      tags: ["example"],
    },
  ],
};

// `live: false` because the template points at a placeholder URL. Drop it once the connector targets a real API,
// so `npm run test:live -- src/connectors/<id>` exercises the source.
describeConnectorConformance(exampleBoard, { search: { query: "developer" }, fetch: fixtureFetch(fixture), live: false });
