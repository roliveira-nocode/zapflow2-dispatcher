/**
 * SiteFlow endpoint — POST /api/siteflow/dispatch
 *
 * Server-to-server entry point that sends ONE approved WhatsApp template.
 * Separate from the campaign dispatcher (/api/dispatch) in every way: its own
 * shared secret, its own payload, its own registry of templates.
 *
 * A CLOSED set of logical templates — SITEFLOW_TEMPLATES below — is the only
 * thing a caller may request via the optional `template` field. Each entry's
 * provider ID is never hardcoded: it is read from that entry's own env var at
 * send time. A caller can never supply a raw provider template ID.
 */
import { type Request, type Response } from "express";

import { maskPhone, normalizePhone } from "./phone.js";
import { sendTemplateMessage, sendTextMessage, type SendTemplateResult } from "./umbler.js";

/**
 * One entry per logical (Meta/Umbler) template this endpoint may send.
 *
 * - `envVar` names the environment variable holding THIS template's provider
 *   ID. Never a shared/default variable — a missing one only disables that
 *   one template, never the others.
 * - `paramOrder` is documentation of the template's declared variables, in
 *   order. The endpoint does not match params by name (the caller already
 *   built them in order); it only validates the COUNT against this length.
 * - `requiresConsent` is false only for the internal notification: it never
 *   goes to the visitor, so there is no visitor consent to require, and none
 *   is synthesized.
 */
export interface SiteflowTemplateSpec {
  logicalName: string;
  envVar: string;
  paramOrder: readonly string[];
  requiresConsent: boolean;
}

export const SITEFLOW_TEMPLATES = {
  continuar_conversa: {
    logicalName: "siteflow_continuar_conversa",
    envVar: "SITEFLOW_TEMPLATE_ID",
    paramOrder: ["visitor_first_name", "client_brand"],
    requiresConsent: true,
  },
  confirmacao_contato: {
    logicalName: "siteflow_confirmacao_contato",
    envVar: "SITEFLOW_TEMPLATE_CONFIRMACAO_CONTATO_ID",
    paramOrder: ["visitor_first_name"],
    requiresConsent: true,
  },
  notificacao_interna: {
    logicalName: "siteflow_nova_solicitacao_interna",
    envVar: "SITEFLOW_TEMPLATE_NOTIFICACAO_INTERNA_ID",
    paramOrder: ["visitor_name", "visitor_phone"],
    requiresConsent: false,
  },
} as const satisfies Record<string, SiteflowTemplateSpec>;

export type SiteflowTemplateKey = keyof typeof SITEFLOW_TEMPLATES;

/**
 * Legacy/default template — used whenever a caller omits `template`
 * entirely. Keeps every caller written before this registry existed working
 * byte-for-byte, with zero contract change.
 */
export const DEFAULT_SITEFLOW_TEMPLATE_KEY: SiteflowTemplateKey = "continuar_conversa";

/** @deprecated kept for callers/logs referencing the old single-template name. */
export const SITEFLOW_TEMPLATE_NAME = SITEFLOW_TEMPLATES[DEFAULT_SITEFLOW_TEMPLATE_KEY].logicalName;

function isSiteflowTemplateKey(value: unknown): value is SiteflowTemplateKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SITEFLOW_TEMPLATES, value);
}

interface SiteflowConsent {
  granted: boolean;
  granted_at: string;
  source: string;
}

interface SiteflowDispatchRequest {
  client_id: string;
  // Required only when `template` is omitted (legacy path) — it feeds the
  // second positional param of siteflow_continuar_conversa.
  client_brand?: string;
  conversation_id: string;
  lead_id: string;
  // Always required: also used as the Umbler contact display name, for every
  // template, unchanged from the original behaviour.
  visitor_first_name: string;
  phone: string;
  // Required unless the resolved template has requiresConsent === false.
  consent?: SiteflowConsent;
  // Logical key into SITEFLOW_TEMPLATES. Omitted = DEFAULT_SITEFLOW_TEMPLATE_KEY.
  template?: string;
  // Required when `template` is present: the template's params, already in
  // order. Ignored when `template` is omitted (legacy params are computed
  // internally, see below) — a caller cannot use `params` to bypass the
  // legacy param computation.
  params?: string[];
}

interface ValidatedSiteflowRequest {
  payload: SiteflowDispatchRequest;
  templateKey: SiteflowTemplateKey;
  spec: SiteflowTemplateSpec;
  params: string[];
}

/**
 * Validate an incoming SiteFlow payload and resolve which template it
 * targets. Returns an error message string, or the validated+resolved
 * request. Consent VALUE (granted === true) is checked by the caller, not
 * here — this only checks shape/presence, exactly like before.
 */
