import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertSandbox, PaypalClient, sandboxUrl, type FetchLike } from "../src/paypal/client.js";
import { credentialsPath, fingerprintOf, loadCredentials, type Credentials } from "../src/paypal/credentials.js";
import { PaypalError } from "../src/paypal/errors.js";
import { summarizeCapture, summarizeDisputes, summarizeOrder } from "../src/paypal/summary.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(ROOT, "tests/fixtures/paypal", name), "utf8"));

// Made-up values. The secret has dots so it can never look like a real PayPal key.
const CREDS: Credentials = {
  clientId: "test-client-id-0001",
  clientSecret: "test.secret.not.real",
  fingerprint: fingerprintOf("test-client-id-0001", "test.secret.not.real"),
};
const TOKEN = { status: 200, body: { access_token: "test-access-token", token_type: "Bearer", expires_in: 3600 } };

interface Call {
  url: string;
  init: RequestInit;
}

/** Answers calls in order from `replies`; any extra call fails the test. */
function scripted(replies: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected call ${url}`);
    const body = typeof next.body === "string" ? next.body : JSON.stringify(next.body);
    return new Response(body, { status: next.status, headers: next.headers });
  };
  return { fetch, calls, left: () => replies.length };
}

function client(fetch: FetchLike, now = () => 0): PaypalClient {
  return new PaypalClient({ credentials: () => CREDS, fetch, now });
}

async function rejectsKind(promise: Promise<unknown>, kind: string): Promise<PaypalError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PaypalError, String(error));
    assert.equal(error.kind, kind);
    return error;
  }
  assert.fail(`expected ${kind}`);
}

/** Collects console.error lines while `run` executes. */
async function captureLogs(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await run().catch(() => undefined);
  } finally {
    console.error = original;
  }
  return lines.join("\n");
}

describe("credentials file", () => {
  const dir = mkdtempSync(join(tmpdir(), "refund-desk-creds-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const id = "sandbox-client-id-0001";
  const secret = "sandbox-secret-value-0001";
  // Built at run time so this source file never holds a key line.
  const body = [`# sandbox app`, ["PAYPAL_CLIENT_ID", id].join("="), ["PAYPAL_CLIENT_SECRET", `"${secret}"`].join("=")].join("\n");

  it("reads a mode 600 file and fingerprints the pair with 8 hex characters", () => {
    const path = join(dir, "ok.env");
    writeFileSync(path, body, { mode: 0o600 });
    const creds = loadCredentials(path);
    assert.equal(creds.clientId, id);
    assert.equal(creds.clientSecret, secret);
    assert.match(creds.fingerprint, /^[0-9a-f]{8}$/);
    assert.equal(creds.fingerprint, createHash("sha256").update(`${id}:${secret}`).digest("hex").slice(0, 8));
  });

  it("refuses a file other users can read, without echoing its contents", () => {
    const path = join(dir, "open.env");
    writeFileSync(path, body);
    chmodSync(path, 0o644);
    const error = (() => {
      try {
        loadCredentials(path);
      } catch (caught) {
        return caught as PaypalError;
      }
      return null;
    })();
    assert.equal(error?.kind, "credential_file_mode");
    assert.equal(String(error?.message).includes(secret), false);
  });

  it("says not_configured for a missing file and credential_file for a missing secret", () => {
    assert.throws(() => loadCredentials(join(dir, "missing.env")), (e: unknown) => (e as PaypalError).kind === "not_configured");
    const path = join(dir, "half.env");
    writeFileSync(path, ["PAYPAL_CLIENT_ID", id].join("="), { mode: 0o600 });
    assert.throws(() => loadCredentials(path), (e: unknown) => (e as PaypalError).kind === "credential_file");
  });

  it("lives under ~/.config/refund-desk by default and honors PAYPAL_CREDENTIALS_FILE", () => {
    assert.match(credentialsPath({}), /[/\\]\.config[/\\]refund-desk[/\\]sandbox\.env$/);
    assert.equal(credentialsPath({ PAYPAL_CREDENTIALS_FILE: "/tmp/x.env" }), "/tmp/x.env");
  });
});

