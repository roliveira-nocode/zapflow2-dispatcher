/**
 * SiteFlow endpoint — POST /api/siteflow/media
 *
 * Read-only lookup: given the exact Umbler provider message ID, reports
 * whether that message's media is ready and, if so, its metadata. Answers
 * "is the media ready yet?" only — it never downloads the audio bytes,
 * never transcribes anything, and never sends a WhatsApp message. Shares
 * the SiteFlow dispatch secret (`SITEFLOW_DISPATCH_SECRET`) and fail-closed
 * behaviour with /api/siteflow/dispatch and /api/siteflow/message, but is
 * otherwise fully independent — safe to call repeatedly for the same
 * messageId (no side effects, no state written anywhere).
 *
 * The provider message ID is the only lookup key: no phone, contact name,
 * chat recency, tenant, or caller-supplied organization ID is accepted. The
 * dispatcher always uses its own already-configured Umbler organization
 * (see ORGANIZATION_ID in umbler.ts).
 */
import { type Request, type Response } from "express";

import { getMessageMedia } from "./umbler.js";

const MAX_MESSAGE_ID_LENGTH = 128;
// Umbler provider message IDs observed in production are short
// alphanumeric/underscore/hyphen tokens (e.g. "an4ZQL9PiM6AvyyT"). Reject
// anything else outright instead of forwarding an unvalidated string into
// the Umbler request path.
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface SiteflowMediaRequest {
  messageId: string;
}

/**
 * Validate an incoming media-lookup payload. Returns an error message
 * string, or null if the payload is structurally valid.
 */
export function validateSiteflowMediaRequest(data: unknown): string | null {
  if (typeof data !== "object" || data === null) {
    return "Body must be a JSON object.";
  }

  const payload = data as Partial<SiteflowMediaRequest>;
  const messageId = payload.messageId;

  if (typeof messageId !== "string" || messageId.trim() === "") {
    return "messageId is required.";
  }
  if (messageId.length > MAX_MESSAGE_ID_LENGTH) {
    return `messageId must be at most ${MAX_MESSAGE_ID_LENGTH} characters.`;
  }
  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    return "messageId has an invalid format.";
  }

  return null;
}

/**
 * Build the Express handler. The Umbler token is injected (already
 * validated at startup) so this module never reads it itself and never
 * logs it. The response is never cached and never logged: the media URL it
 * may contain must not be persisted or written to server logs.
 */
export function createSiteflowMediaHandler(apiToken: string) {
  return async (req: Request, res: Response): Promise<void> => {
    // 1. The route is only available once its own secret is configured —
    //    same secret as the other SiteFlow routes, same fail-closed
    //    behaviour (kept out of startup checks so a missing value cannot
    //    stop the server from booting).
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

    // 3. Payload shape — messageId is the only accepted lookup key.
    const validationError = validateSiteflowMediaRequest(req.body);
    if (validationError) {
      res.status(400).json({ success: false, error: validationError });
      return;
    }

    const { messageId } = req.body as SiteflowMediaRequest;

    res.set("Cache-Control", "no-store");

    const result = await getMessageMedia(messageId, apiToken);

    if (result.state === "error") {
      // Sanitized: result.error is always one of a small set of fixed
      // strings (see getMessageMedia), never provider response-body text,
      // a raw exception message, the lookup URL, or the Umbler token.
      res.status(502).json({ success: false, error: result.error ?? "Umbler media lookup failed." });
      return;
    }

    if (result.state === "processing") {
      res.json({ success: true, state: "processing" });
      return;
    }

    // result.state === "ready" — result.media is guaranteed non-null here.
    const media = result.media as NonNullable<typeof result.media>;
    res.json({
      success: true,
      state: "ready",
      media: {
        url: media.url,
        contentType: media.contentType,
        sizeBytes: media.sizeBytes,
      },
    });
  };
}
