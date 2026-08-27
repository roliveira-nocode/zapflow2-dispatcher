/**
 * SiteFlow endpoint — POST /api/siteflow/preflight
 *
 * Answers exactly one question, and sends nothing:
 *
 *     "Given this logical template key and this many params, is the
 *      dispatcher configured to send it?"
 *
 * Built for campaign preparation: SiteFlow needs to know a template is
 * dispatchable BEFORE a run starts, and the only way to find that out today
 * is to attempt a real send. This endpoint closes that gap without ever
 * crossing the provider boundary.
 *
 * ZERO-SEND GUARANTEE. Three independent layers, not one:
 *
 *  1. Structural — this module does not import ./umbler.js. It cannot reach
 *     sendTemplateMessage, sendTextMessage or the network, because it never
 *     references them.
 *  2. No token — createSiteflowPreflightHandler() takes NO arguments. Unlike
 *     the other three SiteFlow factories it is never handed the Umbler API
 *     token, so it cannot leak what it does not have and could not
 *     authenticate to the provider even if it tried.
 *  3. By construction — the Slice 4 metadata is only ever spread from the
 *     frozen NOT_ATTEMPTED_* constants, so `provider_attempted: true` is
 *     unrepresentable here.
 *
 * DRY_RUN is deliberately ignored. The dispatch route lets DRY_RUN skip the
 * provider-ID check; preflight must not, or it would report `ready: true`
 * for a template that cannot actually be sent. Preflight always answers
 * "can a REAL send be made".
 *
 * What preflight does NOT check, by design: recipient consent (that belongs
 * to SiteFlow), the CONTENT of the params, the phone number, or any campaign
 * execution state. It creates nothing and mutates nothing — calling it twice
 * is identical to calling it once.
 *
 * On the static path, a caller selects a LOGICAL key only — a raw provider
 * template ID is never accepted there. The dynamic campaign-template path
 * (`provider_template_id` present, see validateDynamicSiteflowPreflightRequest
 * below and ./siteflow-template-id.ts) is the one exception: SiteFlow's
 * server sends the already-resolved provider ID directly, over the same
 * authenticated server-to-server secret as this whole endpoint — never the
 * browser or an LLM. Either way, a provider template ID never appears in a
 * response.
 */
import { type Request, type Response } from "express";

import {
  NOT_ATTEMPTED_CONFIGURATION,
  NOT_ATTEMPTED_OK,
  NOT_ATTEMPTED_PRE_PROVIDER_ERROR,
  NOT_ATTEMPTED_VALIDATION,
  type DispatchFailureMeta,
} from "./dispatch-outcome.js";
import {
  isSiteflowTemplateKey,
  SITEFLOW_TEMPLATES,
  type SiteflowTemplateKey,
  type SiteflowTemplateSpec,
} from "./siteflow.js";
import { validateProviderTemplateId, validateTemplateIdentity } from "./siteflow-template-id.js";

/**
 * Stable, machine-readable failure codes. SiteFlow branches on these, so they
 * are part of the contract: never renamed, never repurposed.
 */
export const PREFLIGHT_CODES = Object.freeze({
  /** SITEFLOW_DISPATCH_SECRET is unset on the server. */
  DISPATCH_NOT_CONFIGURED: "DISPATCH_NOT_CONFIGURED",
  /** Missing or wrong x-siteflow-dispatch-secret header. */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** Body shape is wrong: not an object, or a missing/ill-typed field. */
  INVALID_REQUEST: "INVALID_REQUEST",
  /** `template` is not a key of the closed SITEFLOW_TEMPLATES registry. */
  UNKNOWN_TEMPLATE: "UNKNOWN_TEMPLATE",
  /** `params_count` does not match that template's registered arity. */
  PARAMS_COUNT_MISMATCH: "PARAMS_COUNT_MISMATCH",
  /** The template exists but its provider-ID env var is unset. */
  TEMPLATE_NOT_CONFIGURED: "TEMPLATE_NOT_CONFIGURED",
  /**
   * Dynamic path only: `provider_template_id` is missing, blank, or fails
   * the shared strict validator (see ./siteflow-template-id.ts). The same
   * fixtures rejected here are rejected by the real dispatch route.
   */
  INVALID_PROVIDER_TEMPLATE_ID: "INVALID_PROVIDER_TEMPLATE_ID",
  /** Unexpected dispatcher exception. Sanitized. */
  UNEXPECTED_ERROR: "UNEXPECTED_ERROR",
} as const);

export type PreflightCode = (typeof PREFLIGHT_CODES)[keyof typeof PREFLIGHT_CODES];

