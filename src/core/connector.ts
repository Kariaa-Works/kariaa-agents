/**
 * The connector contract. Implement the methods for the stages the source
 * supports and leave the others out; the stages are derived from what exists.
 */
import { ProtocolError } from "./errors.js";
import { isConnectorId } from "./ids.js";
import {
  CONNECTOR_CATEGORIES,
  PAYOUT_RAILS,
  STAGES,
  type Account,
  type ApplyInput,
  type ConnectorCategory,
  type JobKind,
  type Link,
  type NativeApplication,
  type NativeEarnings,
  type NativeJob,
  type NativePayout,
  type PayoutInput,
  type PayoutRail,
  type ResolvedWork,
  type SearchQuery,
  type Stage,
  type WorkReceipt,
  type PostInput,
  type NativePosting,
  type Offer,
  type ReviewInput,
  type PayInput,
  type NativePayment,
} from "./types.js";

/**
 * How far the catalog takes a platform:
 * - managed: the agent can do every step, and Kariaa sets the account up for the person (`register`, or
 *   the Kariaa sign-in itself); the person can still link their own instead.
 * - self: every step works once the person links their own account.
 * - discover: listings only. Actions answer `handoff_required` with what the person does on the site,
 *   because the platform's terms or sign-in don't allow an agent to act there.
 */
export const CATALOG_TIERS = ["managed", "self", "discover"] as const;
export type CatalogTier = (typeof CATALOG_TIERS)[number];

/** The stages that act on a platform. A discover-tier platform hands these to the person. */
export const ACTION_STAGES: ReadonlySet<Stage> = new Set([
  "apply",
  "upload",
  "remove",
  "submit",
  "payout",
  "post",
  "award",
  "review",
  "pay",
  "cancel",
]);

export type AuthSpec =
  | { type: "none" }
  | {
      type: "api_key";
      /** Environment variable names that hold the credential(s). */
      env: string[];
      /** Where a person gets one. Shown when the credential is missing. */
      help: string;
      /** false: the connector works without it (fewer stages, lower limits). Default true. */
      required?: boolean;
      /** Sets of names, any one of which is enough, for sources that take a token or app credentials. Default: all of `env`. */
      anyOf?: string[][];
    }
  | {
      type: "oauth";
      /** How to sign in, usually `work login <id>`. */
      help: string;
      /** An environment variable that may hold a static token instead. */
      env?: string;
      /** true: nothing works without a sign-in. Default false (reads work anonymously). */
      required?: boolean;
    };

export type ProfileField = { name: string; description: string; example?: string };

export type Logger = (event: string, data?: Record<string, unknown>) => void;

export type ConnectorContext = {
  /** The values of `auth.env`, from the environment or the caller. */
  credentials: Record<string, string | undefined>;
  /** Always use this, never the global one: tests and hosts replace it. */
  fetch: typeof fetch;
  /** Aborted when the caller's time budget is spent. Pass it to every request. */
  signal: AbortSignal;
  log: Logger;
};

export type SearchOutput = { jobs: NativeJob[]; more?: boolean };

/** Who the new account is for. The owner's email receives anything the platform sends to claim it. */
export type RegisterInput = { email: string; name?: string; handle?: string; description?: string };

export type Registration = {
  /** The new account's credentials, by `auth.env` name. */
  credentials: Record<string, string>;
  /** The platform's id or handle for the new account. */
  account_id?: string;
  /** What the owner still has to do, such as claiming the account from an email. */
  next_step?: string;
};

export interface Connector {
  /** Lowercase letters, digits and dashes. Prefixes every id this connector returns. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly homepage?: string;
  readonly kinds: readonly JobKind[];
  /** How the source pays. Every built-in connector declares one. */
  readonly category?: ConnectorCategory;
  /** Where the money lands. */
  readonly payoutRails?: readonly PayoutRail[];
  readonly auth: AuthSpec;
  /** The fields `updateAccount` accepts. */
  readonly profileFields?: readonly ProfileField[];
  /**
   * true: left out of all-source searches and used only when named. For sources that start a
   * local process, read a chain or cost money per call.
   */
  readonly optIn?: boolean;
  /**
   * Set: in the curated default catalog. Others are searched only when named, unless WORK_CATALOG=all.
   * See CatalogTier.
   */
  readonly tier?: CatalogTier;
  /**
   * true: without a key, this platform is reached through a limit every caller on the same network shares
   * (GitHub's anonymous API, for one). It then joins a search only when named, so one room of people
   * does not turn every search into a rate-limit error. With a key it behaves like any other.
   */
  readonly sharedLimitWithoutKey?: boolean;
  /** true: every action waits for the person's yes, whatever their setting (the platform's terms ask for it). */
  readonly askFirst?: boolean;

