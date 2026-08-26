/**
 * Dispatcher failure metadata — the single source of truth for
 * `provider_attempted` and `failure_stage`.
 *
 * CORE SAFETY INVARIANT
 * ---------------------
 * Only a literal `provider_attempted: false` proves that no provider request
 * was ever initiated. `true`, `null`, `undefined` or an absent field (an older
 * dispatcher deployment) must all be read as "the provider may have been
 * called". The forbidden inference is:
 *
 *     "the dispatcher returned an error"  =>  "the provider was not called"
 *
 * A request timeout, a connection reset after the request started, a provider
 * 5xx, a malformed/HTML body, or any exception raised once the provider call
 * is under way all leave the delivery outcome unprovable. They are reported as
 * attempted, never as a safe non-send.
 *
 * This module is pure: no I/O, no Express, no provider import, nothing to mock.
 */

/**
 * Where a dispatch stopped. Deliberately small — six values, each grounded in
 * a real code path. `status` already carries the exact HTTP code, so this does
 * not restate it.
 */
export type FailureStage =
  /** No failure classified: a success, including a dry-run simulated success. */
  | "none"
  /** Caller-fixable: secret header, payload shape, unknown template, params count, consent, phone. */
  | "request_validation"
  /** Operator-fixable server configuration: a required env var is unset. */
  | "configuration"
  /** Unexpected exception raised before the provider-attempt boundary. */
  | "pre_provider_error"
  /** The provider responded with a definite non-acceptance (HTTP 400-499). */
  | "provider_rejected"
  /** The provider was attempted but the outcome cannot be proven. */
  | "provider_indeterminate";

export interface DispatchFailureMeta {
  /**
   * `false` ONLY when no provider request was initiated — the single value a
   * consumer may treat as a proven non-send. Never set to `false` anywhere at
   * or after the provider-attempt boundary.
   */
  provider_attempted: boolean;
  failure_stage: FailureStage;
}

/** Dry run: validated and simulated, the provider is never called. */
export const NOT_ATTEMPTED_OK: DispatchFailureMeta = Object.freeze({
  provider_attempted: false,
  failure_stage: "none",
});

/** Rejected before the provider: bad secret header, payload, consent or phone. */
export const NOT_ATTEMPTED_VALIDATION: DispatchFailureMeta = Object.freeze({
  provider_attempted: false,
  failure_stage: "request_validation",
});

/** Rejected before the provider: a required server-side env var is unset. */
export const NOT_ATTEMPTED_CONFIGURATION: DispatchFailureMeta = Object.freeze({
  provider_attempted: false,
  failure_stage: "configuration",
});

/** An unexpected exception that provably happened before the provider call. */
export const NOT_ATTEMPTED_PRE_PROVIDER_ERROR: DispatchFailureMeta = Object.freeze({
  provider_attempted: false,
  failure_stage: "pre_provider_error",
});

/** The provider responded and accepted the request. */
export const ATTEMPTED_OK: DispatchFailureMeta = Object.freeze({
  provider_attempted: true,
  failure_stage: "none",
});

/** The provider was attempted; the delivery outcome cannot be proven. */
export const ATTEMPTED_INDETERMINATE: DispatchFailureMeta = Object.freeze({
  provider_attempted: true,
  failure_stage: "provider_indeterminate",
});

/**
 * Classify a provider response that actually came back.
 *
 * A 4xx is a definite rejection by the provider. Anything else that is not
 * `ok` — a 5xx above all, but also any other non-2xx — leaves the outcome
 * unprovable: the provider may have accepted the send and failed to tell us.
 *
 * Never returns `provider_attempted: false`: reaching this function means a
 * response was received, so a request was certainly sent.
 */
export function classifyProviderResponse(ok: boolean, status: number): DispatchFailureMeta {
  if (ok) {
    return ATTEMPTED_OK;
  }
  if (status >= 400 && status <= 499) {
    return { provider_attempted: true, failure_stage: "provider_rejected" };
  }
  return ATTEMPTED_INDETERMINATE;
}

/**
 * Classify a throw raised at or after the provider-attempt boundary.
 *
 * Takes NO argument on purpose. An `AbortError` (timeout), a `TypeError`
 * ("fetch failed" / connection reset) and a `TimeoutError` are all raised
 * after the request may already have reached the provider, so inspecting the
 * error could only ever be used to downgrade the verdict. Refusing the input
 * makes that downgrade unrepresentable.
 */
export function classifyProviderThrow(): DispatchFailureMeta {
  return ATTEMPTED_INDETERMINATE;
}
