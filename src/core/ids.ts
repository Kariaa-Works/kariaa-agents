import { ProtocolError } from "./errors.js";

/** Lowercase letters, digits and dashes, starting with a letter or digit. */
export const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]*$/;

export function isConnectorId(value: string): boolean {
  return CONNECTOR_ID.test(value);
}

/** `<connector>:<native>`. The native part may itself contain colons. */
export function makeId(connector: string, native: string): string {
  return `${connector}:${native}`;
}

export function parseId(id: string): { connector: string; native: string } {
  const colon = typeof id === "string" ? id.indexOf(":") : -1;
  if (colon <= 0 || colon === id.length - 1) {
    throw new ProtocolError("invalid_input", `Ids look like <connector>:<id>, for example kariaa:3f2a… Got ${JSON.stringify(id)}.`);
  }
  const connector = id.slice(0, colon);
  if (!isConnectorId(connector)) {
    throw new ProtocolError("invalid_input", `${JSON.stringify(connector)} is not a connector id.`);
  }
  return { connector, native: id.slice(colon + 1) };
}
