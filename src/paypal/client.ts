import { credentialsPath, loadCredentials, type Credentials } from "./credentials.js";
import { PaypalError } from "./errors.js";

/** The only host this client ever calls. There is no setting to change it. */
export const SANDBOX_HOST = "api-m.sandbox.paypal.com";
const SANDBOX_ORIGIN = `https://${SANDBOX_HOST}`;

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** A token is dropped this long before PayPal says it expires. */
const TOKEN_MARGIN_MS = 60_000;
const ID_RX = /^[A-Za-z0-9-]{1,64}$/;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Which kinds of request PayPal has answered 403 to. Each stays refused until a restart. */
export type ApiFamily = "orders" | "payments" | "disputes";

export type CredentialState = "not_loaded" | "ok" | "rejected";

export const DISPUTE_STATES = [
  "REQUIRED_ACTION",
  "REQUIRED_OTHER_PARTY_ACTION",
  "UNDER_PAYPAL_REVIEW",
  "RESOLVED",
  "OPEN_INQUIRIES",
  "APPEALABLE",
] as const;
export type DisputeState = (typeof DISPUTE_STATES)[number];

/**
 * Builds a sandbox URL and checks it. A path that would leave the sandbox host (for example
 * "//api-m.paypal.com/...") or a non-https URL is refused before any request is made.
 */
export function sandboxUrl(path: string, query: Record<string, string> = {}): string {
  const url = new URL(path, SANDBOX_ORIGIN);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  assertSandbox(url.toString());
  return url.toString();
}

export function assertSandbox(href: string): void {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    throw new PaypalError("bad_host");
  }
  if (url.protocol !== "https:" || url.host !== SANDBOX_HOST || url.username || url.password) {
    throw new PaypalError("bad_host");
  }
}

function checkId(id: string): string {
  if (!ID_RX.test(id)) throw new PaypalError("bad_id");
  return encodeURIComponent(id);
}

function debugIdOf(body: string): string | undefined {
  try {
    const value = (JSON.parse(body) as { debug_id?: unknown }).debug_id;
    return typeof value === "string" && /^[A-Za-z0-9]{1,40}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface PaypalClientOptions {
  /** Called once, on the first request. Defaults to the key file. */
  credentials?: () => Credentials;
  fetch?: FetchLike;
  now?: () => number;
}

/**
 * Read-only PayPal sandbox client: OAuth client-credentials token, orders, captures and
 * disputes. A 401 or 403 from the token endpoint puts the credential in the rejected state:
 * no further request is sent until the owner replaces the key file and restarts. A 401 from
 * an API call gets exactly one fresh token; a second 401 is a rejection. A 403 from an API
 * call refuses that kind of request (orders, payments or disputes) until a restart.
 */
export class PaypalClient {
  private readonly loadCreds: () => Credentials;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private creds: Credentials | null = null;
  private token: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;
  private rejectedFingerprint: string | null = null;
  private readonly forbidden = new Set<ApiFamily>();

  constructor(options: PaypalClientOptions = {}) {
    this.loadCreds = options.credentials ?? (() => loadCredentials(credentialsPath()));
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  get state(): CredentialState {
    if (this.rejectedFingerprint) return "rejected";
    return this.creds ? "ok" : "not_loaded";
  }

  get forbiddenFamilies(): ApiFamily[] {
    return [...this.forbidden];
  }

  async getOrder(orderId: string): Promise<unknown> {
    return this.get("orders", `/v2/checkout/orders/${checkId(orderId)}`);
  }

  async getCapture(captureId: string): Promise<unknown> {
    return this.get("payments", `/v2/payments/captures/${checkId(captureId)}`);
  }

  async listDisputes(filter: { state?: DisputeState; transactionId?: string; pageSize?: number } = {}): Promise<unknown> {
    const query: Record<string, string> = { page_size: String(Math.min(Math.max(filter.pageSize ?? 10, 1), 50)) };
    if (filter.state) query.dispute_state = filter.state;
    if (filter.transactionId) {
      if (!ID_RX.test(filter.transactionId)) throw new PaypalError("bad_id");
      query.disputed_transaction_id = filter.transactionId;
    }
    return this.get("disputes", "/v1/customer/disputes", query);
  }

  private credentials(): Credentials {
    if (!this.creds) this.creds = this.loadCreds();
    return this.creds;
  }

  private refuseIfRejected(): void {
    if (this.rejectedFingerprint) throw new PaypalError("credential_rejected", { fingerprint: this.rejectedFingerprint });
  }

  private reject(creds: Credentials, status: number, debugId?: string): never {
    this.rejectedFingerprint = creds.fingerprint;
    this.token = null;
    console.error(`paypal credential rejected status=${status} fp=${creds.fingerprint}`);
    throw new PaypalError("credential_rejected", { status, debugId, fingerprint: creds.fingerprint });
  }

  private async send(href: string, init: RequestInit): Promise<{ status: number; body: string }> {
    assertSandbox(href);
    let response: Response;
    try {
      response = await this.fetchImpl(href, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new PaypalError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "http");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new PaypalError("too_large", { status: response.status });
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new PaypalError("too_large", { status: response.status });
    return { status: response.status, body };
  }

  private accessToken(): Promise<string> {
    this.refuseIfRejected();
    if (this.token && this.now() < this.token.expiresAt) return Promise.resolve(this.token.value);
    if (!this.pendingToken) {
      this.pendingToken = this.fetchToken().finally(() => {
        this.pendingToken = null;
      });
    }
    return this.pendingToken;
  }

  private async fetchToken(): Promise<string> {
    const creds = this.credentials();
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    const { status, body } = await this.send(sandboxUrl("/v1/oauth2/token"), {
      method: "POST",
      headers: {
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    if (status === 401 || status === 403) this.reject(creds, status, debugIdOf(body));
    if (status !== 200) throw new PaypalError("http", { status, debugId: debugIdOf(body) });
    let parsed: { access_token?: unknown; expires_in?: unknown };
    try {
      parsed = JSON.parse(body) as typeof parsed;
    } catch {
      throw new PaypalError("bad_response", { status });
    }
    if (typeof parsed.access_token !== "string" || !parsed.access_token) throw new PaypalError("bad_response", { status });
    const seconds = typeof parsed.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in : 0;
    this.token = { value: parsed.access_token, expiresAt: this.now() + Math.max(seconds * 1000 - TOKEN_MARGIN_MS, 0) };
    return parsed.access_token;
  }

  private async get(family: ApiFamily, path: string, query: Record<string, string> = {}): Promise<unknown> {
    if (this.forbidden.has(family)) throw new PaypalError("forbidden");
    const href = sandboxUrl(path, query);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.accessToken();
      const { status, body } = await this.send(href, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (status === 401) {
        this.token = null;
        if (attempt === 0) continue;
        this.reject(this.credentials(), status, debugIdOf(body));
      }
      if (status === 403) {
        this.forbidden.add(family);
        console.error(`paypal forbidden family=${family} status=403`);
        throw new PaypalError("forbidden", { status, debugId: debugIdOf(body) });
      }
      if (status === 404) throw new PaypalError("not_found", { status, debugId: debugIdOf(body) });
      if (status !== 200) throw new PaypalError("http", { status, debugId: debugIdOf(body) });
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new PaypalError("bad_response", { status });
      }
    }
    throw new PaypalError("http");
  }
}

let shared: PaypalClient | null = null;

/** One client per process, so the token cache and the rejected state are shared by every request. */
export function sharedPaypal(): PaypalClient {
  if (!shared) shared = new PaypalClient();
  return shared;
}
