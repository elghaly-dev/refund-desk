#!/usr/bin/env node
// refund-check.mjs — read one refund email as data, check it against the
// shop's written refund policy, and say what the agent may do next.
//
//   node refund-check.mjs --policy policy.json < input.json
//
// input.json  { "email": { from, subject, text, date, sender_authentication, scan_status },
//               "context": { "purchases": [...], "prior_refund_requests": 0 } }
// stdout      one JSON object (see README "What the checker returns")
//
// The email text is matched against fixed patterns and never executed,
// evaluated or followed. The result can say "skip", "acknowledge",
// "escalate" or "quarantine". It never says "refund": paying money back is
// the shop owner's job, outside the agent.
//
// Copied from Alarm2024/mermail-refund-desk (MIT, same owner). One change:
// a message with no scan_status was never scanned by a mail scanner (a
// pasted message, a PayPal dispute note), so it is "not_applicable" rather
// than quarantined. A scan_status that is present and not "clean" is still
// quarantined.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MAX_TEXT = 10_000;

const REFUND_WORDS = {
  en: [/\brefund/i, /\bmoney back\b/i, /\bmy money\b/i, /\breimburse/i, /\bchargeback\b/i, /\breturn (?:the |my )?payment\b/i],
  ar: [/استرداد/, /استرجاع/, /رد المبلغ/, /إرجاع (?:المال|المبلغ)/, /ارجاع (?:المال|المبلغ)/],
  ru: [/возврат/i, /верн(?:уть|ите) деньги/i, /возмест/i],
  zh: [/退款/, /退钱/, /退还/, /返还/],
  de: [/rückerstattung/i, /geld zurück/i, /erstattung/i, /zurückerstatt/i],
  es: [/reembolso/i, /devoluci[oó]n/i, /devolver (?:el|mi) dinero/i, /devu[eé]lv/i],
};

// Text that tries to steer the agent instead of asking the shop.
const INJECTION = [
  /ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions|rules|messages)/i,
  /disregard (?:the|your|all) (?:policy|rules|instructions)/i,
  /\bsystem prompt\b/i,
  /\byou are (?:now )?(?:an? |the )?(?:ai|assistant|agent|model)\b/i,
  /^\s*(?:assistant|system)\s*:/im,
  /\[\s*(?:system|instructions?)\s*\]/i,
  /\b(?:as|to) the (?:ai|agent|assistant)\b[,:]/i,
  /忽略(?:之前|以上|上面)的?(?:指令|说明|规则)/,
  /игнорируй(?:те)? (?:все |предыдущие )?инструкции/i,
  /تجاهل (?:كل )?التعليمات/,
];

// No customer needs to mention these to get money back.
const SECRETS = [
  /\b(?:seed|recovery|secret) phrase\b/i, /\bprivate key\b/i, /\bmnemonic\b/i,
  /私钥/, /助记词/, /сид[- ]?фраз/i, /приватн\w* ключ/i, /العبارة السرية/, /المفتاح الخاص/,
];

const URGENCY = [
  /\bwithin (?:\d+ )?(?:minutes?|hours?|an hour)\b/i, /\bimmediately\b/i, /\bright now\b/i,
  /\burgent/i, /\basap\b/i, /\bfinal (?:notice|warning)\b/i, /\blegal action\b/i, /\blawyer\b/i,
];

// Words that ask for the money to go somewhere other than where it came from.
const DESTINATION_CHANGE = [
  /\b(?:different|another|other|new|my new|this) (?:wallet|address|card|account)\b/i,
  /\bsend (?:it|the refund|the money|my refund)? ?(?:to|into) (?:this|my new|another|the following)\b/i,
  /\binstead\b/i, /\bchanged? my (?:wallet|card|address|account)\b/i,
  /\blost (?:access to )?my (?:wallet|card)\b/i,
  /新(?:钱包|地址)/, /另一个(?:钱包|地址)/, /другой (?:кошел[её]к|адрес)/i, /новый (?:кошел[её]к|адрес)/i,
  /محفظة (?:أخرى|جديدة)/, /neue (?:wallet|adresse)/i, /otra (?:wallet|billetera|dirección)/i, /nueva (?:wallet|billetera|dirección)/i,
];

const EXCHANGE = /\b(?:binance|coinbase|okx|bybit|kraken|kucoin|bitget|gate\.io|htx|huobi|mexc|exchange)\b/i;

