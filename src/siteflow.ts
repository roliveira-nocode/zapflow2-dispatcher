/**
 * SiteFlow endpoint — POST /api/siteflow/dispatch
 *
 * Server-to-server entry point that sends ONE approved WhatsApp template to a
 * single visitor who has explicitly consented. Separate from the campaign
 * dispatcher (/api/dispatch) in every way: its own shared secret, its own
 * payload, its own template.
 *
 * The template's provider ID is never hardcoded — it is read from
 * SITEFLOW_TEMPLATE_ID. SITEFLOW_TEMPLATE_NAME below is only the logical name
 * used for identification, logs and documentation.
 */
import { type Request, type Response } from "express";

import { maskPhone, normalizePhone } from "./phone.js";
import { sendTemplateMessage, type SendTemplateResult } from "./umbler.js";

/** Logical (Meta/Umbler) template name. Not the provider ID. */
export const SITEFLOW_TEMPLATE_NAME = "siteflow_continuar_conversa";

/** Template params, in the order the template declares them. */
const TEMPLATE_PARAM_ORDER = ["visitor_first_name", "client_brand"] as const;

interface SiteflowConsent {
  granted: boolean;
  granted_at: string;
  source: string;
}

interface SiteflowDispatchRequest {
  client_id: string;
  client_brand: string;
  conversation_id: string;
  lead_id: string;
  visitor_first_name: string;
  phone: string;
  consent: SiteflowConsent;
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
 * Validate an incoming SiteFlow payload. Returns an error message string, or
 * null if the payload is structurally valid.
 *
 * Note: this checks that `consent.granted` is a boolean, not that it is true —
 * a denied consent is a separate, non-validation rejection.
 */
export function validateSiteflowRequest(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return "Body must be a JSON object.";
  }

  const payload = data as Partial<SiteflowDispatchRequest>;

  for (const field of [
    "client_id",
    "client_brand",
    "conversation_id",
    "lead_id",
    "visitor_first_name",
    "phone",
  ] as const) {
    const value = payload[field];
    if (typeof value !== "string" || value.trim() === "") {
      return `${field} is required.`;
    }
  }

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

  return null;
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

    // 3. Payload shape.
    const validationError = validateSiteflowRequest(req.body);
    if (validationError) {
      res.status(400).json({ success: false, error: validationError });
      return;
    }

    const payload = req.body as SiteflowDispatchRequest;

    // 4. Consent must be explicitly granted — nothing else counts.
    if (payload.consent.granted !== true) {
      res.status(403).json({ success: false, error: "Consent was not granted." });
      return;
    }

    // 5. Same Brazilian phone rules as the campaign dispatcher.
    const phone = normalizePhone(payload.phone);
    if (phone === null) {
      res.status(400).json({ success: false, error: "Invalid phone number." });
      return;
    }

    const dryRun = isDryRun();
    const params = TEMPLATE_PARAM_ORDER.map((key) => payload[key]);

    // Never log the full phone number, the secret or the template ID.
    console.log(
      `SiteFlow dispatch: client=${payload.client_id} conversation=${payload.conversation_id} ` +
        `phone=${maskPhone(phone)} dry_run=${dryRun}`,
    );

    let result: SendTemplateResult;

    if (dryRun) {
      // Simulated success: no provider call, no approved template required, no
      // SITEFLOW_TEMPLATE_ID required.
      result = {
        accepted: true,
        status: null,
        message_state: "simulated",
        provider_message_id: null,
        chat_id: null,
        error: null,
      };
    } else {
      // 6. Real sends need the provider template ID from the environment.
      const templateId = process.env.SITEFLOW_TEMPLATE_ID;
      if (!templateId || templateId.trim() === "") {
        res.status(503).json({ success: false, error: "SiteFlow template is not configured." });
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
      template_name: SITEFLOW_TEMPLATE_NAME,
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