describe("sandbox host guard", () => {
  it("builds sandbox URLs and refuses every other host", () => {
    assert.equal(sandboxUrl("/v2/checkout/orders/ABC"), "https://api-m.sandbox.paypal.com/v2/checkout/orders/ABC");
    for (const bad of [
      "https://api-m.paypal.com/v2/checkout/orders/ABC",
      "http://api-m.sandbox.paypal.com/v2/checkout/orders/ABC",
      // user:pass@host, joined at run time so it does not read as an email address in the source.
      ["https://user:pass", "api-m.sandbox.paypal.com/x"].join("@"),
      "https://api-m.sandbox.paypal.com.example.com/x",
      "not a url",
    ]) {
      assert.throws(() => assertSandbox(bad), (e: unknown) => (e as PaypalError).kind === "bad_host", bad);
    }
    assert.throws(() => sandboxUrl("//api-m.paypal.com/v1/oauth2/token"), (e: unknown) => (e as PaypalError).kind === "bad_host");
  });

  it("refuses ids that are not PayPal ids before any request", async () => {
    const { fetch, calls } = scripted([]);
    const paypal = client(fetch);
    for (const bad of ["../v1/oauth2/token", "a/b", "", "x".repeat(65), "id?x=1"]) {
      await rejectsKind(paypal.getOrder(bad), "bad_id");
    }
    await rejectsKind(paypal.listDisputes({ transactionId: "a/b" }), "bad_id");
    assert.equal(calls.length, 0);
  });
});

