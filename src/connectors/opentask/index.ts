/**
 * OpenTask (opentask.ai): a marketplace where people and AI agents post work, bid on it,
 * deliver it under a contract and are paid in stablecoins through OpenTask's payment router.
 * Open tasks are public. Bidding, delivering files or links, competition entries, contracts,
 * earnings and the account use a scoped API token.
 */
import { createHash } from "node:crypto";
import { defineConnector, type ConnectorContext } from "../../core/connector.js";
import { ProtocolError, isProtocolError, toProtocolError } from "../../core/errors.js";
import { fetchJson } from "../../core/http.js";
import { applyFilters, iso, num, str, strings } from "../../core/jsonBoard.js";
import { queryWords, stripHtml, truncate } from "../../core/text.js";
import type { ApplicationFile, ApplyInput, Earning, NativeApplication, NativeJob, ResolvedWork } from "../../core/types.js";

export const OPENTASK_API = "https://opentask.ai/api";
export const OPENTASK_SITE = "https://opentask.ai";
const ID = "opentask";
const LABEL = "OpenTask";
const TOKEN_ENV = "OPENTASK_API_TOKEN";
export const OPENTASK_HELP =
  "Create an API token at https://opentask.ai/account/tokens with the scopes profile:read tasks:read bids:read bids:write contracts:read submissions:read submissions:write deliveries:read deliveries:write attachments:read attachments:write payments:read, and set OPENTASK_API_TOKEN. Browsing tasks works without one.";

type Rec = Record<string, unknown>;
type Money = { amount: number; currency: string };
type Stage = NativeApplication["stage"];

const rec = (value: unknown): Rec | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : undefined);
const recs = (value: unknown): Rec[] => (Array.isArray(value) ? value.map(rec).filter((r): r is Rec => r !== undefined) : []);

/** OpenTask ids are cuids. */
const NATIVE_ID = /^[A-Za-z0-9_-]{6,64}$/u;
/** A competition entry is followed as `<taskId>/entry`: OpenTask gives the entry its own id only on the first submission. */
const ENTRY_ID = /^([A-Za-z0-9_-]{6,64})\/entry$/u;
const entryTaskOf = (applicationId: string): string | undefined => ENTRY_ID.exec(applicationId)?.[1];

export const taskUrl = (id: string) => `${OPENTASK_SITE}/tasks/${id}`;
const contractUrl = (id: string) => `${OPENTASK_SITE}/dashboard/contracts/${id}`;

const BID_HINT =
  'Bid with apply_to_job: your price in answers.price (for example "30 USDC"; the task budget when left out), days to deliver in answers.eta_days, and your approach in note. Once the poster hires you, send the work with submit_work: a link in note, or files added with add_work first.';
const ENTRY_HINT =
  "Competition: apply_to_job opens your entry without sending anything; add your artifacts as files with add_work, then submit_work with your notes. The poster awards the best entries and the prize is paid automatically.";

/** "30 USDC", "7 USD", "$15" as money; undefined when the text names no amount. */
export function moneyOf(text: string | undefined): Money | undefined {
  if (!text) return undefined;
  const dollars = /\$\s*(\d+(?:\.\d+)?)/u.exec(text);
  if (dollars) return { amount: Number(dollars[1]), currency: "USD" };
  const match = /(\d+(?:\.\d+)?)\s*([A-Za-z][A-Za-z0-9]{1,15})\b/u.exec(text);
  return match ? { amount: Number(match[1]), currency: match[2]!.toUpperCase() } : undefined;
}

const atomicMoney = (atomic: unknown, decimals: unknown, token: unknown): Money | undefined => {
  const units = num(atomic);
  const places = num(decimals);
  const currency = str(token);
  return units !== undefined && places !== undefined && currency ? { amount: units / 10 ** places, currency } : undefined;
};

function taskPay(t: Rec): NativeJob["pay"] | undefined {
  const text = str(t.budgetText)?.trim();
  const reward = rec(t.rewardTerms);
  const prize = reward ? atomicMoney(reward.rewardAmountAtomic, reward.rewardTokenDecimals, reward.rewardToken) : undefined;
  if (prize && prize.amount > 0) {
    const winners = num(reward?.maxWinners);
    return {
      min: prize.amount,
      max: prize.amount,
      currency: prize.currency,
      period: "unit",
      unit: "prize",
      text: `${text ?? `${prize.amount} ${prize.currency}`} prize${winners ? `, ${winners} winner${winners === 1 ? "" : "s"}` : ""}`,
    };
  }
  const amount = num(t.budgetAmount);
  const currency = str(t.budgetCurrency);
  if (amount !== undefined && amount > 0) {
    return { min: amount, max: amount, ...(currency ? { currency } : {}), period: "unit", unit: "per task", ...(text ? { text } : {}) };
  }
  // Many tasks carry the budget only as text: "30 USDC", "0 (internal roadmap item)".
  const written = text?.match(/^\s*(\d+(?:\.\d+)?)\s*([A-Za-z]{2,6})?\b/u);
  if (written) {
    const value = Number(written[1]);
    const code = written[2]?.toUpperCase();
    return { min: value, max: value, ...(code ? { currency: code } : {}), period: "unit", unit: "per task", text: text! };
  }
  if (unpaid(t)) return { min: 0, max: 0, ...(text ? { text } : {}) };
  return text ? { text } : undefined;
}

/** A budget that names no positive amount ("0 (internal roadmap item)", "Free - community contribution"). */
function unpaid(t: Rec): boolean {
  if ((num(t.budgetAmount) ?? 0) > 0 || rec(t.rewardTerms)) return false;
  const text = str(t.budgetText);
  if (!text) return false;
  const money = moneyOf(text);
  return !money || money.amount === 0;
}

/** false when the task says it takes no new bids or entries (closed, judging); undefined when the row does not say. */
function openForWork(t: Rec, actions: unknown): boolean | undefined {
  const status = str(t.status);
  if (status && status !== "open") return false;
  const list = recs(actions);
  if (list.length) {
    return list.some(
      (a) => str(a.state) === "available" && (str(rec(a.actor)?.role) === "worker" || /bid|entr|submit/u.test(str(a.action) ?? "")),
    );
  }
  return status ? true : undefined;
}

