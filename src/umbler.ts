/**
 * Umbler Talk transport.
 *
 * The single place that talks to the provider. Extracted from src/server.ts so
 * every route sends template messages through the same code path — the request
 * body, headers and defensive response parsing are unchanged.
 */

// Fixed values for this proof of concept (safe to keep in source — not secrets).
export const FROM_PHONE = "+5521990047343";
export const ORGANIZATION_ID = "aQDFQYsjuFhKAP11";
export const API_URL = "https://app-utalk.umbler.com/api/v1/template-messages/simplified/";

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
    };
  } catch (error: unknown) {
    // Never print the token; only surface the error message. Keep going.
    return {
      accepted: false,
      status: null,
      message_state: null,
      provider_message_id: null,
      chat_id: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
