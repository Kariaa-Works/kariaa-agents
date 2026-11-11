import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeConnectorConformance, fixtureFetch, jsonResponse, testContext } from "../../core/conformance.js";
import { competitionToJob, createKaggle, submissionStage } from "./index.js";

const CREDS = { KAGGLE_USERNAME: "ama", KAGGLE_KEY: "k3y" };

/** Hand-made from the kagglesdk 0.1.37 types (ApiCompetition, ApiSubmission); not captured live. */
const TITANIC = {
  id: 3136,
  ref: "titanic",
  title: "Titanic - Machine Learning from Disaster",
  url: "https://www.kaggle.com/competitions/titanic",
  description: "Start here! Predict survival on the Titanic and get familiar with ML basics",
  organizationName: "Kaggle",
  category: "Getting Started",
  reward: "Knowledge",
  tags: [
    { ref: "tabular", name: "tabular" },
    { ref: "binary-classification", name: "binary classification" },
  ],
  deadline: "2030-01-01T00:00:00Z",
  enabledDate: "2012-09-28T21:13:33.21Z",
  teamCount: 14000,
  userHasEntered: true,
  maxDailySubmissions: 10,
  submissionsDisabled: false,
};
const PRIZE = {
  id: 1,
  ref: "cash-comp",
  title: "Predict the thing",
  url: "https://www.kaggle.com/competitions/cash-comp",
  reward: "$50,000",
  category: "Featured",
  deadline: "2026-12-31T23:59:00Z",
  userHasEntered: false,
  tags: [],
};
const SUBMISSION = {
  ref: 9001,
  date: "2026-10-20T10:00:00Z",
  description: "first try",
  fileName: "submission.csv",
  status: "COMPLETE",
  publicScore: "0.77511",
  submittedBy: "ama",
};

type Call = { url: string; init?: RequestInit };
const api = (calls: Call[] = [], state: { submissions: Record<string, unknown>[] } = { submissions: [SUBMISSION] }) =>
  fixtureFetch((url, init) => {
    calls.push({ url, init });
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (url.startsWith("https://upload.example/")) return new Response("", { status: 200 });
    if (auth !== `Basic ${Buffer.from("ama:k3y").toString("base64")}`) return jsonResponse({ code: 401, message: "Unauthorized" }, 401);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const method = url.split("/").pop();
    switch (method) {
      case "ListCompetitions":
        if (body.group === "COMPETITION_LIST_TAB_ENTERED") return { competitions: [TITANIC] };
        return { competitions: body.search === "titanic" ? [TITANIC] : [TITANIC, PRIZE], nextPageToken: "" };
      case "GetCompetition":
        if (body.competitionName === "titanic") return TITANIC;
        if (body.competitionName === "cash-comp") return PRIZE;
        return { code: 404, message: "Competition not found" };
      case "ListSubmissions":
        return { submissions: state.submissions };
      case "StartSubmissionUpload":
        return { token: "blob-token-1", createUrl: "https://upload.example/blob-1" };
      case "CreateSubmission":
        state.submissions = [{ ...SUBMISSION, ref: 9002, status: "PENDING", description: body.submissionDescription }];
        return { message: "Successfully submitted to Titanic", ref: 9002 };
      default:
        return jsonResponse({ code: 500, message: "?" }, 500);
    }
  });

const kaggle = createKaggle({ pendingFile: path.join(mkdtempSync(path.join(os.tmpdir(), "work-kaggle-")), "uploads.json") });

describeConnectorConformance(kaggle, {
  search: { query: "titanic" },
  fetch: api(),
  credentials: CREDS,
  minResults: 1,
  expectQueryInUrl: false,
});