describe("PayPal sandbox client", () => {
  it("gets a client-credentials token, then reads the order with it", async () => {
    const { fetch, calls } = scripted([TOKEN, { status: 200, body: fixture("order-completed.json") }]);
    const order = await client(fetch).getOrder("9SYN0000ORDER0001");
    assert.equal((order as { id: string }).id, "9SYN0000ORDER0001");

    assert.equal(calls[0].url, "https://api-m.sandbox.paypal.com/v1/oauth2/token");
    assert.equal(calls[0].init.method, "POST");
    const headers0 = calls[0].init.headers as Record<string, string>;
    assert.equal(headers0.authorization, `Basic ${Buffer.from(`${CREDS.clientId}:${CREDS.clientSecret}`).toString("base64")}`);
    assert.equal(calls[0].init.body, "grant_type=client_credentials");

    assert.equal(calls[1].url, "https://api-m.sandbox.paypal.com/v2/checkout/orders/9SYN0000ORDER0001");
    assert.equal(calls[1].init.method, "GET");
    assert.equal((calls[1].init.headers as Record<string, string>).authorization, "Bearer test-access-token");
    for (const call of calls) assert.equal(call.init.redirect, "error");
  });

  it("reuses the token until a minute before it expires", async () => {
    let now = 0;
    const capture = { status: 200, body: fixture("capture.json") };
    const { fetch, calls } = scripted([TOKEN, capture, capture, TOKEN, capture]);
    const paypal = client(fetch, () => now);
    await paypal.getCapture("9SYN0000CAPTURE01");
    // expires_in is 3600 s and the margin is 60 s, so the token is good until 3540 s.
    now = 3_539_000;
    await paypal.getCapture("9SYN0000CAPTURE01");
    now = 3_540_000;
    await paypal.getCapture("9SYN0000CAPTURE01");
    assert.deepEqual(
      calls.map((call) => call.url.endsWith("/v1/oauth2/token")),
      [true, false, false, true, false],
    );
  });

  it("puts the credential in the rejected state on a 401 from the token endpoint", async () => {
    const { fetch, calls } = scripted([{ status: 401, body: { error: "invalid_client", debug_id: "abc123" } }]);
    const paypal = client(fetch);
    const logs = await captureLogs(async () => {
      const error = await rejectsKind(paypal.getOrder("9SYN0000ORDER0001"), "credential_rejected");
      assert.equal(error.fingerprint, CREDS.fingerprint);
      assert.equal(error.status, 401);
    });
    assert.equal(paypal.state, "rejected");
    // No further request is sent: the next call fails before fetch.
    await rejectsKind(paypal.getCapture("9SYN0000CAPTURE01"), "credential_rejected");
    assert.equal(calls.length, 1);
    assert.match(logs, new RegExp(`fp=${CREDS.fingerprint}`));
    assert.equal(logs.includes(CREDS.clientSecret), false);
    assert.equal(logs.includes(CREDS.clientId), false);
  });

  it("treats a 403 from the token endpoint as a rejection too", async () => {
    const { fetch } = scripted([{ status: 403, body: "" }]);
    const paypal = client(fetch);
    await rejectsKind(paypal.listDisputes(), "credential_rejected");
    assert.equal(paypal.state, "rejected");
  });

  it("gives a 401 from the API exactly one fresh token, and rejects on the second 401", async () => {
    const order = { status: 200, body: fixture("order-completed.json") };
    const ok = scripted([TOKEN, { status: 401, body: "" }, TOKEN, order]);
    await client(ok.fetch).getOrder("9SYN0000ORDER0001");
    assert.equal(ok.left(), 0);

    const bad = scripted([TOKEN, { status: 401, body: "" }, TOKEN, { status: 401, body: "" }]);
    const paypal = client(bad.fetch);
    await captureLogs(() => rejectsKind(paypal.getOrder("9SYN0000ORDER0001"), "credential_rejected"));
    assert.equal(paypal.state, "rejected");
    assert.equal(bad.left(), 0);
  });

  it("refuses a kind of request after PayPal answers it with 403, and keeps the others", async () => {
    const { fetch, calls } = scripted([
      TOKEN,
      { status: 403, body: { name: "NOT_AUTHORIZED", debug_id: "f00d42" } },
      { status: 200, body: fixture("order-completed.json") },
    ]);
    const paypal = client(fetch);
    const logs = await captureLogs(() => rejectsKind(paypal.listDisputes(), "forbidden"));
    assert.match(logs, /paypal forbidden family=disputes status=403/);
    await rejectsKind(paypal.listDisputes(), "forbidden");
    assert.deepEqual(paypal.forbiddenFamilies, ["disputes"]);
    assert.equal(paypal.state, "ok");
    await paypal.getOrder("9SYN0000ORDER0001");
    assert.equal(calls.length, 3);
  });

  it("maps 404, 500, timeouts and oversized answers to fixed errors", async () => {
    const notFound = scripted([TOKEN, { status: 404, body: { name: "RESOURCE_NOT_FOUND", debug_id: "d00d01" } }]);
    const missing = await rejectsKind(client(notFound.fetch).getOrder("9SYN0000NOPE00001"), "not_found");
    assert.equal(missing.debugId, "d00d01");

    const broken = scripted([TOKEN, { status: 500, body: "<html>oops</html>" }]);
    const error = await rejectsKind(client(broken.fetch).getOrder("9SYN0000ORDER0001"), "http");
    assert.equal(error.status, 500);
    assert.equal(error.message.includes("oops"), false);

    const big = scripted([TOKEN, { status: 200, body: "{}", headers: { "content-length": String(2 * 1024 * 1024) } }]);
    await rejectsKind(client(big.fetch).getOrder("9SYN0000ORDER0001"), "too_large");

    const slow: FetchLike = async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    };
    await rejectsKind(client(slow).getOrder("9SYN0000ORDER0001"), "timeout");
  });

  it("sends the dispute filters as query parameters, with page_size capped at 50", async () => {
    const { fetch, calls } = scripted([TOKEN, { status: 200, body: fixture("disputes.json") }]);
    await client(fetch).listDisputes({ state: "REQUIRED_ACTION", transactionId: "9SYN0000CAPTURE01", pageSize: 500 });
    const url = new URL(calls[1].url);
    assert.equal(url.origin + url.pathname, "https://api-m.sandbox.paypal.com/v1/customer/disputes");
    assert.equal(url.searchParams.get("page_size"), "50");
    assert.equal(url.searchParams.get("dispute_state"), "REQUIRED_ACTION");
    assert.equal(url.searchParams.get("disputed_transaction_id"), "9SYN0000CAPTURE01");
  });
});