export function validateSiteflowRequest(data: unknown): string | ValidatedSiteflowRequest {
  if (typeof data !== "object" || data === null) {
    return "Body must be a JSON object.";
  }

  const payload = data as Partial<SiteflowDispatchRequest>;

  for (const field of ["client_id", "conversation_id", "lead_id", "visitor_first_name", "phone"] as const) {
    const value = payload[field];
    if (typeof value !== "string" || value.trim() === "") {
      return `${field} is required.`;
    }
  }

  // Closed set: an unrecognized `template` is rejected outright, never
  // forwarded to the provider as a raw ID.
  let templateKey: SiteflowTemplateKey = DEFAULT_SITEFLOW_TEMPLATE_KEY;
  if (payload.template !== undefined) {
    if (!isSiteflowTemplateKey(payload.template)) {
      return "template is not one of the known SiteFlow templates.";
    }
    templateKey = payload.template;
  }
  const spec = SITEFLOW_TEMPLATES[templateKey];

  let params: string[];
  if (payload.template === undefined) {
    // Legacy path — byte-for-byte the original contract: client_brand is
    // required, and params are computed from the two fixed fields, never
    // from a caller-supplied `params`.
    if (typeof payload.client_brand !== "string" || payload.client_brand.trim() === "") {
      return "client_brand is required.";
    }
    params = [payload.visitor_first_name as string, payload.client_brand];
  } else {
    if (!Array.isArray(payload.params) || payload.params.some((p) => typeof p !== "string" || p.trim() === "")) {
      return "params is required and must be a non-empty array of non-empty strings.";
    }
    if (payload.params.length !== spec.paramOrder.length) {
      return `params must have exactly ${spec.paramOrder.length} value(s) for template "${spec.logicalName}".`;
    }
    params = payload.params;
  }

  if (spec.requiresConsent) {
    const consent = payload.consent;
    if (typeof consent !== "object" || consent === null) {
      return "consent is required.";
    }
    if (typeof consent.granted !== "boolean") {
      return "consent.granted must be a boolean.";
    }
    if (typeof consent.granted_at !== "string" || Number.isNaN(Date.parse(consent.granted_at))) {
      return "consent.granted_at must be an ISO-8601 date string.";
    }
    if (typeof consent.source !== "string" || consent.source.trim() === "") {
      return "consent.source is required.";
    }
  }
  // requiresConsent === false: consent is never required, and none is
  // synthesized — payload.consent, if present, is simply ignored.

  return { payload: payload as SiteflowDispatchRequest, templateKey, spec, params };
}

/**
 * Build the Express handler. The Umbler token is injected (already validated at
 * startup) so this module never reads it itself and never logs it.
 */
export function createSiteflowDispatchHandler(apiToken: string) {
  return async (req: Request, res: Response): Promise<void> => {
    // 1. The route is only available once its own secret is configured. Kept
    //    out of the startup checks so a missing value cannot stop the server
    //    (and /api/dispatch) from booting.
    const siteflowSecret = process.env.SITEFLOW_DISPATCH_SECRET;
    if (!siteflowSecret || siteflowSecret.trim() === "") {
      res.status(503).json({ success: false, error: "SiteFlow dispatch is not configured." });
      return;
    }

    // 2. Require the shared secret header. Never leak the expected value.
    const provided = req.header("x-siteflow-dispatch-secret");
    if (!provided || provided !== siteflowSecret) {
      res.status(401).json({ success: false, error: "Unauthorized." });
      return;
    }

    // 3. Payload shape + template resolution.
    const validated = validateSiteflowRequest(req.body);
    if (typeof validated === "string") {
      res.status(400).json({ success: false, error: validated });
      return;
    }
    const { payload, spec, params } = validated;

    // 4. Consent must be explicitly granted — nothing else counts. Skipped
    //    entirely for a template with requiresConsent === false (only the
    //    internal notification today): there is no visitor consent to check,
    //    and none is ever synthesized.
    if (spec.requiresConsent && payload.consent?.granted !== true) {
      res.status(403).json({ success: false, error: "Consent was not granted." });
      return;
    }

    // 5. Same Brazilian phone rules as the campaign dispatcher, for every
    //    template — including the internal one, whose target is a fixed
    //    company number, not the visitor's.
    const phone = normalizePhone(payload.phone);
    if (phone === null) {
      res.status(400).json({ success: false, error: "Invalid phone number." });
      return;
    }

    const dryRun = isDryRun();

    // Never log the full phone number, the secret or the template ID.
    console.log(
      `SiteFlow dispatch: client=${payload.client_id} conversation=${payload.conversation_id} ` +
        `template=${spec.logicalName} phone=${maskPhone(phone)} dry_run=${dryRun}`,
    );

    let result: SendTemplateResult;

    if (dryRun) {
      // Simulated success: no provider call, no approved template required, no
      // provider template ID required.
      result = {
        accepted: true,
        status: null,
        message_state: "simulated",
        provider_message_id: null,
        chat_id: null,
        error: null,
      };
    } else {
      // 6. Real sends need THIS template's provider ID from the environment.
      //    A template whose env var is unset is unavailable on its own —
      //    the other templates are unaffected.
      const templateId = process.env[spec.envVar];
      if (!templateId || templateId.trim() === "") {
        res.status(503).json({ success: false, error: `SiteFlow template "${spec.logicalName}" is not configured.` });
        return;
      }

      result = await sendTemplateMessage(
        {
          toPhone: phone,
          templateId,
          params,
          contactName: payload.visitor_first_name,
        },
        apiToken,
      );
    }

    res.json({
      success: result.accepted,
      dry_run: dryRun,
      client_id: payload.client_id,
      conversation_id: payload.conversation_id,
      lead_id: payload.lead_id,
      template_name: spec.logicalName,
      phone: maskPhone(phone),
      params,
      accepted: result.accepted,
      status: result.status,
      message_state: result.message_state,
      provider_message_id: result.provider_message_id,
      chat_id: result.chat_id,
      delivery_status: "pending",
      error: result.error,
    });
  };
}