function capabilityLine(c: Rec): string | undefined {
  const name = str(c.name);
  if (!name) return undefined;
  const tools = strings(c.tools);
  const outputs = strings(c.outputs);
  return [
    `${name}${str(c.requirementLevel) ? ` (${str(c.requirementLevel)})` : ""}`,
    tools.length ? `tools: ${tools.join(", ")}` : "",
    outputs.length ? `outputs: ${outputs.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** One task of `GET /tasks` (a summary row) or `GET /tasks/{id}` (the detail, with its available actions) as a job. */
export function taskToJob(t: Rec, actions?: unknown): NativeJob | null {
  const id = str(t.id);
  const title = str(t.title);
  if (!id || !title) return null;
  const owner = rec(t.owner);
  const mode = str(t.executionMode) ?? "pitch";
  const delivery = str(t.deliveryStructure);
  const text = stripHtml(str(t.description));
  const criteria = strings(t.acceptanceCriteria);
  const deliverables = strings(t.expectedDeliverableTypes);
  const capabilities = recs(t.capabilityRequirements)
    .map(capabilityLine)
    .filter((line): line is string => Boolean(line));
  const attachments = recs(t.attachments)
    .map((a) => (str(a.url) ? `${str(a.label) ?? "Attachment"}: ${str(a.url)}` : undefined))
    .filter((line): line is string => Boolean(line));
  const sections = [
    text,
    criteria.length ? `Acceptance criteria:\n${criteria.map((c) => `- ${c}`).join("\n")}` : "",
    deliverables.length ? `Deliverables: ${deliverables.join("; ")}` : "",
    capabilities.length ? `Required capabilities:\n${capabilities.map((c) => `- ${c}`).join("\n")}` : "",
    attachments.length ? `Attachments:\n${attachments.map((a) => `- ${a}`).join("\n")}` : "",
    delivery === "milestones" ? "Delivered in milestones agreed with the poster after hiring." : "",
  ].filter(Boolean);
  const pay = taskPay(t);
  const org = str(owner?.displayName) ?? str(owner?.handle);
  const posted = iso(t.createdAt);
  const deadline = iso(t.deadline);
  const open = openForWork(t, actions);
  return {
    id,
    kind: "task",
    title,
    ...(org ? { org } : {}),
    location: { remote: true },
    ...(pay ? { pay } : {}),
    ...(text ? { summary: truncate(text, 300) } : {}),
    ...(sections.length ? { description: truncate(sections.join("\n\n"), 6000) } : {}),
    url: taskUrl(id),
    ...(posted ? { posted_at: posted } : {}),
    ...(deadline ? { expires_at: deadline } : {}),
    tags: [...strings(t.skillsTags).slice(0, 4), mode, ...(unpaid(t) ? ["unpaid"] : []), "agent-allowed", "source:opentask"],
    ...(open === false ? { stages: ["search", "get"] } : {}),
    apply_hint: mode === "pitch" ? BID_HINT : ENTRY_HINT,
    ...(criteria.length ? { requirements: { rules: criteria } } : {}),
    raw: {
      execution_mode: mode,
      delivery: delivery ?? null,
      owner: owner ? { handle: str(owner.handle) ?? null, kind: str(owner.kind) ?? null } : null,
      status: str(t.status) ?? null,
      phase: str(t.executionPhase) ?? null,
      updated_at: str(t.updatedAt) ?? null,
    },
  };
}

const BID_STAGE: Record<string, Stage> = {
  active: "applied",
  accepted: "work_needed",
  withdrawn: "withdrawn",
  rejected: "rejected",
  expired: "closed",
};
const BID_NEXT: Record<string, string> = {
  active: "Waiting for the poster to hire a bidder. A hire starts a contract; get_application shows it.",
  accepted: "Hired: the contract is starting. Do the work, then submit_work.",
  withdrawn: "Bid withdrawn.",
  rejected: "The poster declined this bid.",
  expired: "The bid expired before the poster hired anyone.",
};
const CONTRACT_STAGE: Record<string, Stage> = {
  in_progress: "work_needed",
  submitted: "in_review",
  accepted: "accepted",
  rejected: "rejected",
  cancelled: "closed",
};

function contractNext(contract: Rec): string {
  switch (str(contract.status)) {
    case "in_progress":
      return "Hired. Do the work, then submit_work with the deliverable link in note, or add_work files first. Milestone contracts are delivered one milestone at a time.";
    case "submitted":
      return "Submitted. The poster reviews it, pays your payout wallet through OpenTask's payment router, then accepts.";
    case "accepted":
      return str(contract.settlementStatus) === "fully_settled"
        ? "Accepted and paid to your payout wallet."
        : "Accepted; the payment to your payout wallet is settling.";
    case "rejected":
      return "The poster rejected the submission. The reason is on the contract page, where a dispute can be opened.";
    case "cancelled":
      return "The contract was cancelled.";
    default:
      return "The contract page shows the next step.";
  }
}

/** A bid as an application, with the contract it became when the poster hired the bidder. */
export function bidToApplication(bid: Rec, contract?: Rec): NativeApplication {
  const id = String(bid.id);
  const task = rec(bid.task) ?? rec(contract?.task);
  const taskId = str(task?.id) ?? str(bid.taskId) ?? id;
  const title = str(task?.title);
  const bidStatus = str(bid.status) ?? "active";
  const contractId = str(contract?.id);
  const contractStatus = str(contract?.status);
  const stage: Stage = contractStatus ? (CONTRACT_STAGE[contractStatus] ?? "work_needed") : (BID_STAGE[bidStatus] ?? "applied");
  const next = contract && contractStatus ? contractNext(contract) : (BID_NEXT[bidStatus] ?? `Bid ${bidStatus}.`);
  const amount = num(bid.priceAmount);
  const currency = str(bid.priceCurrency);
  const price = amount !== undefined && currency ? { amount, currency } : moneyOf(str(bid.priceText) ?? str(rec(contract?.bid)?.priceText));
  const settled = str(contract?.settlementStatus);
  const created = iso(bid.createdAt);
  const updated = iso(contract?.updatedAt ?? bid.updatedAt);
  return {
    id,
    job_id: taskId,
    ...(title ? { job_title: title } : {}),
    stage,
    next,
    url: contractId ? contractUrl(contractId) : taskUrl(taskId),
    ...(created ? { created_at: created } : {}),
    ...(updated ? { updated_at: updated } : {}),
    ...(stage === "accepted" && settled === "fully_settled" && price ? { review: { earned: price } } : {}),
    raw: {
      bid_status: bidStatus,
      price: str(bid.priceText) ?? null,
      eta_days: num(bid.etaDays) ?? null,
      contract_id: contractId ?? null,
      contract_status: contractStatus ?? null,
      settlement: settled ?? null,
    },
  };
}

/** A won competition entry (a task-award contract) as an application. */
export function awardToApplication(contract: Rec): NativeApplication | null {
  const task = rec(contract.task);
  const taskId = str(task?.id);
  if (!taskId || contract.id === undefined) return null;
  const award = rec(contract.taskAward);
  const prize = atomicMoney(award?.sellerAmountAtomic, award?.payoutTokenDecimals, award?.payoutToken);
  const cancelled = str(contract.status) === "cancelled";
  const paid = str(contract.settlementStatus) === "fully_settled";
  const created = iso(contract.createdAt);
  const updated = iso(contract.updatedAt);
  return {
    id: `${taskId}/entry`,
    job_id: taskId,
    ...(str(task?.title) ? { job_title: str(task?.title) } : {}),
    stage: cancelled ? "closed" : "accepted",
    next: cancelled
      ? "The award was cancelled."
      : paid
        ? "Your entry won; the prize was paid to your payout wallet."
        : "Your entry won; the prize is paid automatically to your payout wallet.",
    url: contractUrl(String(contract.id)),
    ...(created ? { created_at: created } : {}),
    ...(updated ? { updated_at: updated } : {}),
    ...(paid && prize ? { review: { earned: prize } } : {}),
    raw: {
      contract_id: String(contract.id),
      contract_status: str(contract.status) ?? null,
      settlement: str(contract.settlementStatus) ?? null,
    },
  };
}

const ENTRY_STAGE: Record<string, Stage> = {
  active: "in_review",
  changes_requested: "work_needed",
  withdrawn: "withdrawn",
  rejected: "rejected",
  awarded: "accepted",
  not_selected: "rejected",
};
const ENTRY_NEXT: Record<string, string> = {
  active: "Entry in. The poster judges the entries after intake closes and awards the best; prizes are paid automatically.",
  changes_requested: "The poster asked for changes: add_work the revised files and submit_work again.",
  withdrawn: "Entry withdrawn.",
  rejected: "The poster rejected this entry.",
  awarded: "Your entry won; the prize is paid automatically to your payout wallet.",
  not_selected: "Judging is over; this entry was not selected.",
};

/** Your entry in a competition (or the empty entry before the first submission) as an application. */
export function entryToApplication(taskId: string, entry: Rec | undefined, title?: string): NativeApplication {
  const base = { id: `${taskId}/entry`, job_id: taskId, ...(title ? { job_title: title } : {}), url: taskUrl(taskId) };
  if (!entry)
    return { ...base, stage: "work_needed", next: "No entry yet: add_work your artifacts (files), then submit_work with your notes." };
  const status = str(entry.status) ?? "active";
  const created = iso(entry.createdAt);
  const updated = iso(entry.updatedAt);
  return {
    ...base,
    stage: ENTRY_STAGE[status] ?? "in_review",
    next: ENTRY_NEXT[status] ?? `Entry ${status}.`,
    ...(created ? { created_at: created } : {}),
    ...(updated ? { updated_at: updated } : {}),
    raw: {
      entry_id: str(entry.id) ?? null,
      status,
      version_id: str(entry.currentVersionId) ?? null,
      versions: num(entry.versionCount) ?? null,
      reason: str(entry.statusReason) ?? null,
    },
  };
}

function requireToken(ctx: ConnectorContext): string {
  const token = ctx.credentials[TOKEN_ENV]?.trim();
  if (!token) throw new ProtocolError("auth_required", OPENTASK_HELP, { connector: ID });
  return token;
}

type Call = { method?: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown; key?: string };
type FetchMethod = NonNullable<Parameters<typeof fetchJson>[2]["method"]>;

/** The machine-readable `code` of an OpenTask error body (`{ error, code, issues }`). */
async function errorCode(response: Response): Promise<string | undefined> {
  try {
    return str(rec(await response.json())?.code);
  } catch {
    return undefined;
  }
}

/**
 * One request to the API: public when `token` is undefined, as the token's profile otherwise. A refused request
 * keeps OpenTask's error code in `details.code` (fetchJson keeps only the status), for example native_delivery_required.
 */
async function api(ctx: ConnectorContext, token: string | undefined, path: string, call: Call = {}): Promise<Rec> {
  let code: string | undefined;
  const watched: ConnectorContext = {
    ...ctx,
    fetch: async (input, init) => {
      const response = await ctx.fetch(input, init);
      if (!response.ok) code = await errorCode(response.clone());
      return response;
    },
  };
  try {
    const body = await fetchJson<unknown>(watched, `${OPENTASK_API}${path}`, {
      label: LABEL,
      connector: ID,
      // fetchJson sends the method as given; its type does not list PATCH, which delivery drafts use.
      ...(call.method ? { method: call.method as FetchMethod } : {}),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(call.key ? { "idempotency-key": call.key } : {}) },
      ...(call.body !== undefined ? { body: call.body } : {}),
      authHelp: OPENTASK_HELP,
    });
    return rec(body) ?? {};
  } catch (error) {
    if (!code || !isProtocolError(error)) throw error;
    throw new ProtocolError(error.code, error.message, {
      connector: ID,
      details: { ...error.details, code },
      ...(error.retry_after !== undefined ? { retry_after: error.retry_after } : {}),
      cause: error.cause,
    });
  }
}

/** A stable Idempotency-Key: the same write sent twice replays on OpenTask instead of happening twice. */
const idempotencyKey = (...parts: string[]) => `wp-${createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 40)}`;

const answerOf = (input: ApplyInput, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = input.answers?.[key];
    const text = (Array.isArray(value) ? value.join(", ") : value)?.trim();
    if (text) return text;
  }
  return undefined;
};

function priceText(input: ApplyInput, task: Rec): string | undefined {
  const given = answerOf(input, "price", "price_text", "amount") ?? input.preferred_rate?.trim();
  const currency = str(task.budgetCurrency);
  if (given) return /^\d+(?:\.\d+)?$/u.test(given) && currency ? `${given} ${currency}` : given.slice(0, 100);
  const amount = num(task.budgetAmount);
  return amount !== undefined && amount > 0 && currency ? `${String(task.budgetAmount)} ${currency}` : undefined;
}

function etaDays(input: ApplyInput): number | undefined {
  const text = answerOf(input, "eta_days", "days", "eta");
  if (text === undefined) return undefined;
  const days = Number(text);
  if (!Number.isInteger(days) || days < 0 || days > 365) {
    throw new ProtocolError("invalid_input", "answers.eta_days must be a whole number of days from 0 to 365.", { connector: ID });
  }
  return days;
}

function closedError(task: Rec, actions: unknown): ProtocolError {
  const label = recs(actions)
    .map((a) => str(a.label))
    .find(Boolean);
  const what = (str(task.executionMode) ?? "pitch") === "pitch" ? "bids" : "entries";
  return new ProtocolError("wrong_stage", `${str(task.title) ?? "This task"} is not taking new ${what}${label ? ` (${label})` : ""}.`, {
    connector: ID,
    details: { status: str(task.status) ?? null, phase: str(task.executionPhase) ?? null },
  });
}

async function publicTask(ctx: ConnectorContext, taskId: string): Promise<{ task: Rec; actions: unknown }> {
  const body = await api(ctx, undefined, `/tasks/${taskId}`);
  const task = rec(body.task);
  if (!task || !str(task.id))
    throw new ProtocolError("upstream_error", "OpenTask answered the task in an unexpected shape.", { connector: ID });
  return { task, actions: body.availableActions };
}

/** A bid, the contract it became, and the actions that contract offers you now. */
type Contracted = { bid: Rec; contract?: Rec; actions: Rec[] };

async function bidAndContract(ctx: ConnectorContext, token: string, bidId: string): Promise<Contracted> {
  if (!NATIVE_ID.test(bidId))
    throw new ProtocolError("not_found", `${JSON.stringify(bidId)} is not an OpenTask bid id.`, { connector: ID });
  const body = await api(ctx, token, `/agent/bids/${bidId}`);
  const bid = rec(body.bid);
  if (!bid || bid.id === undefined)
    throw new ProtocolError("upstream_error", "OpenTask answered the bid without an id.", { connector: ID });
  let contractId = str(rec(bid.contract)?.id);
  if (!contractId && str(bid.status) === "accepted") {
    // A hired bid without the contract inline: find the contract that names this bid.
    const mine = await api(ctx, token, "/agent/contracts?role=seller&limit=100");
    contractId = str(recs(mine.contracts).find((c) => str(rec(c.bid)?.id) === bidId)?.id);
  }
  if (!contractId) return { bid, actions: [] };
  const detail = await api(ctx, token, `/agent/contracts/${contractId}`);
  const contract = rec(detail.contract) ?? rec(bid.contract);
  return { bid, contract, actions: [...recs(detail.availableActions), ...recs(contract?.availableActions)] };
}

/** How a contract takes work now: a native delivery package, an ordinary submission, an ordinary milestone submission, or nothing yet. */
type Plan = { kind: "native" | "ordinary" | "milestone" | "waiting"; contractId: string; milestone?: Rec };

const NATIVE_ACTION = /^(prepare|revise)_delivery$/u;
const OPEN_MILESTONE = new Set(["active", "rejected"]);

async function planFor(ctx: ConnectorContext, token: string, contractId: string, contract: Rec, actions: Rec[]): Promise<Plan> {
  const schedule = await api(ctx, token, `/agent/contracts/${contractId}/milestones`);
  const milestones = recs(schedule.milestones).sort((a, b) => (num(a.sequence) ?? 0) - (num(b.sequence) ?? 0));
  if (str(rec(schedule.summary)?.settlementMode) === "milestones" && milestones.length) {
    const open = milestones.find((m) => OPEN_MILESTONE.has(str(m.status) ?? ""));
    if (!open) {
      const sent = milestones.find((m) => str(m.status) === "submitted");
      return {
        kind: "waiting",
        contractId,
        milestone: sent ?? milestones.find((m) => !["accepted", "cancelled"].includes(str(m.status) ?? "")),
      };
    }
    // A milestone with a native package stays on native delivery.
    const native = NATIVE_ACTION.test(str(open.recommendedAction) ?? "") || rec(open.currentDelivery) !== undefined;
    return { kind: native ? "native" : "milestone", contractId, milestone: open };
  }
  const offered = actions.filter((a) => str(a.state) !== "complete").map((a) => str(a.action) ?? "");
  // submit_deliverable is documented as the contract's suggestedAction; action names are free strings.
  const ordinary = offered.includes("submit_deliverable") || str(contract.suggestedAction) === "submit_deliverable";
  const native =
    offered.some((name) => NATIVE_ACTION.test(name)) || (!ordinary && rec(contract.nativeDeliveryAvailability)?.enabled === true);
  return { kind: native ? "native" : "ordinary", contractId };
}

const milestoneName = (m: Rec) => `Milestone ${num(m.sequence) ?? ""} (${str(m.title) ?? "untitled"})`;

const PENDING_PACKAGE = new Set(["processing", "submitted", "approved", "approved_pending_settlement", "accepted"]);

/** Your draft delivery package in this scope: resumed when one exists, otherwise created (on the reviewed revision after requested changes). */
async function draftFor(
  ctx: ConnectorContext,
  token: string,
  contractId: string,
  milestone: Rec | undefined,
  title: string | undefined,
): Promise<{ draft?: Rec; latest?: Rec; rebase?: string }> {
  const milestoneId = milestone ? String(milestone.id) : undefined;
  const page = await api(ctx, token, `/agent/contracts/${contractId}/deliveries?limit=50`);
  const scoped = recs(page.deliveries).filter((d) => (str(d.milestoneId) ?? "") === (milestoneId ?? ""));
  const draft = scoped.find((d) => str(d.status) === "draft");
  if (draft) {
    // A draft started before the poster asked for changes moves onto the reviewed revision.
    const reviewed = str(scoped.find((d) => str(d.status) === "changes_requested")?.id);
    return reviewed && str(draft.basedOnPackageId) !== reviewed ? { draft, rebase: reviewed } : { draft };
  }
  const latest = scoped.find((d) => str(d.status) !== "superseded");
  if (latest && PENDING_PACKAGE.has(str(latest.status) ?? "")) return { latest };
  const base = latest && str(latest.status) === "changes_requested" ? String(latest.id) : undefined;
  const body = {
    ...(milestoneId ? { milestoneId } : {}),
    ...(title ? { title: truncate(title, 190) } : {}),
    ...(base ? { basedOnDeliveryPackageId: base } : {}),
  };
  const created = await api(ctx, token, `/agent/contracts/${contractId}/deliveries`, {
    method: "POST",
    body,
    key: idempotencyKey(contractId, "delivery", JSON.stringify(body)),
  });
  const delivery = rec(created.delivery);
  if (!delivery || delivery.id === undefined) {
    throw new ProtocolError("upstream_error", "OpenTask answered the delivery draft without an id.", { connector: ID });
  }
  return { draft: delivery };
}

/** The application while a submitted package waits on the poster. */
function withPoster(current: NativeApplication, latest: Rec): NativeApplication {
  const status = str(latest.status) ?? "submitted";
  const next =
    status === "accepted"
      ? "The delivery was accepted."
      : status.startsWith("approved")
        ? "The poster approved the delivery; payment to your payout wallet comes next."
        : "The delivery is with the poster for review.";
  return {
    ...current,
    stage: status === "accepted" ? "accepted" : "in_review",
    next,
    raw: { ...(rec(current.raw) ?? {}), delivery_id: str(latest.id) ?? null, delivery_status: status },
  };
}

function notHired(bid: Rec): ProtocolError {
  const app = bidToApplication(bid);
  return new ProtocolError(
    "wrong_stage",
    `Not hired yet: work goes in once the poster starts a contract from this bid. ${app.next ?? ""}`.trim(),
    {
      connector: ID,
      details: { stage: app.stage },
    },
  );
}

async function entryOf(ctx: ConnectorContext, token: string, taskId: string): Promise<Rec | undefined> {
  const body = await api(ctx, token, `/agent/tasks/${taskId}/entries?limit=5`);
  return recs(body.entries)[0];
}

const entryUploads = (taskId: string) => `/agent/tasks/${taskId}/entry-attachments/upload-intents`;
const contractUploads = (contractId: string) => `/agent/contracts/${contractId}/submission-attachments/upload-intents`;

/** Where files for this application go: the competition entry, the contract's draft delivery package, or the contract's submission. */
async function uploadsOf(ctx: ConnectorContext, token: string, applicationId: string): Promise<string> {
  const taskId = entryTaskOf(applicationId);
  if (taskId) return entryUploads(taskId);
  const { bid, contract, actions } = await bidAndContract(ctx, token, applicationId);
  const contractId = str(contract?.id);
  if (!contract || !contractId) throw notHired(bid);
  const status = str(contract.status);
  if (status !== "in_progress" && status !== "rejected") {
    throw new ProtocolError("wrong_stage", `The contract is ${status ?? "closed"}; it takes no more files.`, {
      connector: ID,
      details: { stage: bidToApplication(bid, contract).stage },
    });
  }
  const plan = await planFor(ctx, token, contractId, contract, actions);
  if (plan.kind === "ordinary") return contractUploads(contractId);
  if (plan.kind === "native") {
    const { draft } = await draftFor(ctx, token, contractId, plan.milestone, str(rec(bid.task)?.title));
    if (draft) return `/agent/contracts/${contractId}/deliveries/${String(draft.id)}/upload-intents`;
    throw new ProtocolError("wrong_stage", "The delivery is with the poster; files go in again if they ask for changes.", {
      connector: ID,
    });
  }
  if (plan.kind === "milestone") {
    throw new ProtocolError("not_supported", "This milestone takes a link and notes, not files: put the link in submit_work's note.", {
      connector: ID,
    });
  }
  throw new ProtocolError("wrong_stage", "No milestone is open for delivery right now.", { connector: ID });
}

const GONE_INTENT = new Set(["canceled", "expired", "failed"]);
const GONE_FILE = new Set(["deleted", "delete_pending", "quarantined", "processing_failed"]);

/** The upload intents that still hold a file. */
async function intentsAt(ctx: ConnectorContext, token: string, base: string): Promise<Rec[]> {
  const body = await api(ctx, token, base);
  return recs(body.uploadIntents).filter((i) => !GONE_INTENT.has(str(i.status) ?? "") && !GONE_FILE.has(str(i.fileStatus) ?? ""));
}

function intentFile(intent: Rec): ApplicationFile {
  const size = num(intent.sizeBytes);
  return {
    id: String(intent.id),
    name: str(intent.filename) ?? String(intent.id),
    kind: str(intent.contentType) ?? "file",
    ...(size !== undefined ? { size } : {}),
  };
}

/** A submission, a delivery package and an entry version each take at most 20 files. */
const MAX_FILES = 20;

/** The uploaded files that can go out now; not_ready while OpenTask is still scanning one. */
function readyFiles(intents: Rec[]): Rec[] {
  const completed = intents.filter((i) => str(i.status) === "completed");
  const waiting = completed.filter((i) => str(i.fileStatus) !== "ready");
  if (waiting.length) {
    const ms = Math.max(...waiting.map((i) => num(i.pollAfterMs) ?? 2000));
    throw new ProtocolError("not_ready", `OpenTask is still checking ${waiting.length} file(s); submit again in a few seconds.`, {
      connector: ID,
      retry_after: Math.max(1, Math.ceil(ms / 1000)),
      details: { files: waiting.map(intentFile) },
    });
  }
  if (completed.length > MAX_FILES) {
    throw new ProtocolError(
      "invalid_input",
      `OpenTask takes at most ${MAX_FILES} files at a time: remove_work ${completed.length - MAX_FILES} of the ${completed.length} uploaded files first.`,
      { connector: ID, details: { files: completed.map(intentFile) } },
    );
  }
  return completed;
}

const isImage = (intent: Rec) => /^image\//u.test(str(intent.contentType) ?? "");

function workFile(work: ResolvedWork): { bytes: Uint8Array; name: string; mime: string } {
  if (work.kind === "file") return { bytes: work.bytes, name: work.name, mime: work.mime_type || "application/octet-stream" };
  return { bytes: new TextEncoder().encode(work.text), name: "work.txt", mime: "text/plain" };
}

/** PUT the bytes to the short-lived storage URL OpenTask issued, with exactly the headers it asked for. */
async function putBytes(ctx: ConnectorContext, url: string, headers: Rec | undefined, bytes: Uint8Array): Promise<void> {
  const sent: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    // fetch sets the length from the body itself
    if ((typeof value === "string" || typeof value === "number") && name.toLowerCase() !== "content-length") sent[name] = String(value);
  }
  let response: Response;
  try {
    response = await ctx.fetch(url, { method: "PUT", headers: sent, body: bytes, signal: ctx.signal });
  } catch (error) {
    throw toProtocolError(error, ID);
  }
  if (!response.ok) {
    throw new ProtocolError("upstream_error", `OpenTask's file storage refused the upload (${response.status}); add the file again.`, {
      connector: ID,
      details: { status: response.status },
    });
  }
}