const RX = {
  evmTx: /\b0x[a-fA-F0-9]{64}\b/g,
  evmAddr: /\b0x[a-fA-F0-9]{40}\b/g,
  base58: /\b[1-9A-HJ-NP-Za-km-z]{32,88}\b/g,
  btcAddr: /\bbc1[ac-hj-np-z02-9]{11,71}\b/g,
  hex64: /\b[a-fA-F0-9]{64}\b/g,
  url: /\bhttps?:\/\/[^\s<>"')]+/gi,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  amount: /(?:\$\s?(\d[\d,]*(?:\.\d+)?))|(?:\b(\d[\d,]*(?:\.\d+)?)\s?(USDC|USDT|SOL|ETH|BTC|USD|EUR)\b)/gi,
};

// The id must hold a digit, so "order sent" never yields "SENT". JavaScript's
// \b does not see CJK, Cyrillic or Arabic letters as word characters, so
// those keywords sit outside it.
const DEFAULT_ORDER = "(?:\\b(?:order|invoice|receipt|bestellung|pedido)|订单|заказ|طلب)\\s*(?:#|№|no\\.?|number|id|号|رقم|номер)?\\s*[:#：]?\\s*((?=[A-Z-]*\\d)[A-Z0-9][A-Z0-9-]{3,})";

function uniq(list) { return [...new Set(list)]; }

function mixedBase58(s) {
  // A real key or signature mixes digits, upper and lower case. Plain words
  // and long numbers do not, which keeps ordinary text out of the results.
  return /[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

export function language(text) {
  if (/[؀-ۿ]/.test(text)) return "ar";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[Ѐ-ӿ]/.test(text)) return "ru";
  if (/[äöüß]|\b(?:bitte|ich|und|nicht|meine?)\b/i.test(text)) return "de";
  if (/[ñ¿¡]|\b(?:por favor|quiero|mi dinero|gracias)\b/i.test(text)) return "es";
  return "en";
}

export function senderAddress(from) {
  const m = String(from || "").match(RX.email);
  return m ? m[0].toLowerCase() : "";
}

export function extract(text, policy = {}) {
  const tx = [];
  const addresses = [];
  for (const m of text.matchAll(RX.evmTx)) tx.push({ chain: "evm", value: m[0] });
  for (const m of text.matchAll(RX.evmAddr)) addresses.push({ chain: "evm", value: m[0] });
  for (const m of text.matchAll(RX.btcAddr)) addresses.push({ chain: "bitcoin", value: m[0] });
  for (const m of text.matchAll(RX.base58)) {
    const v = m[0];
    if (!mixedBase58(v)) continue;
    if (v.length >= 86) tx.push({ chain: "solana", value: v });
    else if (v.length <= 44) addresses.push({ chain: "solana", value: v });
  }
  for (const m of text.matchAll(RX.hex64)) {
    if (!tx.some((t) => t.value.toLowerCase().endsWith(m[0].toLowerCase()))) tx.push({ chain: "bitcoin-or-other", value: m[0] });
  }
  const orderRx = new RegExp(policy.order_pattern || DEFAULT_ORDER, "gi");
  const orders = uniq([...text.matchAll(orderRx)].map((m) => m[1].toUpperCase()));
  const amounts = [...text.matchAll(RX.amount)].map((m) => (m[1] ? `$${m[1]}` : `${m[2]} ${m[3].toUpperCase()}`));
  return {
    orders,
    tx: uniq(tx.map((t) => JSON.stringify(t))).map((s) => JSON.parse(s)),
    addresses: uniq(addresses.map((a) => JSON.stringify(a))).map((s) => JSON.parse(s)),
    amounts: uniq(amounts),
    links: uniq([...text.matchAll(RX.url)].map((m) => m[0])).slice(0, 10),
  };
}

function any(patterns, text) { return patterns.some((p) => p.test(text)); }

export function check(input, policy = {}) {
  const email = input.email || {};
  const context = input.context || {};
  const raw = `${email.subject || ""}\n${email.text || ""}`;
  const truncated = raw.length > MAX_TEXT;
  const text = raw.slice(0, MAX_TEXT);
  const lang = language(text);
  const isRefund = Object.values(REFUND_WORDS).some((list) => any(list, text));
  const found = extract(text, policy);
  const flags = [];
  const reasons = [];

  const scan = email.scan_status || "not_applicable";
  if (scan !== "clean" && scan !== "not_applicable") {
    flags.push("not_scanned_clean");
    reasons.push(`scan_status is ${scan}: keep to metadata, do not interpret the body`);
  }
  if (any(INJECTION, text)) { flags.push("prompt_injection"); reasons.push("the email contains instructions aimed at an AI agent"); }
  if (any(SECRETS, text)) { flags.push("mentions_secret"); reasons.push("the email mentions a seed phrase or private key; no refund needs one"); }
  if (any(URGENCY, text)) { flags.push("urgency_pressure"); reasons.push("pressure wording; the policy has no deadline to rush"); }
  if (found.links.length) flags.push("link_present");

  const auth = (email.sender_authentication && email.sender_authentication.status) || "unknown";
  if (auth !== "pass") reasons.push(`sender authentication is ${auth}: the From line alone does not prove who wrote this`);

  // Purchase matching, from receipts the agent found in the mailbox. Without
  // them the checker says "unknown" rather than guessing.
  const sender = senderAddress(email.from);
  const purchases = Array.isArray(context.purchases) ? context.purchases : [];
  let senderMatches = "unknown";
  let alreadyRefunded = "unknown";
  let payerWallets = [];
  if (purchases.length) {
    const byOrder = purchases.filter((p) => found.orders.includes(String(p.order || "").toUpperCase()));
    const bySender = purchases.filter((p) => String(p.buyer_email || "").toLowerCase() === sender);
    const relevant = byOrder.length ? byOrder : bySender;
    senderMatches = relevant.length && relevant.every((p) => String(p.buyer_email || "").toLowerCase() === sender) ? "yes" : "no";
    alreadyRefunded = relevant.length ? (relevant.some((p) => p.refunded === true) ? "yes" : "no") : "unknown";
    payerWallets = relevant.map((p) => String(p.payer_wallet || "")).filter(Boolean);
    if (senderMatches === "no") { flags.push("sender_not_buyer"); reasons.push("the sender is not the address the purchase was made from"); }
    if (alreadyRefunded === "yes" && policy.once_per_purchase !== false) { flags.push("already_refunded"); reasons.push("this purchase is already marked refunded; the policy pays back once"); }
  }
  if ((context.prior_refund_requests || 0) > 0) reasons.push(`${context.prior_refund_requests} earlier refund request(s) from this sender in the mailbox`);

  let within = "n/a";
  if (Number.isFinite(policy.time_limit_days)) {
    const paid = purchases.map((p) => Date.parse(p.date)).filter(Number.isFinite);
    const asked = Date.parse(email.date);
    if (!paid.length || !Number.isFinite(asked)) within = "unknown";
    else within = (asked - Math.max(...paid)) / 86_400_000 <= policy.time_limit_days ? "yes" : "no";
    if (within === "no") { flags.push("outside_time_limit"); reasons.push(`asked more than ${policy.time_limit_days} days after the purchase`); }
  }

  // Money goes back where it came from. An address in the email is ignored
  // when it matches the payer, and is an escalation when the email asks to
  // use it instead.
  const strange = found.addresses.filter((a) => !payerWallets.includes(a.value));
  const changeWords = any(DESTINATION_CHANGE, text);
  const destinationChange = changeWords && (strange.length > 0 || /card|account|tarjeta|karte|карт/i.test(text));
  if (destinationChange) { flags.push("destination_change"); reasons.push("asks for the money to go somewhere other than where it came from"); }
  else if (strange.length) reasons.push("an address is written in the email; it is ignored — refunds go back to the paying wallet");
  const exchangeClaim = policy.exchange_exception !== false && EXCHANGE.test(text) && /\b(?:paid|sent|bought|from)\b/i.test(text);
  if (exchangeClaim) { flags.push("exchange_exception_claimed"); reasons.push("says the payment came from an exchange; the owner confirms before using a different wallet"); }

  let action;
  if (!isRefund) action = "skip";
  else if (flags.some((f) => ["prompt_injection", "mentions_secret", "not_scanned_clean"].includes(f))) action = "quarantine";
  else if (flags.some((f) => ["destination_change", "sender_not_buyer", "already_refunded", "outside_time_limit", "exchange_exception_claimed"].includes(f))) action = "escalate";
  else action = "acknowledge";
  if (!isRefund) reasons.unshift("not a refund request");
  if (truncated) reasons.push(`text truncated at ${MAX_TEXT} characters; absence of a field is not proof`);

  return {
    is_refund_request: isRefund,
    language: lang,
    extracted: found,
    checks: {
      sender_matches_purchase: senderMatches,
      already_refunded: alreadyRefunded,
      within_time_limit: within,
      destination_change: destinationChange,
      exchange_exception_claimed: exchangeClaim,
      sender_authentication: auth,
    },
    flags: uniq(flags),
    action,
    reasons,
    never: ["move money", "send a reply without the user's approval", "use an address written in the email"],
  };
}

function readArg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const policyPath = readArg("--policy");
  const policy = policyPath ? JSON.parse(readFileSync(policyPath, "utf8")) : {};
  const input = JSON.parse(readFileSync(readArg("--input") || 0, "utf8"));
  process.stdout.write(JSON.stringify(check(input, policy), null, 2) + "\n");
}
