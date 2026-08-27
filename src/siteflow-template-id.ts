/**
 * Shared strict validator for a raw Umbler/Meta provider template ID.
 *
 * The dynamic campaign-template path lets SiteFlow send a `provider_template_id`
 * it already resolved server-side, from its own frozen catalog revision — the
 * browser and the LLM never see or send a provider ID themselves. This is the
 * ONE place that string is validated before the dispatcher trusts it enough to
 * use directly in a real provider send.
 *
 * Both `/api/siteflow/preflight` and `/api/siteflow/dispatch` call this exact
 * function for the dynamic path — never a re-implementation — so a malformed
 * fixture is rejected identically by both, always.
 */

const MAX_PROVIDER_TEMPLATE_ID_LENGTH = 128;

// Same shape already trusted for Umbler provider message IDs in
// siteflow-media.ts (e.g. "aYSx9KNRwPC0hnHe", "an4ZQL9PiM6AvyyT") — short
// alphanumeric/underscore/hyphen tokens. Reject anything else outright
// instead of forwarding an unvalidated string into the provider send.
const PROVIDER_TEMPLATE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a raw provider template ID. Returns an error message string, or
 * null when the value is a well-formed provider template ID.
 */
export function validateProviderTemplateId(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return "provider_template_id is required.";
  }
  if (value.length > MAX_PROVIDER_TEMPLATE_ID_LENGTH) {
    return `provider_template_id must be at most ${MAX_PROVIDER_TEMPLATE_ID_LENGTH} characters.`;
  }
  if (!PROVIDER_TEMPLATE_ID_PATTERN.test(value)) {
    return "provider_template_id has an invalid format.";
  }
  return null;
}

/** Type-guard form for call sites that only need a boolean. Same rules as above. */
export function isValidProviderTemplateId(value: unknown): value is string {
  return validateProviderTemplateId(value) === null;
}