/** The first link in a note, which becomes the deliverable URL; `https` passes over http:// links. */
export function firstLink(note: string, https = false): string | undefined {
  const link = https ? /https:\/\/[^\s<>"')\]]+/u : /https?:\/\/[^\s<>"')\]]+/u;
  return link.exec(note)?.[0]?.replace(/[.,;:!?]+$/u, "");
}

const MAX_URL = 2000;

/** The deliverable link of a note, refused locally when it is longer than OpenTask takes. */
function linkOf(note: string, https = false): string | undefined {
  const link = firstLink(note, https);
  if (link && link.length > MAX_URL) {
    throw new ProtocolError("invalid_input", `The link in note is longer than the ${MAX_URL} characters OpenTask takes.`, {
      connector: ID,
    });
  }
  return link;
}

/** A URL in its parsed form, so a different case in the host or a default port does not make it a new link. */
const sameUrl = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

/** Changes with every submission and update of the contract: a resubmission after a rejection is a new write, a retry replays. */
const attemptOf = (contract: Rec) => `${num(rec(contract._count)?.submissions) ?? ""}@${str(contract.updatedAt) ?? ""}`;

/** A competition note: plain notes, or JSON `{ notes, benchmarkProof }` for a benchmark. */
function entryNote(note: string): { notes?: string; benchmarkProof?: Rec } {
  if (note.startsWith("{")) {
    try {
      const parsed = rec(JSON.parse(note));
      const proof = rec(parsed?.benchmarkProof);
      if (parsed && proof) return { ...(str(parsed.notes) ? { notes: str(parsed.notes) } : {}), benchmarkProof: proof };
    } catch {
      // plain notes
    }
  }
  return note ? { notes: note } : {};
}

const NO_DELIVERABLE = "OpenTask needs the deliverable: a link (https://…) in note, or files added with add_work first.";

async function submitBid(ctx: ConnectorContext, token: string, bidId: string, note: string): Promise<NativeApplication> {
  const { bid, contract, actions } = await bidAndContract(ctx, token, bidId);
  const contractId = str(contract?.id);
  if (!contract || !contractId) throw notHired(bid);
  const current = bidToApplication(bid, contract);
  const status = str(contract.status);
  if (status === "submitted") return current;
  if (status !== "in_progress" && status !== "rejected") {
    throw new ProtocolError("wrong_stage", `The contract is ${status ?? "closed"}; it takes no more submissions.`, {
      connector: ID,
      details: { stage: current.stage },
    });
  }
  const plan = await planFor(ctx, token, contractId, contract, actions);
  if (plan.kind === "native") return submitNative(ctx, token, current, plan, note);
  if (plan.kind === "milestone") return submitMilestone(ctx, token, current, bidId, plan, note);
  if (plan.kind === "ordinary") return submitOrdinary(ctx, token, current, bidId, plan, contract, note);
  const milestone = plan.milestone;
  if (milestone && str(milestone.status) === "submitted") {
    return { ...current, stage: "in_review", next: `${milestoneName(milestone)} is with the poster.` };
  }
  const waiting = milestone
    ? ` (${milestoneName(milestone)}: ${(str(milestone.recommendedAction) ?? str(milestone.status) ?? "").replace(/_/gu, " ")})`
    : "";
  throw new ProtocolError("wrong_stage", `No milestone is open for delivery${waiting}.`, {
    connector: ID,
    details: { stage: current.stage },
  });
}

/** An ordinary contract submission: the ready files, the first link in the note, and the note. */
async function submitOrdinary(
  ctx: ConnectorContext,
  token: string,
  current: NativeApplication,
  bidId: string,
  plan: Plan,
  contract: Rec,
  note: string,
): Promise<NativeApplication> {
  const link = linkOf(note);
  const ready = readyFiles(await intentsAt(ctx, token, contractUploads(plan.contractId)));
  const fileIds = ready.map((i) => String(i.fileId));
  if (!link && !fileIds.length) throw new ProtocolError("invalid_input", NO_DELIVERABLE, { connector: ID });
  const body = {
    ...(link ? { deliverableUrl: link } : {}),
    ...(fileIds.length ? { fileIds } : {}),
    ...(note ? { notes: truncate(note, 19999) } : {}),
  };
  let answer: Rec;
  try {
    answer = await api(ctx, token, `/agent/contracts/${plan.contractId}/submissions`, {
      method: "POST",
      body,
      // OpenTask replays an exact retry under the same key even after the contract changes state.
      key: idempotencyKey(bidId, plan.contractId, attemptOf(contract), JSON.stringify(body)),
    });
  } catch (error) {
    // A contract on native delivery refuses ordinary submissions: deliver a package instead.
    if (isProtocolError(error) && error.details?.code === "native_delivery_required") {
      return submitNative(ctx, token, current, { kind: "native", contractId: plan.contractId }, note);
    }
    throw error;
  }
  if (answer.replayed === true && str(contract.status) === "rejected") {
    throw new ProtocolError(
      "already_exists",
      "OpenTask answered with the earlier submission, so nothing new reached the poster and the contract is still rejected. Change the note or the files, then submit_work again.",
      { connector: ID, details: { stage: current.stage, submission_id: str(rec(answer.submission)?.id) ?? null } },
    );
  }
  return {
    ...current,
    stage: "in_review",
    next: contractNext({ status: "submitted" }),
    ...(ready.length ? { files: ready.map(intentFile) } : {}),
    raw: { ...(rec(current.raw) ?? {}), contract_status: "submitted", submission_id: str(rec(answer.submission)?.id) ?? null },
  };
}

/** An ordinary milestone submission: a link and notes, with the milestone's version. */
async function submitMilestone(
  ctx: ConnectorContext,
  token: string,
  current: NativeApplication,
  bidId: string,
  plan: Plan,
  note: string,
): Promise<NativeApplication> {
  const milestone = plan.milestone ?? {};
  if (!note) {
    throw new ProtocolError("invalid_input", "OpenTask needs the milestone's deliverable: a link (https://…) or notes in note.", {
      connector: ID,
    });
  }
  const link = linkOf(note);
  const body = { expectedVersion: num(milestone.version) ?? 1, ...(link ? { deliverableUrl: link } : {}), notes: truncate(note, 4999) };
  await api(ctx, token, `/agent/contracts/${plan.contractId}/milestones/${String(milestone.id)}/submit`, {
    method: "POST",
    body,
    key: idempotencyKey(bidId, String(milestone.id), JSON.stringify(body)),
  });
  return {
    ...current,
    stage: "in_review",
    next: `${milestoneName(milestone)} submitted. The poster accepts and pays it; then the next milestone opens.`,
    raw: { ...(rec(current.raw) ?? {}), milestone_id: String(milestone.id) },
  };
}

/**
 * A native delivery package: resume or create the draft, add the note's link as an external artifact, claim every
 * acceptance criterion as satisfied with the artifacts as evidence, then submit it with the ready files bound to it.
 */
async function submitNative(
  ctx: ConnectorContext,
  token: string,
  current: NativeApplication,
  plan: Plan,
  note: string,
): Promise<NativeApplication> {
  // External delivery artifacts are canonical https:// URLs only.
  const link = linkOf(note, true);
  if (!link && firstLink(note)) {
    throw new ProtocolError("invalid_input", "OpenTask delivery packages take https:// links only: put the https:// address in note.", {
      connector: ID,
    });
  }
  const { draft, latest, rebase } = await draftFor(ctx, token, plan.contractId, plan.milestone, current.job_title);
  if (!draft) return withPoster(current, latest ?? {});
  const packageId = String(draft.id);
  const base = `/agent/contracts/${plan.contractId}/deliveries/${packageId}`;
  const ready = readyFiles(await intentsAt(ctx, token, `${base}/upload-intents`));
  let delivery = draft;
  if (link && !recs(delivery.artifacts).some((a) => sameUrl(str(a.externalUrl)) === sameUrl(link))) {
    const body = { expectedVersion: num(delivery.version) ?? 1, kind: "external_url", label: "Deliverable", url: link };
    await api(ctx, token, `${base}/external-artifacts`, { method: "POST", body, key: idempotencyKey(packageId, JSON.stringify(body)) });
    delivery = rec((await api(ctx, token, base)).delivery) ?? delivery;
  }
  const artifactIds = recs(delivery.artifacts).map((a) => String(a.id));
  if (!artifactIds.length && !ready.length) throw new ProtocolError("invalid_input", NO_DELIVERABLE, { connector: ID });
  const criterionIds = recs(delivery.criteria).map((c) => String(c.id));
  const summary = note.split(/\n\s*\n/u)[0]?.trim();
  const patch = {
    expectedVersion: num(delivery.version) ?? 1,
    ...(summary ? { summary: truncate(summary, 2000) } : {}),
    ...(note ? { verificationInstructions: truncate(note, 19000) } : {}),
    ...(rebase ? { basedOnDeliveryPackageId: rebase } : {}),
    ...(rebase || str(delivery.basedOnPackageId) ? { changeSummary: truncate(note || "Revised as requested.", 9000) } : {}),
    ...(criterionIds.length
      ? {
          criteria: criterionIds.map((criterionId) => ({
            criterionId,
            claim: "satisfied",
            ...(artifactIds.length ? { artifactIds } : {}),
          })),
        }
      : {}),
  };
  const updated = rec(
    (await api(ctx, token, base, { method: "PATCH", body: patch, key: idempotencyKey(packageId, JSON.stringify(patch)) })).delivery,
  );
  const body = {
    expectedVersion: num(updated?.version) ?? patch.expectedVersion + 1,
    nativeArtifacts: ready.map((i) => ({
      fileId: String(i.fileId),
      label: truncate(str(i.filename) ?? "File", 199),
      ...(criterionIds.length ? { criterionIds } : {}),
    })),
    confirmed: true,
  };
  const answer = await api(ctx, token, `${base}/submit`, { method: "POST", body, key: idempotencyKey(packageId, JSON.stringify(body)) });
  const submitted = rec(answer.delivery);
  return {
    ...current,
    stage: "in_review",
    next: `${plan.milestone ? `${milestoneName(plan.milestone)}: delivery` : "Delivery"} submitted. The poster reviews each acceptance criterion, then pays your payout wallet and accepts.`,
    ...(ready.length ? { files: ready.map(intentFile) } : {}),
    raw: {
      ...(rec(current.raw) ?? {}),
      delivery_id: packageId,
      revision: num(submitted?.revision) ?? null,
      delivery_status: str(submitted?.status) ?? null,
    },
  };
}

async function submitEntry(ctx: ConnectorContext, token: string, taskId: string, note: string): Promise<NativeApplication> {
  const [{ task }, entry, intents] = await Promise.all([
    publicTask(ctx, taskId),
    entryOf(ctx, token, taskId),
    intentsAt(ctx, token, entryUploads(taskId)),
  ]);
  const title = str(task.title);
  if (entry && str(entry.status) !== "changes_requested") return entryToApplication(taskId, entry, title);
  const ready = readyFiles(intents);
  if (!ready.length) {
    throw new ProtocolError("not_ready", "OpenTask entries are files: add_work your artifacts first, then submit_work.", { connector: ID });
  }
  const { notes, benchmarkProof } = entryNote(note);
  if (str(task.executionMode) === "benchmark" && !benchmarkProof) {
    throw new ProtocolError(
      "invalid_input",
      'OpenTask benchmarks need benchmarkProof: send note as JSON {"notes": "…", "benchmarkProof": {"workerReportedMetricValue": "0.93", "procedure": "…", "environment": {}, "dependencyVersions": {}, "caveats": "…", "reproducibilityNotes": "…"}}.',
      { connector: ID },
    );
  }
  // altText is 1 to 240 characters; truncate may add an ellipsis after the cut.
  const alt = notes?.trim() ? truncate(notes.replace(/\s+/gu, " ").trim(), 239) : undefined;
  if (!alt && ready.some(isImage)) {
    throw new ProtocolError("invalid_input", "OpenTask needs a description of the image in note: it becomes the image's alt text.", {
      connector: ID,
    });
  }
  const artifacts = ready.map((i) => ({ kind: "native_file", fileId: String(i.fileId), ...(isImage(i) && alt ? { altText: alt } : {}) }));
  const extras = { ...(notes ? { notes: truncate(notes, 19999) } : {}), ...(benchmarkProof ? { benchmarkProof } : {}) };
  const revising = entry !== undefined;
  const body = revising
    ? { artifacts, ...extras, baseVersionId: str(entry.currentVersionId) ?? null }
    : { expectedTaskUpdatedAt: str(task.updatedAt), artifacts, ...extras };
  const path = revising ? `/agent/tasks/${taskId}/entries/${String(entry.id)}/versions` : `/agent/tasks/${taskId}/entries`;
  const answer = await api(ctx, token, path, { method: "POST", body, key: idempotencyKey(`${taskId}/entry`, JSON.stringify(body)) });
  return entryToApplication(taskId, rec(answer.entry) ?? { status: "active" }, title);
}

/** One page of open tasks for a phrase (the API matches the whole phrase in the title and description). */
async function taskPage(ctx: ConnectorContext, phrase: string | undefined, limit: number): Promise<{ rows: Rec[]; more: boolean }> {
  const url = new URL(`${OPENTASK_API}/tasks`);
  if (phrase) url.searchParams.set("query", phrase);
  url.searchParams.set("sort", "new");
  url.searchParams.set("limit", String(limit));
  const body = rec(await fetchJson<unknown>(ctx, url, { label: LABEL, connector: ID }));
  if (!body || !Array.isArray(body.tasks)) {
    throw new ProtocolError("upstream_error", "OpenTask answered the task list in an unexpected shape.", { connector: ID });
  }
  return { rows: recs(body.tasks), more: Boolean(str(body.nextCursor)) };
}

const short = (address: string | undefined) => (address && address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address);

export const opentask = defineConnector({
  id: ID,
  name: LABEL,
  description:
    "Tasks and competitions on OpenTask, a marketplace where people and AI agents post work, bid, deliver under a contract and are paid in stablecoins. Find and read without a key; bid, deliver links or files, enter competitions and follow contracts and earnings with an API token.",
  homepage: OPENTASK_SITE,
  kinds: ["task"],
  category: "bounty",
  // No tier: asked when named. Its board is small and much of it is stale or promotes other boards.
  payoutRails: ["crypto"],
  auth: { type: "api_key", env: [TOKEN_ENV], help: OPENTASK_HELP, required: false },

  async search(query, ctx) {
    if (query.kind === "listing") return { jobs: [] };
    const limit = query.limit ?? 20;
    const phrase = query.query?.trim().replace(/\s+/gu, " ").slice(0, 200) || undefined;
    let { rows, more } = await taskPage(ctx, phrase, Math.min(100, limit));
    const words = [...new Set(queryWords(phrase))];
    if (!rows.length && words.length > 1) {
      // No task holds the whole phrase: ask for each word and keep the tasks every word found.
      const pages = await Promise.all(
        words
          .sort((a, b) => b.length - a.length)
          .slice(0, 3)
          .map((word) => taskPage(ctx, word, 100)),
      );
      const others = pages.slice(1).map((page) => new Set(page.rows.map((row) => String(row.id))));
      rows = pages[0]!.rows.filter((row) => others.every((ids) => ids.has(String(row.id))));
      more = pages.some((page) => page.more);
    }
    const jobs = rows.map((row) => taskToJob(row)).filter((job): job is NativeJob => job !== null);
    const filtered = applyFilters(jobs, query, { query: true });
    return { jobs: filtered.slice(0, limit), more: more || filtered.length > limit };
  },

  async get(nativeId, ctx) {
    if (!NATIVE_ID.test(nativeId)) return null;
    const { task, actions } = await publicTask(ctx, nativeId);
    return taskToJob(task, actions);
  },

  async apply(nativeId, input, ctx) {
    const token = requireToken(ctx);
    if (!NATIVE_ID.test(nativeId)) {
      throw new ProtocolError("not_found", `${JSON.stringify(nativeId)} is not an OpenTask task id.`, { connector: ID });
    }
    const { task, actions } = await publicTask(ctx, nativeId);
    const title = str(task.title);
    const mode = str(task.executionMode) ?? "pitch";
    if (mode === "bounty" || mode === "benchmark") {
      const entry = await entryOf(ctx, token, nativeId);
      if (entry) return entryToApplication(nativeId, entry, title);
      if (openForWork(task, actions) === false) throw closedError(task, actions);
      return {
        ...entryToApplication(nativeId, undefined, title),
        next: "Entry opened; nothing is sent yet. add_work your artifacts (files), then submit_work with your notes. OpenTask takes up to 5 entry versions a day per profile.",
      };
    }
    // A live bid is returned instead of a second one. After a rejected, withdrawn or expired bid, or a cancelled
    // contract, OpenTask takes a new bid.
    const mine = await api(ctx, token, `/agent/bids?taskId=${encodeURIComponent(nativeId)}&limit=20`);
    const live = recs(mine.bids).filter(
      (b) =>
        (str(rec(b.task)?.id) ?? nativeId) === nativeId && b.id !== undefined && ["active", "accepted"].includes(str(b.status) ?? "active"),
    );
    for (const existing of live) {
      const { bid, contract } = await bidAndContract(ctx, token, String(existing.id));
      if (str(contract?.status) !== "cancelled") return bidToApplication(bid, contract);
    }
    if (openForWork(task, actions) === false) throw closedError(task, actions);
    const approach = input.note?.trim();
    if (!approach) {
      throw new ProtocolError("invalid_input", "OpenTask needs note: your approach and how the poster can check the work.", {
        connector: ID,
      });
    }
    const price = priceText(input, task);
    if (!price) {
      throw new ProtocolError("invalid_input", 'OpenTask needs answers.price: your price with its currency, for example "30 USDC".', {
        connector: ID,
      });
    }
    const eta = etaDays(input);
    const updatedAt = str(task.updatedAt);
    if (!updatedAt)
      throw new ProtocolError("upstream_error", "OpenTask answered the task without the updatedAt a bid needs.", { connector: ID });
    const body = {
      expectedTaskUpdatedAt: updatedAt,
      priceText: price,
      ...(eta !== undefined ? { etaDays: eta } : {}),
      approach: truncate(approach, 9999),
    };
    const answer = await api(ctx, token, `/agent/tasks/${nativeId}/bids`, { method: "POST", body });
    const bid = rec(answer.bid);
    if (!bid || bid.id === undefined)
      throw new ProtocolError("upstream_error", "OpenTask answered the bid without an id.", { connector: ID });
    return bidToApplication({
      priceText: price,
      ...(eta !== undefined ? { etaDays: eta } : {}),
      createdAt: bid.updatedAt,
      ...bid,
      task: { id: nativeId, title },
    });
  },

  async upload(nativeApplicationId, work, ctx) {
    const token = requireToken(ctx);
    const base = await uploadsOf(ctx, token, nativeApplicationId);
    const { bytes, name, mime } = workFile(work);
    if (!bytes.byteLength) throw new ProtocolError("invalid_input", "The file is empty.", { connector: ID });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const body = { filename: name, contentType: mime, sizeBytes: bytes.byteLength, sha256 };
    // The key names the parent (contract, delivery draft or entry): the same file sent to a later draft is a new intent.
    let created = await api(ctx, token, base, { method: "POST", body, key: idempotencyKey(base, name, sha256) });
    let intent = rec(created.uploadIntent);
    if (intent && created.replayed === true && GONE_INTENT.has(str(intent.status) ?? "")) {
      // The same file was removed or its upload expired: ask for a fresh upload.
      created = await api(ctx, token, base, {
        method: "POST",
        body,
        key: idempotencyKey(base, name, sha256, new Date().toISOString()),
      });
      intent = rec(created.uploadIntent);
    }
    const intentId = str(intent?.id);
    if (!intent || !intentId)
      throw new ProtocolError("upstream_error", "OpenTask answered the upload request without an id.", { connector: ID });
    const file = intentFile({ ...intent, filename: name, contentType: mime, sizeBytes: bytes.byteLength });
    if (created.replayed === true && str(intent.status) === "completed") {
      throw new ProtocolError("already_exists", `${name} is already uploaded to this application.`, { connector: ID, details: { file } });
    }
    if (str(intent.status) === "issued") {
      const target = rec(intent.upload);
      const url = str(target?.url);
      if (!url) throw new ProtocolError("upstream_error", "OpenTask answered the upload request without an upload URL.", { connector: ID });
      await putBytes(ctx, url, rec(target?.callerHeaders), bytes);
      await api(ctx, token, `${base}/${intentId}/complete`, { method: "POST" });
    }
    const files = (await intentsAt(ctx, token, base)).map(intentFile);
    return {
      file,
      files: files.some((f) => f.id === file.id) ? files : [...files, file],
      next: "OpenTask scans each file for a few seconds before it can go out. submit_work sends every ready file with your note.",
    };
  },

  async remove(nativeApplicationId, fileId, ctx) {
    const token = requireToken(ctx);
    const base = await uploadsOf(ctx, token, nativeApplicationId);
    if (!NATIVE_ID.test(fileId))
      throw new ProtocolError("not_found", `${JSON.stringify(fileId)} is not an OpenTask upload id.`, { connector: ID });
    const answer = await api(ctx, token, `${base}/${fileId}`, { method: "DELETE" });
    const files = (await intentsAt(ctx, token, base)).filter((i) => String(i.id) !== fileId).map(intentFile);
    return {
      removed: { id: fileId, name: str(rec(answer.file)?.filename) ?? fileId },
      files,
      next: files.length ? "submit_work sends the remaining ready files." : "No files left: add_work to upload one.",
    };
  },

  async submit(nativeApplicationId, input, ctx) {
    const token = requireToken(ctx);
    const note = input.note?.trim() ?? "";
    const taskId = entryTaskOf(nativeApplicationId);
    return taskId ? submitEntry(ctx, token, taskId, note) : submitBid(ctx, token, nativeApplicationId, note);
  },

  async status(nativeApplicationId, ctx) {
    const token = requireToken(ctx);
    const taskId = entryTaskOf(nativeApplicationId);
    if (taskId) return entryToApplication(taskId, await entryOf(ctx, token, taskId));
    if (!NATIVE_ID.test(nativeApplicationId)) return null;
    const { bid, contract } = await bidAndContract(ctx, token, nativeApplicationId);
    return bidToApplication(bid, contract);
  },

  async list(ctx) {
    const token = requireToken(ctx);
    const [bids, contracts] = await Promise.all([
      api(ctx, token, "/agent/bids?limit=100"),
      api(ctx, token, "/agent/contracts?role=seller&limit=100"),
    ]);
    const rows = recs(contracts.contracts);
    const byBid = new Map<string, Rec>();
    for (const contract of rows) {
      const bidId = str(rec(contract.bid)?.id);
      if (bidId) byBid.set(bidId, contract);
    }
    const fromBids = recs(bids.bids)
      .filter((bid) => bid.id !== undefined)
      .map((bid) => bidToApplication(bid, byBid.get(String(bid.id))));
    const awards = rows
      .filter((contract) => str(contract.source) === "task_award")
      .map(awardToApplication)
      .filter((app): app is NativeApplication => app !== null);
    return [...fromBids, ...awards];
  },

  async account(ctx) {
    const token = ctx.credentials[TOKEN_ENV]?.trim();
    if (!token) return { signed_in: false, help: OPENTASK_HELP };
    const me = await api(ctx, token, "/agent/me");
    const profile = rec(me.profile) ?? {};
    const stats = rec(me.stats) ?? {};
    const wallets = num(me.activePayoutMethodCount) ?? 0;
    const page = str(profile.publicProfileUrl);
    return {
      signed_in: true,
      ...(str(profile.handle) ? { label: str(profile.handle) } : {}),
      ready: true,
      profile: {
        id: profile.id ?? null,
        handle: profile.handle ?? null,
        display_name: profile.displayName ?? null,
        kind: profile.kind ?? null,
        skills: strings(profile.skillsTags),
        public_profile: page ? new URL(page, OPENTASK_SITE).href : null,
        payout_wallets: wallets,
        active_bids: num(stats.activeBids) ?? null,
        contracts_as_seller: num(stats.contractsAsSeller) ?? null,
        average_rating: num(stats.averageRating) ?? null,
        reviews: num(stats.reviewCount) ?? null,
      },
      ...(wallets === 0
        ? { help: "Add a payout wallet (USDC on Base) to your OpenTask profile before you are hired: posters pay it directly." }
        : {}),
    };
  },

  async earnings(ctx) {
    const token = requireToken(ctx);
    const [contracts, methods] = await Promise.all([
      api(ctx, token, "/agent/contracts?role=seller&limit=100"),
      api(ctx, token, "/agent/me/payout-methods?limit=50"),
    ]);
    const entries: Earning[] = [];
    for (const contract of recs(contracts.contracts)) {
      const paid = str(contract.settlementStatus) === "fully_settled";
      if (!paid && str(contract.status) !== "accepted") continue;
      const award = str(contract.source) === "task_award";
      const terms = rec(contract.taskAward);
      const money = award
        ? atomicMoney(terms?.sellerAmountAtomic, terms?.payoutTokenDecimals, terms?.payoutToken)
        : moneyOf(str(rec(contract.bid)?.priceText));
      if (!money || contract.id === undefined) continue;
      const taskId = str(rec(contract.task)?.id);
      const applicationId = award ? (taskId ? `${taskId}/entry` : undefined) : str(rec(contract.bid)?.id);
      const at = iso(contract.updatedAt);
      entries.push({
        id: String(contract.id),
        ...(applicationId ? { application_id: applicationId } : {}),
        ...(str(rec(contract.task)?.title) ? { job_title: str(rec(contract.task)?.title) } : {}),
        amount: money.amount,
        currency: money.currency,
        status: paid ? "paid" : "pending",
        ...(at ? { earned_at: at } : {}),
      });
    }
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.currency, (counts.get(entry.currency) ?? 0) + 1);
    const currency = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USDC";
    const total = (status: Earning["status"]) =>
      Math.round(entries.filter((e) => e.status === status && e.currency === currency).reduce((sum, e) => sum + e.amount, 0) * 1e6) / 1e6;
    const wallets = recs(methods.methods)
      .filter((m) => m.isActive !== false)
      .map((m) => [str(m.symbol), str(m.network) ? `on ${str(m.network)}` : undefined, short(str(m.address))].filter(Boolean).join(" "));
    return {
      balance: { amount: 0, currency },
      total_earned: { amount: total("paid"), currency },
      pending: { amount: total("pending"), currency },
      entries,
      methods: wallets,
      help: `OpenTask holds no balance to withdraw: posters pay your payout wallet through OpenTask's payment router before they accept the work, and competition prizes are paid automatically.${wallets.length ? "" : " Add a payout wallet (USDC on Base) to your OpenTask profile to be paid."}`,
    };
  },
});
