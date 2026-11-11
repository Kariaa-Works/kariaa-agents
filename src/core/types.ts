/**
 * The protocol's nouns, as zod schemas with the TypeScript types derived from them.
 *
 * A connector returns the `Native*` shapes (ids as the source knows them, no
 * `connector` field). The router publishes them: it prefixes every id with the
 * connector id, sets `connector`, and fills `stages`.
 */
import { z } from "zod";

export const JOB_KINDS = ["task", "listing"] as const;
export const JobKindSchema = z.enum(JOB_KINDS);
/** `task`: work done and submitted through the protocol. `listing`: a posting you apply to elsewhere. */
export type JobKind = z.infer<typeof JobKindSchema>;

/**
 * How a source pays. `bounty`: paid per accepted deliverable (code, security, content). `micro_task`:
 * short paid tasks (clipping, UGC, data capture, labelling). `selling`: money from selling goods or
 * digital products. `competition`: prize pools paid by rank. `job`: employer or freelance work.
 */
export const CONNECTOR_CATEGORIES = ["bounty", "micro_task", "selling", "competition", "job"] as const;
export const ConnectorCategorySchema = z.enum(CONNECTOR_CATEGORIES);
export type ConnectorCategory = z.infer<typeof ConnectorCategorySchema>;

/** Where the money lands. `fiat`: the platform pays out in ordinary currency. `crypto`: on chain. `employer`: payroll or an invoice to the client. */
export const PAYOUT_RAILS = ["fiat", "crypto", "employer"] as const;
export const PayoutRailSchema = z.enum(PAYOUT_RAILS);
export type PayoutRail = z.infer<typeof PayoutRailSchema>;

export const STAGES = [
  "search",
  "get",
  "apply",
  "upload",
  "remove",
  "submit",
  "status",
  "list",
  "link",
  "account",
  "earnings",
  "payout",
  // The other side of the table: giving work out and paying for it.
  "post",
  "postings",
  "offers",
  "award",
  "review",
  "pay",
  "cancel",
] as const;
export const StageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof StageSchema>;

export const MEDIA_KINDS = ["text", "image", "audio", "video"] as const;
export const MediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const QuestionSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  type: z.enum(["text", "select", "multiselect", "url_list"]).default("text"),
  options: z.array(z.string()).nullable().optional(),
  required: z.boolean().optional(),
});
export type Question = z.infer<typeof QuestionSchema>;

export const PayPeriodSchema = z.enum(["hour", "day", "week", "month", "year", "unit"]);
export const PaySchema = z.object({
  min: z.number().optional(),
  max: z.number().optional(),
  currency: z.string().optional(),
  period: PayPeriodSchema.optional(),
  /** For `period: "unit"`: what one unit is ("per clip", "per photo"). */
  unit: z.string().optional(),
  /** Pay as the source words it, when it is not structured. */
  text: z.string().optional(),
});
export type Pay = z.infer<typeof PaySchema>;

export const LocationSchema = z.object({
  text: z.string().optional(),
  country: z.string().optional(),
  remote: z.boolean().optional(),
});

export const PARTICIPATION_MODES = ["direct_apply", "claim", "bid", "competition"] as const;
export const ParticipationModeSchema = z.enum(PARTICIPATION_MODES);
export type ParticipationMode = z.infer<typeof ParticipationModeSchema>;

