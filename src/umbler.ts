/**
 * Umbler Talk transport.
 *
 * The single place that talks to the provider. Extracted from src/server.ts so
 * every route sends template messages through the same code path — the request
 * body, headers and defensive response parsing are unchanged.
 */

import {
  ATTEMPTED_INDETERMINATE,
  classifyProviderResponse,
  type FailureStage,
} from "./dispatch-outcome.js";

// Fixed values for this proof of concept (safe to keep in source — not secrets).
export const FROM_PHONE = "+5521990047343";
export const ORGANIZATION_ID = "aQDFQYsjuFhKAP11";
export const API_URL = "https://app-utalk.umbler.com/api/v1/template-messages/simplified/";
export const MESSAGE_API_URL = "https://app-utalk.umbler.com/api/v1/messages/simplified/";
export const MESSAGE_LOOKUP_URL = "https://app-utalk.umbler.com/api/v1/messages/";

export interface SendTemplateArgs {
  /** Destination phone, already normalized to E.164. */
  toPhone: string;
  /** Provider template ID. Never hardcoded — always comes from configuration. */
  templateId: string;
  /** Positional template params, in the template's declared order. */
  params: string[];
  contactName: string;
}

export interface SendTemplateResult {
  accepted: boolean;
  status: number | null;
  message_state: string | null;
  provider_message_id: string | null;
  chat_id: string | null;
  error: string | null;
  /**
   * `false` ONLY when no provider request was initiated. Any other value —
   * including an absent field from an older deployment — means the provider
   * may have been called, so it is never a proven non-send. See
   * src/dispatch-outcome.ts.
   */
  provider_attempted: boolean;
  failure_stage: FailureStage;
}

/**
 * Read the first non-empty string among the given keys of a parsed object.
 * Returns null if none is present. Used to pull fields out of the provider
 * response defensively, without assuming its exact shape.
 */
export function readString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return null;
}

/**
 * Send one template message via Umbler Talk. `toPhone` must already be
 * normalized. Never throws: any failure is captured in the returned result.
 */
export async function sendTemplateMessage(
  args: SendTemplateArgs,
  apiToken: string,
): Promise<SendTemplateResult> {
  const body = {
    toPhone: args.toPhone,
    fromPhone: FROM_PHONE,
    organizationId: ORGANIZATION_ID,
    templateId: args.templateId,
    params: args.params,
    contactName: args.contactName,
    skipReassign: false,
  };

  try {
    // PROVIDER-ATTEMPT BOUNDARY. This fetch is deliberately the first
    // statement of the try, so every path that reaches the catch below is at
    // or after it and can only ever be reported as attempted.
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
      accepted: response.ok,
      status: response.status,
      message_state: messageState,
      provider_message_id: providerMessageId,
      chat_id: chatId,
      error,
      ...classifyProviderResponse(response.ok, response.status),
    };
  } catch (error: unknown) {
    // Never print the token; only surface the error message. Keep going.
    //
    // This catch sits at or after the provider-attempt boundary above: a
    // timeout, an AbortError, a connection reset or any other throw leaves
    // the delivery outcome unprovable, so it is always reported as attempted.
    return {
      accepted: false,
      status: null,
      message_state: null,
      provider_message_id: null,
      chat_id: null,
      error: error instanceof Error ? error.message : String(error),
      ...ATTEMPTED_INDETERMINATE,
    };
  }
}

/** Bounded network timeout for the read-only message lookup below. */
const LOOKUP_TIMEOUT_MS = 8000;

export type MediaLookupState = "processing" | "ready" | "error";

export interface UmblerMediaFile {
  url: string;
  contentType: string | null;
  sizeBytes: number | null;
}

export interface MediaLookupResult {
  state: MediaLookupState;
  media: UmblerMediaFile | null;
  error: string | null;
}

/**
 * Look up the CURRENT server-side state of one exact Umbler message by its
 * provider message ID (GET /v1/messages/{id}/ — read-only, never mutates
 * the message). Used to answer "is the inbound audio's media ready yet?".
 *
 * `MessageState` is intentionally NOT used as the readiness signal: measured
 * against real production traffic, it can stay "Processing" long after
 * `File.Url` is already populated with a downloadable link. `File.Url !==
 * null` is the only field this function treats as "ready".
 *
 * Never downloads the media itself, never throws — any failure (timeout,
 * malformed response, non-2xx, or a malformed/non-HTTPS URL) is captured in
 * the returned `error` field instead. `error` is always one of a small set
 * of fixed, sanitized strings — never provider response-body text, never
 * the requested lookup URL, never a raw exception message. Those are
 * external/unbounded and could otherwise leak provider details, URLs, or
 * identifiers into a client-facing response.
 */
