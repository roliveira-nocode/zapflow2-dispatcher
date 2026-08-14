import "dotenv/config";
import express, { type Request, type Response } from "express";

import { normalizePhone } from "./phone.js";
import { createSiteflowMediaHandler } from "./siteflow-media.js";
import { createSiteflowDispatchHandler, createSiteflowMessageHandler } from "./siteflow.js";
import { sendTemplateMessage } from "./umbler.js";

interface Contact {
  contact_id: string;
  name: string;
  phone: string;
  reason: string;
}

interface Campaign {
  campaign_id: string;
  campaign_name: string;
  template_id: string;
  contacts: Contact[];
}

interface ApprovedTemplate {
  template_id: string;
  label: string;
  params: string[];
}

interface ContactResult {
  contact_id: string;
  name: string;
  phone: string;
  accepted: boolean;
  status: number | null;
  message_state: string | null;
  provider_message_id: string | null;
  chat_id: string | null;
  error: string | null;
}

// Templates this local dispatcher is allowed to send. For now, exactly one.
const APPROVED_TEMPLATES: Record<string, ApprovedTemplate> = {
  aYSx9KNRwPC0hnHe: {
    template_id: "aYSx9KNRwPC0hnHe",
    label: "zapflow_primeiro_contato_v1",
    params: ["name", "reason"],
  },
};

/**
 * Read a required environment variable or fail clearly.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    console.error(`Missing required environment variable: ${name}`);
    console.error("Copy .env.example to .env and fill in the values, then try again.");
    process.exit(1);
  }
  return value;
}

/**
 * Validate an incoming campaign payload. Returns an error message string, or
 * null if the payload is valid.
 */
function validateCampaign(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return "Body must be a JSON object.";
  }

  const payload = data as Partial<Campaign>;

  if (!payload.campaign_id || typeof payload.campaign_id !== "string") {
    return "campaign_id is required.";
  }
  if (!payload.campaign_name || typeof payload.campaign_name !== "string") {
    return "campaign_name is required.";
  }
  if (!payload.template_id || typeof payload.template_id !== "string") {
    return "template_id is required.";
  }
  if (!Array.isArray(payload.contacts) || payload.contacts.length === 0) {
    return "contacts must be a non-empty array.";
  }

  for (let index = 0; index < payload.contacts.length; index++) {
    const contact = payload.contacts[index] as Partial<Contact>;
    for (const field of ["contact_id", "name", "phone", "reason"] as const) {
      const value = contact?.[field];
      if (!value || typeof value !== "string") {
        return `contact at index ${index} is missing "${field}".`;
      }
    }
  }

  return null;
}

/**
 * Send one approved template message to a single contact via Umbler Talk.
 * `phone` must already be normalized. Never throws: any failure is captured
 * in the returned result.
 */
async function sendToContact(
  contact: Contact,
  phone: string,
  template: ApprovedTemplate,
  apiToken: string,
): Promise<ContactResult> {
  // Build template params from the approved template's declared order.
  const paramSource: Record<string, string> = {
    name: contact.name,
    reason: contact.reason,
  };
  const params = template.params.map((key) => paramSource[key] ?? "");

  const base = {
    contact_id: contact.contact_id,
    name: contact.name,
    phone,
  };

  const result = await sendTemplateMessage(
    {
      toPhone: phone,
      templateId: template.template_id,
      params,
      contactName: contact.name,
    },
    apiToken,
  );

  return { ...base, ...result };
}

const apiToken = requireEnv("UMBLER_TALK_API_TOKEN");
const dispatchSecret = requireEnv("DISPATCH_SECRET");
const PORT = Number(process.env.PORT) || 3000;
const MAX_CONTACTS = Number(process.env.MAX_CONTACTS) || 20;

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post("/api/dispatch", async (req: Request, res: Response) => {
  // Require the shared secret header. Never leak the expected value.
  const provided = req.header("x-dispatch-secret");
  if (!provided || provided !== dispatchSecret) {
    return res.status(401).json({ success: false, error: "Unauthorized." });
  }

  const validationError = validateCampaign(req.body);
  if (validationError) {
    return res.status(400).json({ success: false, error: validationError });
  }

  const payload = req.body as Campaign;

  // Only approved templates may be dispatched from this local tool.
  const template = APPROVED_TEMPLATES[payload.template_id];
  if (!template) {
    return res
      .status(400)
      .json({ success: false, error: "Template is not approved for this local dispatcher." });
  }

  // Safety limit so a large payload can't fan out an unexpected blast.
  if (payload.contacts.length > MAX_CONTACTS) {
    return res.status(400).json({
      success: false,
      error: `Too many contacts: ${payload.contacts.length} (max ${MAX_CONTACTS}).`,
    });
  }

  console.log(
    `Dispatch: ${payload.campaign_id} "${payload.campaign_name}" — ${payload.contacts.length} contact(s)`,
  );

  const results: ContactResult[] = [];
  for (const contact of payload.contacts) {
    const phone = normalizePhone(contact.phone);

    // Invalid phone: mark failed, skip the Umbler call, keep going.
    if (phone === null) {
      console.log(`  ${contact.name}: failed (invalid phone)`);
      results.push({
        contact_id: contact.contact_id,
        name: contact.name,
        phone: contact.phone,
        accepted: false,
        status: null,
        message_state: null,
        provider_message_id: null,
        chat_id: null,
        error: "Invalid phone number.",
      });
      continue;
    }

    const result = await sendToContact(contact, phone, template, apiToken);
    console.log(`  ${contact.name}: ${result.accepted ? "accepted" : "failed"}`);
    results.push(result);
  }

  const accepted = results.filter((r) => r.accepted).length;
  const failed = results.length - accepted;

  return res.json({
    success: failed === 0,
    campaign_id: payload.campaign_id,
    campaign_name: payload.campaign_name,
    template_id: template.template_id,
    template_label: template.label,
    total: payload.contacts.length,
    accepted,
    failed,
    delivery_status: "pending",
    results,
  });
});

// SiteFlow: single consent-gated template message. Own secret, own payload,
// own template — see src/siteflow.ts.
app.post("/api/siteflow/dispatch", createSiteflowDispatchHandler(apiToken));

// SiteFlow: single free-text message (the "Receber resumo" reply), sent
// after the template above. Same secret, independent payload and provider
// call — see src/siteflow.ts.
app.post("/api/siteflow/message", createSiteflowMessageHandler(apiToken));

// SiteFlow: read-only lookup of one exact inbound message's media
// readiness (audio transcription support). Same secret, no side effects —
// see src/siteflow-media.ts.
app.post("/api/siteflow/media", createSiteflowMediaHandler(apiToken));

// On Vercel the app is exported and invoked as a serverless function, so we
// must NOT call listen(). Locally (npm run dev) there is no VERCEL env var, so
// we start a normal HTTP server exactly as before.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`zapflow dispatch API listening on http://localhost:${PORT}`);
    console.log(`  GET  /health`);
    console.log(`  POST /api/dispatch`);
    console.log(`  POST /api/siteflow/dispatch`);
    console.log(`  POST /api/siteflow/message`);
    console.log(`  POST /api/siteflow/media`);
  });
}

// Default export lets Vercel's @vercel/node runtime use the Express app as the
// request handler. Does not affect local development.
export default app;