describe("kaggle", () => {
  it("searches competitions over the RPC with basic auth", async () => {
    const calls: Call[] = [];
    const { jobs } = await kaggle.search!({ query: "titanic" }, testContext({ fetch: api(calls), credentials: CREDS }));
    expect(calls[0]!.url).toBe("https://api.kaggle.com/v1/competitions.CompetitionApiService/ListCompetitions");
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ search: "titanic", pageSize: 20, page: 1 });
    expect(jobs[0]).toMatchObject({
      id: "titanic",
      kind: "task",
      org: "Kaggle",
      pay: { min: 0, max: 0, period: "unit", text: "Knowledge (no cash prize)" },
      expires_at: "2030-01-01T00:00:00.000Z",
      posted_at: "2012-09-28T21:13:33.210Z",
      url: "https://www.kaggle.com/competitions/titanic",
    });
    expect(jobs[0]!.tags).toEqual(["getting started", "tabular", "binary classification", "entered", "source:kaggle"]);
    expect(competitionToJob(PRIZE)).toMatchObject({ pay: { min: 50000, max: 50000, currency: "USD", period: "unit", text: "$50,000" } });
    expect(competitionToJob({ ...PRIZE, deadline: "2020-01-01T00:00:00Z" })!.stages).toEqual(["search", "get"]);
    expect(competitionToJob({ title: "no ref" })).toBeNull();
  });

  it("refuses everything without the token", async () => {
    await expect(kaggle.search!({ query: "x" }, testContext({ fetch: api() }))).rejects.toMatchObject({ code: "auth_required" });
    expect(await kaggle.account!(testContext({ fetch: api() }))).toMatchObject({ signed_in: false });
    await expect(
      kaggle.get!("titanic", testContext({ fetch: api(), credentials: { KAGGLE_USERNAME: "ama", KAGGLE_KEY: "wrong" } })),
    ).rejects.toMatchObject({ code: "auth_required" });
  });

  it("enters, uploads, submits and follows the score", async () => {
    const state = { submissions: [] as Record<string, unknown>[] };
    const calls: Call[] = [];
    const ctx = testContext({ fetch: api(calls, state), credentials: CREDS });
    const notEntered = await kaggle.apply!("cash-comp", {}, ctx);
    expect(notEntered).toMatchObject({ id: "cash-comp", stage: "applied" });
    expect(notEntered.next).toContain("/rules");
    const entered = await kaggle.apply!("titanic", {}, ctx);
    expect(entered).toMatchObject({ id: "titanic", stage: "work_needed", job_title: "Titanic - Machine Learning from Disaster" });
    await expect(kaggle.submit!("titanic", {}, ctx)).rejects.toMatchObject({ code: "not_ready" });

    const receipt = await kaggle.upload!("titanic", { kind: "text", text: "PassengerId,Survived\n892,0\n" }, ctx);
    expect(receipt.file).toMatchObject({ id: "blob-token-1", name: "submission.csv", kind: "file", size: 27 });
    const start = calls.find((c) => c.url.endsWith("/StartSubmissionUpload"))!;
    expect(JSON.parse(String(start.init!.body))).toMatchObject({
      competitionName: "titanic",
      contentLength: 27,
      fileName: "submission.csv",
    });
    const put = calls.find((c) => c.url.startsWith("https://upload.example/"))!;
    expect(put.init!.method).toBe("PUT");
    expect((put.init!.headers as Record<string, string>)["content-range"]).toBe("bytes 0-26/27");
    expect((await kaggle.status!("titanic", ctx)).next).toContain("submit_work");

    const submitted = await kaggle.submit!("titanic", { note: "baseline" }, ctx);
    const create = calls.find((c) => c.url.endsWith("/CreateSubmission"))!;
    expect(JSON.parse(String(create.init!.body))).toEqual({
      competitionName: "titanic",
      blobFileTokens: "blob-token-1",
      submissionDescription: "baseline",
    });
    expect(submitted).toMatchObject({ id: "titanic", stage: "in_review" });
    await expect(kaggle.submit!("titanic", {}, ctx)).rejects.toMatchObject({ code: "not_ready" });

    state.submissions = [SUBMISSION];
    const scored = await kaggle.status!("titanic", ctx);
    expect(scored).toMatchObject({ stage: "accepted", updated_at: "2026-10-20T10:00:00.000Z" });
    expect(scored!.next).toContain("0.77511");
    expect((await kaggle.list!(ctx)).map((a) => a.id)).toEqual(["titanic"]);
    expect(await kaggle.account!(ctx)).toMatchObject({ signed_in: true, label: "ama" });
    await expect(kaggle.get!("nope-nope", ctx)).rejects.toMatchObject({ code: "not_found" });
  });

  it("maps submission states", () => {
    expect(submissionStage({ status: "ERROR", errorDescription: "Wrong columns" }, undefined)).toMatchObject({
      stage: "rejected",
      next: expect.stringContaining("Wrong columns"),
    });
    expect(submissionStage({ status: "SUBMISSION_STATUS_PENDING" }, undefined).stage).toBe("in_review");
    expect(submissionStage(undefined, { token: "t", name: "f.csv", size: 1, at: "" }).next).toContain("f.csv");
  });
});
