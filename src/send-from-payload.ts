import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Fixed values for this proof of concept (safe to keep in source — not secrets).
const FROM_PHONE = "+5521990047343";
const ORGANIZATION_ID = "aQDFQYsjuFhKAP11";
const API_URL = "https://app-utalk.umbler.com/api/v1/template-messages/simplified/";

// Resolve payloads/test-campaign.json relative to this file, not the CWD.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PAYLOAD_PATH = join(__dirname, "..", "payloads", "test-campaign.json");

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
 * Load and validate the campaign payload. Exits with a clear message on any problem.
 */
function loadPayload(path: string): Campaign {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error: unknown) {
    console.error(`Could not read payload file: ${path}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error: unknown) {
    console.error(`Payload file is not valid JSON: ${path}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const payload = data as Partial<Campaign>;

  if (!payload.campaign_id || typeof payload.campaign_id !== "string") {
    console.error("Invalid payload: campaign_id is required.");
    process.exit(1);
  }
  if (!payload.campaign_name || typeof payload.campaign_name !== "string") {
    console.error("Invalid payload: campaign_name is required.");
    process.exit(1);
  }
  if (!payload.template_id || typeof payload.template_id !== "string") {
    console.error("Invalid payload: template_id is required.");
    process.exit(1);
  }
  if (!Array.isArray(payload.contacts) || payload.contacts.length === 0) {
    console.error("Invalid payload: contacts must be a non-empty array.");
    process.exit(1);
  }

  payload.contacts.forEach((contact, index) => {
    for (const field of ["contact_id", "name", "phone", "reason"] as const) {
      const value = (contact as Partial<Contact>)[field];
      if (!value || typeof value !== "string") {
        console.error(`Invalid payload: contact at index ${index} is missing "${field}".`);
        process.exit(1);
      }
    }
  });

  return payload as Campaign;
}

async function main(): Promise<void> {
  const apiToken = requireEnv("UMBLER_TALK_API_TOKEN");
  const payload = loadPayload(PAYLOAD_PATH);

  console.log(`Campaign id:   ${payload.campaign_id}`);
  console.log(`Campaign name: ${payload.campaign_name}`);
  console.log(`Contacts:      ${payload.contacts.length}`);
  console.log(`POST ${API_URL}\n`);

  let sent = 0;
  let failed = 0;

  for (const contact of payload.contacts) {
    const body = {
      toPhone: contact.phone,
      fromPhone: FROM_PHONE,
      organizationId: ORGANIZATION_ID,
      templateId: payload.template_id,
      params: [contact.name, contact.reason],
      contactName: contact.name,
      skipReassign: false,
    };

    console.log(`--- ${contact.name} (${contact.phone}) ---`);

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
      console.log(`Response status: ${response.status} ${response.statusText}`);
      console.log("Response body:", responseText);

      if (response.ok) {
        sent++;
      } else {
        failed++;
      }
    } catch (error: unknown) {
      // Never print the token; only surface the error message. Keep going.
      console.error("Request failed:", error instanceof Error ? error.message : String(error));
      failed++;
    }

    console.log("");
  }

  console.log("=== Summary ===");
  console.log(`Total:  ${payload.contacts.length}`);
  console.log(`Sent:   ${sent}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  // Never print the token; only surface the error message.
  console.error("Request failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
