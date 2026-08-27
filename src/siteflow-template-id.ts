/**
 * Shared strict validators for the two free-form tokens the dynamic
 * campaign-template path introduces: the raw provider template ID, and the
 * caller-supplied logical/internal template identity.
 *
 * The dynamic campaign-template path lets SiteFlow send a `provider_template_id`
 * it already resolved server-side, from its own frozen catalog revision — the
 * browser and the LLM never see or send a provider ID themselves. This is the
 * ONE place that string is validated before the dispatcher trusts it enough to
 * use directly in a real provider send.
 *
 * Both `/api/siteflow/preflight` and `/api/siteflow/dispatch` call these exact
 * functions for the dynamic path — never a re-implementation — so a malformed
 * fixture is rejected identically by both, always.
 */

// Bounds match the CRM precedent that informed this architecture. Every
// currently known approved provider template ID used by this project
// (e.g. "aYSx9KNRwPC0hnHe", 16 chars) falls well inside this range.
const MIN_PROVIDER_TEMPLATE_ID_LENGTH = 4;
const MAX_PROVIDER_TEMPLATE_ID_LENGTH = 64;

// Same character set already trusted for Umbler provider message IDs in
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
  if (value.length < MIN_PROVIDER_TEMPLATE_ID_LENGTH) {
    return `provider_template_id must be at least ${MIN_PROVIDER_TEMPLATE_ID_LENGTH} characters.`;
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

// The dynamic logical/internal template identity is interpolated straight
// into a server log line (see the `template=` field logged by
// createSiteflowDispatchHandler) — unlike the static path's `template`, it
// is never looked up in a fixed registry, so nothing else constrains its
// shape. Restricted to a safe slug/token so it can never inject a newline,
// control character or otherwise corrupt a log line.
const MAX_TEMPLATE_IDENTITY_LENGTH = 128;
const TEMPLATE_IDENTITY_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate the dynamic path's logical/internal template identity (the
 * `template` field once `provider_template_id` is present). Returns an
 * error message string, or null when the value is a safe slug/token.
 *
 * Deliberately does NOT check membership in SITEFLOW_TEMPLATES — the
 * dynamic catalog is SiteFlow's, not this dispatcher's closed registry —
 * and does NOT require any particular prefix.
 */
export function validateTemplateIdentity(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return "template is required.";
  }
  if (value.length > MAX_TEMPLATE_IDENTITY_LENGTH) {
    return `template must be at most ${MAX_TEMPLATE_IDENTITY_LENGTH} characters.`;
  }
  if (!TEMPLATE_IDENTITY_PATTERN.test(value)) {
    return "template has an invalid format.";
  }
  return null;
}