export interface SiteflowPreflightRequest {
  /**
   * Logical key into SITEFLOW_TEMPLATES (static path), or a safe
   * slug/token logical/internal identity (dynamic path, see
   * `provider_template_id` below — it is interpolated into a server log
   * line, so its shape is restricted). Never a raw provider template ID
   * either way.
   */
  template: string;
  /**
   * How many params the caller intends to send. The COUNT only — preflight
   * deliberately does not accept the params themselves: it has no use for
   * visitor names, personalized copy or links, and accepting them would
   * suggest it validated their content. It did not. Static path only — the
   * dynamic path has no registered arity to compare it against.
   */
  params_count: number;
  /**
   * Dynamic campaign-template path (optional). Its presence switches this
   * request onto the dynamic path — same rule as
   * POST /api/siteflow/dispatch. Validated with the SAME shared validator.
   */
  provider_template_id?: string;
  /** Required, and must be an explicit boolean, whenever provider_template_id is present. */
  requires_consent?: boolean;
}

/** A resolved, dispatchable-so-far static request: the key exists and the arity matches. */
export interface PreflightResolvedStatic {
  kind: "static";
  templateKey: SiteflowTemplateKey;
  spec: SiteflowTemplateSpec;
  expectedParams: number;
}

/** A resolved, well-formed dynamic request — shape only, nothing to configure. */
export interface PreflightResolvedDynamic {
  kind: "dynamic";
  templateIdentity: string;
  providerTemplateId: string;
  requiresConsent: boolean;
}

export type PreflightResolved = PreflightResolvedStatic | PreflightResolvedDynamic;

/** A rejection carrying its stable code and a sanitized message. */
export interface PreflightFailure {
  code: PreflightCode;
  error: string;
  /** Present only once the logical key resolved. */
  template?: SiteflowTemplateKey;
  /** Present only once the logical key resolved — the authoritative arity. */
  expected_params?: number;
}

/**
 * Validate the body and resolve the template. Pure: reads no environment, no
 * request headers, and has no side effects — steps 3 to 5 of the endpoint.
 *
 * Returns a PreflightFailure, or the resolved request. Discriminate with
 * `"code" in result`.
 */
export function validateSiteflowPreflightRequest(
  data: unknown,
): PreflightFailure | PreflightResolved {
  if (typeof data !== "object" || data === null) {
    return { code: PREFLIGHT_CODES.INVALID_REQUEST, error: "Body must be a JSON object." };
  }

  const payload = data as {
    template?: unknown;
    params_count?: unknown;
    provider_template_id?: unknown;
    requires_consent?: unknown;
  };

  // Dynamic campaign-template path: same branch condition as the real
  // dispatch route, checked first so its own template-identity validation
  // (a safe slug/token, not just non-empty text) applies uniformly instead
  // of the generic check below. Has no registered arity to check
  // params_count against, so — unlike the static path below — it never
  // reads that field.
  if (payload.provider_template_id !== undefined) {
    return validateDynamicSiteflowPreflightRequest(payload);
  }

  if (typeof payload.template !== "string" || payload.template.trim() === "") {
    return { code: PREFLIGHT_CODES.INVALID_REQUEST, error: "template is required." };
  }

  // Rejects NaN and Infinity too: Number.isInteger is false for both.
  if (
    typeof payload.params_count !== "number" ||
    !Number.isInteger(payload.params_count) ||
    payload.params_count < 0
  ) {
    return {
      code: PREFLIGHT_CODES.INVALID_REQUEST,
      error: "params_count must be a non-negative integer.",
    };
  }

  // Closed set: an unrecognized key is rejected outright. A raw provider
  // template ID can never resolve here — it is simply not a key.
  if (!isSiteflowTemplateKey(payload.template)) {
    return {
      code: PREFLIGHT_CODES.UNKNOWN_TEMPLATE,
      error: "template is not one of the known SiteFlow templates.",
    };
  }

  const templateKey: SiteflowTemplateKey = payload.template;
  const spec: SiteflowTemplateSpec = SITEFLOW_TEMPLATES[templateKey];
  const expectedParams = spec.paramOrder.length;

  if (payload.params_count !== expectedParams) {
    return {
      code: PREFLIGHT_CODES.PARAMS_COUNT_MISMATCH,
      // Same wording as the dispatch route, so both endpoints speak one language.
      error: `params must have exactly ${expectedParams} value(s) for template "${spec.logicalName}".`,
      template: templateKey,
      expected_params: expectedParams,
    };
  }

  return { kind: "static", templateKey, spec, expectedParams };
}

/**
 * Validate the dynamic campaign-template path: `provider_template_id` is
 * present. `templateIdentity` has already been confirmed non-empty by the
 * caller. Order matches the real dispatch route: requires_consent boolean,
 * then the provider ID via the SAME shared validator — so the identical set
 * of malformed fixtures is rejected by both routes.
 */
