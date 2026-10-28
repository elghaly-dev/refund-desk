/**
 * PayPal answers are cut down to what the refund check needs. Names, postal addresses,
 * phone numbers and links are dropped on purpose: the agent never sees them.
 */

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface Money {
  value: string;
  currency: string;
}

function money(value: unknown): Money | undefined {
  const m = obj(value);
  const amount = text(m.value);
  const currency = text(m.currency_code);
  return amount && currency ? { value: amount, currency } : undefined;
}

const REFUNDED = new Set(["REFUNDED", "PARTIALLY_REFUNDED"]);

export interface CaptureSummary {
  capture_id: string;
  status: string;
  amount?: Money;
  created?: string;
  order_id?: string;
  refunded: boolean;
}

export function summarizeCapture(raw: unknown): CaptureSummary {
  const c = obj(raw);
  const status = text(c.status) ?? "UNKNOWN";
  return {
    capture_id: text(c.id) ?? "",
    status,
    amount: money(c.amount),
    created: text(c.create_time),
    order_id: text(obj(obj(c.supplementary_data).related_ids).order_id),
    refunded: REFUNDED.has(status),
  };
}

export interface OrderSummary {
  order_id: string;
  status: string;
  created?: string;
  buyer_email?: string;
  payer_id?: string;
  amount?: Money;
  captures: CaptureSummary[];
  refunded: boolean;
  /** Ready to pass to check_refund as one of its `purchases`. */
  purchase: { order: string; buyer_email?: string; paid_from?: string; date?: string; refunded: boolean };
}

export function summarizeOrder(raw: unknown): OrderSummary {
  const o = obj(raw);
  const payer = obj(o.payer);
  const buyerEmail = text(payer.email_address) ?? text(obj(obj(o.payment_source).paypal).email_address);
  const payerId = text(payer.payer_id) ?? text(obj(obj(o.payment_source).paypal).account_id);
  const units = list(o.purchase_units).map(obj);
  const captures = units.flatMap((unit) => list(obj(unit.payments).captures).map(summarizeCapture));
  const refunds = units.flatMap((unit) => list(obj(unit.payments).refunds));
  const refunded = captures.some((capture) => capture.refunded) || refunds.length > 0;
  const orderId = text(o.id) ?? "";
  const created = text(o.create_time);
  return {
    order_id: orderId,
    status: text(o.status) ?? "UNKNOWN",
    created,
    buyer_email: buyerEmail,
    payer_id: payerId,
    amount: units.length === 1 ? money(units[0].amount) : undefined,
    captures,
    refunded,
    purchase: { order: orderId, buyer_email: buyerEmail, paid_from: payerId, date: created, refunded },
  };
}

export interface DisputeSummary {
  dispute_id: string;
  status: string;
  reason?: string;
  stage?: string;
  amount?: Money;
  created?: string;
  seller_transaction_ids: string[];
}

export function summarizeDisputes(raw: unknown): { disputes: DisputeSummary[]; more: boolean } {
  const page = obj(raw);
  const disputes = list(page.items).map((item) => {
    const d = obj(item);
    return {
      dispute_id: text(d.dispute_id) ?? "",
      status: text(d.status) ?? "UNKNOWN",
      reason: text(d.reason),
      stage: text(d.dispute_life_cycle_stage),
      amount: money(d.dispute_amount),
      created: text(d.create_time),
      seller_transaction_ids: list(d.disputed_transactions)
        .map((t) => text(obj(t).seller_transaction_id))
        .filter((id): id is string => Boolean(id)),
    };
  });
  const more = list(page.links).some((link) => text(obj(link).rel) === "next");
  return { disputes, more };
}
