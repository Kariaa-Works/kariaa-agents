import { describe, expect, it, beforeAll } from "vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describeConnectorConformance, testContext } from "../../core/conformance.js";
import { ProtocolError } from "../../core/errors.js";
import type { ConnectorContext } from "../../core/connector.js";
import { createFakeKariaa, JOB_ONE, TASK_AUDIO, TASK_LOCKED, TASK_TEXT } from "../../../tests/helpers/fakeKariaaServer.js";
import { mapToolError, mapTransportError } from "./client.js";
import { createKariaaConnectors } from "./index.js";
import { earningsOf, inWorkTerms, payoutOf, submissionToApplication, taskToJob } from "./map.js";

const KEY = "kra_" + "x".repeat(43);

function setup(options: { profileComplete?: boolean } = {}) {
  const fake = createFakeKariaa(options);
  const { kariaa, kariaaJobs, pool } = createKariaaConnectors({ transportFactory: fake.transportFactory });
  const ctx = (key?: string): ConnectorContext => testContext({ credentials: { KARIAA_API_KEY: key }, fetch: fake.storageFetch });
  return { fake, kariaa, kariaaJobs, pool, ctx };
}

const audioBytes = (seed: string) => new Uint8Array(Buffer.concat([Buffer.from("ID3"), Buffer.from(seed.repeat(40))]));