function validateDynamicSiteflowPreflightRequest(payload: {
  template?: unknown;
  requires_consent?: unknown;
  provider_template_id?: unknown;
}): PreflightFailure | PreflightResolvedDynamic {
  // Same shared validator as the real dispatch route — a safe slug/token,
  // not just non-empty text — so the accepted shape cannot diverge.
  const templateIdentityError = validateTemplateIdentity(payload.template);
  if (templateIdentityError) {
    return { code: PREFLIGHT_CODES.INVALID_REQUEST, error: templateIdentityError };
  }
  const templateIdentity = payload.template as string;

  if (typeof payload.requires_consent !== "boolean") {
    return {
      code: PREFLIGHT_CODES.INVALID_REQUEST,
      error: "requires_consent must be a boolean.",
    };
  }

  const providerTemplateIdError = validateProviderTemplateId(payload.provider_template_id);
  if (providerTemplateIdError) {
    return {
      code: PREFLIGHT_CODES.INVALID_PROVIDER_TEMPLATE_ID,
      error: providerTemplateIdError,
    };
  }

  return {
    kind: "dynamic",
    templateIdentity,
    providerTemplateId: payload.provider_template_id as string,
    requiresConsent: payload.requires_consent,
  };
}

/**
 * Write one failure response. `meta` is always one of the NOT_ATTEMPTED_*
 * constants, which is what keeps `provider_attempted: false` true on every
 * path without the caller of this helper having to remember it.
 */
function respondFailure(
  res: Response,
  status: number,
  failure: PreflightFailure,
  meta: DispatchFailureMeta,
): void {
  const body: Record<string, unknown> = {
    success: false,
    ready: false,
    code: failure.code,
    error: failure.error,
  };
  if (failure.template !== undefined) {
    body.template = failure.template;
  }
  if (failure.expected_params !== undefined) {
    body.expected_params = failure.expected_params;
  }
  Object.assign(body, meta);
  res.status(status).json(body);
}

/**
 * Build the Express handler.
 *
 * Takes NO arguments on purpose — see the zero-send guarantee at the top of
 * this file. The Umbler token is never passed in because it is never needed.
 */
export function createSiteflowPreflightHandler() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      // 1. The route is only available once the SiteFlow secret is configured
      //    — same secret and same fail-closed behaviour as the other routes.
      const siteflowSecret = process.env.SITEFLOW_DISPATCH_SECRET;
      if (!siteflowSecret || siteflowSecret.trim() === "") {
        respondFailure(
          res,
          503,
          {
            code: PREFLIGHT_CODES.DISPATCH_NOT_CONFIGURED,
            error: "SiteFlow dispatch is not configured.",
          },
          NOT_ATTEMPTED_CONFIGURATION,
        );
        return;
      }

      // 2. Require the shared secret header. Never leak the expected value.
      const provided = req.header("x-siteflow-dispatch-secret");
      if (!provided || provided !== siteflowSecret) {
        respondFailure(
          res,
          401,
          { code: PREFLIGHT_CODES.UNAUTHORIZED, error: "Unauthorized." },
          NOT_ATTEMPTED_VALIDATION,
        );
        return;
      }

      // 3-5. Body shape, known logical template, params arity.
      const validated = validateSiteflowPreflightRequest(req.body);
      if ("code" in validated) {
        respondFailure(res, 400, validated, NOT_ATTEMPTED_VALIDATION);
        return;
      }

      if (validated.kind === "dynamic") {
        // 6-7. Dynamic path: nothing left to configure server-side — the
        // provider ID came from this request and already passed the shared
        // strict validator. Ready as soon as the shape validates. No
        // expected_params: a dynamic template has no registered arity.
        res.json({
          success: true,
          ready: true,
          template: validated.templateIdentity,
          ...NOT_ATTEMPTED_OK,
        });
        return;
      }

      const { templateKey, spec, expectedParams } = validated;

      // 6. THIS template's provider ID must be configured. DRY_RUN does NOT
      //    bypass this check — reporting `ready` for a template that cannot
      //    actually be sent would defeat the whole point of preflighting.
      //    The ID itself is only tested for presence: it is never logged,
      //    never returned, and never leaves this scope.
      const templateId = process.env[spec.envVar];
      if (!templateId || templateId.trim() === "") {
        respondFailure(
          res,
          503,
          {
            code: PREFLIGHT_CODES.TEMPLATE_NOT_CONFIGURED,
            error: `SiteFlow template "${spec.logicalName}" is not configured.`,
            template: templateKey,
            expected_params: expectedParams,
          },
          NOT_ATTEMPTED_CONFIGURATION,
        );
        return;
      }

      // 7. Ready. `success` and `ready` are always equal — `success` keeps the
      //    repo-wide envelope, `ready` is the answer SiteFlow acts on.
      res.json({
        success: true,
        ready: true,
        template: templateKey,
        expected_params: expectedParams,
        ...NOT_ATTEMPTED_OK,
      });
    } catch (unexpected: unknown) {
      // Sanitized like every other SiteFlow route: the raw message may embed
      // request/host details, so it is logged server-side and never returned.
      console.error("SiteFlow preflight: unexpected error.", unexpected);
      if (res.headersSent) {
        return;
      }
      respondFailure(
        res,
        500,
        { code: PREFLIGHT_CODES.UNEXPECTED_ERROR, error: "Unexpected dispatcher error." },
        NOT_ATTEMPTED_PRE_PROVIDER_ERROR,
      );
    }
  };
}