export async function getMessageMedia(
  messageId: string,
  apiToken: string,
): Promise<MediaLookupResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const url = `${MESSAGE_LOOKUP_URL}${encodeURIComponent(messageId)}/?organizationId=${ORGANIZATION_ID}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}` },
      signal: controller.signal,
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

    if (response.status === 404) {
      return { state: "error", media: null, error: "Message not found." };
    }

    if (!response.ok) {
      // Fixed message only — never forward the provider's response body
      // (its "title"/"error"/"message" fields are external, unbounded text).
      return { state: "error", media: null, error: "Umbler media lookup failed." };
    }

    if (!obj) {
      return { state: "error", media: null, error: "Umbler returned a malformed response." };
    }

    const file = obj.file;
    if (file === null || file === undefined || typeof file !== "object") {
      return { state: "processing", media: null, error: null };
    }

    const fileObj = file as Record<string, unknown>;
    const rawUrl = fileObj.url;
    if (typeof rawUrl !== "string" || rawUrl.length === 0) {
      return { state: "processing", media: null, error: null };
    }

    // Fail closed: hand back only a well-formed HTTPS URL.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return { state: "error", media: null, error: "Provider returned a malformed media URL." };
    }
    if (parsedUrl.protocol !== "https:") {
      return { state: "error", media: null, error: "Provider returned a non-HTTPS media URL." };
    }

    const contentType = typeof fileObj.contentType === "string" ? fileObj.contentType : null;
    const rawSize = fileObj.originalSizeBytes;
    const sizeBytes =
      typeof rawSize === "number" && Number.isFinite(rawSize) && rawSize >= 0 ? rawSize : null;

    return {
      state: "ready",
      media: { url: rawUrl, contentType, sizeBytes },
      error: null,
    };
  } catch (error: unknown) {
    // Fixed message only — never the token, never the lookup URL, and never
    // the raw exception message (it may embed request/URL/host details).
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      state: "error",
      media: null,
      error: isAbort ? "Umbler request timed out." : "Umbler request failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export interface SendTextArgs {
  /** Destination phone, already normalized to E.164. */
  toPhone: string;
  /** Free-text message body. */
  message: string;
}

/**
 * Send one free-text message via Umbler Talk (not a template). `toPhone`
 * must already be normalized. Never throws: any failure is captured in the
 * returned result.
 *
 * `accepted: true` means Umbler accepted/queued the request — not that the
 * message was delivered. Umbler's documented fields for this endpoint are
 * `ToPhone`/`FromPhone`/`OrganizationId`/`Message`; the existing template
 * route above already sends the equivalent fields in camelCase against the
 * same API and works, so this keeps that convention instead of introducing a
 * second casing style.
 */
export async function sendTextMessage(
  args: SendTextArgs,
  apiToken: string,
): Promise<SendTemplateResult> {
  const body = {
    toPhone: args.toPhone,
    fromPhone: FROM_PHONE,
    organizationId: ORGANIZATION_ID,
    message: args.message,
  };

  try {
    // PROVIDER-ATTEMPT BOUNDARY. This fetch is deliberately the first
    // statement of the try, so every path that reaches the catch below is at
    // or after it and can only ever be reported as attempted.
    const response = await fetch(MESSAGE_API_URL, {
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
      accepted: response.ok,
      status: response.status,
      message_state: messageState,
      provider_message_id: providerMessageId,
      chat_id: chatId,
      error,
      ...classifyProviderResponse(response.ok, response.status),
    };
  } catch (error: unknown) {
    // Never print the token; only surface the error message. Keep going.
    //
    // This catch sits at or after the provider-attempt boundary above: a
    // timeout, an AbortError, a connection reset or any other throw leaves
    // the delivery outcome unprovable, so it is always reported as attempted.
    return {
      accepted: false,
      status: null,
      message_state: null,
      provider_message_id: null,
      chat_id: null,
      error: error instanceof Error ? error.message : String(error),
      ...ATTEMPTED_INDETERMINATE,
    };
  }
}
