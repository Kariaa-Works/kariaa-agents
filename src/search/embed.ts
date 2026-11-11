/**
 * Embeddings for semantic matching: OpenAI text-embedding-3-small (1536 dimensions, matches the
 * work_index column). Without OPENAI_API_KEY the index ranks by full text only.
 */
export type Embedder = (texts: string[]) => Promise<number[][]>;

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;

export function openAiEmbedder(apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Embedder | undefined {
  const key = apiKey?.trim();
  if (!key) return undefined;
  return async (texts) => {
    const out: number[][] = [];
    // The API takes up to 2048 inputs; smaller batches keep one failure cheap.
    for (let i = 0; i < texts.length; i += 96) {
      const batch = texts.slice(i, i + 96).map((t) => t.slice(0, 8000) || " ");
      const res = await fetchImpl("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`embeddings ${res.status}`);
      const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      const ordered = [...body.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      out.push(...ordered);
    }
    return out;
  };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
