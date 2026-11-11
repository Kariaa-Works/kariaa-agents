/**
 * A test suite any connector can run. Import it from a vitest file:
 *
 *   describeConnectorConformance(connector, { search: { query: "developer" }, fetch: fixtureFetch(fixture) });
 *
 * With LIVE=1 and no `fetch`, the same checks run against the real source.
 */
import { describe, expect, it } from "vitest";
import type { Connector, ConnectorContext } from "./connector.js";
import { canUse, credentialsFor } from "./credentials.js";
import { ProtocolError } from "./errors.js";
import { isConnectorId } from "./ids.js";
import { NativeJobSchema, NativePaymentSchema, NativePostingSchema, OfferSchema, type PostInput, type SearchQuery } from "./types.js";
import { VerdictSchema, type Verifier, type VerifierContext, type VerifyInput } from "./verifier.js";

export type RecordedCall = { url: string; init: RequestInit | undefined };

function urlOf(input: string | URL | Request): string {
  return input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export type FixtureResponder = (url: string, init?: RequestInit) => unknown;

/** A fetch answering every request with the same JSON, or with what a function returns (a body or a Response). */
export function fixtureFetch(responder: FixtureResponder): typeof fetch;
export function fixtureFetch(body: unknown): typeof fetch;
export function fixtureFetch(body: unknown): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const out = typeof body === "function" ? await (body as FixtureResponder)(urlOf(input), init) : body;
    return out instanceof Response ? out : jsonResponse(out);
  }) as typeof fetch;
}

/** Wraps a fetch and records every call. */
export function recordingFetch(inner: typeof fetch, calls: RecordedCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: urlOf(input), init });
    return inner(input, init);
  }) as typeof fetch;
}

export function testContext(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    credentials: {},
    fetch: fixtureFetch({}),
    signal: new AbortController().signal,
    log: () => {},
    ...overrides,
  };
}

export type ConformanceOptions = {
  search: SearchQuery;
  /** The fetch the connector sees. Leave out with LIVE=1 to use the network. */
  fetch?: typeof fetch;
  credentials?: Record<string, string | undefined>;
  /** The connector talks HTTP through ctx.fetch. Default true. */
  expectFetch?: boolean;
  /** The request URL carries the query. Default true when `search.query` is set. */
  expectQueryInUrl?: boolean;
  minResults?: number;
  live?: boolean;
};

export function describeConnectorConformance(connector: Connector, options: ConformanceOptions): void {
  const live = options.live ?? process.env.LIVE === "1";
  const expectFetch = options.expectFetch !== false;

  describe(`${connector.id} conforms to the connector contract`, () => {
    it("declares a valid id, name, description, kinds and auth", () => {
      expect(isConnectorId(connector.id)).toBe(true);
      expect(connector.name.trim().length).toBeGreaterThan(0);
      expect(connector.description.trim().length).toBeGreaterThan(0);
      expect(connector.kinds.length).toBeGreaterThan(0);
      expect(["none", "api_key", "oauth"]).toContain(connector.auth.type);
      if (connector.auth.type === "api_key") {
        expect(connector.auth.env.length).toBeGreaterThan(0);
        expect(connector.auth.help.trim().length).toBeGreaterThan(0);
      }
      expect(typeof connector.search).toBe("function");
    });

    it("search returns native jobs, through ctx.fetch, with ctx.signal", async (context) => {
      const calls: RecordedCall[] = [];
      const inner = live ? globalThis.fetch.bind(globalThis) : (options.fetch ?? (expectFetch ? undefined : fixtureFetch({})));
      if (!inner) throw new Error("conformance: pass `fetch`, or run with LIVE=1 to use the network");
      const credentials = live ? credentialsFor(connector, process.env) : (options.credentials ?? {});
      if (live && !canUse(connector, credentials)) {
        context.skip();
        return;
      }
      const ctx = testContext({ fetch: recordingFetch(inner, calls), credentials });
      const original = globalThis.fetch;
      globalThis.fetch = (() => {
        throw new Error("connectors must use ctx.fetch, not the global fetch");
      }) as typeof fetch;
      let result;
      try {
        result = await connector.search!(options.search, ctx);
      } finally {
        globalThis.fetch = original;
      }
      expect(Array.isArray(result.jobs)).toBe(true);
      expect(result.jobs.length).toBeGreaterThanOrEqual(options.minResults ?? 1);
      const ids = new Set<string>();
      for (const job of result.jobs) {
        const parsed = NativeJobSchema.safeParse(job);
        expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
        expect(job).not.toHaveProperty("connector");
        expect(connector.kinds).toContain(job.kind);
        expect(ids.has(job.id), `duplicate id ${job.id}`).toBe(false);
        ids.add(job.id);
      }
      if (expectFetch) {
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
          expect(call.init?.signal, `${call.url} was fetched without ctx.signal`).toBe(ctx.signal);
        }
        const query = options.search.query;
        if (query && options.expectQueryInUrl !== false) {
          const hit = calls.some((call) => decodeURIComponent(call.url).replace(/\+/gu, " ").toLowerCase().includes(query.toLowerCase()));
          expect(hit, `no request URL carried the query ${JSON.stringify(query)}: ${calls.map((c) => c.url).join(", ")}`).toBe(true);
        }
      }
    });

    if (expectFetch && !live) {
      it("turns an upstream failure into a ProtocolError", async () => {
        const ctx = testContext({
          fetch: fixtureFetch(() => new Response("down", { status: 503 })),
          credentials: options.credentials ?? {},
        });
        await expect(connector.search!(options.search, ctx)).rejects.toBeInstanceOf(ProtocolError);
      });
    }
  });
}