describe("kariaa connector", () => {
  const { fake, kariaa, kariaaJobs, ctx } = setup();

  describeConnectorConformance(kariaa, { search: {}, expectFetch: false, minResults: 3 });
  describeConnectorConformance(kariaaJobs, { search: { query: "electrician" }, expectFetch: false, minResults: 2 });

  it("lists tasks anonymously and filters by media and words", async () => {
    const all = await kariaa.search!({}, ctx());
    expect(all.jobs.map((j) => j.id)).toEqual([TASK_AUDIO, TASK_TEXT, TASK_LOCKED]);
    expect(all.jobs[0]!.kind).toBe("task");
    const audio = await kariaa.search!({ media: ["audio"] }, ctx());
    expect(audio.jobs.map((j) => j.id)).toEqual([TASK_AUDIO]);
    const voice = await kariaa.search!({ query: "voice recording" }, ctx());
    expect(voice.jobs.map((j) => j.id)).toContain(TASK_AUDIO);
    const label = await kariaa.search!({ query: "label" }, ctx());
    expect(label.jobs.map((j) => j.id)).toEqual([TASK_TEXT, TASK_LOCKED]);
  });

  it("maps a task's requirements, pay and material", async () => {
    const job = (await kariaa.get!(TASK_AUDIO, ctx()))!;
    expect(job.title).toBe("Read Sentences Aloud in Your Language");
    expect(job.org).toBe("Kariaa DataHouse");
    expect(job.pay).toMatchObject({ min: 0.5, max: 0.5, currency: "USD", period: "unit", unit: "per clip" });
    expect(job.pay?.text).toContain("samples are unpaid");
    expect(job.instructions).toContain("The cat sat on the mat");
    expect(job.requirements?.questions).toHaveLength(2);
    expect(job.requirements?.questions?.[0]).toMatchObject({
      id: "language",
      type: "select",
      required: true,
      options: ["English", "Twi", "French"],
    });
    expect(job.requirements?.files).toMatchObject({ kinds: ["audio"], count: 2, max_seconds: 30 });
    expect(job.requirements?.how_to).toEqual(["Open the voice recorder", "Read at a natural pace"]);
    expect(job.requirements?.rules).toEqual([
      "Read every sentence once.",
      "Your own recordings only.",
      "No faces of other people without consent.",
    ]);
    expect(job.url).toBe(`https://www.kariaa.com/go/${TASK_AUDIO}`);
    const text = (await kariaa.get!(TASK_TEXT, ctx()))!;
    expect(text.requirements?.text).toEqual({ min_chars: 20, max_chars: 20_000 });
    const locked = (await kariaa.get!(TASK_LOCKED, ctx()))!;
    expect(locked.pay).toEqual({ text: "an agreed rate" });
  });

  it("answers not_found for an unknown or malformed task id", async () => {
    await expect(kariaa.get!("not-a-uuid", ctx())).rejects.toMatchObject({ code: "not_found" });
    await expect(kariaa.get!("99999999-9999-4999-8999-999999999999", ctx())).rejects.toMatchObject({ code: "not_found" });
  });

  it("needs a key for writes and says how to get one", async () => {
    await expect(kariaa.apply!(TASK_AUDIO, { answers: { language: "English" } }, ctx())).rejects.toMatchObject({ code: "auth_required" });
    const anonymous = await kariaa.account!(ctx());
    expect(anonymous.signed_in).toBe(false);
    expect(anonymous.help).toContain("kra_");
  });

  it("rejects missing or invalid answers as invalid_input with details", async () => {
    await expect(kariaa.apply!(TASK_AUDIO, {}, ctx(KEY))).rejects.toMatchObject({
      code: "invalid_input",
      details: { kariaa_error: "answers_missing", question_ids: ["language"] },
    });
    await expect(kariaa.apply!(TASK_AUDIO, { answers: { language: "Klingon" } }, ctx(KEY))).rejects.toMatchObject({
      code: "invalid_input",
      details: { kariaa_error: "answer_not_an_option" },
    });
  });

  it("runs the whole task: apply, upload, remove, submit, status, list, link", async () => {
    const applied = await kariaa.apply!(
      TASK_AUDIO,
      { answers: { language: "English", extra: "ignored" }, preferred_rate: "USD 1 per clip" },
      ctx(KEY),
    );
    expect(applied.stage).toBe("work_needed");
    expect(applied.job_id).toBe(TASK_AUDIO);
    expect(applied.job_title).toBe("Read Sentences Aloud in Your Language");
    expect(applied.progress).toEqual({ received: 0, wanted: 2, ready_to_submit: false });
    expect(applied.raw).toEqual({ ignored_answers: ["extra"] });

    const again = await kariaa.apply!(TASK_AUDIO, { answers: { language: "English" } }, ctx(KEY));
    expect(again.id).toBe(applied.id);

    const first = await kariaa.upload!(
      applied.id,
      { kind: "file", name: "clip1.mp3", mime_type: "audio/mpeg", bytes: audioBytes("a") },
      ctx(KEY),
    );
    expect(first.file?.kind).toBe("audio");
    expect(first.progress).toEqual({ received: 1, wanted: 2, ready_to_submit: false });
    expect(first.next).toContain("1 more");
    expect(fake.state.objects.size).toBe(1);

    await expect(
      kariaa.upload!(applied.id, { kind: "file", name: "clip1-again.mp3", mime_type: "audio/mpeg", bytes: audioBytes("a") }, ctx(KEY)),
    ).rejects.toMatchObject({
      code: "already_exists",
      details: { kariaa_error: "duplicate_sample", duplicate_of: first.file!.id },
    });
    await expect(
      kariaa.upload!(applied.id, { kind: "file", name: "photo.png", mime_type: "image/png", bytes: audioBytes("p") }, ctx(KEY)),
    ).rejects.toMatchObject({ code: "invalid_input", details: { kariaa_error: "kind_not_allowed" } });
    await expect(kariaa.submit!(applied.id, {}, ctx(KEY))).rejects.toMatchObject({
      code: "not_ready",
      details: { kariaa_error: "not_enough_files", received: 1, wanted: 2 },
    });

    const removed = await kariaa.remove!(applied.id, first.file!.id, ctx(KEY));
    expect(removed.removed?.id).toBe(first.file!.id);
    expect(removed.progress?.received).toBe(0);

    await kariaa.upload!(applied.id, { kind: "file", name: "clip1.mp3", mime_type: "audio/mpeg", bytes: audioBytes("b") }, ctx(KEY));
    const second = await kariaa.upload!(
      applied.id,
      { kind: "file", name: "clip2.mp3", mime_type: "audio/mpeg", bytes: audioBytes("c") },
      ctx(KEY),
    );
    expect(second.progress).toEqual({ received: 2, wanted: 2, ready_to_submit: true });

    const link = await kariaa.link!(applied.id, ctx(KEY));
    expect(link.url).toContain("kariaa.com/auth/magic");
    expect(link.expires_at).toBeDefined();

    const submitted = await kariaa.submit!(applied.id, { note: "done" }, ctx(KEY));
    expect(submitted.stage).toBe("in_review");
    expect(submitted.files).toHaveLength(2);
    const twice = await kariaa.submit!(applied.id, {}, ctx(KEY));
    expect(twice.stage).toBe("in_review");

    await expect(
      kariaa.upload!(applied.id, { kind: "file", name: "late.mp3", mime_type: "audio/mpeg", bytes: audioBytes("z") }, ctx(KEY)),
    ).rejects.toMatchObject({ code: "wrong_stage", details: { stage: "in_review" } });

    const status = (await kariaa.status!(applied.id, ctx(KEY)))!;
    expect(status.stage).toBe("in_review");
    expect(status.updated_at).toBeDefined();
    const mine = await kariaa.list!(ctx(KEY));
    expect(mine.map((a) => a.id)).toContain(applied.id);

    await expect(kariaa.get!(applied.id, ctx(KEY))).rejects.toMatchObject({
      code: "not_found",
      message: expect.stringContaining("application id"),
    });
  });

  it("sends written work with add_text_sample and reports a locked task as applied", async () => {
    const applied = await kariaa.apply!(TASK_TEXT, {}, ctx(KEY));
    expect(applied.stage).toBe("work_needed");
    const receipt = await kariaa.upload!(applied.id, { kind: "text", text: "Positive: the customer says they will come back." }, ctx(KEY));
    expect(receipt.file?.kind).toBe("text");
    expect(receipt.progress?.ready_to_submit).toBe(true);
    await expect(kariaa.upload!(applied.id, { kind: "text", text: "a".repeat(30) }, ctx(KEY))).rejects.toMatchObject({
      code: "invalid_input",
      details: { kariaa_error: "looks_like_gibberish" },
    });
    const locked = await kariaa.apply!(TASK_LOCKED, {}, ctx(KEY));
    expect(locked.stage).toBe("applied");
    await expect(kariaa.upload!(locked.id, { kind: "text", text: "Something long enough to count." }, ctx(KEY))).rejects.toMatchObject({
      code: "wrong_stage",
    });
  });

  it("reports the account and updates the profile", async () => {
    const me = await kariaa.account!(ctx(KEY));
    expect(me).toMatchObject({ signed_in: true, ready: true, missing: [], label: "test key" });
    expect(me.usage?.calls_max).toBe(2000);
    const updated = await kariaa.updateAccount!({ location: "Kumasi, Ghana", phone_number: "nope" }, ctx(KEY));
    expect(updated.profile?.location).toBe("Kumasi, Ghana");
    expect(updated.rejected).toEqual([{ field: "phone_number", reason: "Use the international format, like +233201234567." }]);
  });

  it("reads earnings and requests a payout", async () => {
    await expect(kariaa.earnings!(ctx())).rejects.toMatchObject({ code: "auth_required" });
    const earnings = await kariaa.earnings!(ctx(KEY));
    expect(earnings.balance).toEqual({ amount: 12.5, currency: "USD" });
    expect(earnings.total_earned).toEqual({ amount: 13, currency: "USD" });
    expect(earnings.min_payout).toEqual({ amount: 10, currency: "USD" });
    expect(earnings.methods).toEqual(["paypal", "venmo", "giftcard"]);
    expect(earnings.entries?.[0]).toMatchObject({
      id: "earn-1",
      application_id: "00000099-0000-4000-8000-000000000000",
      job_title: "Read Sentences Aloud in Your Language",
      amount: 12.5,
      status: "available",
    });
    expect(earnings.payouts?.[0]).toMatchObject({
      id: "pay-0",
      amount: { amount: 0.5, currency: "USD" },
      method: "paypal",
      status: "paid",
      paid_at: "2026-10-02T00:00:00.000Z",
    });

    await expect(kariaa.payout!({ method: "crypto", destination: "x" }, ctx(KEY))).rejects.toMatchObject({
      code: "invalid_input",
      details: { kariaa_error: "method_not_supported", methods: ["paypal", "venmo", "giftcard"] },
    });
    await expect(kariaa.payout!({ method: "paypal" }, ctx(KEY))).rejects.toMatchObject({
      code: "invalid_input",
      details: { kariaa_error: "destination_required" },
    });
    await expect(kariaa.payout!({ method: "paypal", destination: "ama@example.com", amount: 50 }, ctx(KEY))).rejects.toMatchObject({
      code: "not_ready",
      details: { kariaa_error: "insufficient_balance" },
    });
    await expect(kariaa.payout!({ method: "paypal", destination: "ama@example.com", amount: 5 }, ctx(KEY))).rejects.toMatchObject({
      code: "not_ready",
      details: { kariaa_error: "below_minimum", min_payout: { amount: 10, currency: "USD" } },
    });
    const payout = await kariaa.payout!({ method: "paypal", destination: "ama@example.com" }, ctx(KEY));
    expect(payout).toMatchObject({
      id: "pay-1",
      amount: { amount: 12.5, currency: "USD" },
      method: "paypal",
      destination: "ama@example.com",
      status: "requested",
    });
    await expect(kariaa.payout!({ method: "paypal", destination: "ama@example.com", amount: 10 }, ctx(KEY))).rejects.toMatchObject({
      code: "already_exists",
      details: { kariaa_error: "payout_pending" },
    });
    const after = await kariaa.earnings!(ctx(KEY));
    expect(after.balance.amount).toBe(0);
    expect(after.payouts?.map((p) => p.status)).toEqual(["paid", "requested"]);
  });

  it("answers not_supported while the server lacks the earnings tools", async () => {
    const older = setup();
    const withoutTools = createFakeKariaa({ earnings: false });
    const { kariaa: k } = createKariaaConnectors({ transportFactory: withoutTools.transportFactory });
    await expect(k.earnings!(older.ctx(KEY))).rejects.toMatchObject({
      code: "not_supported",
      message: expect.stringContaining("my_earnings"),
      details: { tool: "my_earnings" },
    });
    await expect(k.payout!({ method: "paypal", destination: "a@b.c" }, older.ctx(KEY))).rejects.toMatchObject({
      code: "not_supported",
      details: { tool: "request_payout" },
    });
  });

  it("shares one connection per key across concurrent calls", async () => {
    const before = fake.state.connections;
    const fresh = setup();
    await Promise.all([
      fresh.kariaa.search!({}, fresh.ctx("kra_" + "y".repeat(43))),
      fresh.kariaaJobs.search!({ query: "electrician" }, fresh.ctx("kra_" + "y".repeat(43))),
    ]);
    expect(fresh.fake.state.connections).toBe(1);
    expect(fake.state.connections).toBe(before);
  });

  it("finds and reads listings through kariaa-jobs", async () => {
    const found = await kariaaJobs.search!({ query: "electrician", location: "Accra", limit: 5 }, ctx());
    expect(found.more).toBe(true);
    expect(found.jobs[0]).toMatchObject({
      id: JOB_ONE,
      kind: "listing",
      org: "Accra Power Ltd",
      location: { text: "Accra, Ghana" },
      pay: { text: "GHS 3,000 per month" },
      tags: ["source:jobberman", "match:exact"],
    });
    expect(found.jobs[1]!.location).toMatchObject({ remote: true });
    expect(await kariaaJobs.search!({ query: "x" }, ctx())).toEqual({ jobs: [] });
    const job = (await kariaaJobs.get!(JOB_ONE, ctx()))!;
    expect(job.description).toContain("Requirements:");
    expect(job.apply_hint).toContain("employer's page");
    expect(await kariaaJobs.get!("nope", ctx())).toBeNull();
    await expect(kariaaJobs.get!("99999999-9999-4999-8999-999999999999", ctx())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("kariaa with an incomplete profile", () => {
  const { kariaa, ctx } = setup({ profileComplete: false });
  it("reports what is missing and refuses to apply with not_ready", async () => {
    const me = await kariaa.account!(ctx(KEY));
    expect(me.ready).toBe(false);
    expect(me.missing).toEqual(["legal_name", "phone_number", "location", "occupation"]);
    expect(me.help).toContain("update_profile");
    await expect(kariaa.apply!(TASK_TEXT, {}, ctx(KEY))).rejects.toMatchObject({
      code: "not_ready",
      details: { kariaa_error: "profile_incomplete" },
    });
  });
});

describe("kariaa error mapping", () => {
  const result = (error: string, extra: Record<string, unknown> = {}) => ({
    isError: true,
    structuredContent: { error, message: `msg ${error}`, ...extra },
  });

  it("maps tool error codes", () => {
    expect(mapToolError("t", result("sign_in_required")).code).toBe("auth_required");
    expect(
      mapToolError("get_task", result("task_not_found", { message: "No open DataHouse task with that id. Call list_tasks." })).message,
    ).toBe("No open DataHouse task with that id. Call search_jobs.");
    expect(mapToolError("t", result("answers_missing", { question_ids: ["q"] }))).toMatchObject({
      code: "invalid_input",
      details: { question_ids: ["q"] },
    });
    expect(mapToolError("t", result("content_not_audio")).code).toBe("invalid_input");
    expect(mapToolError("t", result("duplicate_sample", { duplicate_of: "f" }))).toMatchObject({
      code: "already_exists",
      details: { duplicate_of: "f" },
    });
    expect(mapToolError("t", result("already_submitted"))).toMatchObject({ code: "wrong_stage", details: { stage: "in_review" } });
    expect(mapToolError("t", result("not_unlocked"))).toMatchObject({ code: "wrong_stage", details: { stage: "applied" } });
    expect(mapToolError("t", result("not_enough_files")).code).toBe("not_ready");
    expect(mapToolError("t", result("profile_incomplete")).code).toBe("not_ready");
    expect(
      mapToolError("t", result("submit_failed", { message: "Add a text response or upload at least one file before submitting." })).code,
    ).toBe("not_ready");
    expect(mapToolError("t", result("submit_failed", { message: "The database did not answer." })).code).toBe("upstream_error");
    expect(mapToolError("t", result("task_not_found")).code).toBe("not_found");
    expect(mapToolError("t", result("search_limit"))).toMatchObject({ code: "rate_limited", retry_after: 3600 });
    const daily = mapToolError("t", result("daily_write_limit"));
    expect(daily.code).toBe("rate_limited");
    expect(daily.retry_after).toBeGreaterThan(0);
    expect(daily.retry_after).toBeLessThanOrEqual(86_400);
    expect(mapToolError("t", result("upload_unavailable")).code).toBe("upstream_error");
    expect(mapToolError("t", { isError: true, content: [{ type: "text", text: "plain" }] })).toMatchObject({
      code: "upstream_error",
      message: "plain",
    });
  });

  it("maps transport failures", () => {
    expect(mapTransportError(new StreamableHTTPError(401, "Unauthorized")).code).toBe("auth_required");
    expect(mapTransportError(new StreamableHTTPError(429, "Too many")).code).toBe("rate_limited");
    expect(mapTransportError(new StreamableHTTPError(502, "Bad gateway")).code).toBe("upstream_error");
    expect(mapTransportError(new McpError(ErrorCode.RequestTimeout, "Request timed out")).code).toBe("timeout");
    expect(mapTransportError(new McpError(ErrorCode.InvalidParams, "bad")).message).toBe("bad");
    expect(mapTransportError(Object.assign(new Error("aborted"), { name: "AbortError" })).code).toBe("timeout");
    expect(mapTransportError(new TypeError("fetch failed"))).toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("unreachable"),
    });
    const passthrough = new ProtocolError("timeout", "budget spent");
    expect(mapTransportError(passthrough)).toBe(passthrough);
  });

  it("maps earnings and payouts from loose shapes", () => {
    const earnings = earningsOf({
      balance: 7,
      currency: "GHS",
      entries: [{ earning_id: "x", amount: 7, status: "credited", created_at: "2026-10-01" }, { id: "bad" }],
      payouts: [{ id: "p", amount: { amount: 3, currency: "GHS" }, method: "momo", status: "pending" }, { id: "no-amount" }],
    });
    expect(earnings.balance).toEqual({ amount: 7, currency: "GHS" });
    expect(earnings.entries).toEqual([{ id: "x", amount: 7, currency: "GHS", status: "available", earned_at: "2026-10-01" }]);
    expect(earnings.payouts).toEqual([{ id: "p", amount: { amount: 3, currency: "GHS" }, method: "momo", status: "requested" }]);
    expect(() => payoutOf({ method: "paypal" })).toThrow(/without id or amount/u);
  });

  it("maps shapes without a live server", () => {
    const job = taskToJob({
      task_id: TASK_AUDIO,
      title: "T",
      allowed_file_kinds: ["video"],
      sample: { count: 3, max_duration_seconds: 45, how_to: [], looks_like: null },
      qualification_questions: [{ question: "no id" }],
      rules: [],
      program_rules: [],
    });
    expect(job.requirements?.files).toEqual({ kinds: ["video"], count: 3, max_seconds: 45, max_bytes: 104_857_600 });
    expect(job.requirements?.questions).toBeUndefined();
    const app = submissionToApplication({
      submission_id: "s",
      task_id: "t",
      stage: "approved",
      review: { review_note: "Nice", earned_amount: 3, earned_currency: "USD" },
      received: 2,
      wanted: 2,
      ready_to_submit: false,
    });
    expect(app).toMatchObject({
      stage: "accepted",
      review: { note: "Nice", earned: { amount: 3, currency: "USD" } },
      progress: { received: 2, wanted: 2, ready_to_submit: false },
    });
    expect(inWorkTerms("No open DataHouse task with that id. Call list_tasks.")).toBe(
      "No open DataHouse task with that id. Call search_jobs.",
    );
    expect(inWorkTerms("Check my_submissions, or get_task for the rules; remove_sample to drop one.")).toBe(
      "Check my_applications, or get_job for the rules; remove_work to drop one.",
    );
    expect(inWorkTerms("Same names stay: search_jobs, request_payout.")).toBe("Same names stay: search_jobs, request_payout.");
    expect(submissionToApplication({ submission_id: "s", task_id: "t", stage: "weird" }).stage).toBe("closed");
    // after submit the staged list is empty and the review counts what went in
    const sent = submissionToApplication({
      submission_id: "s",
      task_id: "t",
      stage: "in_review",
      staged_files: [],
      received: 0,
      wanted: 3,
      ready_to_submit: false,
      review: { status: "submitted", files_count: 3 },
    });
    expect(sent.files).toBeUndefined();
    expect(sent.progress).toEqual({ received: 3, wanted: 3, ready_to_submit: false });
  });
});

describe("kariaa default export", () => {
  beforeAll(() => {
    // nothing to prepare; the default instance points at the public endpoint and is not called here
  });
  it("is registered under the expected ids", async () => {
    const mod = await import("./index.js");
    expect(mod.kariaa.id).toBe("kariaa");
    expect(mod.kariaaJobs.id).toBe("kariaa-jobs");
    expect(mod.KARIAA_MCP_URL).toBe("https://agent.kariaa.com/mcp");
  });
});

describe("Kariaa hints in Work API terms", () => {
  it("names the Work API's tools in every hint Kariaa gives", () => {
    expect(inWorkTerms("Submitted. The team reviews it; check get_submission for the outcome.")).toBe(
      "Submitted. The team reviews it; check get_application for the outcome.",
    );
    expect(inWorkTerms("Send the written answer with add_text_sample, then submit_samples.")).toBe(
      "Send the written answer with add_work, then submit_work.",
    );
    expect(inWorkTerms("Upload 3 samples (request_upload, PUT, confirm_upload each), then submit_samples.")).toBe(
      "Upload 3 samples (add_work with a file each), then submit_work.",
    );
    expect(submissionToApplication({ submission_id: "s", task_id: "t", stage: "in_review", next: "check get_submission" }).next).toBe(
      "check get_application",
    );
  });
});
