export type PaypalErrorKind =
  | "not_configured"
  | "credential_file"
  | "credential_file_mode"
  | "credential_rejected"
  | "forbidden"
  | "not_found"
  | "bad_id"
  | "bad_host"
  | "http"
  | "timeout"
  | "too_large"
  | "bad_response";

/** One fixed sentence per kind. Nothing from PayPal's body or from a file is ever echoed. */
export const PAYPAL_ERROR_TEXT: Record<PaypalErrorKind, string> = {
  not_configured:
    "PayPal sandbox keys are not set up on this server. check_refund still works; the README, step 2, shows the setup.",
  credential_file: "The sandbox key file could not be used. It needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET lines.",
  credential_file_mode: "The sandbox key file can be read by other users. Run chmod 600 on it; the next request reads it again.",
  credential_rejected:
    "PayPal rejected the sandbox credential. Replace the key file with a working sandbox key, then restart the server.",
  forbidden: "PayPal refused this kind of request for this sandbox app. Check the app's features in the PayPal developer dashboard.",
  not_found: "PayPal has no sandbox record with that id.",
  bad_id: "That id is not a PayPal id. Ids are letters, digits and dashes.",
  bad_host: "Refused: requests go to the PayPal sandbox and nowhere else.",
  http: "PayPal answered with an error. Nothing was changed.",
  timeout: "PayPal did not answer in time. Nothing was changed.",
  too_large: "PayPal's answer was larger than this desk accepts.",
  bad_response: "PayPal's answer could not be read.",
};

export class PaypalError extends Error {
  readonly kind: PaypalErrorKind;
  readonly status?: number;
  /** PayPal's debug_id, safe to show; it helps PayPal support find the call. */
  readonly debugId?: string;
  readonly fingerprint?: string;

  constructor(kind: PaypalErrorKind, details: { status?: number; debugId?: string; fingerprint?: string } = {}) {
    super(PAYPAL_ERROR_TEXT[kind]);
    this.name = "PaypalError";
    this.kind = kind;
    this.status = details.status;
    this.debugId = details.debugId;
    this.fingerprint = details.fingerprint;
  }
}
