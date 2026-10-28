import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PaypalError } from "./errors.js";

/** The sandbox app's client id and secret. Never logged; only `fingerprint` is ever shown. */
export interface Credentials {
  clientId: string;
  clientSecret: string;
  /** First 8 hex characters of sha256("<id>:<secret>"). Safe to show. */
  fingerprint: string;
}

const MAX_FILE_BYTES = 4096;
const KEY_RX = /^[A-Za-z0-9_-]{10,200}$/;

/** PAYPAL_CREDENTIALS_FILE when set, else ~/.config/refund-desk/sandbox.env. Never inside the repo. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAYPAL_CREDENTIALS_FILE || join(homedir(), ".config", "refund-desk", "sandbox.env");
}

export function fingerprintOf(clientId: string, clientSecret: string): string {
  return createHash("sha256").update(`${clientId}:${clientSecret}`).digest("hex").slice(0, 8);
}

/**
 * Reads PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET from the file. Refuses a file that group or
 * others can read (it must be mode 600), a file that is not a plain file, a large file, and
 * values that do not look like PayPal keys. Error messages never contain the file's contents.
 */
export function loadCredentials(path: string): Credentials {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new PaypalError("not_configured");
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new PaypalError("credential_file");
  if ((stat.mode & 0o077) !== 0) throw new PaypalError("credential_file_mode");

  const values: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  const clientId = values.PAYPAL_CLIENT_ID ?? "";
  const clientSecret = values.PAYPAL_CLIENT_SECRET ?? "";
  if (!KEY_RX.test(clientId) || !KEY_RX.test(clientSecret)) throw new PaypalError("credential_file");
  return { clientId, clientSecret, fingerprint: fingerprintOf(clientId, clientSecret) };
}
