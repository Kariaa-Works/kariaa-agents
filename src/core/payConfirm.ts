/**
 * The confirm step for payments. A first `pay` call answers with a token; money
 * moves only when the token comes back with the same terms.
 *
 * A token is an HMAC over the terms with a secret only this machine holds, so it
 * cannot be worked out ahead of the first call, and it carries its own expiry,
 * so an old one stops working.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** How long a confirm token is good for. */
export const CONFIRM_TTL_MS = 15 * 60_000;

export type PayTerms = {
  posting: string;
  offer?: string;
  action?: string;
  amount?: { amount: number; currency: string };
  to?: string;
  fee?: { amount: number; currency: string };
};

const sum = (m?: { amount: number; currency: string }) => (m ? `${m.amount} ${m.currency.toUpperCase()}` : "");

function sign(secret: string, terms: PayTerms, expires: number): string {
  const parts = [terms.posting, terms.offer ?? "", terms.action ?? "", sum(terms.amount), terms.to ?? "", sum(terms.fee), String(expires)];
  return createHmac("sha256", secret).update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

export class PayConfirm {
  private readonly secret: string;

  constructor(secret?: string) {
    this.secret = secret?.trim() || randomBytes(32).toString("hex");
  }

  /** A token for exactly these terms, good for fifteen minutes. */
  issue(terms: PayTerms, now = Date.now()): string {
    const expires = Math.floor((now + CONFIRM_TTL_MS) / 1000);
    return `pay.${expires.toString(36)}.${sign(this.secret, terms, expires)}`;
  }

  /** ok: the token was issued here for these terms and has not run out. */
  check(token: string | undefined, terms: PayTerms, now = Date.now()): "ok" | "missing" | "expired" | "mismatch" {
    if (!token) return "missing";
    const match = /^pay\.([0-9a-z]+)\.([0-9a-f]{24})$/u.exec(token);
    if (!match) return "mismatch";
    const expires = parseInt(match[1]!, 36);
    const expected = Buffer.from(sign(this.secret, terms, expires));
    const given = Buffer.from(match[2]!);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "mismatch";
    return expires * 1000 < now ? "expired" : "ok";
  }
}

/**
 * A secret kept in the cache folder, so a token from one `work pay` call is
 * still good for the `work pay --confirm` that follows in a new process.
 */
export function persistedConfirmSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.WORK_CACHE_DIR?.trim() || path.join(os.homedir(), ".cache", "work-protocol");
  const file = path.join(dir, "pay-confirm.key");
  try {
    if (fs.existsSync(file)) {
      const kept = fs.readFileSync(file, "utf8").trim();
      if (kept.length >= 32) return kept;
    }
    fs.mkdirSync(dir, { recursive: true });
    const secret = randomBytes(32).toString("hex");
    fs.writeFileSync(file, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
    return secret;
  } catch {
    return undefined; // a read-only disk: tokens then last for one process
  }
}
