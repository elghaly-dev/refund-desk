# refund-desk

A refund desk for a small shop. An AI agent reads each refund request, checks it against the shop's written refund policy, and prepares the next step for the shop owner. Money goes back to the original payment and nowhere else, and a person confirms every refund. It is built on the PayPal sandbox, so no real money moves.

## Status

Step 2 of 5: the policy check, plus three read-only tools for the PayPal sandbox. Nothing can move money yet.

| Step | What it adds |
| --- | --- |
| 1 | MCP server, the policy check, tests, CI, public-safety check |
| 2 (this) | PayPal sandbox, read-only: find an order, read a capture, list disputes |
| 3 | Draft a refund (nothing moves); then a refund on the original sandbox capture after a person confirms with a one-time code; an evidence receipt per decision |
| 4 | Hosted demo on Render, setup steps for judges, three seeded cases |
| 5 | Demo video and write-up |

## Run it

Node 20.12 or newer.

```bash
npm ci
npm test
npm start
```

The MCP endpoint is `http://127.0.0.1:3000/mcp` (Streamable HTTP) and the health check is `/health`. Copy `.env.example` to `.env` to change the host, the port or the policy file.

Connect any MCP client. With Claude Code:

```bash
claude mcp add --transport http refund-desk http://127.0.0.1:3000/mcp
```

## The tool: `check_refund`

Input: one `message` (`from`, `text`, optional `subject`, `date`, `scan_status`), and optionally the shop's own `purchases` for that buyer or order. The answer is one card with a one-sentence `summary` and one `action`:

| Action | When | What the agent does next |
| --- | --- | --- |
| `skip` | not a refund request | nothing |
| `acknowledge` | a plain refund request | drafts the policy reply; the refund waits for the shop owner |
| `escalate` | asks to pay another wallet, card or account; the sender is not the buyer; already refunded; past a time limit; says it paid from an exchange | the shop owner looks first |
| `quarantine` | instructions aimed at an AI, a seed phrase or private key, or a mail scanner that did not clear it | no reply draft |

The card also carries the flags, the reasons, what was pulled out of the text (order ids, transaction ids, addresses, amounts, links) and the policy it was checked against. `policy.example.json` is the policy of the Plumb 35 shop: no time limit, no reason asked, money back once per purchase, to the payment that paid. Point `REFUND_POLICY_FILE` at your own.

## The PayPal sandbox tools

| Tool | What it reads | Notes |
| --- | --- | --- |
| `find_order` | one order by id: status, amount, captures, refunded or not | also returns a `purchase` to pass straight to `check_refund` |
| `get_capture` | one captured payment by id: status, amount, its order id | a refund can only ever go back to a capture |
| `list_disputes` | disputes on the shop's sandbox account, optionally by state or transaction | newest first, up to 50 |

All three are read-only. They call `api-m.sandbox.paypal.com` and nothing else: the host is a constant, every URL is checked before it is sent, ids must be letters, digits and dashes, and redirects are refused. Buyer names, phone numbers and postal addresses are dropped from every answer; the agent sees the buyer's email and payer id, which the policy check needs.

### Set up the sandbox keys

1. At developer.paypal.com, open **Apps & Credentials**, choose **Sandbox**, and create an app. Copy its client id and secret.
2. Save them outside the repo, readable by you alone. This asks for both values and does not show the secret:

   ```sh
   mkdir -p ~/.config/refund-desk && chmod 700 ~/.config/refund-desk
   printf 'Sandbox client id: '; read -r PP_ID
   printf 'Sandbox secret: '; stty -echo; read -r PP_SECRET; stty echo; echo
   ( umask 077; printf 'PAYPAL_CLIENT_ID=%s\nPAYPAL_CLIENT_SECRET=%s\n' "$PP_ID" "$PP_SECRET" > ~/.config/refund-desk/sandbox.env )
   unset PP_ID PP_SECRET
   ```

3. Start the server again. `PAYPAL_CREDENTIALS_FILE` points somewhere else if you need it to.

The server refuses a key file that other users can read. It never prints a key; when it has to name one, it shows an 8-character fingerprint (the start of the SHA-256 of `id:secret`). Without a key file the PayPal tools answer `not_configured` and `check_refund` works as before.

### When PayPal says no

- **401 or 403 from the token endpoint:** the credential goes into the rejected state. No further request is sent until you replace the key file and restart. `/health` shows `"paypal_credential":"rejected"`.
- **401 from a lookup:** the desk fetches one fresh token and tries once more. A second 401 is a rejection, as above.
- **403 from a lookup:** that kind of request (orders, payments or disputes) is refused until a restart; the others keep working. Usually the sandbox app is missing that feature.
- **404, other errors, timeouts (10 s), answers over 1 MB:** a fixed sentence and PayPal's `debug_id` when there is one. PayPal's own error text is never passed on.

## What it never does

- Follow text written inside a request. It is matched against fixed patterns and never run or obeyed.
- Use an address, card or account written in a request as the refund destination.
- Send a reply, store a request, or move money. In step 3 a refund becomes possible, and then only on the original sandbox payment, after a person confirms.
- Call any PayPal host other than the sandbox, or keep a key anywhere but the key file.

## Checks

```bash
npm run typecheck
npm test
npm run check:words   # wording rules for the public text
npm run check:public  # nothing private in the repo
```

`check:public` fails on env or key files, private key blocks, PayPal tokens or client secrets, and any email address other than support@elghaly.dev and the reserved example domains. Private words (names, places) can be added through a `PUBLIC_SAFETY_TERMS` repository secret or an untracked `.public-safety.local` file, one per line, so they never appear in the repo. Hits print as file and line, never the matched text. CI runs all four on every pull request.

## Where the parts come from

- `src/refund-check.mjs`, its tests and the policy file come from [mermail-refund-desk](https://github.com/Alarm2024/mermail-refund-desk) (MIT, same owner). One change: a message that no mail scanner looked at is read instead of quarantined; a scan that did not come back clean is still quarantined.
- `src/http.ts` (Host, Origin, Accept, protocol-version and body-size guards for Streamable HTTP) and its tests come from [iris-alexa](https://github.com/elghaly-dev/iris-alexa) (MIT, same owner).

## Contact

support@elghaly.dev

MIT licence. elghaly, LLC
