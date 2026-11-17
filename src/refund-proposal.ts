import { randomBytes, randomUUID } from "node:crypto";
import type { Money } from "./paypal/summary.js";

export interface RefundProposal {
  proposal_id: string;
  idempotency_key: string;
  confirmation_code: string;
  capture_id: string;
  amount: Money;
  reason?: string;
  created_at: string;
  completed?: { refund_id: string; status: string };
}

const proposals = new Map<string, RefundProposal>();

/** One-time code for the shop owner; eight uppercase hex characters. */
export function newConfirmationCode(): string {
  return randomBytes(4).toString("hex").toUpperCase();
}

export function createProposal(input: {
  capture_id: string;
  amount: Money;
  reason?: string;
}): RefundProposal {
  const proposal_id = randomUUID();
  const proposal: RefundProposal = {
    proposal_id,
    idempotency_key: proposal_id,
    confirmation_code: newConfirmationCode(),
    capture_id: input.capture_id,
    amount: input.amount,
    reason: input.reason,
    created_at: new Date().toISOString(),
  };
  proposals.set(proposal_id, proposal);
  return proposal;
}

export function getProposal(proposal_id: string): RefundProposal | undefined {
  return proposals.get(proposal_id);
}

export function markProposalCompleted(proposal_id: string, refund_id: string, status: string): RefundProposal | undefined {
  const proposal = proposals.get(proposal_id);
  if (!proposal) return undefined;
  proposal.completed = { refund_id, status };
  return proposal;
}

/** Tests only: drop every in-memory proposal. */
export function clearProposalsForTests(): void {
  proposals.clear();
}