export function verifierContext(overrides: Partial<VerifierContext> = {}): VerifierContext {
  return { log: () => {}, signal: new AbortController().signal, ...overrides };
}

export type VerifierConformanceOptions = {
  /** Work the verifier must pass. */
  pass: VerifyInput;
  /** Work it must fail, with at least one failed check. */
  fail?: VerifyInput;
  /** Work it cannot decide. */
  uncertain?: VerifyInput;
};

/** The checks every verifier must meet: valid verdicts, the declared determinism, no network. */
export function describeVerifierConformance(verifier: Verifier, options: VerifierConformanceOptions): void {
  const run = async (input: VerifyInput) => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("verifiers must not use the network");
    }) as typeof fetch;
    try {
      const raw = await verifier.verify(input, verifierContext());
      const parsed = VerdictSchema.safeParse(raw);
      expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
      return parsed.success ? parsed.data : raw;
    } finally {
      globalThis.fetch = original;
    }
  };

  describe(`${verifier.id} conforms to the verifier contract`, () => {
    it("declares a valid id, name, description and determinism", () => {
      expect(isConnectorId(verifier.id)).toBe(true);
      expect(verifier.name.trim().length).toBeGreaterThan(0);
      expect(verifier.description.trim().length).toBeGreaterThan(0);
      expect(typeof verifier.deterministic).toBe("boolean");
    });

    it("passes the work it should pass, and repeats itself", async () => {
      const first = await run(options.pass);
      expect(first.verifier).toBe(verifier.id);
      expect(first.outcome).toBe("pass");
      expect(first.checks.every((c) => c.ok)).toBe(true);
      if (verifier.deterministic) expect(await run(options.pass)).toEqual(first);
    });

    const failInput = options.fail;
    if (failInput) {
      it("fails the work it should fail, naming the check", async () => {
        const verdict = await run(failInput);
        expect(verdict.outcome).toBe("fail");
        expect(verdict.checks.some((c) => !c.ok && c.message.length > 0)).toBe(true);
      });
    }

    const uncertainInput = options.uncertain;
    if (uncertainInput) {
      it("answers uncertain when it cannot decide", async () => {
        expect((await run(uncertainInput)).outcome).toBe("uncertain");
      });
    }
  });
}

export type BuyerConformanceOptions = {
  /** Answers every request the connector makes, from recorded responses. Never the network: these calls post work and move money. */
  fetch: typeof fetch;
  credentials?: Record<string, string>;
  /** A job the fixtures accept. */
  post?: PostInput;
  /** A posting id the fixtures know, for offers. */
  postingId?: string;
};

/**
 * The contract of the buying side, for a connector that implements any of it:
 * `post` returns a posting and charges nothing, `offers` returns readable
 * offers, and `quote` (when there is one) only describes a payment.
 */
export function describeBuyerConformance(connector: Connector, options: BuyerConformanceOptions): void {
  const ctx = () => testContext({ fetch: options.fetch, ...(options.credentials ? { credentials: options.credentials } : {}) });
  describe(`${connector.id} conforms to the buyer contract`, () => {
    it("implements pay only together with a way to read what is being paid for", () => {
      if (typeof connector.pay === "function") expect(typeof connector.offers, "pay needs offers").toBe("function");
      if (typeof connector.award === "function") expect(typeof connector.offers, "award needs offers").toBe("function");
    });

    if (typeof connector.post === "function" && options.post) {
      it("post returns a posting that is not yet paid for", async () => {
        const posting = NativePostingSchema.parse(await connector.post!(options.post!, ctx()));
        expect(posting.title.length).toBeGreaterThan(0);
        expect(["draft", "open"], "a new posting is a draft or open").toContain(posting.status);
        expect(posting.funded ?? false, "posting must not set money aside; pay does").toBe(false);
      });
    }

    if (typeof connector.offers === "function" && options.postingId) {
      it("offers returns the posting and offers a person can compare", async () => {
        const found = await connector.offers!(options.postingId!, ctx());
        expect(found, "the fixture posting is found").not.toBeNull();
        NativePostingSchema.parse(found!.posting);
        for (const offer of found!.offers) OfferSchema.parse(offer);
      });

      if (typeof connector.quote === "function") {
        it("quote describes a payment and moves nothing", async () => {
          const quote = NativePaymentSchema.parse(await connector.quote!(options.postingId!, {}, ctx()));
          expect(quote.status).toBe("confirm_needed");
          expect(quote.amount, "a quote names the amount").toBeDefined();
        });
      }
    }
  });
}
