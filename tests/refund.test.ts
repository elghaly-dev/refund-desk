import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startServer } from "../src/http.js";
import { PaypalClient, type FetchLike } from "../src/paypal/client.js";
import { fingerprintOf } from "../src/paypal/credentials.js";
import { PaypalError } from "../src/paypal/errors.js";
import { clearProposalsForTests } from "../src/refund-proposal.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (name: string): string => readFileSync(join(ROOT, "tests/fixtures/paypal", name), "utf8");

const CREDS = {
  clientId: "test-client-id-0001",
  clientSecret: "test.secret.not.real",
  fingerprint: fingerprintOf("test-client-id-0001", "test.secret.not.real"),
};
const TOKEN = JSON.stringify({ access_token: "test-access-token", token_type: "Bearer", expires_in: 3600 });

function send(port: number, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: {
          host: "127.0.0.1",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          "content-length": String(Buffer.byteLength(body)),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function rpcResult(body: string): { structuredContent: Record<string, unknown>; isError: boolean } {
  const data = body.trimStart().startsWith("{") ? body : (body.match(/^data: (.*)$/m)?.[1] ?? "");
  const message = JSON.parse(data) as { result?: { structuredContent: Record<string, unknown>; isError: boolean } };
  assert.ok(message.result);
  return message.result;
}

function toolCall(id: number, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
}

const ACK_MESSAGE = {
  from: "Ana <ana@example.com>",
  text: "Hi, I'd like a refund for order 9SYN0000ORDER0001.",
};
const PURCHASE = {
  order: "9SYN0000ORDER0001",
  buyer_email: "ana@example.com",
  paid_from: "SYNPAYER0001",
  date: "2026-10-20T10:00:00Z",
  refunded: false,
};

describe("draft_refund and confirm_refund", () => {
  let server: Server;
  let port = 0;
  let paypal: PaypalClient;
  const calls: Array<{ url: string; method: string }> = [];

  function buildFetch(replies: Array<{ status: number; body: string }>): FetchLike {
    return async (url, init) => {
      calls.push({ url, method: init.method ?? "GET" });
      const next = replies.shift();
      if (!next) throw new Error(`unexpected call ${url}`);
      return new Response(next.body, { status: next.status });
    };
  }

  before(async () => {
    clearProposalsForTests();
  });

  after(() => {
    clearProposalsForTests();
    return new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  async function boot(replies: Array<{ status: number; body: string }>): Promise<void> {
    calls.length = 0;
    clearProposalsForTests();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    paypal = new PaypalClient({ credentials: () => CREDS, fetch: buildFetch([...replies]) });
    server = await startServer({ host: "127.0.0.1", port: 0, paypal });
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  }

  it("refuses an amount above the refundable balance at draft time", async () => {
    await boot([
      { status: 200, body: TOKEN },
      { status: 200, body: fixture("capture-partial.json") },
    ]);
    const reply = await send(
      port,
      toolCall(1, "draft_refund", {
        message: ACK_MESSAGE,
        purchases: [PURCHASE],
        capture_id: "9SYN0000CAPTURE03",
        amount: "20.00",
      }),
    );
    const result = rpcResult(reply.body);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error, "over_refund");
    assert.equal(result.structuredContent.refused, true);
    assert.match(String(result.structuredContent.summary), /more than what is left/);
    assert.equal(calls.filter((c) => c.url.includes("/refund")).length, 0);
  });

  it("refuses confirm_refund without the correct one-time code", async () => {
    await boot([
      { status: 200, body: TOKEN },
      { status: 200, body: fixture("capture.json") },
    ]);
    const draft = rpcResult(
      (await send(
        port,
        toolCall(2, "draft_refund", { message: ACK_MESSAGE, purchases: [PURCHASE], capture_id: "9SYN0000CAPTURE01" }),
      )).body,
    );
    const proposal = draft.structuredContent.proposal as { proposal_id: string };
    calls.length = 0;
    const bad = rpcResult(
      (await send(port, toolCall(3, "confirm_refund", { proposal_id: proposal.proposal_id, confirmation_code: "WRONG000" }))).body,
    );
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error, "bad_confirmation");
    assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("/refund")).length, 0);

    const missing = rpcResult(
      (await send(port, toolCall(4, "confirm_refund", { proposal_id: proposal.proposal_id }))).body,
    );
    assert.equal(missing.structuredContent.error, "bad_confirmation");
    assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("/refund")).length, 0);
  });

  it("confirm_refund twice sends one sandbox refund", async () => {
    await boot([
      { status: 200, body: TOKEN },
      { status: 200, body: fixture("capture.json") },
      { status: 200, body: fixture("capture.json") },
      { status: 201, body: fixture("refund-completed.json") },
    ]);
    const draft = rpcResult(
      (await send(
        port,
        toolCall(5, "draft_refund", { message: ACK_MESSAGE, purchases: [PURCHASE], capture_id: "9SYN0000CAPTURE01", amount: "15.00" }),
      )).body,
    );
    const proposal = draft.structuredContent.proposal as { proposal_id: string; confirmation_code: string };
    calls.length = 0;
    const first = rpcResult(
      (await send(
        port,
        toolCall(6, "confirm_refund", { proposal_id: proposal.proposal_id, confirmation_code: proposal.confirmation_code }),
      )).body,
    );
    assert.equal(first.isError, false);
    assert.equal(first.structuredContent.refused, false);
    assert.equal((first.structuredContent.refund as { refund_id: string }).refund_id, "9SYN0000REFUND002");
    const refundPosts = calls.filter((c) => c.method === "POST" && c.url.includes("/refund"));
    assert.equal(refundPosts.length, 1);
    assert.equal(new URL(refundPosts[0].url).host, "api-m.sandbox.paypal.com");

    const second = rpcResult(
      (await send(
        port,
        toolCall(7, "confirm_refund", { proposal_id: proposal.proposal_id, confirmation_code: proposal.confirmation_code }),
      )).body,
    );
    assert.equal(second.structuredContent.idempotent_repeat, true);
    assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("/refund")).length, 1);
  });

  it("401 from confirm_refund puts the credential in rejected state", async () => {
    await boot([
      { status: 200, body: TOKEN },
      { status: 200, body: fixture("capture.json") },
      { status: 200, body: fixture("capture.json") },
      { status: 401, body: "" },
      { status: 200, body: TOKEN },
      { status: 401, body: "" },
    ]);
    const draft = rpcResult(
      (await send(
        port,
        toolCall(8, "draft_refund", { message: ACK_MESSAGE, purchases: [PURCHASE], capture_id: "9SYN0000CAPTURE01" }),
      )).body,
    );
    const proposal = draft.structuredContent.proposal as { proposal_id: string; confirmation_code: string };
    const confirm = rpcResult(
      (await send(
        port,
        toolCall(9, "confirm_refund", { proposal_id: proposal.proposal_id, confirmation_code: proposal.confirmation_code }),
      )).body,
    );
    assert.equal(confirm.isError, true);
    assert.equal(confirm.structuredContent.error, "credential_rejected");
    assert.equal(confirm.structuredContent.credential_fingerprint, CREDS.fingerprint);
    assert.equal(paypal.state, "rejected");
    await assert.rejects(() => paypal.getOrder("9SYN0000ORDER0001"), (e: unknown) => (e as PaypalError).kind === "credential_rejected");
  });
});
