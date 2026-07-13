import "dotenv/config";
import express, { type Request, type Response } from "express";

// Fixed values for this proof of concept (safe to keep in source — not secrets).
const FROM_PHONE = "+5521990047343";
const ORGANIZATION_ID = "aQDFQYsjuFhKAP11";
const API_URL = "https://app-utalk.umbler.com/api/v1/template-messages/simplified/";

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
 * Normalize a Brazilian phone number to "+<digits>" E.164 form.
 *
 * - Strips every non-numeric character.
 * - If the number has 11 digits and no 55 country code, prefixes 55.
 * - Accepts only Brazilian numbers: starts with 55 and has 12 or 13 digits.
 *
 * Returns the normalized phone, or null if it is obviously invalid.
 */
function normalizePhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");

  if (!digits.startsWith("55") && digits.length === 11) {
    digits = `55${digits}`;
  }

  if (!digits.startsWith("55") || (digits.length !== 12 && digits.length !== 13)) {
    return null;
  }

  return `+${digits}`;
}

/**
 * Read the first non-empty string among the given keys of a parsed object.
 * Returns null if none is present. Used to pull fields out of the provider
 * response defensively, without assuming its exact shape.
 */
function readString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
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

  const body = {
    toPhone: phone,
    fromPhone: FROM_PHONE,
    organizationId: ORGANIZATION_ID,
    templateId: template.template_id,
    params,
    contactName: contact.name,
    skipReassign: false,
  };

  const base = {
    contact_id: contact.contact_id,
    name: contact.name,
    phone,
  };

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();

    // Parse defensively: the provider may return non-JSON on some errors.
    let obj: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(responseText);
      if (parsed !== null && typeof parsed === "object") {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      obj = null;
    }

    const messageState = obj ? readString(obj, ["messageState", "state", "message_state"]) : null;
    const providerMessageId = obj ? readString(obj, ["id", "messageId", "message_id"]) : null;
    const chatId = obj ? readString(obj, ["chatId", "chat_id"]) : null;

    let error: string | null = null;
    if (!response.ok) {
      error =
        (obj && readString(obj, ["error", "message", "errorMessage", "title"])) ||
        `Umbler returned HTTP ${response.status}.`;
    }

    return {
      ...base,
      accepted: response.ok,
      status: response.status,
      message_state: messageState,
      provider_message_id: providerMessageId,
      chat_id: chatId,
      error,
    };
  } catch (error: unknown) {
    // Never print the token; only surface the error message. Keep going.
    return {
      ...base,
      accepted: false,
      status: null,
      message_state: null,
      provider_message_id: null,
      chat_id: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

// On Vercel the app is exported and invoked as a serverless function, so we
// must NOT call listen(). Locally (npm run dev) there is no VERCEL env var, so
// we start a normal HTTP server exactly as before.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`zapflow dispatch API listening on http://localhost:${PORT}`);
    console.log(`  GET  /health`);
    console.log(`  POST /api/dispatch`);
  });
}

// Default export lets Vercel's @vercel/node runtime use the Express app as the
// request handler. Does not affect local development.
export default app;