export const RequirementsSchema = z.object({
  questions: z.array(QuestionSchema).optional(),
  files: z
    .object({
      kinds: z.array(z.string()),
      count: z.number().int().optional(),
      max_seconds: z.number().optional(),
      max_bytes: z.number().optional(),
    })
    .optional(),
  text: z.object({ min_chars: z.number().int().optional(), max_chars: z.number().int().optional() }).optional(),
  how_to: z.array(z.string()).optional(),
  looks_like: z.string().optional(),
  rules: z.array(z.string()).optional(),
  output_schema: z.record(z.string(), z.unknown()).optional(),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

/** What a connector returns from `search` and `get`. */
export const NativeJobSchema = z
  .object({
    /** The source's own id. The router prefixes it with the connector id. */
    id: z.string().min(1),
    kind: JobKindSchema,
    title: z.string().min(1),
    /** Company, program or employer. */
    org: z.string().optional(),
    location: LocationSchema.optional(),
    pay: PaySchema.optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    /** The task's own material (sentences to read, answers to rate). For text tasks this is the work. */
    instructions: z.string().optional(),
    url: z.string().optional(),
    posted_at: z.string().optional(),
    expires_at: z.string().optional(),
    tags: z.array(z.string()).optional(),
    /** Narrow the connector's stages for this job (a closed task drops `apply`). Omit to inherit. */
    stages: z.array(StageSchema).optional(),
    participation_mode: ParticipationModeSchema.optional(),
    apply_hint: z.string().optional(),
    requirements: RequirementsSchema.optional(),
    raw: z.unknown().optional(),
  })
  .strict();
export type NativeJob = z.infer<typeof NativeJobSchema>;

/** A job as the protocol publishes it. */
export const JobSchema = NativeJobSchema.extend({
  connector: z.string().min(1),
  stages: z.array(StageSchema),
});
export type Job = z.infer<typeof JobSchema>;

export const APPLICATION_STAGES = ["applied", "work_needed", "in_review", "accepted", "rejected", "withdrawn", "closed"] as const;
export const ApplicationStageSchema = z.enum(APPLICATION_STAGES);
export type ApplicationStage = z.infer<typeof ApplicationStageSchema>;

export const ApplicationFileSchema = z.object({
  /** Only meaningful together with its application; never prefixed. */
  id: z.string().min(1),
  name: z.string(),
  kind: z.string(),
  size: z.number().optional(),
});
export type ApplicationFile = z.infer<typeof ApplicationFileSchema>;

export const ProgressSchema = z.object({
  received: z.number().int(),
  wanted: z.number().int(),
  ready_to_submit: z.boolean(),
});
export type Progress = z.infer<typeof ProgressSchema>;

export const ReviewSchema = z.object({
  note: z.string().optional(),
  earned: z.object({ amount: z.number(), currency: z.string() }).optional(),
});

/** What a connector returns from `apply`, `submit`, `status` and `list`. */
export const NativeApplicationSchema = z
  .object({
    id: z.string().min(1),
    job_id: z.string().min(1),
    job_title: z.string().optional(),
    stage: ApplicationStageSchema,
    files: z.array(ApplicationFileSchema).optional(),
    progress: ProgressSchema.optional(),
    /** What to do next, in plain words. */
    next: z.string().optional(),
    url: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    review: ReviewSchema.optional(),
    raw: z.unknown().optional(),
  })
  .strict();
export type NativeApplication = z.infer<typeof NativeApplicationSchema>;

export const ApplicationSchema = NativeApplicationSchema.extend({ connector: z.string().min(1) });
export type Application = z.infer<typeof ApplicationSchema>;

/** What `upload` and `remove` return: the file touched plus where the application stands. */
export const WorkReceiptSchema = z.object({
  file: ApplicationFileSchema.optional(),
  removed: z.object({ id: z.string(), name: z.string() }).optional(),
  files: z.array(ApplicationFileSchema).optional(),
  progress: ProgressSchema.optional(),
  next: z.string().optional(),
});
export type WorkReceipt = z.infer<typeof WorkReceiptSchema>;

export const SearchQuerySchema = z.object({
  /** Words to look for. Empty means "work available now": only connectors that offer tasks are asked. */
  query: z.string().max(200).optional(),
  location: z.string().max(120).optional(),
  /** true: remote work only. Omit for no filter. */
  remote: z.boolean().optional(),
  kind: JobKindSchema.optional(),
  /** Only sources of this category (bounty, micro_task, selling, competition, job). */
  category: ConnectorCategorySchema.optional(),
  /** For tasks: the media the work is made of. */
  media: z.array(MediaKindSchema).optional(),
  /** Minimum pay / reward amount. */
  pay_min: z.number().nonnegative().optional(),
  /** Currency code filter (e.g. USD, EUR, USDC). */
  currency: z.string().max(20).optional(),
  /** true: only jobs/tasks that support applying or claiming directly through the protocol. */
  direct_apply: z.boolean().optional(),
  /** Connector ids to ask. Omit for all. */
  connectors: z.array(z.string()).optional(),
  /** Connector ids never to ask, even when named. */
  exclude_connectors: z.array(z.string()).max(100).optional(),
  limit: z.number().int().min(1).max(50).optional(),
  /** true: only work paid in ordinary money (bank, PayPal, card), not crypto. */
  fiat_only: z.boolean().optional(),
  /**
   * Only work posted on or after this date (YYYY-MM-DD). Work without a posting date counts while it has a
   * closing date still ahead; standing programs with no dates are left out.
   */
  posted_after: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/u, "posted_after is a date like 2026-10-01")
    .optional(),
  /** From a previous result's `cursor`: the next page. */
  cursor: z.string().max(200).optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const ApplyInputSchema = z.object({
  /** Answers by question id. Choice answers take the option text or its number. */
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  note: z.string().max(2000).optional(),
  preferred_rate: z.string().max(80).optional(),
});
export type ApplyInput = z.infer<typeof ApplyInputSchema>;

export const FileInputSchema = z.object({
  path: z.string().optional(),
  url: z.string().optional(),
  base64: z.string().optional(),
  name: z.string().max(200).optional(),
  mime_type: z.string().max(100).optional(),
});

/** Exactly one of `text`, `file.path`, `file.url` or `file.base64`. */
export const WorkInputSchema = z
  .object({
    text: z.string().optional(),
    file: FileInputSchema.optional(),
  })
  .refine(
    (w) => {
      const sources = [w.text !== undefined, Boolean(w.file?.path), Boolean(w.file?.url), Boolean(w.file?.base64)];
      return sources.filter(Boolean).length === 1;
    },
    { message: "Send exactly one of text, file.path, file.url or file.base64." },
  );
export type WorkInput = z.infer<typeof WorkInputSchema>;

/** The work after the router has read it: text, or bytes with a name and type. */
export type ResolvedWork = { kind: "text"; text: string } | { kind: "file"; name: string; mime_type: string; bytes: Uint8Array };

export const AccountSchema = z.object({
  signed_in: z.boolean(),
  label: z.string().optional(),
  /** Whether the person can apply right now. */
  ready: z.boolean().optional(),
  /** What is missing before they can. */
  missing: z.array(z.string()).optional(),
  profile: z.record(z.string(), z.unknown()).optional(),
  rejected: z.array(z.object({ field: z.string(), reason: z.string() })).optional(),
  usage: z.object({ calls: z.number(), calls_max: z.number(), writes: z.number(), writes_max: z.number() }).optional(),
  help: z.string().optional(),
});
export type Account = z.infer<typeof AccountSchema>;

export const LinkSchema = z.object({
  url: z.string(),
  expires_at: z.string().optional(),
  signed_in: z.boolean().optional(),
});
export type Link = z.infer<typeof LinkSchema>;

export const MoneySchema = z.object({ amount: z.number(), currency: z.string().min(1) });
export type Money = z.infer<typeof MoneySchema>;

export const EARNING_STATUSES = ["pending", "available", "paid"] as const;

/** One credit for accepted work. `application_id` is native in a connector's output and prefixed when published. */
export const EarningSchema = z
  .object({
    id: z.string().min(1),
    application_id: z.string().optional(),
    job_title: z.string().optional(),
    amount: z.number(),
    currency: z.string().min(1),
    status: z.enum(EARNING_STATUSES),
    earned_at: z.string().optional(),
    note: z.string().optional(),
  })
  .strict();
export type Earning = z.infer<typeof EarningSchema>;

export const PAYOUT_STATUSES = ["requested", "paid", "rejected", "cancelled"] as const;

export const NativePayoutSchema = z
  .object({
    id: z.string().min(1),
    amount: MoneySchema,
    /** paypal, venmo, bank, giftcard… as the connector names them. */
    method: z.string().min(1),
    destination: z.string().optional(),
    status: z.enum(PAYOUT_STATUSES),
    requested_at: z.string().optional(),
    paid_at: z.string().optional(),
    note: z.string().optional(),
    raw: z.unknown().optional(),
  })
  .strict();
export type NativePayout = z.infer<typeof NativePayoutSchema>;

export const PayoutSchema = NativePayoutSchema.extend({ connector: z.string().min(1) });
export type Payout = z.infer<typeof PayoutSchema>;

/** What a connector returns from `earnings`: the balance, what it is made of, and how it can be paid out. */
export const NativeEarningsSchema = z
  .object({
    balance: MoneySchema,
    total_earned: MoneySchema.optional(),
    pending: MoneySchema.optional(),
    entries: z.array(EarningSchema).optional(),
    payouts: z.array(NativePayoutSchema).optional(),
    min_payout: MoneySchema.optional(),
    methods: z.array(z.string()).optional(),
    help: z.string().optional(),
  })
  .strict();
export type NativeEarnings = z.infer<typeof NativeEarningsSchema>;

export const EarningsSchema = NativeEarningsSchema.extend({
  connector: z.string().min(1),
  payouts: z.array(PayoutSchema).optional(),
});
export type Earnings = z.infer<typeof EarningsSchema>;

export const PayoutInputSchema = z.object({
  /** Leave out for the whole available balance. */
  amount: z.number().positive().optional(),
  method: z.string().min(1).max(40),
  /** Where the money goes: an email, a handle, an account, as the method needs. */
  destination: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
});
export type PayoutInput = z.infer<typeof PayoutInputSchema>;

export const PartialFailureSchema = z.object({
  connector: z.string(),
  error: z.object({ code: z.string(), message: z.string() }),
});
export type PartialFailure = z.infer<typeof PartialFailureSchema>;

export const SearchResultSchema = z.object({
  jobs: z.array(JobSchema),
  /** A connector has more than it returned; search again with a narrower query or later. */
  more: z.boolean(),
  partial: z.array(PartialFailureSchema),
  /** Pass back as `cursor` for the next page. */
  cursor: z.string().optional(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

// ---- Giving work out: post a job, read the offers, pick one, review what comes back, pay ----

/** Who should do the work. A platform that only has one kind ignores it. */
export const WORKER_KINDS = ["human", "agent", "any"] as const;
export const WorkerKindSchema = z.enum(WORKER_KINDS);
export type WorkerKind = z.infer<typeof WorkerKindSchema>;

/** A job to post. `answers` carries what one platform needs beyond these (a category id, a template). */
export const PostInputSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().min(10).max(20_000),
  budget: MoneySchema,
  /** How the work will be judged, one line each. Posters who write these get fewer disputes. */
  acceptance: z.array(z.string().max(500)).max(20).optional(),
  skills: z.array(z.string().max(60)).max(20).optional(),
  workers: WorkerKindSchema.optional(),
  /** ISO date the work is due. */
  deadline: z.string().max(40).optional(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
});
export type PostInput = z.infer<typeof PostInputSchema>;

export const POSTING_STATUSES = ["draft", "open", "assigned", "in_review", "completed", "cancelled", "expired", "disputed"] as const;
export const PostingStatusSchema = z.enum(POSTING_STATUSES);
export type PostingStatus = z.infer<typeof PostingStatusSchema>;

/** A job you posted, as a connector returns it. Fields the protocol does not know are dropped, not refused. */
export const NativePostingSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: PostingStatusSchema,
  budget: MoneySchema.optional(),
  /** The money is already set aside (escrow, a funded milestone). */
  funded: z.boolean().optional(),
  offers: z.number().int().optional(),
  /** The offer that was picked, once one is. */
  awarded_offer: z.string().optional(),
  url: z.string().optional(),
  /** What to do next, in plain words. */
  next: z.string().optional(),
  created_at: z.string().optional(),
  raw: z.unknown().optional(),
});
export type NativePosting = z.infer<typeof NativePostingSchema>;
export const PostingSchema = NativePostingSchema.extend({ connector: z.string().min(1) });
export type Posting = z.infer<typeof PostingSchema>;

export const OFFER_STATUSES = ["pending", "awarded", "delivered", "accepted", "paid", "rejected", "withdrawn", "expired"] as const;
export const OfferStatusSchema = z.enum(OFFER_STATUSES);

/** One bid, application or entry on a job you posted. Its id is only meaningful with its posting. */
export const OfferSchema = z.object({
  id: z.string().min(1),
  from: z.object({
    name: z.string().optional(),
    id: z.string().optional(),
    kind: z.enum(["human", "agent", "unknown"]).optional(),
    rating: z.number().optional(),
    url: z.string().optional(),
  }),
  amount: MoneySchema.optional(),
  /** Days they say it will take. */
  days: z.number().optional(),
  note: z.string().optional(),
  status: OfferStatusSchema,
  /** What they handed in, once they have. */
  delivery: z.object({ text: z.string().optional(), urls: z.array(z.string()).optional() }).optional(),
  created_at: z.string().optional(),
  raw: z.unknown().optional(),
});
export type Offer = z.infer<typeof OfferSchema>;

export const ReviewInputSchema = z.object({
  decision: z.enum(["accept", "request_changes", "reject"]),
  /** What was good, or exactly what to change. Required when not accepting. */
  note: z.string().max(5000).optional(),
});
export type ReviewInput = z.infer<typeof ReviewInputSchema>;

export const PayInputSchema = z.object({
  /** The offer being paid. Left out: the awarded one. */
  offer: z.string().optional(),
  /** Left out: what the platform says is owed. */
  amount: MoneySchema.optional(),
  /** fund: set the money aside. release: hand it over. Left out: whichever the posting needs next. */
  action: z.enum(["fund", "release"]).optional(),
  note: z.string().max(1000).optional(),
  /** The token a first call returned. Money moves only when it is sent back. */
  confirm: z.string().max(200).optional(),
});
export type PayInput = z.infer<typeof PayInputSchema>;

export const PAYMENT_STATUSES = ["confirm_needed", "funded", "released", "pending", "refunded", "failed", "disputed", "cancelled"] as const;
/** What a pay call did. `confirm_needed` moved nothing: send `confirm` back to go ahead. */
export const NativePaymentSchema = z.object({
  id: z.string().optional(),
  status: z.enum(PAYMENT_STATUSES),
  action: z.enum(["fund", "release"]).optional(),
  amount: MoneySchema.optional(),
  to: z.string().optional(),
  fee: MoneySchema.optional(),
  confirm: z.string().optional(),
  next: z.string().optional(),
  url: z.string().optional(),
  raw: z.unknown().optional(),
});
export type NativePayment = z.infer<typeof NativePaymentSchema>;
export const PaymentSchema = NativePaymentSchema.extend({ connector: z.string().min(1), posting_id: z.string().min(1) });
export type Payment = z.infer<typeof PaymentSchema>;