/**
 * Dry-run mode: validate and simulate, never reach the provider.
 *
 * Read per request (not cached) so a test run can toggle it without a rebuild.
 * Only this endpoint honours it — /api/dispatch is unaffected.
 */
export function isDryRun(): boolean {
  const raw = (process.env.DRY_RUN ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * SiteFlow endpoint — POST /api/siteflow/message
 *
 * Sends ONE free-text WhatsApp message (not a template) to a single visitor.
 * Used only for the "Receber resumo" / "Ver resumo do contato" replies, after
 * that recipient already received an approved template via
 * /api/siteflow/dispatch above. Shares that endpoint's secret and dry-run
 * behaviour; the payload and provider call are otherwise independent, and
 * unaffected by the template registry above (there is nothing to select
 * here — it is one free-text message).
 */

const MAX_MESSAGE_LENGTH = 4000;

interface SiteflowMessageRequest {
  client_id: string;
  conversation_id: string;
  lead_id: string;
  to_phone: string;
  text: string;
}

/**
 * Validate an incoming SiteFlow free-text message payload. Returns an error
 * message string, or null if the payload is structurally valid.
 */
export function validateSiteflowMessageRequest(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return "Body must be a JSON object.";
  }

  const payload = data as Partial<SiteflowMessageRequest>;

  for (const field of [
    "client_id",
    "conversation_id",
    "lead_id",
    "to_phone",
    "text",
  ] as const) {
    const value = payload[field];
    if (typeof value !== "string" || value.trim() === "") {
      return `${field} is required.`;
    }
  }

  if ((payload.text as string).length > MAX_MESSAGE_LENGTH) {
    return `text must be at most ${MAX_MESSAGE_LENGTH} characters.`;
  }

  return null;
}

/**
 * Build the Express handler. The Umbler token is injected (already validated
 * at startup) so this module never reads it itself and never logs it.
 */
export function createSiteflowMessageHandler(apiToken: string) {
  return async (req: Request, res: Response): Promise<void> => {
    // 1. The route is only available once its own secret is configured —
    //    same secret as /api/siteflow/dispatch, same fail-closed behaviour.
    const siteflowSecret = process.env.SITEFLOW_DISPATCH_SECRET;
    if (!siteflowSecret || siteflowSecret.trim() === "") {
      res.status(503).json({ success: false, error: "SiteFlow dispatch is not configured." });
      return;
    }

    // 2. Require the shared secret header. Never leak the expected value.
    const provided = req.header("x-siteflow-dispatch-secret");
    if (!provided || provided !== siteflowSecret) {
      res.status(401).json({ success: false, error: "Unauthorized." });
      return;
    }

    // 3. Payload shape.
    const validationError = validateSiteflowMessageRequest(req.body);
    if (validationError) {
      res.status(400).json({ success: false, error: validationError });
      return;
    }

    const payload = req.body as SiteflowMessageRequest;

    // 4. Same Brazilian phone rules as the template endpoint.
    const phone = normalizePhone(payload.to_phone);
    if (phone === null) {
      res.status(400).json({ success: false, error: "Invalid phone number." });
      return;
    }

    const dryRun = isDryRun();

    // Never log the full phone number, the secret or the message body.
    console.log(
      `SiteFlow message: client=${payload.client_id} conversation=${payload.conversation_id} ` +
        `phone=${maskPhone(phone)} dry_run=${dryRun}`,
    );

    let result: SendTemplateResult;

    if (dryRun) {
      // Simulated success: no provider call.
      result = {
        accepted: true,
        status: null,
        message_state: "simulated",
        provider_message_id: null,
        chat_id: null,
        error: null,
      };
    } else {
      result = await sendTextMessage({ toPhone: phone, message: payload.text }, apiToken);
    }

    res.json({
      success: result.accepted,
      dry_run: dryRun,
      client_id: payload.client_id,
      conversation_id: payload.conversation_id,
      lead_id: payload.lead_id,
      phone: maskPhone(phone),
      accepted: result.accepted,
      status: result.status,
      message_state: result.message_state,
      provider_message_id: result.provider_message_id,
      chat_id: result.chat_id,
      // "accepted" means Umbler accepted/queued the request — never that it
      // was delivered or read. See docs/INTEGRATION.md §11 and §18.
      delivery_status: "pending",
      error: result.error,
    });
  };
}