  search?(query: SearchQuery, ctx: ConnectorContext): Promise<SearchOutput>;
  get?(nativeId: string, ctx: ConnectorContext): Promise<NativeJob | null>;
  apply?(nativeId: string, input: ApplyInput, ctx: ConnectorContext): Promise<NativeApplication>;
  upload?(nativeApplicationId: string, work: ResolvedWork, ctx: ConnectorContext): Promise<WorkReceipt>;
  remove?(nativeApplicationId: string, fileId: string, ctx: ConnectorContext): Promise<WorkReceipt>;
  submit?(nativeApplicationId: string, input: { note?: string }, ctx: ConnectorContext): Promise<NativeApplication>;
  status?(nativeApplicationId: string, ctx: ConnectorContext): Promise<NativeApplication | null>;
  list?(ctx: ConnectorContext): Promise<NativeApplication[]>;
  /** A web link where a person finishes the work in a browser. */
  link?(nativeApplicationId: string, ctx: ConnectorContext): Promise<Link>;
  account?(ctx: ConnectorContext): Promise<Account>;
  updateAccount?(fields: Record<string, unknown>, ctx: ConnectorContext): Promise<Account>;
  /** What the person has earned here: balance, credits, payouts so far, how a payout works. */
  earnings?(ctx: ConnectorContext): Promise<NativeEarnings>;
  /** Ask for money to be paid out. */
  payout?(input: PayoutInput, ctx: ConnectorContext): Promise<NativePayout>;
  // ---- giving work out. Ids here are your own postings on this platform. ----
  /** Post a job. A platform that takes payment at posting time must not charge here: it returns a draft or an unfunded posting, and `pay` moves the money. */
  post?(input: PostInput, ctx: ConnectorContext): Promise<NativePosting>;
  /** The jobs you posted. */
  postings?(ctx: ConnectorContext): Promise<NativePosting[]>;
  /** One posting with its bids, applications or entries. null: not yours or gone. */
  offers?(nativePostingId: string, ctx: ConnectorContext): Promise<{ posting: NativePosting; offers: Offer[] } | null>;
  /** Pick an offer: the work is theirs to do. */
  award?(nativePostingId: string, offerId: string, ctx: ConnectorContext): Promise<NativePosting>;
  /** Judge what was handed in: accept, ask for changes, or reject. Accepting does not pay; `pay` does. */
  review?(nativePostingId: string, input: ReviewInput, ctx: ConnectorContext): Promise<NativePosting>;
  /**
   * Set money aside or hand it over. The router only calls this after the caller sent back the confirm
   * token for exactly this posting, offer, action and amount, so a connector moves money on every call.
   */
  pay?(nativePostingId: string, input: PayInput, ctx: ConnectorContext): Promise<NativePayment>;
  /** What `pay` would do, without doing it: the amount, the fee, who receives it. Used for the confirm step. */
  quote?(nativePostingId: string, input: PayInput, ctx: ConnectorContext): Promise<NativePayment>;
  /** Close a posting. Says in `next` what happens to money already set aside. */
  cancel?(nativePostingId: string, input: { note?: string }, ctx: ConnectorContext): Promise<NativePosting>;
  /**
   * Create an account for the agent through the platform's own sign-up API, for platforms that
   * let agents register themselves. Not a stage: `connect` calls it when no credential is set.
   */
  register?(input: RegisterInput, ctx: ConnectorContext): Promise<Registration>;
  /**
   * The native id of the posting at a web address on this platform, or null when the address is not one of
   * its postings. Reads only. Not a stage: `resolve` asks each connector that has it.
   */
  resolveUrl?(url: URL, ctx: ConnectorContext): Promise<string | null>;
  /** Release connections. Called when the host shuts down. */
  close?(): Promise<void>;
}

const STAGE_METHOD: Record<Stage, keyof Connector> = {
  search: "search",
  get: "get",
  apply: "apply",
  upload: "upload",
  remove: "remove",
  submit: "submit",
  status: "status",
  list: "list",
  link: "link",
  account: "account",
  earnings: "earnings",
  payout: "payout",
  post: "post",
  postings: "postings",
  offers: "offers",
  award: "award",
  review: "review",
  pay: "pay",
  cancel: "cancel",
};

/** The stages a connector supports: those whose method it implements. */
export function stagesOf(connector: Connector): Stage[] {
  return STAGES.filter((stage) => typeof connector[STAGE_METHOD[stage]] === "function");
}

export function hasStage(connector: Connector, stage: Stage): boolean {
  return typeof connector[STAGE_METHOD[stage]] === "function";
}

/** Checks the static parts of a connector and returns it typed. */
export function defineConnector<T extends Connector>(connector: T): T {
  if (!isConnectorId(connector.id)) {
    throw new ProtocolError("invalid_input", `Connector id ${JSON.stringify(connector.id)} must match ${String(CONNECTOR_ID_HINT)}.`);
  }
  if (!connector.name || !connector.description) {
    throw new ProtocolError("invalid_input", `Connector ${connector.id} needs a name and a description.`);
  }
  if (!Array.isArray(connector.kinds) || connector.kinds.length === 0) {
    throw new ProtocolError("invalid_input", `Connector ${connector.id} must declare the kinds it returns (task, listing).`);
  }
  if (connector.category !== undefined && !(CONNECTOR_CATEGORIES as readonly string[]).includes(connector.category)) {
    throw new ProtocolError("invalid_input", `Connector ${connector.id} has unknown category ${JSON.stringify(connector.category)}.`);
  }
  if (connector.payoutRails?.some((rail) => !(PAYOUT_RAILS as readonly string[]).includes(rail))) {
    throw new ProtocolError("invalid_input", `Connector ${connector.id} has an unknown payout rail.`);
  }
  if (connector.tier !== undefined && !(CATALOG_TIERS as readonly string[]).includes(connector.tier)) {
    throw new ProtocolError("invalid_input", `Connector ${connector.id} has unknown tier ${JSON.stringify(connector.tier)}.`);
  }
  if (connector.auth.type === "api_key" && connector.auth.env.length === 0) {
    throw new ProtocolError("invalid_input", `Connector ${connector.id} declares api_key auth without env names.`);
  }
  if (stagesOf(connector).length === 0) {
    throw new ProtocolError("invalid_input", `Connector ${connector.id} implements no stage.`);
  }
  return connector;
}

const CONNECTOR_ID_HINT = "^[a-z0-9][a-z0-9-]*$";
