import { existsSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../core/tenant.js";
import { openAiEmbedder } from "./embed.js";
import { LocalIndex } from "./localIndex.js";

export { understand, type Understood } from "./understand.js";
export { toIndexRow, payUsd, extractSkills, fetchUsdRates, FALLBACK_USD_RATES } from "./normalize.js";
export { openAiEmbedder, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, type Embedder } from "./embed.js";
export { LocalIndex, type LocalIndexOptions } from "./localIndex.js";
export { indexCatalog, indexable, SEED_QUERIES, type IndexReport, type IndexerOptions } from "./indexer.js";
export type { IndexHit, IndexQuery, IndexRow, IndexStore, SearchIndex } from "./types.js";

/** Where `work index` keeps the local index: `work-index.json` in WORK_CACHE_DIR or ~/.cache/work-protocol. */
export function defaultIndexFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), "work-index.json");
}

/** The local index, when `work index` has built one. Searches use it for the platforms it covers. */
export function localIndexIfBuilt(env: NodeJS.ProcessEnv = process.env): LocalIndex | undefined {
  const file = defaultIndexFile(env);
  if (!existsSync(file)) return undefined;
  const embedder = openAiEmbedder(env.OPENAI_API_KEY);
  return new LocalIndex({ file, ...(embedder ? { embedder } : {}) });
}
