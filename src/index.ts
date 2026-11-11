/**
 * Work Protocol: one API for agents and people to find work, apply, do it and
 * submit it, through pluggable connectors.
 *
 *   const work = await createProtocol();
 *   const { jobs } = await work.search({ query: "electrician", location: "Accra" });
 */
export * from "./core/types.js";
export { ProtocolError, isProtocolError, toProtocolError, ERROR_CODES, type ErrorCode } from "./core/errors.js";
export { makeId, parseId, isConnectorId } from "./core/ids.js";
export {
  defineConnector,
  stagesOf,
  hasStage,
  type Connector,
  type ConnectorContext,
  type AuthSpec,
  type ProfileField,
  type Logger,
  type SearchOutput,
  type RegisterInput,
  type Registration,
} from "./core/connector.js";
export {
  fileCredentialStore,
  credentialsFile,
  connectPlan,
  type Connection,
  type ConnectMethod,
  type CredentialStore,
} from "./core/connect.js";
export {
  defineJsonBoard,
  defineFeedBoard,
  applyFilters,
  locationFits,
  str,
  num,
  iso,
  strings,
  type JsonBoard,
  type BoardRequest,
} from "./core/jsonBoard.js";
export { parseFeed, xmlText, type Feed, type FeedItem } from "./core/feed.js";
export { Registry, loadConnectorModules, connectorModulesFromEnv, loadVerifierModules, verifierModulesFromEnv } from "./core/registry.js";
export {
  defineVerifier,
  verifyWork,
  verifierApplies,
  combineOutcomes,
  payFor,
  mediaOf,
  OUTCOMES,
  CheckSchema,
  VerdictSchema,
  VerificationSchema,
  type Verifier,
  type VerifierContext,
  type VerifyInput,
  type Verdict,
  type Verification,
  type Check,
  type Outcome,
  type Applies,
} from "./core/verifier.js";
export { inspectMedia, kindOfMime, wavDuration, mp4Duration, pngDimensions, jpegDimensions, type MediaInfo } from "./core/media.js";
export { builtInVerifiers, requirements, media, duplicates, text } from "./verifiers/index.js";
export { credentialsFor, isConfigured, canUse, type CredentialOverrides } from "./core/credentials.js";
export { JobCache, defaultCacheFile, type JobCacheOptions } from "./core/jobCache.js";
export {
  resolveWork,
  sniffMime,
  mimeFromExtension,
  isPrivateAddress,
  assertPublicHost,
  DEFAULT_MAX_FILE_BYTES,
  type ResolveWorkOptions,
} from "./core/files.js";
export { WorkProtocol, dedupeKey, scoreJob, type WorkProtocolOptions, type ConnectorInfo } from "./core/router.js";
export { stripHtml, truncate, queryWords, decodeEntities } from "./core/text.js";
export { VERSION, USER_AGENT } from "./core/version.js";
export {
  builtInConnectors,
  kariaa,
  kariaaJobs,
  opentask,
  nearAgentMarket,
  superteamEarn,
  algora,
  createAlgora,
  whopBounties,
  kaggle,
  yeswehack,
  printify,
  remotive,
  dice,
} from "./connectors/index.js";
export { createKariaaConnectors, KariaaClientPool, KARIAA_MCP_URL, KARIAA_KEY_HELP } from "./connectors/kariaa/index.js";
export { createWorkMcpServer, WORK_MCP_TOOLS, type WorkMcpServerOptions } from "./mcp/server.js";
export {
  defineMcpConnector,
  isMcpLinked,
  McpProfileSchema,
  draftProfile,
  renderProfileModule,
  writeDraft,
  type McpProfile,
  type McpProfileInput,
  type McpLinkedConnector,
  type McpConnectorOptions,
} from "./core/mcp/index.js";
export { McpClientPool, sharedMcpPool, toolResultJson, toolResultText, mapMcpToolError, mapMcpTransportError } from "./core/mcpClient.js";
export { FileOAuthProvider, oauthTokensExist, clearOAuth } from "./core/oauth.js";
export { loginMcp } from "./core/oauthLogin.js";
export { fetchJson, type JsonRequest } from "./core/http.js";
export * from "./search/index.js";
export { runAsTenant, stateDir, perTenant } from "./core/tenant.js";

import { builtInConnectors } from "./connectors/index.js";
import { Registry, connectorModulesFromEnv, loadConnectorModules, loadVerifierModules, verifierModulesFromEnv } from "./core/registry.js";
import { WorkProtocol, type WorkProtocolOptions } from "./core/router.js";
import { builtInVerifiers } from "./verifiers/index.js";
import { traceProtocol } from "./core/trace.js";

export { loadDotEnv, parseDotEnv } from "./core/env.js";
export { PayConfirm, persistedConfirmSecret, CONFIRM_TTL_MS } from "./core/payConfirm.js";
import { loadDotEnv as loadEnvFiles } from "./core/env.js";

export {
  traceProtocol,
  readTrace,
  summarizeTrace,
  redact,
  TRACED_OPS,
  type TraceEvent,
  type TraceSummary,
  type TracedOp,
  type TraceStep,
} from "./core/trace.js";

export type CreateProtocolOptions = WorkProtocolOptions & {
  /** Register the connectors and verifiers that ship with the package. Default true. */
  builtIns?: boolean;
  /** Extra connector modules to load. Default: `WORK_CONNECTOR_MODULES` from the environment. */
  modules?: string[];
  /** Extra verifier modules to load. Default: `WORK_VERIFIER_MODULES` from the environment. */
  verifierModules?: string[];
};

/** The protocol with the built-in connectors and verifiers, any `WORK_CONNECTOR_MODULES` / `WORK_VERIFIER_MODULES`, and the given options. */
export async function createProtocol(options: CreateProtocolOptions = {}): Promise<WorkProtocol> {
  const { builtIns, modules, verifierModules, connectors, verifiers, ...rest } = options;
  // A program using the library reads keys from .env the way the CLI does. Tests and callers that pass their own env are left alone.
  if (!options.env && !process.env.VITEST && process.env.WORK_DOTENV !== "off") loadEnvFiles();
  const env = options.env ?? process.env;
  const registry = options.registry ?? new Registry();
  if (builtIns !== false) registry.registerAll(builtInConnectors);
  if (connectors) registry.registerAll(connectors);
  const specifiers = modules ?? connectorModulesFromEnv(env);
  if (specifiers.length > 0) await loadConnectorModules(specifiers, registry);
  const allVerifiers = [...(builtIns !== false ? builtInVerifiers : []), ...(verifiers ?? [])];
  const verifierSpecifiers = verifierModules ?? verifierModulesFromEnv(env);
  if (verifierSpecifiers.length > 0) allVerifiers.push(...(await loadVerifierModules(verifierSpecifiers)));
  // The library runs on the caller's own machine, so work can be given as a file path. Servers pass allowLocalFiles: false.
  const protocol = new WorkProtocol({ allowLocalFiles: true, ...rest, registry, verifiers: allVerifiers });
  // `work trace -- <command>` sets this, so a workflow is recorded whether it uses the library, the CLI or the MCP server.
  const traceFile = env.WORK_TRACE_FILE?.trim();
  return traceFile ? traceProtocol(protocol, traceFile) : protocol;
}
