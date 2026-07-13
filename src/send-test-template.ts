import "dotenv/config";

// Fixed values for this proof of concept (safe to keep in source — not secrets).
const FROM_PHONE = "+5521990047343";
const ORGANIZATION_ID = "aQDFQYsjuFhKAP11";
const TEMPLATE_ID = "aYSx9KNRwPC0hnHe";
const API_URL = "https://app-utalk.umbler.com/api/v1/template-messages/simplified/";

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

async function main(): Promise<void> {
  const apiToken = requireEnv("UMBLER_TALK_API_TOKEN");
  const toPhone = requireEnv("TEST_TO_PHONE");
  const contactName = requireEnv("TEST_CONTACT_NAME");
  const reason = requireEnv("TEST_REASON");

  const body = {
    toPhone,
    fromPhone: FROM_PHONE,
    organizationId: ORGANIZATION_ID,
    templateId: TEMPLATE_ID,
    params: [contactName, reason],
    contactName,
    skipReassign: false,
  };

  // Log the request payload WITHOUT the token (the token only lives in the header).
  console.log(`POST ${API_URL}`);
  console.log("Request body:", JSON.stringify(body, null, 2));

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await response.text();

  console.log(`\nResponse status: ${response.status} ${response.statusText}`);
  console.log("Response body:", responseText);

  if (!response.ok) {
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  // Never print the token; only surface the error message.
  console.error("Request failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
