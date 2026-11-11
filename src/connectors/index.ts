import type { Connector } from "../core/connector.js";
import { algora, createAlgora } from "./algora/index.js";
import { dice } from "./dice/index.js";
import { kaggle } from "./kaggle/index.js";
import { kariaa, kariaaJobs } from "./kariaa/index.js";
import { nearAgentMarket } from "./near-agent-market/index.js";
import { opentask } from "./opentask/index.js";
import { printify } from "./printify/index.js";
import { remotive } from "./remotive/index.js";
import { superteamEarn } from "./superteam-earn/index.js";
import { whopBounties } from "./whop-bounties/index.js";
import { opire } from "./opire/index.js";
import { yeswehack } from "./yeswehack/index.js";

/**
 * The connectors that ship with the package: a small set, one or two of each
 * kind, each one a working example to copy. Everything else arrives by pull
 * request (docs/connectors.md). The order is the order search results interleave.
 */
export const builtInConnectors: Connector[] = [
  kariaa,
  kariaaJobs,
  opentask,
  nearAgentMarket,
  superteamEarn,
  algora,
  whopBounties,
  kaggle,
  yeswehack,
  opire,
  printify,
  remotive,
  dice,
];

export {
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
  opire,
  printify,
  remotive,
  dice,
};