describe("summaries", () => {
  it("cuts an order down to what the refund check needs and drops names, phones and addresses", () => {
    const order = summarizeOrder(fixture("order-completed.json"));
    assert.deepEqual(order, {
      order_id: "9SYN0000ORDER0001",
      status: "COMPLETED",
      created: "2026-10-20T10:00:00Z",
      buyer_email: "ana@example.com",
      payer_id: "SYNPAYER0001",
      amount: { value: "25.00", currency: "USD" },
      captures: [
        {
          capture_id: "9SYN0000CAPTURE01",
          status: "COMPLETED",
          amount: { value: "25.00", currency: "USD" },
          refunded_amount: undefined,
          refundable_amount: { value: "25.00", currency: "USD" },
          created: "2026-10-20T10:00:05Z",
          order_id: undefined,
          refunded: false,
        },
      ],
      refunded: false,
      purchase: {
        order: "9SYN0000ORDER0001",
        buyer_email: "ana@example.com",
        paid_from: "SYNPAYER0001",
        date: "2026-10-20T10:00:00Z",
        refunded: false,
      },
    });
    const flat = JSON.stringify(order);
    for (const dropped of ["Test", "Buyer", "Sample Lane", "5550100", "00000", "links"]) {
      assert.equal(flat.includes(dropped), false, dropped);
    }
  });

  it("marks a refunded order and reads the newer payment_source shape", () => {
    const order = summarizeOrder(fixture("order-refunded.json"));
    assert.equal(order.refunded, true);
    assert.equal(order.purchase.refunded, true);
    assert.equal(order.buyer_email, "ana@example.com");
    assert.equal(order.payer_id, "SYNPAYER0001");
  });

  it("reads a capture's order id and status", () => {
    assert.deepEqual(summarizeCapture(fixture("capture.json")), {
      capture_id: "9SYN0000CAPTURE01",
      status: "COMPLETED",
      amount: { value: "25.00", currency: "USD" },
      refunded_amount: undefined,
      refundable_amount: { value: "25.00", currency: "USD" },
      created: "2026-10-20T10:00:05Z",
      order_id: "9SYN0000ORDER0001",
      refunded: false,
    });
    const partial = summarizeCapture(fixture("capture-partial.json"));
    assert.equal(partial.refundable_amount?.value, "15.00");
    assert.equal(partial.refunded, false);
    assert.equal(summarizeCapture({ id: "X1", status: "PARTIALLY_REFUNDED", amount: { currency_code: "USD", value: "1.00" } }).refunded, false);
    assert.equal(summarizeCapture({ id: "X2", status: "REFUNDED", amount: { currency_code: "USD", value: "1.00" } }).refunded, true);
  });

  it("lists disputes and says when there is a next page", () => {
    const page = summarizeDisputes(fixture("disputes.json"));
    assert.equal(page.more, true);
    assert.deepEqual(
      page.disputes.map((d) => [d.dispute_id, d.status, d.seller_transaction_ids]),
      [
        ["PP-D-90001", "WAITING_FOR_SELLER_RESPONSE", ["9SYN0000CAPTURE01"]],
        ["PP-D-90002", "RESOLVED", []],
      ],
    );
    assert.deepEqual(summarizeDisputes({}), { disputes: [], more: false });
  });
});

describe("refund calls stay on the sandbox", () => {
  it("every request of a refund goes to the sandbox host, with redirects refused", async () => {
    const { fetch, calls } = scripted([TOKEN, { status: 201, body: { id: "REFUND-1", status: "COMPLETED" } }]);
    await client(fetch).refundCapture("CAPTURE-1", {}, "idem-key-0001");
    assert.equal(calls.length, 2);
    for (const call of calls) {
      const url = new URL(call.url);
      assert.equal(url.protocol, "https:");
      assert.equal(url.host, "api-m.sandbox.paypal.com", call.url);
      assert.equal(call.init.redirect, "error", "a redirect must never carry the call off the sandbox");
    }
    assert.equal(new URL(calls[1].url).pathname, "/v2/payments/captures/CAPTURE-1/refund");
  });

  it("a capture id that tries to leave the path never reaches fetch", async () => {
    for (const id of ["../../v1/oauth2/token", "//api-m.paypal.com/x", "CAPTURE-1/../x", "a b", ""]) {
      const { fetch, calls } = scripted([]);
      await rejectsKind(client(fetch).refundCapture(id, {}, "idem-key-0001"), "bad_id");
      assert.equal(calls.length, 0, id);
    }
  });

  it("the client has no setting that points it at another host", () => {
    for (const bad of [
      "https://api-m.paypal.com/v2/payments/captures/X/refund",
      "https://api.paypal.com/v1/oauth2/token",
      "http://api-m.sandbox.paypal.com/v1/oauth2/token",
      "https://api-m.sandbox.paypal.com.example/v1/oauth2/token",
    ]) {
      assert.throws(() => assertSandbox(bad), (e: unknown) => (e as PaypalError).kind === "bad_host", bad);
    }
  });
});
